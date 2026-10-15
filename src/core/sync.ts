import type { DatabaseSync } from 'node:sqlite';
import { SYNC_DEFAULTS } from '../config/defaults.js';
import { type LoadedConfig, localSourceRoot } from '../config/load.js';
import type { SourceConfig } from '../config/schema.js';
import { type DocumentRecord, PARSER_VERSION } from '../indexing/passages.js';
import type { ItemOutcome, KnownDocument, SourceAdapter } from '../sources/adapter.js';
import { LocalSourceAdapter } from '../sources/local/adapter.js';
import { WebSourceAdapter } from '../sources/web/adapter.js';
import {
  beginRun,
  cleanupOrphanedStaging,
  documentCount,
  ensureSourceRow,
  heartbeat,
  nowIso,
  releaseLock,
} from '../store/repo.js';
import { computeContentHash } from '../utils/id.js';
import { type Logger, silentLogger } from '../utils/logger.js';

/** Removing this many documents or fewer never trips the mass-deletion guard. */
export const MASS_DELETE_MIN_COUNT = 3;
const MAX_LISTED_ITEMS = 100;

export type SyncStatus = 'completed' | 'completed_with_failures' | 'failed' | 'interrupted';

export interface SyncItemReport {
  location: string;
  reason: string;
  classification?: string;
}

export interface SyncSummary {
  source_id: string;
  run_id: number;
  status: SyncStatus;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  discovery_complete: boolean;
  discovery_reasons: string[];
  counts: {
    added: number;
    updated: number;
    unchanged: number;
    removed: number;
    excluded: number;
    failed: number;
    documents_total: number;
  };
  mass_delete_guard: {
    triggered: boolean;
    would_remove: number;
    existing: number;
    threshold: number;
  };
  removed: SyncItemReport[];
  failed: SyncItemReport[];
  excluded: SyncItemReport[];
  warnings: string[];
  error?: string;
}

/** Progress for one sync run. Locations are identifiers (URLs, relative paths), never content. */
export interface SyncProgress {
  source_id: string;
  /** `fetching`: streaming items from the source. `applying`: writing them to the index. */
  phase: 'fetching' | 'applying';
  /** Items reported by the adapter so far, keyed by outcome kind. */
  items: Record<ItemOutcome['kind'], number>;
  /** Sum of `items`. */
  processed: number;
  /** The most recent item. */
  location?: string;
}

export interface SyncOptions {
  allowMassDelete?: boolean;
  signal?: AbortSignal;
  logger?: Logger;
  /** Called after each item and once when applying starts. Must not throw. */
  onProgress?: (progress: SyncProgress) => void;
  /** Test hook: build the adapter for a source. */
  adapterFactory?: (source: SourceConfig, loaded: LoadedConfig) => SourceAdapter;
  /** Test hook: throw inside the apply transaction to verify atomicity. */
  failDuringApply?: boolean;
}

/** Hash of the source settings that affect what gets indexed (the display name is excluded). */
export function sourceConfigHash(source: SourceConfig): string {
  const { name: _name, ...rest } = source;
  const sorted = Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)));
  return computeContentHash(JSON.stringify(sorted));
}

export function createAdapter(source: SourceConfig, loaded: LoadedConfig): SourceAdapter {
  if (source.type === 'local') {
    return new LocalSourceAdapter(source, { root: localSourceRoot(source, loaded.configDir) });
  }
  return new WebSourceAdapter(source);
}

const OUTCOME_RANK: Record<ItemOutcome['kind'], number> = {
  document: 5,
  unchanged: 4,
  failed: 3,
  gone: 2,
  excluded: 1,
};

interface DocumentPayload {
  document: DocumentRecord;
  url?: string;
  path?: string;
  alternateUrls?: string[];
  etag?: string;
  lastModified?: string;
  updatedAt?: string;
  commitSha?: string;
  dirty?: boolean;
}

interface StagedRow {
  location: string;
  document_id: string | null;
  outcome: ItemOutcome['kind'];
  reason: string | null;
  payload_json: string | null;
}

interface ExistingDoc {
  id: string;
  location: string;
  content_hash: string;
  parser_version: number;
  config_hash: string;
}

function pushLimited(list: SyncItemReport[], item: SyncItemReport): void {
  if (list.length < MAX_LISTED_ITEMS) list.push(item);
}

