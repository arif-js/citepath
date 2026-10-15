import { describe, expect, it } from 'vitest';
import type { SyncProgress } from '../../src/core/sync.js';
import { createSyncProgress, describeProgress } from '../../src/interfaces/cli/progress.js';

function progress(processed: number, overrides: Partial<SyncProgress> = {}): SyncProgress {
  return {
    source_id: 'docs',
    phase: 'fetching',
    items: { document: processed, unchanged: 0, gone: 0, excluded: 0, failed: 0 },
    processed,
    location: `https://example.test/page-${processed}`,
    ...overrides,
  };
}

describe('sync progress', () => {
  it('describes discovery, fetching with failures, and applying', () => {
    expect(describeProgress(progress(0))).toBe('docs: discovering pages...');
    expect(
      describeProgress(progress(7, { items: { document: 3, unchanged: 1, gone: 1, excluded: 0, failed: 2 } }))
    ).toBe('docs: 7 items (4 ok, 2 failed, 1 gone)');
    expect(describeProgress(progress(7, { phase: 'applying' }))).toBe(
      'docs: 7 items fetched, writing to the index...'
    );
  });

  it('prints a plain line every N items and when applying starts', () => {
    const out: string[] = [];
    const reporter = createSyncProgress('docs', {
      stderr: (t) => out.push(t),
      interactive: false,
      everyItems: 2,
      now: () => 0,
    });
    for (let i = 1; i <= 5; i++) reporter.update(progress(i));
    reporter.update(progress(5, { phase: 'applying', location: undefined }));
    reporter.done();
    expect(out).toEqual([
      '  docs: 2 items (2 ok) [0s]\n',
      '  docs: 4 items (4 ok) [0s]\n',
      '  docs: 5 items fetched, writing to the index... [0s]\n',
    ]);
  });

  it('redraws one line in a terminal, keeps it within the width, and erases it when done', () => {
    const out: string[] = [];
    let clock = 0;
    const reporter = createSyncProgress('docs', {
      stderr: (t) => out.push(t),
      interactive: true,
      columns: 40,
      now: () => clock,
    });
    expect(out).toEqual(['\r\x1b[K  docs: discovering pages... [0s]']);
    reporter.update(progress(1));
    expect(out).toHaveLength(1); // throttled: no time has passed
    clock = 65_000;
    reporter.update(progress(2));
    const line = out.at(-1)!;
    expect(line.startsWith('\r\x1b[K  docs: 2 items (2 ok) [1m 05s]')).toBe(true);
    expect(line.length - '\r\x1b[K'.length).toBeLessThanOrEqual(39);
    reporter.clear();
    expect(out.at(-1)).toBe('\r\x1b[K');
    reporter.done();
    expect(out.at(-1)).toBe('\r\x1b[K'); // already cleared: nothing more to erase
  });
});
