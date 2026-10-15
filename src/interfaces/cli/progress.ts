import type { SyncProgress } from '../../core/sync.js';

/**
 * Sync progress on stderr.
 * - Terminal: one status line, redrawn in place (at most every 100 ms, plus a 1 s tick so the
 *   elapsed time keeps moving while a slow page or robots.txt is being fetched).
 * - Pipe or file: a plain line every `everyItems` items and when applying starts, so logs
 *   stay readable and output is deterministic.
 */

const REDRAW_MS = 100;
const TICK_MS = 1000;
const CLEAR_LINE = '\r\x1b[K';

export interface ProgressOptions {
  stderr: (text: string) => void;
  /** Whether stderr is a terminal. */
  interactive: boolean;
  /** Terminal width, used to keep the status line on one row. */
  columns?: number;
  /** Plain-mode line interval. */
  everyItems?: number;
  now?: () => number;
}

export interface SyncProgressReporter {
  update(progress: SyncProgress): void;
  /** Erases the status line so other output starts on a clean row; the next update redraws it. */
  clear(): void;
  /** Stops the ticker and erases the status line. */
  done(): void;
}

function elapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function describeProgress(p: SyncProgress): string {
  if (p.phase === 'applying') return `${p.source_id}: ${p.processed} items fetched, writing to the index...`;
  if (p.processed === 0) return `${p.source_id}: discovering pages...`;
  const i = p.items;
  const parts = [`${i.document + i.unchanged} ok`];
  if (i.failed > 0) parts.push(`${i.failed} failed`);
  if (i.excluded > 0) parts.push(`${i.excluded} excluded`);
  if (i.gone > 0) parts.push(`${i.gone} gone`);
  return `${p.source_id}: ${p.processed} items (${parts.join(', ')})`;
}

export function createSyncProgress(sourceId: string, options: ProgressOptions): SyncProgressReporter {
  const now = options.now ?? Date.now;
  const started = now();
  let latest: SyncProgress = {
    source_id: sourceId,
    phase: 'fetching',
    items: { document: 0, unchanged: 0, gone: 0, excluded: 0, failed: 0 },
    processed: 0,
  };

  if (!options.interactive) {
    const every = options.everyItems ?? 100;
    return {
      update(p) {
        const phaseChanged = p.phase !== latest.phase;
        latest = p;
        if (phaseChanged || (p.phase === 'fetching' && p.processed % every === 0)) {
          options.stderr(`  ${describeProgress(p)} [${elapsed(now() - started)}]\n`);
        }
      },
      clear() {},
      done() {},
    };
  }

  const columns = Math.max(options.columns ?? 80, 20);
  let shown = false;
  let lastDraw = 0;
  const draw = () => {
    let line = `  ${describeProgress(latest)} [${elapsed(now() - started)}]`;
    if (latest.phase === 'fetching' && latest.location) line += ` ${latest.location}`;
    if (line.length > columns - 1) line = `${line.slice(0, columns - 2)}…`;
    options.stderr(`${CLEAR_LINE}${line}`);
    shown = true;
    lastDraw = now();
  };
  const ticker = setInterval(draw, TICK_MS);
  ticker.unref();
  draw();

  const clear = () => {
    if (shown) options.stderr(CLEAR_LINE);
    shown = false;
  };
  return {
    update(p) {
      const phaseChanged = p.phase !== latest.phase;
      latest = p;
      if (phaseChanged || now() - lastDraw >= REDRAW_MS) draw();
    },
    clear,
    done() {
      clearInterval(ticker);
      clear();
    },
  };
}
