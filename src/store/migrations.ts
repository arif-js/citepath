import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { ftsHeadingPath, passageCodeTerms } from '../indexing/passages.js';
import { IndexError } from '../utils/errors.js';

/**
 * Forward-only schema migrations. Never edit a released migration; add a new one.
 * Before upgrading an existing index, a backup is written next to it.
 */

interface Migration {
  version: number;
  sql: string;
  /** Data step that runs after `sql`, in the same transaction. */
  run?: (db: DatabaseSync) => void;
}

const FTS_REBUILD_PAGE = 500;

/** Refills passages_fts from stored passages, page by page, with the same values sync writes. */
function rebuildFts(db: DatabaseSync): void {
  const page = db.prepare(
    `SELECT p.rowid AS rowid, d.title AS title, p.heading_path_json AS heading_path_json, p.text AS text
     FROM passages p JOIN documents d ON d.id = p.document_id
     WHERE p.rowid > ? ORDER BY p.rowid LIMIT ?`
  );
  const insert = db.prepare(
    'INSERT INTO passages_fts (rowid, title, heading_path, text, code_terms) VALUES (?, ?, ?, ?, ?)'
  );
  let after = 0;
  for (;;) {
    const rows = page.all(after, FTS_REBUILD_PAGE) as Array<{
      rowid: number;
      title: string;
      heading_path_json: string;
      text: string;
    }>;
    for (const row of rows) {
      const headingPath = JSON.parse(row.heading_path_json) as string[];
      insert.run(
        row.rowid,
        row.title,
        ftsHeadingPath(row.title, headingPath),
        row.text,
        passageCodeTerms(headingPath, row.text)
      );
    }
    if (rows.length < FTS_REBUILD_PAGE) return;
    after = rows[rows.length - 1]!.rowid;
  }
}

/** Exported for tests that build an index at an older version. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE sources (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        config_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_run_id INTEGER
      );

      CREATE TABLE documents (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        location TEXT NOT NULL,
        url TEXT,
        path TEXT,
        title TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        parser_version INTEGER NOT NULL,
        config_hash TEXT NOT NULL,
        etag TEXT,
        last_modified TEXT,
        commit_sha TEXT,
        dirty INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT,
        fetched_at TEXT NOT NULL,
        last_seen_run_id INTEGER,
        UNIQUE (source_id, location)
      );
      CREATE INDEX documents_source ON documents(source_id);

      CREATE TABLE document_urls (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        PRIMARY KEY (document_id, url)
      );
      CREATE INDEX document_urls_url ON document_urls(url);

      CREATE TABLE passages (
        rowid INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        heading_path_json TEXT NOT NULL,
        anchor TEXT,
        line_start INTEGER,
        line_end INTEGER,
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        occurrence_index INTEGER NOT NULL
      );
      CREATE INDEX passages_document ON passages(document_id, ordinal);
      CREATE INDEX passages_source ON passages(source_id);

      -- Contentless FTS index: text is read from passages; FTS rows mirror passage rowids.
      CREATE VIRTUAL TABLE passages_fts USING fts5(
        title, heading_path, text, code_terms,
        content = '',
        contentless_delete = 1,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      -- Keep FTS in step with passages, including cascaded deletes from documents/sources.
      CREATE TRIGGER passages_fts_delete AFTER DELETE ON passages BEGIN
        DELETE FROM passages_fts WHERE rowid = old.rowid;
      END;

      CREATE TABLE sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        discovery_complete INTEGER,
        summary_json TEXT
      );
      CREATE INDEX sync_runs_source ON sync_runs(source_id, id);

      CREATE TABLE sync_locks (
        source_id TEXT PRIMARY KEY,
        run_id INTEGER NOT NULL,
        pid INTEGER NOT NULL,
        hostname TEXT NOT NULL,
        started_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      );

      -- Per-run staging. Rows are applied in one transaction at the end of a sync and
      -- cleared afterwards; rows left by an interrupted run are discarded on the next run.
      CREATE TABLE staged_items (
        run_id INTEGER NOT NULL,
        location TEXT NOT NULL,
        document_id TEXT,
        outcome TEXT NOT NULL,
        reason TEXT,
        payload_json TEXT,
        -- Document content hash (non-empty documents only), for cross-URL deduplication.
        content_hash TEXT,
        PRIMARY KEY (run_id, location)
      );
    `,
  },
  {
    // English stemming: "caching", "cache", and "cached" match each other. FTS5 applies the
    // same tokenizer to queries, so query construction is unchanged. The index is rebuilt from
    // stored passages; IDs and documents are untouched, so no re-sync is needed.
    version: 2,
    sql: `
      DROP TRIGGER passages_fts_delete;
      DROP TABLE passages_fts;

      CREATE VIRTUAL TABLE passages_fts USING fts5(
        title, heading_path, text, code_terms,
        content = '',
        contentless_delete = 1,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER passages_fts_delete AFTER DELETE ON passages BEGIN
        DELETE FROM passages_fts WHERE rowid = old.rowid;
      END;
    `,
    run: rebuildFts,
  },
  {
    // Index the page title once per passage: the heading_path column no longer repeats it.
    // Same tables and IDs; the search index is refilled from stored passages.
    version: 3,
    sql: "INSERT INTO passages_fts(passages_fts) VALUES('delete-all');",
    run: rebuildFts,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function getSchemaVersion(db: DatabaseSync): number {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!table) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

/**
 * Brings the database to the latest schema version.
 * @param dbPath file path used for the pre-migration backup (omit for in-memory databases)
 */
export function migrate(
  db: DatabaseSync,
  dbPath?: string
): { from: number; to: number; backupPath?: string } {
  const current = getSchemaVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new IndexError(
      `The index at ${dbPath ?? '(memory)'} uses schema version ${current}, but this version of Citepath ` +
        `supports up to ${LATEST_SCHEMA_VERSION}. Upgrade Citepath to open it; the index was not modified.`
    );
  }
  if (current === LATEST_SCHEMA_VERSION) return { from: current, to: current };

  let backupPath: string | undefined;
  if (current > 0 && dbPath) {
    backupPath = `${dbPath}.backup-v${current}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (fs.existsSync(backupPath)) fs.rmSync(backupPath);
    db.prepare('VACUUM INTO ?').run(backupPath);
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      migration.run?.(db);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(String(migration.version));
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Already rolled back; keep the original error.
      }
      throw err;
    }
  }
  return { from: current, to: LATEST_SCHEMA_VERSION, backupPath };
}
