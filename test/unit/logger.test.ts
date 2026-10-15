import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/utils/logger.js';

describe('Logger', () => {
  it('filters by level and formats fields', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', write: (line) => lines.push(line) });
    log.debug('hidden');
    log.info('fetched', { url: 'https://example.com/a b', status: 200 });
    log.error('failed');
    expect(lines).toEqual([
      '[citepath] info: fetched url="https://example.com/a b" status=200',
      '[citepath] error: failed',
    ]);
  });

  it('writes nothing when silent', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'silent', write: (line) => lines.push(line) });
    log.error('x');
    expect(lines).toEqual([]);
  });
});
