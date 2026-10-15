import { describe, expect, it } from 'vitest';
import { decodeHtmlBytes, decodeLocalText, looksBinary, normalizeText } from '../../src/utils/encoding.js';
import { createScopeMatcher, defaultPathPrefix, escapeLike, normalizeUrl } from '../../src/utils/url.js';

describe('URL normalization', () => {
  it('normalizes case, fragments, default ports, index files, and trailing slashes', () => {
    expect(normalizeUrl('HTTPS://Docs.Example.com:443/Guide/index.html#intro')).toBe(
      'https://docs.example.com/Guide'
    );
    expect(normalizeUrl('https://docs.example.com/guide/')).toBe('https://docs.example.com/guide');
    expect(normalizeUrl('https://docs.example.com/')).toBe('https://docs.example.com/');
    expect(normalizeUrl('https://docs.example.com//a//b')).toBe('https://docs.example.com/a/b');
  });

  it('drops query strings by default, or keeps them sorted without tracking parameters', () => {
    expect(normalizeUrl('https://x.test/a?b=2&a=1')).toBe('https://x.test/a');
    expect(normalizeUrl('https://x.test/a?b=2&utm_source=x&a=1', 'keep')).toBe('https://x.test/a?a=1&b=2');
  });

  it('derives the default crawl scope from the start URL', () => {
    expect(defaultPathPrefix('https://react.dev/reference')).toBe('/reference/');
    expect(defaultPathPrefix('https://x.test/docs/')).toBe('/docs/');
    expect(defaultPathPrefix('https://x.test/docs/intro.html')).toBe('/docs/');
    expect(defaultPathPrefix('https://x.test')).toBe('/');
  });

  it('matches scope by origin, path prefix, and include/exclude globs', () => {
    const inScope = createScopeMatcher({
      origin: 'https://x.test',
      pathPrefix: '/docs/',
      exclude: ['/docs/private/**'],
    });
    expect(inScope('https://x.test/docs')).toBe(true);
    expect(inScope('https://x.test/docs/a/b')).toBe(true);
    expect(inScope('https://x.test/docsearch')).toBe(false);
    expect(inScope('https://x.test/docs/private/key')).toBe(false);
    expect(inScope('https://other.test/docs/a')).toBe(false);

    const onlyApi = createScopeMatcher({ origin: 'https://x.test', pathPrefix: '/', include: ['/api/**'] });
    expect(onlyApi('https://x.test/api/users')).toBe(true);
    expect(onlyApi('https://x.test/guide')).toBe(false);
  });

  it('escapes LIKE wildcards', () => {
    expect(escapeLike('docs/100%_done\\x')).toBe('docs/100\\%\\_done\\\\x');
  });
});

describe('Encoding', () => {
  it('decodes using the Content-Type charset, then <meta charset>, then UTF-8', () => {
    const latin1 = Buffer.from('<p>Caf\xe9 na\xefve</p>', 'latin1');
    expect(decodeHtmlBytes(latin1, 'text/html; charset=windows-1252').text).toBe('<p>Café naïve</p>');

    const withMeta = Buffer.concat([
      Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>', 'latin1'),
      Buffer.from('Gr\xf6\xdfe', 'latin1'),
    ]);
    expect(decodeHtmlBytes(withMeta, 'text/html').text).toContain('Größe');

    expect(decodeHtmlBytes(Buffer.from('ユーザー', 'utf8'), 'text/html').text).toBe('ユーザー');
  });

  it('strips a UTF-8 BOM and falls back to windows-1252 for invalid UTF-8 local files', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Title', 'utf8')]);
    expect(decodeLocalText(bom)).toEqual({ text: '# Title', encoding: 'utf-8', fallback: false });
    const legacy = decodeLocalText(Buffer.from('caf\xe9', 'latin1'));
    expect(legacy).toEqual({ text: 'café', encoding: 'windows-1252', fallback: true });
  });

  it('detects binary content and normalizes text', () => {
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text'))).toBe(false);
    expect(normalizeText('a\r\nb\rc')).toBe('a\nb\nc');
    expect(normalizeText('é')).toBe('é');
  });
});
