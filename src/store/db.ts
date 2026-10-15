import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IndexError } from '../utils/errors.js';
import { migrate } from './migrations.js';

export const INDEX_FILE_NAME = 'index.db';

export function indexPath(dataDir: string): string {
  return path.join(dataDir, INDEX_FILE_NAME);
}

/** Opens the index in a data directory, creating and migrating it if needed. */
export function openIndex(dataDir: string): DatabaseSync {
  fs.mkdirSync(dataDir, { recursive: true });
  return openDatabase(indexPath(dataDir));
}

/** Opens a database file (or ":memory:") with Citepath's pragmas and latest schema. */
export function openDatabase(dbPath: string): DatabaseSync {
  const isMemory = dbPath === ':memory:';
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
  } catch (err: any) {
    throw new IndexError(`Cannot open index ${dbPath}: ${err?.message ?? err}`);
  }
  try {
    assertFts5(db);
    // Wait for a concurrent writer (e.g. a sync committing) instead of failing immediately.
    db.exec('PRAGMA busy_timeout = 10000');
    if (!isMemory) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, isMemory ? undefined : dbPath);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/** Node's bundled SQLite includes FTS5 only from Node 22.16.0; fail clearly on older runtimes. */
function assertFts5(db: DatabaseSync): void {
  const row = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5").get() as { fts5: number };
  if (row.fts5 !== 1) {
    throw new IndexError(
      `This Node.js (${process.version}) ships SQLite without full-text search (FTS5). ` +
        'Citepath requires Node.js 22.16 or later.'
    );
  }
}

/** Runs `fn` inside a write transaction (BEGIN IMMEDIATE), rolling back on error. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite already rolled back (e.g. after SQLITE_FULL); keep the original error.
    }
    throw err;
  }
}
