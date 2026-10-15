import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SourceUnavailableError } from '../../src/sources/adapter.js';
import { LocalSourceAdapter, mapLocalUrl } from '../../src/sources/local/adapter.js';
import { byKind, canSymlink, collect, copyDir, DOCS_FIXTURE, makeTempDir } from '../helpers.js';

describe('Local directory adapter', () => {
  let tmp: string;
  let root: string;

  beforeEach(() => {
    tmp = makeTempDir();
    root = path.join(tmp, 'docs');
    copyDir(DOCS_FIXTURE, root);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const adapterFor = (overrides: Record<string, unknown> = {}) =>
    new LocalSourceAdapter({ id: 'nimbus', type: 'local', path: root, ...overrides }, { root });

  it('indexes Markdown, MDX, and text files with relative POSIX paths in sorted order', async () => {
    const adapter = adapterFor();
    const docs = byKind(await collect(adapter), 'document');
    expect(docs.map((d) => d.location)).toEqual([
      'api/client.md',
      'cli.mdx',
      'empty.md',
      'getting-started.md',
      'guides/caching.md',
      'guides/pagination.md',
      'guides/webhooks.md',
      'i18n/de.md',
      'i18n/ja.md',
      'notes.txt',
      'security/untrusted.md',
    ]);
    expect(adapter.discovery.complete).toBe(true);

    const started = docs.find((d) => d.location === 'getting-started.md')!;
    expect(started.path).toBe('getting-started.md');
    expect(started.document.title).toBe('Getting Started with Nimbus');
    const auth = started.document.passages.find((p) => p.headingPath.includes('Configure authentication'))!;
    expect(auth.lineStart).toBe(18);
    expect(auth.anchor).toBe('configure-authentication');

    const mdx = docs.find((d) => d.location === 'cli.mdx')!;
    const mdxText = mdx.document.passages.map((p) => p.text).join('\n');
    expect(mdxText).toContain('--dry-run');
    expect(mdxText).not.toContain('import Tabs');
    expect(mdxText).not.toContain('<TabItem');

    expect(docs.find((d) => d.location === 'empty.md')!.document.passages).toEqual([]);
  });

  it('respects default ignores, hidden directories, and nested .gitignore files', async () => {
    fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules/pkg/README.md'), '# Dependency readme');
    fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
    fs.writeFileSync(path.join(root, '.cache/notes.md'), '# Hidden');
    fs.writeFileSync(path.join(root, '.gitignore'), 'drafts/\n*.secret.md\n');
    fs.mkdirSync(path.join(root, 'drafts'));
    fs.writeFileSync(path.join(root, 'drafts/plan.md'), '# Draft');
    fs.writeFileSync(path.join(root, 'keys.secret.md'), '# Secret');
    fs.writeFileSync(path.join(root, 'guides/.gitignore'), 'webhooks.md\n');

    const locations = byKind(await collect(adapterFor()), 'document').map((d) => d.location);
    expect(locations).not.toContain('node_modules/pkg/README.md');
    expect(locations).not.toContain('.cache/notes.md');
    expect(locations).not.toContain('drafts/plan.md');
    expect(locations).not.toContain('keys.secret.md');
    expect(locations).not.toContain('guides/webhooks.md');
    expect(locations).toContain('guides/pagination.md');
  });

  it('applies include and exclude globs and reports scope', async () => {
    const adapter = adapterFor({ include: ['guides/**/*.md', 'api/**'], exclude: ['guides/pagination.md'] });
    const locations = byKind(await collect(adapter), 'document').map((d) => d.location);
    expect(locations).toEqual(['api/client.md', 'guides/caching.md', 'guides/webhooks.md']);
    expect(adapter.isInScope('guides/webhooks.md')).toBe(true);
    expect(adapter.isInScope('guides/pagination.md')).toBe(false);
    expect(adapter.isInScope('getting-started.md')).toBe(false);
  });

  it('skips binary and oversized files as failures (not removals)', async () => {
    fs.writeFileSync(path.join(root, 'image.md'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01]));
    fs.writeFileSync(path.join(root, 'huge.md'), `# Huge\n\n${'x'.repeat(6000)}`);
    const outcomes = await collect(adapterFor({ max_file_bytes: 5000 }));
    const failed = byKind(outcomes, 'failed');
    expect(failed.find((f) => f.location === 'image.md')?.reason).toMatch(/binary/);
    expect(failed.find((f) => f.location === 'huge.md')?.reason).toMatch(/over the 5000-byte limit/);
    expect(failed.every((f) => f.classification === 'permanent')).toBe(true);
  });

  it('decodes invalid UTF-8 as windows-1252 and records the fallback', async () => {
    fs.writeFileSync(
      path.join(root, 'legacy.md'),
      Buffer.from('# Caf\xe9 menu\n\nCr\xe8me br\xfbl\xe9e', 'latin1')
    );
    const legacy = byKind(await collect(adapterFor()), 'document').find((d) => d.location === 'legacy.md')!;
    expect(legacy.document.title).toBe('Café menu');
    expect(legacy.document.metadata.encoding).toBe('windows-1252');
  });

  it('does not follow symlinks outside the root and survives symlink loops', async (ctx) => {
    if (!canSymlink(tmp)) ctx.skip();
    const outside = path.join(tmp, 'outside-secret.md');
    fs.writeFileSync(outside, '# Outside\n\nPrivate content outside the source root.');
    fs.symlinkSync(outside, path.join(root, 'escape.md'));
    fs.symlinkSync(root, path.join(root, 'guides', 'loop'), 'dir');
    fs.symlinkSync(path.join(root, 'api', 'client.md'), path.join(root, 'client-link.md'));

    const outcomes = await collect(adapterFor());
    const docs = byKind(outcomes, 'document');
    expect(docs.map((d) => d.location)).not.toContain('escape.md');
    expect(byKind(outcomes, 'excluded').find((e) => e.location === 'escape.md')?.reason).toMatch(/outside/);
    expect(docs.some((d) => d.location.startsWith('guides/loop/'))).toBe(false);
    // A symlink to a file inside the root is indexed under its link path.
    expect(docs.map((d) => d.location)).toContain('client-link.md');
  });

  it('throws SourceUnavailableError for a missing root instead of yielding nothing', async () => {
    const missing = path.join(tmp, 'does-not-exist');
    const adapter = new LocalSourceAdapter({ id: 'x', type: 'local', path: missing }, { root: missing });
    await expect(collect(adapter)).rejects.toThrow(SourceUnavailableError);
  });

  it('maps citation URLs for repository and site styles', () => {
    const base = 'https://github.com/acme/docs/blob/main/docs';
    expect(mapLocalUrl('guides/web hooks.md', base)).toBe(`${base}/guides/web%20hooks.md`);
    expect(mapLocalUrl('guides/webhooks.md', 'https://docs.acme.dev/', 'site')).toBe(
      'https://docs.acme.dev/guides/webhooks'
    );
    expect(mapLocalUrl('guides/index.md', 'https://docs.acme.dev', 'site')).toBe(
      'https://docs.acme.dev/guides/'
    );
    expect(mapLocalUrl('README.md', 'https://docs.acme.dev', 'site')).toBe('https://docs.acme.dev/');
    expect(mapLocalUrl('a.md', undefined)).toBeUndefined();
  });
});
