/**
 * Retrieval quality gate for the fixture corpus (`npm run eval:fixtures`, run in CI).
 * Retrieval changes must keep these numbers at or above the thresholds; report before/after
 * values in the change description (AGENTS.md, Testing).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '../../src/config/load.js';
import { readEvalFile, runEvaluation } from '../../src/core/eval.js';
import { syncSource } from '../../src/core/sync.js';
import { openIndex } from '../../src/store/db.js';
import { DOCS_FIXTURE, makeTempDir } from '../helpers.js';

const MIN_RECALL = 1.0;
const MIN_MRR = 0.9;

describe('Fixture corpus evaluation', () => {
  let tmp: string;
  let loaded: LoadedConfig;
  let db: ReturnType<typeof openIndex>;

  beforeAll(async () => {
    tmp = makeTempDir('citepath-eval-');
    loaded = {
      config: { sources: [{ id: 'nimbus', type: 'local', path: DOCS_FIXTURE }] },
      configPath: path.join(tmp, 'config.json'),
      configDir: tmp,
      exists: true,
      dataDir: path.join(tmp, 'data'),
    };
    db = openIndex(loaded.dataDir);
    await syncSource(db, loaded, loaded.config.sources[0]!);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it(`meets recall@5 >= ${MIN_RECALL} and MRR >= ${MIN_MRR}`, () => {
    const report = runEvaluation({ db, loaded }, readEvalFile(path.join(__dirname, 'fixtures.eval.json')));
    const misses = report.results
      .filter((r) => !r.hit)
      .map((r) => `${r.id}: ${r.retrieved.map((x) => x.citation_url).join(', ')}`);
    process.stderr.write(
      `eval: recall@${report.k}=${report.recall_at_k} hit_rate=${report.hit_rate} mrr=${report.mrr}\n`
    );
    expect(misses).toEqual([]);
    expect(report.not_in_index).toBe(0);
    expect(report.recall_at_k).toBeGreaterThanOrEqual(MIN_RECALL);
    expect(report.mrr).toBeGreaterThanOrEqual(MIN_MRR);
  });
});
