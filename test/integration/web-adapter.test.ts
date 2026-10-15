import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSourceConfig } from '../../src/config/schema.js';
import { WebSourceAdapter } from '../../src/sources/web/adapter.js';
import { USER_AGENT } from '../../src/version.js';
import { FixtureServer } from '../fixtures/server.js';
import { adapterContext, byKind, collect } from '../helpers.js';

describe('Website adapter', () => {
  let server: FixtureServer;
  let origin: string;

  beforeEach(async () => {
    server = new FixtureServer();
    origin = await server.start();
    server.set('/docs/legacy', { status: 301, headers: { Location: '/docs/auth.html' } });
  });

  afterEach(async () => {
    await server.close();
  });

  const source = (overrides: Partial<WebSourceConfig> = {}): WebSourceConfig => ({
    id: 'site',
    type: 'web',
    url: `${origin}/docs/`,
    allow_private_network: true,
    requests_per_second: 50,
    ...overrides,
  });
  const adapterFor = (overrides: Partial<WebSourceConfig> = {}) =>
    new WebSourceAdapter(source(overrides), { retryBaseDelayMs: 10 });
  const loc = (p: string) => `${origin}${p}`;

  describe('sitemap discovery', () => {
    it('uses the sitemap index from robots.txt, filters scope, and merges canonical duplicates', async () => {
      const adapter = adapterFor();
      const outcomes = await collect(adapter);
      const docs = byKind(outcomes, 'document');

      expect(docs.map((d) => d.location).sort()).toEqual(
        [loc('/docs'), loc('/docs/api.html'), loc('/docs/auth.html'), loc('/docs/install.html')].sort()
      );
      // setup.html declares install.html as canonical: it becomes an alias, not a second document.
      const alias = byKind(outcomes, 'excluded').find((e) => e.location === loc('/docs/setup.html'));
      expect(alias?.aliasOf).toBe(loc('/docs/install.html'));
      // The blog is in the sitemap but outside the /docs/ scope.
      expect(outcomes.some((o) => o.location.includes('/blog/'))).toBe(false);
      // The missing gzipped sitemap (404) does not make discovery incomplete.
      expect(adapter.discovery).toEqual({ complete: true, reasons: [] });
      // No link-following in sitemap mode.
      expect(server.requestsFor('/docs/guide/deep.html')).toHaveLength(0);
    });

    it('reads gzipped sitemaps', async () => {
      const xml = `<?xml version="1.0"?><urlset><url><loc>${origin}/docs/guide/deep.html</loc></url></urlset>`;
      server.set('/sitemap-extra.xml.gz', {
        status: 200,
        headers: { 'Content-Type': 'application/gzip' },
        body: zlib.gzipSync(xml),
      });
      const docs = byKind(await collect(adapterFor()), 'document');
      expect(docs.map((d) => d.location)).toContain(loc('/docs/guide/deep.html'));
    });

    it('marks discovery incomplete when an explicit sitemap cannot be fetched', async () => {
      server.setStatus('/sitemap-docs.xml', 503);
      const adapter = adapterFor({ discovery: 'sitemap' });
      await collect(adapter);
      expect(adapter.discovery.complete).toBe(false);
      expect(adapter.discovery.reasons.join(' ')).toMatch(/sitemap-docs\.xml failed/);
    });
  });

  describe('link crawling', () => {
    it('follows in-scope links and classifies every edge case', async () => {
      const adapter = adapterFor({ discovery: 'crawl' });
      const outcomes = await collect(adapter);
      const docs = byKind(outcomes, 'document');
      const excluded = byKind(outcomes, 'excluded');
      const failed = byKind(outcomes, 'failed');
      const find = <T extends { location: string }>(list: T[], p: string) =>
        list.find((o) => o.location === loc(p));

      expect(docs.map((d) => d.location).sort()).toEqual(
        [
          '/docs',
          '/docs/api.html',
          '/docs/auth.html',
          '/docs/guide/deep.html',
          '/docs/guide/deeper.html',
          '/docs/injection.html',
          '/docs/install.html',
        ]
          .map(loc)
          .sort()
      );
      expect(find(excluded, '/docs/legacy')?.aliasOf).toBe(loc('/docs/auth.html'));
      expect(find(excluded, '/docs/setup.html')?.aliasOf).toBe(loc('/docs/install.html'));
      expect(find(excluded, '/docs/noindex.html')?.reason).toMatch(/noindex/);
      expect(find(excluded, '/docs/private/secret.html')?.reason).toMatch(/robots/);
      expect(find(failed, '/docs/js-app.html')?.reason).toMatch(/JavaScript/);
      expect(find(failed, '/docs/soft-404.html')?.reason).toMatch(/soft 404/);
      expect(find(failed, '/docs/manual.pdf')?.reason).toMatch(/unsupported content type/);
      expect(server.requestsFor('/docs/private/secret.html')).toHaveLength(0);
      expect(server.requests.some((r) => r.path.startsWith('/blog'))).toBe(false);
      expect(adapter.discovery.complete).toBe(true);
    });

    it('extracts clean passages with anchors and canonical URLs', async () => {
      const docs = byKind(await collect(adapterFor({ discovery: 'crawl' })), 'document');
      const api = docs.find((d) => d.location === loc('/docs/api.html'))!;
      expect(api.url).toBe(loc('/docs/api.html'));
      const text = api.document.passages.map((p) => p.text).join('\n');
      expect(text).toContain('client.getUserName(event.user_profile_id)');
      expect(text).not.toContain('tracking-snippet');
      expect(text).not.toContain('uses cookies');
      expect(api.document.passages.map((p) => p.anchor)).toEqual(['api', 'get-user-name', 'errors']);
      const install = docs.find((d) => d.location === loc('/docs/install.html'))!;
      expect(install.alternateUrls).toEqual([]);
    });

    it('indexes pages served as Markdown and follows their links', async () => {
      server.set('/md/', {
        status: 200,
        headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        body: '# Upgrading to version 16\n\n## Breaking changes\n\nThe `middleware` file is now called `proxy`. See [caching](./caching) and [outside](https://elsewhere.test/x).\n',
      });
      server.set('/md/caching', {
        status: 200,
        headers: { 'Content-Type': 'text/x-markdown' },
        body: '# Caching\n\n## Cache lifetime\n\nCall `cacheLife` inside a `use cache` function to set the cache lifetime.\n',
      });
      const outcomes = await collect(adapterFor({ url: `${origin}/md/`, discovery: 'crawl' }));
      const docs = byKind(outcomes, 'document');
      expect(docs.map((d) => d.location).sort()).toEqual([loc('/md'), loc('/md/caching')]);
      const upgrade = docs.find((d) => d.location === loc('/md'))!;
      expect(upgrade.document.title).toBe('Upgrading to version 16');
      // The H1 has no text of its own, so the first passage is its subsection.
      expect(upgrade.document.passages.map((p) => p.anchor)).toEqual(['breaking-changes']);
      expect(upgrade.document.passages[0]!.headingPath).toEqual([
        'Upgrading to version 16',
        'Breaking changes',
      ]);
      expect(upgrade.document.passages.map((p) => p.text).join('\n')).toContain('now called `proxy`');
      expect(byKind(outcomes, 'failed')).toEqual([]);
      expect(server.requestsFor('/md/caching')).toHaveLength(1);
    });

    it('stops at max_depth and max_pages and reports incomplete discovery', async () => {
      const shallow = adapterFor({ discovery: 'crawl', max_depth: 2 });
      const docs = byKind(await collect(shallow), 'document').map((d) => d.location);
      expect(docs).toContain(loc('/docs/guide/deep.html'));
      expect(docs).not.toContain(loc('/docs/guide/deeper.html'));
      expect(shallow.discovery.complete).toBe(false);
      expect(shallow.discovery.reasons.join(' ')).toMatch(/max_depth/);

      const small = adapterFor({ discovery: 'crawl', max_pages: 3 });
      await collect(small);
      expect(small.discovery.complete).toBe(false);
      expect(small.discovery.reasons.join(' ')).toMatch(/max_pages/);
    });

    it('marks discovery incomplete when a page fails, so unseen documents are not removed', async () => {
      server.setStatus('/docs/api.html', 500);
      const adapter = adapterFor({ discovery: 'crawl' });
      const outcomes = await collect(adapter);
      const failure = byKind(outcomes, 'failed').find((f) => f.location === loc('/docs/api.html'));
      expect(failure?.classification).toBe('transient');
      expect(server.requestsFor('/docs/api.html')).toHaveLength(3); // 1 try + 2 retries
      expect(adapter.discovery.complete).toBe(false);
    });

    it('reports 404 and 410 as gone', async () => {
      server.setStatus('/docs/auth.html', 410);
      server.remove('/docs/install.html');
      const outcomes = await collect(adapterFor({ discovery: 'crawl' }));
      const gone = byKind(outcomes, 'gone').map((g) => g.location);
      expect(gone).toEqual(expect.arrayContaining([loc('/docs/auth.html'), loc('/docs/install.html')]));
    });

    it('treats 403 as a failure, never as removal evidence', async () => {
      server.setStatus('/docs/auth.html', 403);
      const outcomes = await collect(adapterFor({ discovery: 'crawl' }));
      expect(
        byKind(outcomes, 'failed').find((f) => f.location === loc('/docs/auth.html'))?.classification
      ).toBe('permanent');
      expect(byKind(outcomes, 'gone')).toHaveLength(0);
    });
  });

  describe('politeness and protocol handling', () => {
    it('sends the Citepath User-Agent', async () => {
      await collect(adapterFor());
      expect(server.requests.every((r) => r.headers['user-agent'] === USER_AGENT)).toBe(true);
    });

    it('crawls nothing when robots.txt returns a server error', async () => {
      server.setStatus('/robots.txt', 503);
      const adapter = adapterFor();
      const outcomes = await collect(adapter);
      expect(outcomes).toEqual([]);
      expect(adapter.discovery.complete).toBe(false);
      expect(server.requests.map((r) => r.path)).toEqual(['/robots.txt']);
    });

    it('allows everything when robots.txt is missing', async () => {
      server.remove('/robots.txt');
      const docs = byKind(await collect(adapterFor({ discovery: 'crawl' })), 'document');
      expect(docs.length).toBeGreaterThan(3);
    });

    it('honors robots.txt crawl-delay', async () => {
      server.set('/robots.txt', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: 'User-agent: *\nCrawl-delay: 0.3\n',
      });
      const xml = `<urlset><url><loc>${origin}/docs/install.html</loc></url><url><loc>${origin}/docs/auth.html</loc></url></urlset>`;
      server.set('/sitemap.xml', { status: 200, headers: { 'Content-Type': 'application/xml' }, body: xml });
      await collect(adapterFor({ concurrency: 4 }));
      const pageTimes = server.requests.filter((r) => r.path.startsWith('/docs/')).map((r) => r.at);
      expect(pageTimes.length).toBe(3);
      for (let i = 1; i < pageTimes.length; i++) {
        expect(pageTimes[i]! - pageTimes[i - 1]!).toBeGreaterThanOrEqual(250);
      }
    });

    it('retries after 429 with Retry-After and then succeeds', async () => {
      let calls = 0;
      server.set('/docs/auth.html', {
        handler: (_req, res) => {
          calls++;
          if (calls === 1) {
            res.writeHead(429, { 'Retry-After': '0' });
            res.end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<main><h1>Authentication</h1><p>Use an API key for every request to the Nimbus service. Keys are created in the dashboard and can be rotated at any time.</p></main>'
          );
        },
      });
      const docs = byKind(await collect(adapterFor()), 'document');
      expect(calls).toBe(2);
      expect(docs.map((d) => d.location)).toContain(loc('/docs/auth.html'));
    });

    it('sends conditional requests and reports 304 as unchanged', async () => {
      server.setHtml(
        '/docs/install.html',
        '<main><h1>Install</h1><p>Install with npm install nimbus-sdk on any supported platform today.</p></main>',
        { etag: '"v1"' }
      );
      const known = {
        [loc('/docs/install.html')]: { location: loc('/docs/install.html'), etag: '"v1"', reusable: true },
      };
      const outcomes = await collect(adapterFor(), adapterContext(known));
      expect(byKind(outcomes, 'unchanged').map((u) => u.location)).toEqual([loc('/docs/install.html')]);
      const request = server.requestsFor('/docs/install.html')[0]!;
      expect(request.headers['if-none-match']).toBe('"v1"');

      // When the parser changed (reusable: false), no conditional headers are sent.
      server.requests.length = 0;
      known[loc('/docs/install.html')]!.reusable = false;
      await collect(adapterFor(), adapterContext(known));
      expect(server.requestsFor('/docs/install.html')[0]!.headers['if-none-match']).toBeUndefined();
    });

    it('decodes windows-1252 pages', async () => {
      server.set('/docs/install.html', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=windows-1252' },
        body: Buffer.from(
          '<main><h1>Caf\xe9 setup</h1><p>Na\xefve configuration of the caf\xe9 SDK for r\xe9sum\xe9 uploads works fine for every region and every account type.</p></main>',
          'latin1'
        ),
      });
      const docs = byKind(await collect(adapterFor()), 'document');
      const install = docs.find((d) => d.location === loc('/docs/install.html'))!;
      expect(install.document.passages[0]!.text).toContain('Naïve configuration of the café SDK');
    });

    it('blocks private addresses unless the source opts in', async () => {
      const adapter = adapterFor({ allow_private_network: false });
      const outcomes = await collect(adapter);
      expect(outcomes).toEqual([]);
      expect(server.requests).toHaveLength(0);
      expect(adapter.discovery.complete).toBe(false);
      expect(adapter.discovery.reasons.join(' ')).toMatch(/SSRF blocked/);
    });
  });
});
