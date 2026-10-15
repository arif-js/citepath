import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '../../src/config/load.js';
import { search } from '../../src/core/retrieval.js';
import { syncSource } from '../../src/core/sync.js';
import { openIndex } from '../../src/store/db.js';
import { documentFamily, versionFolder } from '../../src/utils/versions.js';
import { makeTempDir, VERSIONED_FIXTURE } from '../helpers.js';

describe('documentFamily', () => {
  it('gives every version of a page the same key and marks the current copy', () => {
    const current = documentFamily('s', 'https://example.test/docs/app/guide');
    for (const versioned of [
      'https://example.test/docs/15/app/guide',
      'https://example.test/docs/v2/app/guide',
      'https://example.test/docs/1.4/app/guide',
      'https://example.test/docs/2.x/app/guide',
      'https://example.test/docs/v3.1.0/app/guide/',
    ]) {
      expect(documentFamily('s', versioned)).toEqual({ key: current.key, versioned: true });
    }
    expect(current.versioned).toBe(false);
    expect(documentFamily('s', 'https://example.test/docs/latest/app/guide')).toEqual({
      key: current.key,
      versioned: false,
    });
    expect(documentFamily('s', '15/guides/caching.md').key).toBe(
      documentFamily('s', 'guides/caching.md').key
    );
  });

  it('finds the old-version folder of a location', () => {
    expect(versionFolder('https://example.test/docs/15/app/guide')).toBe('/docs/15/');
    expect(versionFolder('https://example.test/v2.1/guide')).toBe('/v2.1/');
    expect(versionFolder('15/guides/caching.md')).toBe('15/');
    expect(versionFolder('https://example.test/docs/app/guide')).toBeUndefined();
    expect(versionFolder('https://example.test/docs/latest/guide')).toBeUndefined();
    expect(versionFolder('https://example.test/errors/404')).toBeUndefined();
  });

  it('keeps pages apart when the differing segment is not a version', () => {
    const key = (location: string) => documentFamily('s', location).key;
    expect(key('https://example.test/errors/404')).not.toBe(key('https://example.test/errors/500'));
    expect(key('https://example.test/blog/2024/post')).not.toBe(key('https://example.test/blog/2023/post'));
    expect(key('https://example.test/docs/app/guide')).not.toBe(key('https://example.test/docs/pages/guide'));
    expect(key('https://a.test/docs/guide')).not.toBe(key('https://b.test/docs/guide'));
    expect(documentFamily('a', 'guides/caching.md').key).not.toBe(
      documentFamily('b', 'guides/caching.md').key
    );
  });
});

describe('Search across documentation versions', () => {
  let tmp: string;
  let db: DatabaseSync;
  let loaded: LoadedConfig;
  let warnings: string[];
  const ctx = () => ({ db, loaded });
  const paths = (query: string, extra: { path_prefix?: string; limit?: number } = {}) =>
    search(ctx(), { query, limit: 10, ...extra }).results.map((r) => `${r.path} > ${r.heading_path.at(-1)}`);

  beforeAll(async () => {
    tmp = makeTempDir();
    loaded = {
      config: { sources: [{ id: 'versioned', type: 'local', path: VERSIONED_FIXTURE }] },
      configPath: path.join(tmp, 'config.json'),
      configDir: tmp,
      exists: true,
      dataDir: path.join(tmp, 'data'),
    };
    db = openIndex(loaded.dataDir);
    ({ warnings } = await syncSource(db, loaded, loaded.config.sources[0]!));
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('warns after sync when many documents are old versions, and suggests excludes', () => {
    expect(warnings).toEqual([
      '3 of 6 documents are in older documentation versions (15/: 2, v14/: 1). Search shows the current ' +
        'copy of each page, but to leave old versions out of the index add "exclude": ["15/**", "v14/**"] ' +
        'to this source in the config.',
    ]);
  });

  it('drops old versions and the warning once the suggested excludes are added', async () => {
    const source = {
      id: 'current-only',
      type: 'local' as const,
      path: VERSIONED_FIXTURE,
      exclude: ['15/**', 'v14/**'],
    };
    const summary = await syncSource(db, { ...loaded, config: { sources: [source] } }, source);
    expect(summary.warnings).toEqual([]);
    expect(summary.counts.documents_total).toBe(3);
  });

  it('returns one copy of each section, preferring the current version', () => {
    const results = paths('set the cache lifetime');
    const caching = results.filter((r) => r.endsWith('caching.md > Set the cache lifetime'));
    expect(caching).toEqual(['guides/caching.md > Set the cache lifetime']);
    // Pages that exist in only one version, and pages that merely share a heading, still appear.
    expect(results).toContain('15/guides/legacy-cache.md > Set the cache lifetime with unstable_cache');
    expect(results).toContain('errors/404.md > Cache lifetime of error pages');
    expect(results).toContain('errors/500.md > Cache lifetime of error pages');
  });

  it('counts every version of a page toward the per-document cap', () => {
    const results = search(ctx(), { query: 'cache', limit: 25 }).results;
    const caching = results.filter((r) => r.path!.endsWith('guides/caching.md'));
    expect(caching.length).toBeLessThanOrEqual(2);
    expect(new Set(caching.map((r) => r.path))).toEqual(new Set(['guides/caching.md']));
  });

  it('keeps scores in decreasing order and the output deterministic', () => {
    const first = search(ctx(), { query: 'cache entry lifetime', limit: 10 });
    const scores = first.results.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(search(ctx(), { query: 'cache entry lifetime', limit: 10 })).toEqual(first);
  });

  it('lists older versions that also matched, as ready-to-use path prefixes', () => {
    const response = search(ctx(), { query: 'set the cache lifetime', limit: 5 });
    expect(response.other_versions.map((v) => v.path_prefix)).toEqual(['15/', 'v14/']);
    const counts = response.other_versions.map((v) => v.matches);
    expect(counts.every((n) => n > 0)).toBe(true);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));

    // Each prefix narrows the search to that version.
    for (const { path_prefix } of response.other_versions) {
      const narrowed = search(ctx(), { query: 'set the cache lifetime', limit: 5, path_prefix });
      expect(narrowed.results.length).toBeGreaterThan(0);
      expect(narrowed.results.every((r) => r.path!.startsWith(path_prefix))).toBe(true);
      // The folder the search is narrowed to is not suggested again.
      expect(narrowed.other_versions).toEqual([]);
    }
  });

  it('still returns an older version when the search is narrowed to it', () => {
    expect(paths('set the cache lifetime', { path_prefix: '15/' })).toContain(
      '15/guides/caching.md > Set the cache lifetime'
    );
    const v14 = paths('clear the cache', { path_prefix: 'v14/' });
    expect(v14[0]).toBe('v14/guides/caching.md > Clear the cache');
    expect(v14.every((r) => r.startsWith('v14/'))).toBe(true);
  });
});
