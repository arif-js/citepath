import { describe, expect, it } from 'vitest';
import { chunkBlocks } from '../../src/indexing/chunker.js';
import { parseHtml } from '../../src/indexing/html.js';

const PAGE = `<!doctype html>
<html><head>
  <title>Auth Guide</title>
  <link rel="canonical" href="/docs/auth">
  <meta name="description" content="How to authenticate">
  <script>window.tracking = "should not appear";</script>
  <style>.x { color: red }</style>
</head>
<body>
  <header><a href="/">Home</a> <a href="/docs/install">Install</a></header>
  <nav><a href="/docs/api">API</a> Sidebar link text</nav>
  <div class="cookie-banner">We use cookies</div>
  <main>
    <h1 id="authentication">Authentication <a href="#authentication">#</a></h1>
    <p>Set the <code>AUTH_TOKEN</code> variable before calling <code>getUserName()</code>.</p>
    <section id="tokens"><h2>Tokens</h2>
      <pre><code class="language-bash">export AUTH_TOKEN=abc
citepath sync   --force</code></pre>
      <ul><li>Read scope<ul><li>nested item</li></ul></li><li>Write scope</li></ul>
      <table><tr><th>Name</th><th>Type</th></tr><tr><td>token</td><td>string</td></tr></table>
      <p hidden>Hidden text</p>
      <p style="display: none">Also hidden</p>
    </section>
    <aside>Related articles</aside>
    <footer>Edit this page on GitHub</footer>
  </main>
  <footer>Copyright</footer>
</body></html>`;

describe('HTML extraction', () => {
  const doc = parseHtml(PAGE, 'https://docs.example.com/docs/auth.html');
  const allText = doc.blocks.map((b) => b.text).join('\n');

  it('extracts title, canonical URL, description, and discovery links', () => {
    expect(doc.title).toBe('Auth Guide');
    expect(doc.canonicalUrl).toBe('https://docs.example.com/docs/auth');
    expect(doc.metadata.description).toBe('How to authenticate');
    expect(doc.links).toEqual(
      expect.arrayContaining([
        'https://docs.example.com/',
        'https://docs.example.com/docs/install',
        'https://docs.example.com/docs/api',
      ])
    );
  });

  it('keeps main content and removes scripts, navigation, boilerplate, and hidden elements', () => {
    expect(allText).toContain('Set the `AUTH_TOKEN` variable');
    for (const unwanted of [
      'should not appear',
      'Sidebar link text',
      'We use cookies',
      'Related articles',
      'Edit this page',
      'Copyright',
      'Hidden text',
      'Also hidden',
    ]) {
      expect(allText).not.toContain(unwanted);
    }
  });

  it('keeps code verbatim with its language and formats lists and tables', () => {
    expect(allText).toContain('```bash\nexport AUTH_TOKEN=abc\ncitepath sync   --force\n```');
    expect(allText).toContain('- Read scope\n  - nested item\n- Write scope');
    expect(allText).toContain('| Name | Type |\n| token | string |');
  });

  it('uses heading ids (or the enclosing section id) as anchors and strips permalink symbols', () => {
    const headings = doc.blocks.filter((b) => b.kind === 'heading');
    expect(headings.map((h) => [h.headingText, h.anchor])).toEqual([
      ['Authentication', 'authentication'],
      ['Tokens', 'tokens'],
    ]);
  });

  it('chunks into heading sections with breadcrumbs', () => {
    const chunks = chunkBlocks(doc.blocks);
    expect(chunks.map((c) => c.headingPath)).toEqual([['Authentication'], ['Authentication', 'Tokens']]);
    expect(chunks[1]!.anchor).toBe('tokens');
  });

  it('detects noindex and falls back to <body> when there is no main region', () => {
    const page = parseHtml(
      '<html><head><meta name="robots" content="noindex, follow"></head><body><header>Site</header><h1>Hello</h1><p>World text.</p></body></html>',
      'https://x.test/a'
    );
    expect(page.noindex).toBe(true);
    expect(page.title).toBe('Hello');
    expect(page.blocks.map((b) => b.text)).toEqual(['# Hello', 'World text.']);
  });

  it('honors a per-source content selector', () => {
    const page = parseHtml(
      '<body><div class="doc-body"><p>Real content</p></div><div class="promo"><p>Promo</p></div></body>',
      'https://x.test/',
      { contentSelector: '.doc-body' }
    );
    expect(page.blocks.map((b) => b.text)).toEqual(['Real content']);
  });

  it('reports near-empty JavaScript-rendered pages through textLength', () => {
    const page = parseHtml(
      '<body><div id="root"></div><script src="/app.js"></script></body>',
      'https://x.test/'
    );
    expect(page.textLength).toBe(0);
  });

  it('finds section anchors in Sphinx-style markup with empty anchor targets before the heading', () => {
    const page = parseHtml(
      `<main>
        <section id="list-comprehensions"><span id="tut-listcomps"></span>
          <h3>List Comprehensions<a class="headerlink" href="#list-comprehensions">¶</a></h3>
          <p>List comprehensions provide a concise way to create lists.</p>
        </section>
        <a id="legacy-anchor"></a><h2>Legacy</h2><p>Old content.</p>
      </main>`,
      'https://docs.example.com/tutorial/'
    );
    const headings = page.blocks.filter((b) => b.kind === 'heading');
    expect(headings.map((h) => [h.headingText, h.anchor])).toEqual([
      ['List Comprehensions', 'list-comprehensions'],
      ['Legacy', 'legacy-anchor'],
    ]);
  });
});
