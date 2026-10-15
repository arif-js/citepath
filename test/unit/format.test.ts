import { describe, expect, it } from 'vitest';
import { formatPassage } from '../../src/interfaces/format.js';
import type { PassageResult } from '../../src/types/index.js';

function passage(title: string, heading_path: string[]): PassageResult {
  return {
    id: 'p1',
    source_id: 'docs',
    source_name: 'Docs',
    title,
    heading_path,
    citation_url: 'https://example.test/page#usage',
    text: 'Body text.',
    score: 1,
    content_hash: 'h',
    fetched_at: '2026-01-01T00:00:00.000Z',
    untrusted: true,
  };
}

describe('formatPassage', () => {
  it('does not repeat the title when it is also the top heading', () => {
    expect(formatPassage(passage('cacheLife', ['cacheLife', 'Usage']), 1).split('\n')[0]).toBe(
      '[1] cacheLife › Usage'
    );
    expect(formatPassage(passage('cacheLife', ['CacheLife ']), 1).split('\n')[0]).toBe('[1] cacheLife');
  });

  it('keeps every heading when the top heading differs from the title', () => {
    expect(formatPassage(passage('Caching guide', ['Overview', 'Usage'])).split('\n')[0]).toBe(
      'Caching guide › Overview › Usage'
    );
    expect(formatPassage(passage('Notes', [])).split('\n')[0]).toBe('Notes');
  });
});
