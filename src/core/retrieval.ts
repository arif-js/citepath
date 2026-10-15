import type { DatabaseSync } from 'node:sqlite';
import { SEARCH_LIMITS } from '../config/defaults.js';
import type { LoadedConfig } from '../config/load.js';
import type { SourceConfig } from '../config/schema.js';
import { buildFtsQuery } from '../indexing/tokenizer.js';
import { documentCount, getLock, latestRun, listSourceRows, passageCount } from '../store/repo.js';
import {
  type PassageResult,
  type PassageWithContext,
  RESULT_SCHEMA_VERSION,
  type SearchFilters,
  type SearchResponse,
  type SourceStatus,
  type SourcesResponse,
} from '../types/index.js';
import { NotFoundError, UsageError } from '../utils/errors.js';
import { escapeLike } from '../utils/url.js';

/**
 * The single retrieval implementation behind the CLI, MCP server, and local API.
 * Interfaces only parse input and format these results.
 */

export interface RetrievalContext {
  db: DatabaseSync;
  loaded: LoadedConfig;
}

export interface SearchParams {
  query: string;
  limit?: number;
  source_ids?: string[];
  path_prefix?: string;
}

/** BM25 column weights: title, heading_path, text, code_terms. */
const BM25_WEIGHTS = [2.0, 3.0, 1.0, 0.5] as const;

interface PassageRow {
  id: string;
  document_id: string;
  source_id: string;
  ordinal: number;
  heading_path_json: string;
  anchor: string | null;
  line_start: number | null;
  line_end: number | null;
  text: string;
  content_hash: string;
  occurrence_index: number;
  title: string;
  url: string | null;
  path: string | null;
  updated_at: string | null;
  fetched_at: string;
  commit_sha: string | null;
  rank?: number;
}

const PASSAGE_COLUMNS = `p.id, p.document_id, p.source_id, p.ordinal, p.heading_path_json, p.anchor, p.line_start,
  p.line_end, p.text, p.content_hash, p.occurrence_index, d.title, d.url, d.path, d.updated_at, d.fetched_at, d.commit_sha`;

/**
 * Path segments that name a documentation version: "15", "v2", "1.4", "2.x", "v3.1.0", and the
 * aliases "latest", "stable", "current". Two-digit numbers at most, so "404" and "2024" are not
 * versions.
 */
const VERSION_SEGMENT = /^(?:v?\d{1,2}(?:\.(?:\d+|x)){0,2}|v\d+(?:\.\d+)*|latest|stable|current)$/i;
const CURRENT_ALIASES = new Set(['latest', 'stable', 'current']);

/**
 * Identifies the same page across documentation versions: "/docs/15/app/x" and "/docs/app/x" share
 * a key. `versioned` is false for the current copy (no version segment, or "latest"/"stable").
 */
export function documentFamily(sourceId: string, location: string): { key: string; versioned: boolean } {
  let origin = '';
  let pathname = location;
  try {
    const url = new URL(location);
    origin = url.origin;
    pathname = url.pathname;
  } catch {
    // A local path relative to the source root.
  }
  let versioned = false;
  const segments = pathname.split('/').filter((segment) => {
    if (!segment) return false;
    if (!VERSION_SEGMENT.test(segment)) return true;
    if (!CURRENT_ALIASES.has(segment.toLowerCase())) versioned = true;
    return false;
  });
  return { key: JSON.stringify([sourceId, origin, segments.join('/')]), versioned };
}

function configuredSources(loaded: LoadedConfig): Map<string, SourceConfig> {
  return new Map(loaded.config.sources.map((s) => [s.id, s]));
}

/** Builds the citation link for a passage. */
export function citationUrl(row: PassageRow, source: SourceConfig | undefined): string {
  const lines =
    row.line_start != null ? `#L${row.line_start}${row.line_end != null ? `-L${row.line_end}` : ''}` : '';
  if (row.url) {
    if (source?.type === 'local') {
      const style = source.url_style ?? 'repository';
      if (style === 'site') return row.anchor ? `${row.url}#${row.anchor}` : row.url;
      return `${row.url}${lines}`;
    }
    return row.anchor ? `${row.url}#${encodeURIComponent(row.anchor)}` : row.url;
  }
  return `${row.path ?? ''}${lines}`;
}

function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const boundary = cut.lastIndexOf(' ');
  const trimmed = boundary > maxChars * 0.8 ? cut.slice(0, boundary) : cut;
  return { text: `${trimmed.trimEnd()} …`, truncated: true };
}