function stage(db: DatabaseSync, runId: number, outcome: ItemOutcome): void {
  let payload: unknown = null;
  let documentId: string | null = null;
  let reason: string | null = null;
  let contentHash: string | null = null;
  switch (outcome.kind) {
    case 'document': {
      const { kind: _kind, location: _location, ...rest } = outcome;
      payload = rest;
      documentId = outcome.document.id;
      if (outcome.document.passages.length > 0) contentHash = outcome.document.contentHash;
      break;
    }
    case 'unchanged':
      payload = { etag: outcome.etag, lastModified: outcome.lastModified };
      break;
    case 'excluded':
      reason = outcome.reason;
      payload = outcome.aliasOf ? { aliasOf: outcome.aliasOf, url: outcome.url } : null;
      break;
    case 'failed':
      reason = outcome.reason;
      payload = { classification: outcome.classification };
      break;
    case 'gone':
      reason = outcome.reason;
      break;
  }
  db.prepare(
    `INSERT INTO staged_items (run_id, location, document_id, outcome, reason, payload_json, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, location) DO UPDATE SET
       document_id = excluded.document_id, outcome = excluded.outcome,
       reason = excluded.reason, payload_json = excluded.payload_json, content_hash = excluded.content_hash`
  ).run(
    runId,
    outcome.location,
    documentId,
    outcome.kind,
    reason,
    payload === null ? null : JSON.stringify(payload),
    contentHash
  );
}

