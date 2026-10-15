import { describe, expect, it } from 'vitest';
import { ftsHeadingPath } from '../../src/indexing/passages.js';

describe('ftsHeadingPath', () => {
  it('drops the top heading when it repeats the page title', () => {
    expect(
      ftsHeadingPath('How to configure CI build caching', ['How to configure CI build caching', 'Netlify'])
    ).toBe('Netlify');
    expect(ftsHeadingPath('Caching ', ['caching'])).toBe('');
  });

  it('keeps every heading when the top heading differs from the title', () => {
    expect(ftsHeadingPath('Guide', ['Overview', 'Install'])).toBe('Overview / Install');
    expect(ftsHeadingPath('Guide', [])).toBe('');
  });
});