function toResult(row: PassageRow, sources: Map<string, SourceConfig>, score: number): PassageResult {
  const source = sources.get(row.source_id);
  const result: PassageResult = {
    id: row.id,
    source_id: row.source_id,
    source_name: source?.name ?? row.source_id,
    title: row.title,
    heading_path: JSON.parse(row.heading_path_json) as string[],
    citation_url: citationUrl(row, source),
    text: row.text,
    score,
    content_hash: row.content_hash,
    fetched_at: row.fetched_at,
    untrusted: true,
  };
  if (row.url) result.url = source?.type === 'local' ? row.url : citationUrl(row, source);
  if (row.path) result.path = row.path;
  if (row.line_start != null) result.line_start = row.line_start;
  if (row.line_end != null) result.line_end = row.line_end;
  if (row.updated_at) result.updated_at = row.updated_at;
  if (row.commit_sha) result.commit = row.commit_sha;
  return result;
}

function resolveSourceFilter(loaded: LoadedConfig, sourceIds: string[] | undefined): string[] {
  const configured = loaded.config.sources.map((s) => s.id);
  if (!sourceIds || sourceIds.length === 0) return configured;
  const unknown = sourceIds.filter((id) => !configured.includes(id));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown source ${unknown.map((id) => `"${id}"`).join(', ')}. ` +
        `Configured sources: ${configured.length > 0 ? configured.join(', ') : '(none)'}`
    );
  }
  return [...new Set(sourceIds)];
}

export function search(context: RetrievalContext, params: SearchParams): SearchResponse {
  if (typeof params.query !== 'string' || params.query.trim().length === 0) {
    throw new UsageError('The search query must not be empty.');
  }
  const limitInput = params.limit ?? SEARCH_LIMITS.defaultLimit;
  if (!Number.isInteger(limitInput) || limitInput < 1) {
    throw new UsageError(`The result limit must be a positive integer (got ${params.limit}).`);
  }
  const limit = Math.min(limitInput, SEARCH_LIMITS.maxLimit);
  const queryTruncated = params.query.length > SEARCH_LIMITS.queryChars;
  const query = queryTruncated ? params.query.slice(0, SEARCH_LIMITS.queryChars) : params.query;
  const sourceIds = resolveSourceFilter(context.loaded, params.source_ids);
  const pathPrefix = params.path_prefix?.trim() || undefined;

  const filters: SearchFilters = {};
  if (params.source_ids?.length) filters.source_ids = sourceIds;
  if (pathPrefix) filters.path_prefix = pathPrefix;

  const response: SearchResponse = {
    query,
    query_truncated: queryTruncated,
    results: [],
    effective_limit: limit,
    filters,
    truncated: false,
    schema_version: RESULT_SCHEMA_VERSION,
  };

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery || sourceIds.length === 0) return response;

  const candidates = Math.min(SEARCH_LIMITS.maxCandidates, limit * SEARCH_LIMITS.candidateMultiplier);
  const conditions = [`p.source_id IN (${sourceIds.map(() => '?').join(', ')})`];
  const args: Array<string | number> = [ftsQuery, ...sourceIds];
  if (pathPrefix) {
    const like = `${escapeLike(pathPrefix)}%`;
    conditions.push(
      "(d.path LIKE ? ESCAPE '\\' OR d.url LIKE ? ESCAPE '\\' OR d.location LIKE ? ESCAPE '\\')"
    );
    args.push(like, like, like);
  }
  args.push(candidates);

  const rows = context.db
    .prepare(
      `SELECT ${PASSAGE_COLUMNS}, bm25(passages_fts, ${BM25_WEIGHTS.join(', ')}) AS rank
       FROM passages_fts
       JOIN passages p ON p.rowid = passages_fts.rowid
       JOIN documents d ON d.id = p.document_id
       WHERE passages_fts MATCH ? AND ${conditions.join(' AND ')}
       ORDER BY rank ASC, p.id ASC
       LIMIT ?`
    )
    .all(...args) as unknown as PassageRow[];

  // Copies of one section across documentation versions ("/docs/15/x" and "/docs/x") form a group.
  // Each group yields one result, at the position of its best-ranked copy, using the current
  // (unversioned) copy when it is among the candidates. The per-document cap counts all versions.
  const family = new Map<string, { key: string; versioned: boolean }>();
  const groupOf = new Map<string, string>();
  const chosen = new Map<string, PassageRow>();
  for (const row of rows) {
    const fam = documentFamily(row.source_id, row.url ?? row.path ?? row.document_id);
    const group = JSON.stringify([fam.key, row.heading_path_json, row.occurrence_index]);
    family.set(row.id, fam);
    groupOf.set(row.id, group);
    const current = chosen.get(group);
    if (!current || (family.get(current.id)!.versioned && !fam.versioned)) chosen.set(group, row);
  }

  const sources = configuredSources(context.loaded);
  const seenContent = new Set<string>();
  const seenGroups = new Set<string>();
  const perDocument = new Map<string, number>();
  let bytes = 0;

  for (const ranked of rows) {
    if (response.results.length >= limit) break;
    const group = groupOf.get(ranked.id)!;
    if (seenGroups.has(group)) continue;
    const row = chosen.get(group)!;
    const familyKey = family.get(row.id)!.key;
    if (seenContent.has(row.content_hash)) continue;
    const docCount = perDocument.get(familyKey) ?? 0;
    if (docCount >= SEARCH_LIMITS.perDocumentCap) continue;

    // Score of the group's best copy, so scores keep decreasing down the list.
    const result = toResult(row, sources, Math.round(-(ranked.rank ?? 0) * 10_000) / 10_000);
    const excerpt = truncateText(result.text, SEARCH_LIMITS.excerptChars);
    result.text = excerpt.text;
    if (excerpt.truncated) response.truncated = true;

    const size = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (bytes + size > SEARCH_LIMITS.responseBytes) {
      response.truncated = true;
      break;
    }
    bytes += size;
    seenContent.add(row.content_hash);
    seenGroups.add(group);
    perDocument.set(familyKey, docCount + 1);
    response.results.push(result);
  }
  return response;
}

export function getPassage(context: RetrievalContext, id: string, neighbors = 0): PassageWithContext {
  if (typeof id !== 'string' || id.trim() === '') throw new UsageError('A passage ID is required.');
  if (!Number.isInteger(neighbors) || neighbors < 0) {
    throw new UsageError('neighbors must be a non-negative integer.');
  }
  const count = Math.min(neighbors, SEARCH_LIMITS.maxNeighbors);
  const sources = configuredSources(context.loaded);
  const row = context.db
    .prepare(
      `SELECT ${PASSAGE_COLUMNS} FROM passages p JOIN documents d ON d.id = p.document_id WHERE p.id = ?`
    )
    .get(id.trim()) as PassageRow | undefined;
  if (!row || !sources.has(row.source_id)) throw new NotFoundError(`No passage with ID "${id}".`);

  const around =
    count > 0
      ? (context.db
          .prepare(
            `SELECT ${PASSAGE_COLUMNS} FROM passages p JOIN documents d ON d.id = p.document_id
             WHERE p.document_id = ? AND p.ordinal BETWEEN ? AND ? AND p.id != ?
             ORDER BY p.ordinal`
          )
          .all(row.document_id, row.ordinal - count, row.ordinal + count, row.id) as unknown as PassageRow[])
      : [];

  return {
    passage: toResult(row, sources, 0),
    before: around.filter((r) => r.ordinal < row.ordinal).map((r) => toResult(r, sources, 0)),
    after: around.filter((r) => r.ordinal > row.ordinal).map((r) => toResult(r, sources, 0)),
    schema_version: RESULT_SCHEMA_VERSION,
  };
}

export function listSources(context: RetrievalContext): SourcesResponse {
  const { db, loaded } = context;
  const sources: SourceStatus[] = loaded.config.sources.map((source) => {
    const run = latestRun(db, source.id);
    const status: SourceStatus = {
      id: source.id,
      name: source.name ?? source.id,
      type: source.type,
      documents: documentCount(db, source.id),
      passages: passageCount(db, source.id),
      syncing: getLock(db, source.id) !== undefined,
      last_sync: run
        ? {
            run_id: run.id,
            status: run.status,
            started_at: run.started_at,
            finished_at: run.finished_at,
            discovery_complete: run.discovery_complete == null ? null : run.discovery_complete === 1,
          }
        : null,
    };
    if (source.type === 'web') status.url = source.url;
    else status.path = source.path;
    return status;
  });

  const configured = new Set(loaded.config.sources.map((s) => s.id));
  const orphaned = listSourceRows(db)
    .filter((row) => !configured.has(row.id))
    .map((row) => ({ id: row.id, documents: documentCount(db, row.id) }));

  return { sources, orphaned, schema_version: RESULT_SCHEMA_VERSION };
}