function insertPassages(db: DatabaseSync, sourceId: string, doc: DocumentRecord): void {
  const insertPassage = db.prepare(
    `INSERT INTO passages (id, document_id, source_id, ordinal, heading_path_json, anchor, line_start,
       line_end, text, content_hash, occurrence_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFts = db.prepare(
    'INSERT INTO passages_fts (rowid, title, heading_path, text, code_terms) VALUES (?, ?, ?, ?, ?)'
  );
  for (const passage of doc.passages) {
    const result = insertPassage.run(
      passage.id,
      doc.id,
      sourceId,
      passage.ordinal,
      JSON.stringify(passage.headingPath),
      passage.anchor ?? null,
      passage.lineStart ?? null,
      passage.lineEnd ?? null,
      passage.text,
      passage.contentHash,
      passage.occurrenceIndex
    );
    insertFts.run(
      Number(result.lastInsertRowid),
      doc.title,
      passage.headingPath.join(' / '),
      passage.text,
      passage.codeTerms
    );
  }
}

/**
 * Syncs one source (docs/sync.md):
 * 1. take the per-source lock (recovering stale locks from crashed runs);
 * 2. stream adapter outcomes into staging, leaving the committed index untouched;
 * 3. apply everything in one transaction: add/update/keep documents, then remove only
 *    on evidence (gone, excluded, out of scope, or unseen after a complete discovery),
 *    subject to the mass-deletion guard.
 * An error or interruption before step 3 commits leaves the previous index intact.
 */
export async function syncSource(
  db: DatabaseSync,
  loaded: LoadedConfig,
  source: SourceConfig,
  options: SyncOptions = {}
): Promise<SyncSummary> {
  const logger = options.logger ?? silentLogger;
  const configHash = sourceConfigHash(source);
  const threshold =
    source.mass_delete_threshold ?? loaded.config.mass_delete_threshold ?? SYNC_DEFAULTS.massDeleteThreshold;
  const startedAt = nowIso();
  const startMs = Date.now();

  ensureSourceRow(db, source.id, source.type, configHash);
  cleanupOrphanedStaging(db);
  const { runId, tookOverStaleLock } = beginRun(db, source.id);

  const summary: SyncSummary = {
    source_id: source.id,
    run_id: runId,
    status: 'completed',
    started_at: startedAt,
    finished_at: startedAt,
    duration_ms: 0,
    discovery_complete: false,
    discovery_reasons: [],
    counts: { added: 0, updated: 0, unchanged: 0, removed: 0, excluded: 0, failed: 0, documents_total: 0 },
    mass_delete_guard: { triggered: false, would_remove: 0, existing: 0, threshold },
    removed: [],
    failed: [],
    excluded: [],
    warnings: [],
  };
  if (tookOverStaleLock) summary.warnings.push('recovered a stale lock left by an interrupted sync');

  const beat = setInterval(() => {
    try {
      heartbeat(db, source.id, runId);
    } catch {
      // A busy database delays the heartbeat; the next tick retries.
    }
  }, SYNC_DEFAULTS.lockHeartbeatMs);
  beat.unref();

  const finish = (status: SyncStatus, error?: string): SyncSummary => {
    summary.status = status;
    summary.finished_at = nowIso();
    summary.duration_ms = Date.now() - startMs;
    if (error) summary.error = error;
    return summary;
  };

  try {
    const adapter = (options.adapterFactory ?? createAdapter)(source, loaded);
    const lookupStmt = db.prepare(
      `SELECT location, etag, last_modified, parser_version, config_hash FROM documents
       WHERE source_id = ? AND (location = ? OR id IN (SELECT document_id FROM document_urls WHERE url = ?))
       LIMIT 1`
    );
    const lookup = (key: string): KnownDocument | undefined => {
      const row = lookupStmt.get(source.id, key, key) as
        | {
            location: string;
            etag: string | null;
            last_modified: string | null;
            parser_version: number;
            config_hash: string;
          }
        | undefined;
      if (!row) return undefined;
      return {
        location: row.location,
        etag: row.etag ?? undefined,
        lastModified: row.last_modified ?? undefined,
        reusable: row.parser_version === PARSER_VERSION && row.config_hash === configHash,
      };
    };

    // Phase 1: stream outcomes into staging. Higher-ranked outcomes win for a location.
    const ranks = new Map<string, number>();
    const progress: SyncProgress = {
      source_id: source.id,
      phase: 'fetching',
      items: { document: 0, unchanged: 0, gone: 0, excluded: 0, failed: 0 },
      processed: 0,
    };
    const report = () => options.onProgress?.({ ...progress, items: { ...progress.items } });
    for await (const outcome of adapter.run({ logger, signal: options.signal, lookup })) {
      if (options.signal?.aborted) break;
      progress.items[outcome.kind]++;
      progress.processed++;
      progress.location = outcome.location;
      report();
      const rank = OUTCOME_RANK[outcome.kind];
      if ((ranks.get(outcome.location) ?? 0) > rank) continue;
      ranks.set(outcome.location, rank);
      stage(db, runId, outcome);
    }

    if (options.signal?.aborted) {
      db.prepare('DELETE FROM staged_items WHERE run_id = ?').run(runId);
      db.prepare("UPDATE sync_runs SET status = 'interrupted', finished_at = ? WHERE id = ?").run(
        nowIso(),
        runId
      );
      return finish('interrupted', 'sync was interrupted; the index was not changed');
    }

    summary.discovery_complete = adapter.discovery.complete;
    summary.discovery_reasons = [...adapter.discovery.reasons];

    // Phase 2: apply atomically.
    progress.phase = 'applying';
    progress.location = undefined;
    report();
    db.exec('BEGIN IMMEDIATE');
    try {
      applyStaged(db, source, runId, configHash, adapter, summary, options);
      if (options.failDuringApply) throw new Error('simulated failure during apply');
      summary.counts.documents_total = documentCount(db, source.id);
      if (summary.counts.documents_total === 0) {
        summary.warnings.push('the source has no indexed documents');
      }
      const hasProblems =
        summary.counts.failed > 0 || summary.mass_delete_guard.triggered || !summary.discovery_complete;
      finish(hasProblems ? 'completed_with_failures' : 'completed');
      db.prepare('UPDATE sources SET config_hash = ?, last_run_id = ? WHERE id = ?').run(
        configHash,
        runId,
        source.id
      );
      db.prepare(
        'UPDATE sync_runs SET status = ?, finished_at = ?, discovery_complete = ?, summary_json = ? WHERE id = ?'
      ).run(
        summary.status,
        summary.finished_at,
        summary.discovery_complete ? 1 : 0,
        JSON.stringify(summary),
        runId
      );
      db.prepare('DELETE FROM staged_items WHERE run_id = ?').run(runId);
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already rolled back.
      }
      throw err;
    }
    return summary;
  } catch (err) {
    const interrupted = options.signal?.aborted === true;
    const message = interrupted
      ? 'sync was interrupted; the index was not changed'
      : ((err as Error)?.message ?? String(err));
    if (!interrupted)
      logger.error('sync failed; the index was not changed', { source: source.id, error: message });
    const status: SyncStatus = interrupted ? 'interrupted' : 'failed';
    try {
      db.prepare('DELETE FROM staged_items WHERE run_id = ?').run(runId);
      const result = finish(status, message);
      db.prepare('UPDATE sync_runs SET status = ?, finished_at = ?, summary_json = ? WHERE id = ?').run(
        status,
        result.finished_at,
        JSON.stringify(result),
        runId
      );
    } catch {
      // Best effort: the lock is released below either way.
    }
    return finish(status, message);
  } finally {
    clearInterval(beat);
    try {
      releaseLock(db, source.id, runId);
    } catch {
      // A stale lock is recovered automatically by the next run.
    }
  }
}

function applyStaged(
  db: DatabaseSync,
  source: SourceConfig,
  runId: number,
  configHash: string,
  adapter: SourceAdapter,
  summary: SyncSummary,
  options: SyncOptions
): void {
  const existingRows = db
    .prepare(
      'SELECT id, location, content_hash, parser_version, config_hash FROM documents WHERE source_id = ?'
    )
    .all(source.id) as unknown as ExistingDoc[];
  const existing = new Map(existingRows.map((row) => [row.location, row]));
  const now = nowIso();

  // Same content at several URLs (web): keep the lexicographically first location.
  // Only hashes are read here, so memory does not grow with document size.
  const aliasTargets = new Map<string, string>(); // alias location -> kept location
  if (source.type === 'web') {
    const firstByHash = new Map<string, string>();
    const hashes = db
      .prepare(
        `SELECT location, content_hash FROM staged_items
         WHERE run_id = ? AND outcome = 'document' AND content_hash IS NOT NULL ORDER BY location`
      )
      .all(runId) as Array<{ location: string; content_hash: string }>;
    for (const row of hashes) {
      const kept = firstByHash.get(row.content_hash);
      if (kept) aliasTargets.set(row.location, kept);
      else firstByHash.set(row.content_hash, row.location);
    }
  }

  // Staged rows are read in pages so large sources are applied with bounded memory.
  const pageStmt = db.prepare(
    `SELECT location, document_id, outcome, reason, payload_json FROM staged_items
     WHERE run_id = ? AND location > ? ORDER BY location LIMIT 200`
  );
  function* stagedRows(): Generator<StagedRow> {
    let after = '';
    while (true) {
      const page = pageStmt.all(runId, after) as unknown as StagedRow[];
      if (page.length === 0) return;
      yield* page;
      after = page[page.length - 1]!.location;
    }
  }

  const seen = new Set<string>();
  const removals = new Map<string, string>(); // location -> reason
  const alternateUrls = new Map<string, Set<string>>(); // kept location -> urls

  const addAlternate = (location: string, url: string | undefined) => {
    if (!url) return;
    const set = alternateUrls.get(location) ?? new Set<string>();
    set.add(url);
    alternateUrls.set(location, set);
  };

  const upsertDoc = db.prepare(
    `INSERT INTO documents (id, source_id, location, url, path, title, content_hash, parser_version, config_hash,
       etag, last_modified, commit_sha, dirty, metadata_json, updated_at, fetched_at, last_seen_run_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       url = excluded.url, path = excluded.path, title = excluded.title, content_hash = excluded.content_hash,
       parser_version = excluded.parser_version, config_hash = excluded.config_hash, etag = excluded.etag,
       last_modified = excluded.last_modified, commit_sha = excluded.commit_sha, dirty = excluded.dirty,
       metadata_json = excluded.metadata_json, updated_at = excluded.updated_at, fetched_at = excluded.fetched_at,
       last_seen_run_id = excluded.last_seen_run_id`
  );
  const markSeen = db.prepare(
    'UPDATE documents SET last_seen_run_id = ? WHERE source_id = ? AND location = ?'
  );

  for (const row of stagedRows()) {
    switch (row.outcome) {
      case 'document': {
        const payload = JSON.parse(row.payload_json!) as DocumentPayload;
        const keptLocation = aliasTargets.get(row.location);
        if (keptLocation) {
          addAlternate(keptLocation, payload.url);
          if (existing.has(row.location)) removals.set(row.location, `duplicate content of ${keptLocation}`);
          summary.counts.excluded++;
          pushLimited(summary.excluded, {
            location: row.location,
            reason: `duplicate content of ${keptLocation}`,
          });
          break;
        }
        seen.add(row.location);
        const doc = payload.document;
        const prior = existing.get(row.location);
        const unchanged =
          prior &&
          prior.content_hash === doc.contentHash &&
          prior.parser_version === PARSER_VERSION &&
          prior.config_hash === configHash;

        upsertDoc.run(
          doc.id,
          source.id,
          row.location,
          payload.url ?? null,
          payload.path ?? null,
          doc.title || payload.path || row.location,
          doc.contentHash,
          PARSER_VERSION,
          configHash,
          payload.etag ?? null,
          payload.lastModified ?? null,
          payload.commitSha ?? null,
          payload.dirty === undefined ? null : payload.dirty ? 1 : 0,
          JSON.stringify(doc.metadata ?? {}),
          payload.updatedAt ?? null,
          now,
          runId
        );
        for (const url of payload.alternateUrls ?? []) addAlternate(row.location, url);
        if (unchanged) {
          summary.counts.unchanged++;
        } else {
          db.prepare('DELETE FROM passages WHERE document_id = ?').run(doc.id);
          insertPassages(db, source.id, doc);
          if (prior) summary.counts.updated++;
          else summary.counts.added++;
        }
        break;
      }
      case 'unchanged': {
        seen.add(row.location);
        const payload = row.payload_json ? (JSON.parse(row.payload_json) as { etag?: string }) : {};
        db.prepare(
          'UPDATE documents SET last_seen_run_id = ?, fetched_at = ?, etag = COALESCE(?, etag) WHERE source_id = ? AND location = ?'
        ).run(runId, now, payload.etag ?? null, source.id, row.location);
        summary.counts.unchanged++;
        break;
      }
      case 'failed': {
        seen.add(row.location);
        markSeen.run(runId, source.id, row.location);
        const payload = row.payload_json ? (JSON.parse(row.payload_json) as { classification?: string }) : {};
        summary.counts.failed++;
        pushLimited(summary.failed, {
          location: row.location,
          reason: row.reason ?? 'failed',
          classification: payload.classification,
        });
        break;
      }
      case 'gone':
        if (existing.has(row.location)) removals.set(row.location, row.reason ?? 'gone');
        break;
      case 'excluded': {
        const payload = row.payload_json
          ? (JSON.parse(row.payload_json) as { aliasOf?: string; url?: string })
          : {};
        if (payload.aliasOf) addAlternate(payload.aliasOf, payload.url ?? row.location);
        else {
          summary.counts.excluded++;
          pushLimited(summary.excluded, { location: row.location, reason: row.reason ?? 'excluded' });
        }
        if (existing.has(row.location)) removals.set(row.location, row.reason ?? 'excluded');
        break;
      }
    }
  }

  // Scope narrowing applies even when discovery was incomplete.
  for (const prior of existingRows) {
    if (!adapter.isInScope(prior.location) && !removals.has(prior.location)) {
      removals.set(prior.location, 'outside the configured scope');
    }
  }
  if (adapter.discovery.complete) {
    for (const prior of existingRows) {
      if (!seen.has(prior.location) && !removals.has(prior.location)) {
        removals.set(
          prior.location,
          source.type === 'local' ? 'file no longer exists' : 'no longer discovered'
        );
      }
    }
  }

  // Mass-deletion guard.
  const existingCount = existingRows.length;
  const wouldRemove = removals.size;
  summary.mass_delete_guard.would_remove = wouldRemove;
  summary.mass_delete_guard.existing = existingCount;
  const tripped =
    existingCount > 0 &&
    wouldRemove > MASS_DELETE_MIN_COUNT &&
    wouldRemove / existingCount > summary.mass_delete_guard.threshold;
  if (tripped && !options.allowMassDelete) {
    summary.mass_delete_guard.triggered = true;
    summary.warnings.push(
      `mass-deletion guard: this sync would remove ${wouldRemove} of ${existingCount} documents ` +
        `(more than ${Math.round(summary.mass_delete_guard.threshold * 100)}%). Nothing was removed. ` +
        'If this is expected, re-run with --allow-mass-delete.'
    );
  } else {
    const deleteDoc = db.prepare('DELETE FROM documents WHERE source_id = ? AND location = ?');
    for (const [location, reason] of [...removals].sort(([a], [b]) => a.localeCompare(b))) {
      deleteDoc.run(source.id, location);
      summary.counts.removed++;
      pushLimited(summary.removed, { location, reason });
    }
  }

  // Alternate URLs for documents that still exist.
  const docIdFor = db.prepare('SELECT id FROM documents WHERE source_id = ? AND location = ?');
  const insertUrl = db.prepare('INSERT OR IGNORE INTO document_urls (document_id, url) VALUES (?, ?)');
  for (const [location, urls] of alternateUrls) {
    const row = docIdFor.get(source.id, location) as { id: string } | undefined;
    if (!row) continue;
    for (const url of urls) if (url !== location) insertUrl.run(row.id, url);
  }

  if (!summary.discovery_complete && summary.discovery_reasons.length > 0) {
    summary.warnings.push(
      `discovery was incomplete (${summary.discovery_reasons.join('; ')}), so unseen documents were kept`
    );
  }
}
