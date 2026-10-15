import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AdapterContext, ItemOutcome, KnownDocument, SourceAdapter } from '../src/sources/adapter.js';
import { silentLogger } from '../src/utils/logger.js';

export const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
export const DOCS_FIXTURE = path.join(FIXTURES_DIR, 'docs');
export const VERSIONED_FIXTURE = path.join(FIXTURES_DIR, 'versioned');

export function makeTempDir(prefix = 'citepath-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function copyDir(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
}

export function adapterContext(known: Record<string, KnownDocument> = {}): AdapterContext {
  return { logger: silentLogger, lookup: (key) => known[key] };
}

export async function collect(adapter: SourceAdapter, context = adapterContext()): Promise<ItemOutcome[]> {
  const outcomes: ItemOutcome[] = [];
  for await (const outcome of adapter.run(context)) outcomes.push(outcome);
  return outcomes;
}

export function byKind<K extends ItemOutcome['kind']>(outcomes: ItemOutcome[], kind: K) {
  return outcomes.filter((o): o is Extract<ItemOutcome, { kind: K }> => o.kind === kind);
}

/** True when the OS lets this process create symlinks (Windows needs developer mode or admin). */
export function canSymlink(dir: string): boolean {
  const target = path.join(dir, '.symlink-probe-target');
  const link = path.join(dir, '.symlink-probe-link');
  try {
    fs.writeFileSync(target, 'x');
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(link, { force: true });
    fs.rmSync(target, { force: true });
  }
}
