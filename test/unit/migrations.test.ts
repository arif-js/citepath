import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexPath, openDatabase, openIndex } from '../../src/store/db.js';
import { getSchemaVersion, LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/store/migrations.js';
import { IndexError } from '../../src/utils/errors.js';

describe('Index schema and migrations', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citepath-db-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates a new index at the latest schema version', () => {
    const db = openIndex(dir);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
    expect(fs.existsSync(indexPath(dir))).toBe(true);
  });

  it('is idempotent when reopened', () => {
    openIndex(dir).close();
    const db = openIndex(dir);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it('refuses an index created by a newer version without modifying it', () => {
    openIndex(dir).close();
    const raw = new DatabaseSync(indexPath(dir));
    raw
      .prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'")
      .run(String(LATEST_SCHEMA_VERSION + 1));
    raw.close();

    expect(() => openIndex(dir)).toThrow(IndexError);
    const check = new DatabaseSync(indexPath(dir));
    const row = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(Number(row.value)).toBe(LATEST_SCHEMA_VERSION + 1);
    check.close();
  });

  it('removes FTS rows when passages are deleted through a cascade', () => {
    const db = openDatabase(':memory:');
    db.prepare(
      "INSERT INTO sources (id, type, config_hash, created_at) VALUES ('s', 'local', 'h', 'now')"
    ).run();
    db.prepare(
      `INSERT INTO documents (id, source_id, location, title, content_hash, parser_version, config_hash, fetched_at)
       VALUES ('d', 's', 'a.md', 'A', 'h', 1, 'h', 'now')`
    ).run();
    db.prepare(
      `INSERT INTO passages (rowid, id, document_id, source_id, ordinal, heading_path_json, text, content_hash, occurrence_index)
       VALUES (1, 'p', 'd', 's', 0, '[]', 'hello world', 'h', 0)`
    ).run();
    db.prepare(
      "INSERT INTO passages_fts (rowid, title, heading_path, text, code_terms) VALUES (1, 'A', '', 'hello world', '')"
    ).run();
    const count = () =>
      (
        db.prepare("SELECT count(*) AS c FROM passages_fts WHERE passages_fts MATCH 'hello'").get() as {
          c: number;
        }
      ).c;
    expect(count()).toBe(1);

    db.prepare("DELETE FROM sources WHERE id = 's'").run();
    expect(count()).toBe(0);
    expect((db.prepare('SELECT count(*) AS c FROM passages').get() as { c: number }).c).toBe(0);
    db.close();
  });

  it('upgrades a v1 index to stemmed search in place, with a backup and unchanged passages', () => {
    // Build an index exactly as version 1 left it: unstemmed FTS rows written by sync.
    const raw = new DatabaseSync(indexPath(dir), { enableForeignKeyConstraints: true });
    raw.exec(MIGRATIONS[0]!.sql);
    raw.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");
    raw.exec("INSERT INTO sources (id, type, config_hash, created_at) VALUES ('s', 'local', 'h', 'now')");
    raw.exec(
      `INSERT INTO documents (id, source_id, location, title, content_hash, parser_version, config_hash, fetched_at)
       VALUES ('d', 's', 'a.md', 'Response cache', 'h', 1, 'h', 'now')`
    );
    const passage = raw.prepare(
      `INSERT INTO passages (rowid, id, document_id, source_id, ordinal, heading_path_json, text, content_hash, occurrence_index)
       VALUES (?, ?, 'd', 's', ?, ?, ?, 'h', 0)`
    );
    const fts = raw.prepare(
      'INSERT INTO passages_fts (rowid, title, heading_path, text, code_terms) VALUES (?, ?, ?, ?, ?)'
    );
    // More rows than one rebuild page, so pagination is exercised.
    const total = 1201;
    raw.exec('BEGIN');
    for (let i = 1; i <= total; i++) {
      const text = i === total ? 'Call clearCache to empty the cache.' : `Filler passage number ${i}.`;
      passage.run(i, `p${i}`, i - 1, JSON.stringify(['Response cache', `Part ${i}`]), text);
      fts.run(i, 'Response cache', `Response cache / Part ${i}`, text, '');
    }
    raw.exec('COMMIT');
    const matches = (db: DatabaseSync, query: string) =>
      (
        db.prepare('SELECT rowid FROM passages_fts WHERE passages_fts MATCH ? ORDER BY rowid').all(query) as {
          rowid: number;
        }[]
      ).map((r) => r.rowid);
    expect(matches(raw, '"caching" AND "empty"')).toEqual([]);
    const idsBefore = raw.prepare('SELECT id, text FROM passages ORDER BY rowid').all();
    raw.close();

    const db = openIndex(dir);
    expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(fs.readdirSync(dir).some((f) => f.includes('.backup-v1-'))).toBe(true);
    expect(db.prepare('SELECT id, text FROM passages ORDER BY rowid').all()).toEqual(idsBefore);
    expect((db.prepare('SELECT count(*) AS c FROM passages_fts').get() as { c: number }).c).toBe(total);
    // Stemmed: "caching" finds a passage that says "cache"; code_terms were rebuilt ("clear" from clearCache).
    expect(matches(db, '"caching" AND "empty"')).toEqual([total]);
    expect(matches(db, 'code_terms : "clear"')).toEqual([total]);
    // The recreated delete trigger still keeps the FTS index in step.
    db.prepare("DELETE FROM sources WHERE id = 's'").run();
    expect((db.prepare('SELECT count(*) AS c FROM passages_fts').get() as { c: number }).c).toBe(0);
    db.close();
  });
});
