import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '../../src/config/load.js';
import type { LocalSourceConfig } from '../../src/config/schema.js';
import { getPassage, listSources, search } from '../../src/core/retrieval.js';
import { syncSource } from '../../src/core/sync.js';
import { openIndex } from '../../src/store/db.js';
import { NotFoundError, UsageError } from '../../src/utils/errors.js';
import { copyDir, DOCS_FIXTURE, makeTempDir } from '../helpers.js';

describe('Retrieval core', () => {
  let tmp: string;
  let db: DatabaseSync;
  let loaded: LoadedConfig;
  const ctx = () => ({ db, loaded });

  beforeAll(async () => {
    tmp = makeTempDir();
    const root = path.join(tmp, 'docs');
    copyDir(DOCS_FIXTURE, root);
    // A long section to exercise excerpt truncation.
    fs.writeFileSync(
      path.join(root, 'long.md'),
      `# Retention\n\n${'Retention policies keep object versions for a configurable number of days. '.repeat(26)}`
    );
    const source: LocalSourceConfig = {
      id: 'nimbus',
      type: 'local',
      path: root,
      name: 'Nimbus Docs',
      base_url: 'https://github.com/nimbus/docs/blob/main',
    };
    loaded = {
      config: { sources: [source, { id: 'notes', type: 'local', path: path.join(root, 'i18n') }] },
      configPath: path.join(tmp, 'config.json'),
      configDir: tmp,
      exists: true,
      dataDir: path.join(tmp, 'data'),
    };
    db = openIndex(loaded.dataDir);
    for (const s of loaded.config.sources) await syncSource(db, loaded, s);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the result contract with citations, provenance, and untrusted labels', () => {
    const response = search(ctx(), { query: 'getUserName', limit: 1, source_ids: ['nimbus'] });
    expect(response).toMatchObject({
      query: 'getUserName',
      query_truncated: false,
      effective_limit: 1,
      filters: { source_ids: ['nimbus'] },
      truncated: false,
      schema_version: 1,
    });
    const [top] = response.results;
    expect(top).toMatchObject({
      source_id: 'nimbus',
      source_name: 'Nimbus Docs',
      title: 'Client API Reference',
      heading_path: ['Client API Reference', 'client.getUserName(id)'],
      path: 'api/client.md',
      line_start: 13,
      line_end: 20,
      url: 'https://github.com/nimbus/docs/blob/main/api/client.md',
      citation_url: 'https://github.com/nimbus/docs/blob/main/api/client.md#L13-L20',
      untrusted: true,
    });
    expect(top!.id).toMatch(/^[0-9a-f]{64}$/);
    expect(top!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof top!.score).toBe('number');
  });

  it('finds code identifiers, natural-language questions, and German and Japanese text', () => {
    const top = (query: string) =>
      search(ctx(), { query, limit: 1, source_ids: ['nimbus'] }).results[0]?.path;
    expect(top('user_profile_id')).toBe('api/client.md');
    expect(top('E_RATE_LIMITED')).toBeDefined();
    expect(top('--dry-run')).toBe('cli.mdx');
    expect(top('how do I configure authentication')).toBe('getting-started.md');
    expect(top('Größe')).toBe('i18n/de.md');
    expect(top('ユーザー認証')).toBe('i18n/ja.md');
  });

  it('matches English word forms through stemming, without changing identifier search', () => {
    const top = (query: string) =>
      search(ctx(), { query, limit: 1, source_ids: ['nimbus'] }).results[0]?.path;
    // guides/caching.md says "cache", "cached", and "configuration", never "caching" or "configure".
    expect(top('configure caching')).toBe('guides/caching.md');
    expect(top('caches')).toBe('guides/caching.md');
    expect(top('clearing cached responses')).toBe('guides/caching.md');
    // Identifier parts still match as before, also when they look like inflected words.
    expect(top('clearCache')).toBe('guides/caching.md');
    expect(top('cacheTtlSeconds')).toBe('guides/caching.md');
    expect(top('maxRetries')).toBe('api/client.md');
  });

  it('never throws on search-syntax characters and returns empty results for no match', () => {
    for (const query of [
      'AND',
      'NEAR(a, b)',
      '"unterminated',
      '*',
      'a.b.c',
      'foo(',
      '{"x":1}',
      '---',
      '???',
    ]) {
      expect(() => search(ctx(), { query })).not.toThrow();
    }
    expect(search(ctx(), { query: 'zebra-unicorn-xylophone' }).results).toEqual([]);
  });

  it('validates input', () => {
    expect(() => search(ctx(), { query: '   ' })).toThrow(UsageError);
    expect(() => search(ctx(), { query: 'x', limit: 0 })).toThrow(UsageError);
    expect(() => search(ctx(), { query: 'x', source_ids: ['missing'] })).toThrow(/Unknown source "missing"/);
  });

  it('clamps the limit, truncates long queries and long passages, and reports it', () => {
    const big = search(ctx(), { query: 'nimbus', limit: 1000 });
    expect(big.effective_limit).toBe(25);
    expect(big.results.length).toBeLessThanOrEqual(25);

    const longQuery = search(ctx(), { query: `retention ${'x'.repeat(600)}` });
    expect(longQuery.query_truncated).toBe(true);
    expect(longQuery.query.length).toBe(512);

    const retention = search(ctx(), { query: 'retention policies', limit: 1 });
    expect(retention.truncated).toBe(true);
    expect(retention.results[0]!.text.length).toBeLessThanOrEqual(1502);
    expect(retention.results[0]!.text.endsWith('…')).toBe(true);
  });

  it('caps results per document and keeps the response under the size cap', () => {
    const response = search(ctx(), { query: 'pagination cursor ordering guarantee', limit: 25 });
    const perDoc = new Map<string, number>();
    for (const r of response.results) perDoc.set(r.path!, (perDoc.get(r.path!) ?? 0) + 1);
    expect(Math.max(...perDoc.values())).toBeLessThanOrEqual(2);
    expect(Buffer.byteLength(JSON.stringify(response.results))).toBeLessThanOrEqual(32 * 1024 + 2048);
  });

  it('is deterministic', () => {
    const a = search(ctx(), { query: 'options', limit: 10 });
    const b = search(ctx(), { query: 'options', limit: 10 });
    expect(a).toEqual(b);
  });

  it('filters by source and path prefix, matching wildcards literally', () => {
    const notes = search(ctx(), { query: 'Größe', source_ids: ['notes'] });
    expect(notes.results.every((r) => r.source_id === 'notes')).toBe(true);

    const guides = search(ctx(), { query: 'options webhooks pagination', limit: 25, path_prefix: 'guides/' });
    expect(guides.results.length).toBeGreaterThan(0);
    expect(guides.results.every((r) => r.path!.startsWith('guides/'))).toBe(true);
    expect(search(ctx(), { query: 'options', path_prefix: 'g%' }).results).toEqual([]);
  });

  it('returns a passage with neighboring context', () => {
    const hit = search(ctx(), { query: 'Object deleted includeVersions', limit: 1 }).results[0]!;
    const context = getPassage(ctx(), hit.id, 1);
    expect(context.passage.id).toBe(hit.id);
    expect(context.before).toHaveLength(1);
    expect(context.after).toHaveLength(1);
    expect(hit.heading_path).toEqual(['Webhooks', 'Object deleted', 'Options']);
    expect(context.before[0]!.heading_path.at(-1)).toBe('Object deleted');
    expect(context.after[0]!.heading_path.at(-1)).toBe('Verifying signatures');
    expect(() => getPassage(ctx(), 'no-such-id')).toThrow(NotFoundError);
  });

  it('lists sources with counts and flags orphaned index data', () => {
    const before = listSources(ctx());
    expect(before.sources.map((s) => [s.id, s.documents > 0, s.last_sync?.status])).toEqual([
      ['nimbus', true, 'completed'],
      ['notes', true, 'completed'],
    ]);
    const withoutNotes = { ...loaded, config: { sources: loaded.config.sources.slice(0, 1) } };
    const after = listSources({ db, loaded: withoutNotes });
    expect(after.orphaned).toEqual([{ id: 'notes', documents: 2 }]);
    // Orphaned sources are not searchable.
    expect(
      search({ db, loaded: withoutNotes }, { query: 'ユーザー認証' }).results.every(
        (r) => r.source_id === 'nimbus'
      )
    ).toBe(true);
  });

  it('returns prompt-injection text only as labeled data', () => {
    const hit = search(ctx(), { query: 'delete_source admin mode', limit: 1 }).results[0]!;
    expect(hit.path).toBe('security/untrusted.md');
    expect(hit.untrusted).toBe(true);
  });
});
