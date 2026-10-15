import os from 'node:os';
import type { DatabaseSync } from 'node:sqlite';
import { SYNC_DEFAULTS } from '../config/defaults.js';
import { LockError } from '../utils/errors.js';

/** Data access helpers shared by sync, retrieval, and management commands. */

export interface SourceRow {
  id: string;
  type: string;
  config_hash: string;
  created_at: string;
  last_run_id: number | null;
}

export interface SyncRunRow {
  id: number;
  source_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  discovery_complete: number | null;
  summary_json: string | null;
}

export interface LockRow {
  source_id: string;
  run_id: number;
  pid: number;
  hostname: string;
  started_at: string;
  heartbeat_at: string;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getSourceRow(db: DatabaseSync, id: string): SourceRow | undefined {
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
}

export function listSourceRows(db: DatabaseSync): SourceRow[] {
  return db.prepare('SELECT * FROM sources ORDER BY id').all() as unknown as SourceRow[];
}

export function ensureSourceRow(db: DatabaseSync, id: string, type: string, configHash: string): void {
  db.prepare(
    `INSERT INTO sources (id, type, config_hash, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(id, type, configHash, nowIso());
}

export function documentCount(db: DatabaseSync, sourceId: string): number {
  return (
    db.prepare('SELECT count(*) AS c FROM documents WHERE source_id = ?').get(sourceId) as { c: number }
  ).c;
}

export function passageCount(db: DatabaseSync, sourceId: string): number {
  return (db.prepare('SELECT count(*) AS c FROM passages WHERE source_id = ?').get(sourceId) as { c: number })
    .c;
}

export function latestRun(db: DatabaseSync, sourceId: string): SyncRunRow | undefined {
  return db.prepare('SELECT * FROM sync_runs WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(sourceId) as
    | SyncRunRow
    | undefined;
}

export function getLock(db: DatabaseSync, sourceId: string): LockRow | undefined {
  return db.prepare('SELECT * FROM sync_locks WHERE source_id = ?').get(sourceId) as LockRow | undefined;
}

/** True if a process with this PID exists on this machine. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === 'EPERM';
  }
}

/**
 * A lock is stale when its heartbeat stopped, or when it belongs to a process on this
 * machine that no longer exists (crash, kill -9, power loss).
 */
export function isLockStale(lock: LockRow, now = Date.now()): boolean {
  if (now - Date.parse(lock.heartbeat_at) > SYNC_DEFAULTS.staleLockMs) return true;
  return lock.hostname === os.hostname() && !isProcessAlive(lock.pid);
}

/**
 * Starts a sync run and takes the source lock in one transaction.
 * A stale lock is taken over (its run is marked interrupted and its staging rows dropped).
 */
export function beginRun(db: DatabaseSync, sourceId: string): { runId: number; tookOverStaleLock: boolean } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = getLock(db, sourceId);
    let tookOverStaleLock = false;
    if (existing) {
      if (!isLockStale(existing)) {
        throw new LockError(
          `Source "${sourceId}" is already being synced (pid ${existing.pid} on ${existing.hostname}, ` +
            `started ${existing.started_at}). If no sync is running, run: citepath unlock ${sourceId}`
        );
      }
      markRunInterrupted(db, existing.run_id);
      db.prepare('DELETE FROM sync_locks WHERE source_id = ?').run(sourceId);
      tookOverStaleLock = true;
    }
    const now = nowIso();
    const result = db
      .prepare("INSERT INTO sync_runs (source_id, started_at, status) VALUES (?, ?, 'running')")
      .run(sourceId, now);
    const runId = Number(result.lastInsertRowid);
    db.prepare(
      `INSERT INTO sync_locks (source_id, run_id, pid, hostname, started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sourceId, runId, process.pid, os.hostname(), now, now);
    db.exec('COMMIT');
    return { runId, tookOverStaleLock };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function markRunInterrupted(db: DatabaseSync, runId: number): void {
  db.prepare(
    "UPDATE sync_runs SET status = 'interrupted', finished_at = ? WHERE id = ? AND status = 'running'"
  ).run(nowIso(), runId);
  db.prepare('DELETE FROM staged_items WHERE run_id = ?').run(runId);
}

export function heartbeat(db: DatabaseSync, sourceId: string, runId: number): void {
  db.prepare('UPDATE sync_locks SET heartbeat_at = ? WHERE source_id = ? AND run_id = ?').run(
    nowIso(),
    sourceId,
    runId
  );
}

export function releaseLock(db: DatabaseSync, sourceId: string, runId: number): void {
  db.prepare('DELETE FROM sync_locks WHERE source_id = ? AND run_id = ?').run(sourceId, runId);
}

/** Manual escape hatch for `citepath unlock`. Returns the removed lock, if any. */
export function forceUnlock(db: DatabaseSync, sourceId: string): LockRow | undefined {
  const lock = getLock(db, sourceId);
  if (!lock) return undefined;
  db.exec('BEGIN IMMEDIATE');
  try {
    markRunInterrupted(db, lock.run_id);
    db.prepare('DELETE FROM sync_locks WHERE source_id = ?').run(sourceId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return lock;
}

/** Drops staging rows left by runs that are no longer running (e.g. after a crash). */
export function cleanupOrphanedStaging(db: DatabaseSync): void {
  db.prepare(
    `DELETE FROM staged_items
     WHERE run_id NOT IN (SELECT id FROM sync_runs WHERE status = 'running')`
  ).run();
}

/** Deletes a source and everything stored for it (documents, passages, FTS rows, runs, locks). */
export function deleteSourceData(
  db: DatabaseSync,
  sourceId: string
): { documents: number; passages: number } {
  const documents = documentCount(db, sourceId);
  const passages = passageCount(db, sourceId);
  db.exec('BEGIN IMMEDIATE');
  try {
    const runIds = db.prepare('SELECT id FROM sync_runs WHERE source_id = ?').all(sourceId) as Array<{
      id: number;
    }>;
    for (const { id } of runIds) db.prepare('DELETE FROM staged_items WHERE run_id = ?').run(id);
    db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId); // Cascades to documents/passages/FTS
    db.prepare('DELETE FROM documents WHERE source_id = ?').run(sourceId); // In case the source row was missing
    db.prepare('DELETE FROM sync_runs WHERE source_id = ?').run(sourceId);
    db.prepare('DELETE FROM sync_locks WHERE source_id = ?').run(sourceId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { documents, passages };
}
