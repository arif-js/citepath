import { describe, expect, it } from 'vitest';
import { formatPassage, formatSearch } from '../../src/interfaces/format.js';
import type { PassageResult, SearchResponse } from '../../src/types/index.js';

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

describe('formatSearch', () => {
  const response = (other_versions: SearchResponse['other_versions']): SearchResponse => ({
    query: 'cache',
    query_truncated: false,
    results: [passage('Caching', ['Caching', 'Usage'])],
    effective_limit: 5,
    filters: {},
    truncated: false,
    other_versions,
    schema_version: 1,
  });

  it('points to older versions that also matched', () => {
    const text = formatSearch(
      response([
        { path_prefix: 'https://example.test/docs/15/', matches: 12 },
        { path_prefix: 'https://example.test/docs/14/', matches: 3 },
      ])
    );
    expect(text.split('\n').at(-1)).toBe(
      'Note: older documentation versions also matched: https://example.test/docs/15/ (12), ' +
        'https://example.test/docs/14/ (3). To search one, pass it as the path prefix (CLI --path-prefix, MCP path_prefix).'
    );
  });

  it('adds no note when no other versions matched', () => {
    expect(formatSearch(response([]))).not.toContain('older documentation versions');
  });
});
