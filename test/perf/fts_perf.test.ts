/**
 * Benchmark (`npm run bench`, not part of `npm test`): the real pipeline at the plan's
 * target size. 10,000 Markdown files with 10 sections each (~100,000 passages) are synced
 * through syncSource, then queried through the same search() used by every interface.
 * Target (docs/design.md "Performance targets"): p95 < 250 ms on a warm index.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoadedConfig } from '../../src/config/load.js';
import { search } from '../../src/core/retrieval.js';
import { syncSource } from '../../src/core/sync.js';
import { openIndex } from '../../src/store/db.js';

const FILES = 10_000;
const SECTIONS = 10;

const SUBSYSTEMS = [
  'auth',
  'billing',
  'storage',
  'network',
  'search',
  'queue',
  'cache',
  'metrics',
  'deploy',
  'logging',
];
const VERBS = [
  'configure',
  'rotate',
  'enable',
  'disable',
  'migrate',
  'inspect',
  'restore',
  'validate',
  'tune',
  'scale',
];
const NOUNS = [
  'tokens',
  'buckets',
  'replicas',
  'shards',
  'webhooks',
  'quotas',
  'policies',
  'regions',
  'indexes',
  'workers',
];

function word(seed: number, list: string[]): string {
  return list[seed % list.length]!;
}

function makeFile(i: number): string {
  const sections: string[] = [`# ${word(i, SUBSYSTEMS)} guide ${i}`];
  for (let s = 0; s < SECTIONS; s++) {
    const seed = i * SECTIONS + s;
    const subsystem = word(seed, SUBSYSTEMS);
    const ident = `${word(seed, VERBS)}${word(seed >> 3, NOUNS).replace(/^./, (c) => c.toUpperCase())}${seed % 97}`;
    sections.push(
      `## ${word(seed, VERBS)} ${word(seed >> 2, NOUNS)} (${subsystem})`,
      `To ${word(seed, VERBS)} ${word(seed >> 2, NOUNS)} in the ${subsystem} service, call \`${ident}()\` ` +
        `with the \`${subsystem}_${word(seed >> 4, NOUNS)}_id\` option. Error E_${subsystem.toUpperCase()}_${seed % 50} ` +
        `means the ${word(seed >> 5, NOUNS)} limit was reached; retry with --${word(seed >> 6, VERBS)}-${word(seed, NOUNS)}. ` +
        `Document ${i} section ${s} unique marker token${seed}.`
    );
  }
  return sections.join('\n\n');
}

describe('Benchmark: 100,000 passages through the real pipeline', () => {
  it('syncs and answers queries within the non-functional targets', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'citepath-bench-'));
    const root = path.join(tmp, 'docs');
    for (let i = 0; i < FILES; i++) {
      const dir = path.join(root, `area${i % 100}`);
      if (i < 100) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `page${i}.md`), makeFile(i));
    }

    const loaded: LoadedConfig = {
      config: { sources: [{ id: 'bench', type: 'local', path: root }] },
      configPath: path.join(tmp, 'config.json'),
      configDir: tmp,
      exists: true,
      dataDir: path.join(tmp, 'data'),
    };
    const db = openIndex(loaded.dataDir);

    const memBefore = process.memoryUsage().rss;
    const syncStart = performance.now();
    const summary = await syncSource(db, loaded, loaded.config.sources[0]!);
    const syncSeconds = (performance.now() - syncStart) / 1000;
    const passages = (db.prepare('SELECT count(*) AS c FROM passages').get() as { c: number }).c;
    const dbBytes = fs.statSync(path.join(loaded.dataDir, 'index.db')).size;
    console.log(
      `sync: ${summary.counts.added} documents, ${passages} passages in ${syncSeconds.toFixed(1)}s ` +
        `(${Math.round(passages / syncSeconds)} passages/s), index ${(dbBytes / 1024 / 1024).toFixed(1)} MB, ` +
        `RSS +${Math.round((process.memoryUsage().rss - memBefore) / 1024 / 1024)} MB`
    );
    expect(passages).toBeGreaterThanOrEqual(100_000);

    const queries = [
      'how do I rotate tokens in the auth service',
      'configureBuckets12',
      'E_STORAGE_7',
      '--enable-replicas',
      'billing_quotas_id',
      'migrate shards network',
      'token12345',
      'what does the cache limit error mean',
      'scale workers deploy',
      'restore policies',
    ];
    const ctx = { db, loaded };
    for (const q of queries) search(ctx, { query: q, limit: 10 }); // Warm-up

    const latencies: number[] = [];
    for (let i = 0; i < 200; i++) {
      const query = queries[i % queries.length]!;
      const start = performance.now();
      const response = search(ctx, { query, limit: 10, path_prefix: i % 4 === 0 ? 'area1' : undefined });
      latencies.push(performance.now() - start);
      if (i % 4 !== 0) expect(response.results.length).toBeGreaterThan(0);
    }
    latencies.sort((a, b) => a - b);
    const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]!;
    console.log(
      `search: p50 ${pct(0.5).toFixed(1)} ms, p95 ${pct(0.95).toFixed(1)} ms, p99 ${pct(0.99).toFixed(1)} ms`
    );
    expect(pct(0.95)).toBeLessThan(250);

    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 600_000);
});
