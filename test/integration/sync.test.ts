import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '../../src/config/load.js';
import type { LocalSourceConfig, SourceConfig, WebSourceConfig } from '../../src/config/schema.js';
import { type SyncProgress, syncSource } from '../../src/core/sync.js';
import { WebSourceAdapter } from '../../src/sources/web/adapter.js';
import { openIndex } from '../../src/store/db.js';
import { LockError } from '../../src/utils/errors.js';
import { FixtureServer } from '../fixtures/server.js';
import { copyDir, DOCS_FIXTURE, makeTempDir } from '../helpers.js';

function loadedConfig(dir: string, sources: SourceConfig[]): LoadedConfig {
  return {
    config: { sources },
    configPath: path.join(dir, 'config.json'),
    configDir: dir,
    exists: true,
    dataDir: path.join(dir, 'data'),
  };
}

function snapshot(db: DatabaseSync, sourceId: string) {
  const docs = db
    .prepare('SELECT location, content_hash FROM documents WHERE source_id = ? ORDER BY location')
    .all(sourceId);
  const passages = db
    .prepare('SELECT id, content_hash FROM passages WHERE source_id = ? ORDER BY id')
    .all(sourceId);
  return { docs, passages };
}

function ftsCount(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS c FROM passages_fts').get() as { c: number }).c;
}

function passageTotal(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS c FROM passages').get() as { c: number }).c;
}

describe('Sync engine: local sources', () => {
  let tmp: string;
  let root: string;
  let db: DatabaseSync;
  let source: LocalSourceConfig;

  beforeEach(() => {
    tmp = makeTempDir();
    root = path.join(tmp, 'docs');
    copyDir(DOCS_FIXTURE, root);
    db = openIndex(path.join(tmp, 'data'));
    source = { id: 'nimbus', type: 'local', path: root };
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const sync = (src: SourceConfig = source, options = {}) =>
    syncSource(db, loadedConfig(tmp, [src]), src, options);

  it('indexes, then re-syncs without duplicates and with identical IDs', async () => {
    const first = await sync();
    expect(first.status).toBe('completed');
    expect(first.counts.added).toBe(12);
    expect(first.warnings).toEqual([]);
    const before = snapshot(db, 'nimbus');
    expect(ftsCount(db)).toBe(passageTotal(db));

    const second = await sync();
    expect(second.counts).toMatchObject({ added: 0, updated: 0, unchanged: 12, removed: 0 });
    expect(snapshot(db, 'nimbus')).toEqual(before);
    expect(ftsCount(db)).toBe(passageTotal(db));
  });

  it('updates changed files and keeps passage IDs for unchanged sections', async () => {
    await sync();
    const idsBefore = db
      .prepare(
        "SELECT id, heading_path_json FROM passages WHERE document_id IN (SELECT id FROM documents WHERE location = 'api/client.md') ORDER BY ordinal"
      )
      .all() as Array<{ id: string }>;

    const file = path.join(root, 'api/client.md');
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('Returns the display name', 'Returns the full display name')
    );
    const result = await sync();
    expect(result.counts).toMatchObject({ updated: 1, unchanged: 11, added: 0, removed: 0 });

    const idsAfter = db
      .prepare(
        "SELECT id, heading_path_json FROM passages WHERE document_id IN (SELECT id FROM documents WHERE location = 'api/client.md') ORDER BY ordinal"
      )
      .all() as Array<{ id: string }>;
    expect(idsAfter.map((r) => r.id)).toEqual(idsBefore.map((r) => r.id));
    expect(ftsCount(db)).toBe(passageTotal(db));
  });

  it('removes deleted files when discovery is complete', async () => {
    await sync();
    fs.rmSync(path.join(root, 'notes.txt'));
    const result = await sync();
    expect(result.counts.removed).toBe(1);
    expect(result.removed).toEqual([{ location: 'notes.txt', reason: 'file no longer exists' }]);
    expect(ftsCount(db)).toBe(passageTotal(db));
  });

  it('removes documents that fall outside a narrowed scope', async () => {
    await sync();
    const narrowed: LocalSourceConfig = { ...source, exclude: ['i18n/**'] };
    const result = await sync(narrowed);
    expect(result.removed.map((r) => r.location).sort()).toEqual(['i18n/de.md', 'i18n/ja.md']);
  });

  it('trips the mass-deletion guard and removes nothing unless overridden', async () => {
    await sync();
    for (const file of [
      'notes.txt',
      'cli.mdx',
      'empty.md',
      'getting-started.md',
      'guides/ci-cache.md',
      'guides/pagination.md',
      'guides/webhooks.md',
    ]) {
      fs.rmSync(path.join(root, file));
    }
    const guarded = await sync();
    expect(guarded.status).toBe('completed_with_failures');
    expect(guarded.mass_delete_guard).toMatchObject({ triggered: true, would_remove: 7, existing: 12 });
    expect(guarded.counts.removed).toBe(0);
    expect(db.prepare("SELECT count(*) AS c FROM documents WHERE source_id = 'nimbus'").get()).toEqual({
      c: 12,
    });

    const forced = await sync(source, { allowMassDelete: true });
    expect(forced.counts.removed).toBe(7);
  });

  it('fails without removing anything when the source directory is missing', async () => {
    await sync();
    const before = snapshot(db, 'nimbus');
    fs.rmSync(root, { recursive: true });
    const result = await sync();
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/Cannot read source directory/);
    expect(snapshot(db, 'nimbus')).toEqual(before);
  });

  it('rolls back completely when applying fails', async () => {
    await sync();
    const before = snapshot(db, 'nimbus');
    fs.writeFileSync(path.join(root, 'new.md'), '# New page\n\nBrand new content.');
    fs.rmSync(path.join(root, 'notes.txt'));
    const result = await sync(source, { failDuringApply: true });
    expect(result.status).toBe('failed');
    expect(snapshot(db, 'nimbus')).toEqual(before);
    expect(db.prepare('SELECT count(*) AS c FROM staged_items').get()).toEqual({ c: 0 });
  });

  it('leaves the index unchanged when interrupted', async () => {
    await sync();
    const before = snapshot(db, 'nimbus');
    fs.rmSync(path.join(root, 'notes.txt'));
    const controller = new AbortController();
    controller.abort(new Error('interrupted by test'));
    const result = await sync(source, { signal: controller.signal });
    expect(result.status).toBe('interrupted');
    expect(snapshot(db, 'nimbus')).toEqual(before);
  });

  it('reports progress for every item, then once when applying', async () => {
    const events: SyncProgress[] = [];
    const result = await sync(source, { onProgress: (p: SyncProgress) => events.push(p) });
    expect(result.status).toBe('completed');
    const fetching = events.filter((e) => e.phase === 'fetching');
    expect(fetching.map((e) => e.processed)).toEqual(fetching.map((_, i) => i + 1));
    expect(fetching.every((e) => typeof e.location === 'string')).toBe(true);
    const last = events.at(-1)!;
    expect(last).toMatchObject({ source_id: 'nimbus', phase: 'applying', processed: fetching.length });
    expect(last.location).toBeUndefined();
    expect(last.items.document).toBe(result.counts.added);
    expect(events.filter((e) => e.phase === 'applying')).toHaveLength(1);
  });

  it('refuses to run while another live sync holds the lock, and recovers stale locks', async () => {
    await sync();
    const insertLock = db.prepare(
      'INSERT INTO sync_locks (source_id, run_id, pid, hostname, started_at, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const now = new Date().toISOString();
    insertLock.run('nimbus', 999, process.pid, os.hostname(), now, now);
    await expect(sync()).rejects.toThrow(LockError);

    db.prepare('DELETE FROM sync_locks').run();
    insertLock.run('nimbus', 999, 2 ** 22 + 12345, os.hostname(), now, now); // Dead PID
    const recovered = await sync();
    expect(recovered.status).toBe('completed');
    expect(recovered.warnings.join(' ')).toMatch(/stale lock/);
    expect(db.prepare('SELECT count(*) AS c FROM sync_locks').get()).toEqual({ c: 0 });
  });

  it('re-processes every document when the parser version changes', async () => {
    await sync();
    db.prepare('UPDATE documents SET parser_version = 0').run();
    const result = await sync();
    expect(result.counts.updated).toBe(12);
  });

  it('records Git provenance when the source is a Git checkout', async (ctx) => {
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
    } catch {
      ctx.skip();
    }
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
    git('init', '-q');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'add', '-A');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'init');
    fs.appendFileSync(path.join(root, 'notes.txt'), '\nUncommitted change.\n');
    await sync();
    const rows = db
      .prepare('SELECT location, commit_sha, dirty FROM documents ORDER BY location')
      .all() as Array<{
      location: string;
      commit_sha: string;
      dirty: number;
    }>;
    expect(rows.every((r) => /^[0-9a-f]{40,64}$/.test(r.commit_sha))).toBe(true);
    expect(rows.find((r) => r.location === 'notes.txt')?.dirty).toBe(1);
    expect(rows.find((r) => r.location === 'cli.mdx')?.dirty).toBe(0);
  });
});

describe('Sync engine: web sources', () => {
  let tmp: string;
  let db: DatabaseSync;
  let server: FixtureServer;
  let source: WebSourceConfig;

  beforeEach(async () => {
    tmp = makeTempDir();
    db = openIndex(path.join(tmp, 'data'));
    server = new FixtureServer();
    const origin = await server.start();
    server.set('/docs/legacy', { status: 301, headers: { Location: '/docs/auth.html' } });
    source = {
      id: 'site',
      type: 'web',
      url: `${origin}/docs/`,
      discovery: 'crawl',
      allow_private_network: true,
      requests_per_second: 50,
    };
  });

  afterEach(async () => {
    await server.close();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const sync = (options = {}) =>
    syncSource(db, loadedConfig(tmp, [source]), source, {
      adapterFactory: (s) => new WebSourceAdapter(s as WebSourceConfig, { retryBaseDelayMs: 10 }),
      ...options,
    });
  const locations = () =>
    (
      db.prepare("SELECT location FROM documents WHERE source_id = 'site' ORDER BY location").all() as Array<{
        location: string;
      }>
    ).map((r) => r.location.replace(server.origin, ''));

  it('indexes the site and records aliases as alternate URLs', async () => {
    const result = await sync();
    expect(result.status).toBe('completed_with_failures'); // js-app, soft-404, and the PDF fail
    expect(locations()).toEqual([
      '/docs',
      '/docs/api.html',
      '/docs/auth.html',
      '/docs/guide/deep.html',
      '/docs/guide/deeper.html',
      '/docs/injection.html',
      '/docs/install.html',
    ]);
    const alternates = db
      .prepare(
        'SELECT d.location, u.url FROM document_urls u JOIN documents d ON d.id = u.document_id ORDER BY u.url'
      )
      .all() as Array<{ location: string; url: string }>;
    expect(
      alternates.map((a) => [a.location.replace(server.origin, ''), a.url.replace(server.origin, '')])
    ).toEqual([
      ['/docs/auth.html', '/docs/legacy'],
      ['/docs/install.html', '/docs/setup.html'],
    ]);
  });

  it('removes 404 and 410 pages but keeps pages that fail transiently or with 403', async () => {
    await sync();
    server.remove('/docs/install.html');
    server.setStatus('/docs/setup.html', 410);
    server.setStatus('/docs/auth.html', 403);
    server.setStatus('/docs/guide/deep.html', 503);
    const result = await sync();
    const list = locations();
    expect(list).not.toContain('/docs/install.html');
    expect(list).toContain('/docs/auth.html');
    expect(list).toContain('/docs/guide/deep.html');
    // deeper.html is only linked from deep.html, which failed: discovery is incomplete, so it is kept.
    expect(list).toContain('/docs/guide/deeper.html');
    expect(result.discovery_complete).toBe(false);
  });

  it('keeps everything when robots.txt is unavailable', async () => {
    await sync();
    const before = locations();
    server.setStatus('/robots.txt', 503);
    const result = await sync();
    expect(result.discovery_complete).toBe(false);
    expect(result.counts.removed).toBe(0);
    expect(locations()).toEqual(before);
  });

  it('removes a page that becomes noindex or disallowed by robots.txt', async () => {
    await sync();
    server.setHtml(
      '/docs/injection.html',
      '<html><head><meta name="robots" content="noindex"></head><body><main><p>Now hidden from indexing.</p></main></body></html>'
    );
    server.set('/robots.txt', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: 'User-agent: *\nDisallow: /docs/guide/\n',
    });
    const result = await sync();
    const removed = result.removed.map((r) => r.location.replace(server.origin, '')).sort();
    // deeper.html was only linked from the now-disallowed guide, so a complete crawl no longer finds it.
    expect(removed).toEqual(['/docs/guide/deep.html', '/docs/guide/deeper.html', '/docs/injection.html']);
  });

  it('stores identical content under one location and aliases the duplicate', async () => {
    const body =
      '<main><h1>Mirror</h1><p>This page is published under two URLs with no canonical link at all, on purpose.</p></main>';
    server.setHtml('/docs/mirror-a.html', body);
    server.setHtml('/docs/mirror-b.html', body);
    server.setHtml(
      '/docs/',
      '<main><h1>Index</h1><p>Links to both mirrors of the same page for testing.</p><a href="/docs/mirror-b.html">B</a><a href="/docs/mirror-a.html">A</a></main>'
    );
    await sync();
    const list = locations();
    expect(list).toContain('/docs/mirror-a.html');
    expect(list).not.toContain('/docs/mirror-b.html');
  });

  it('sends conditional requests on re-sync and treats 304 as unchanged', async () => {
    server.setHtml(
      '/docs/install.html',
      '<main><h1>Install</h1><p>Install with npm install nimbus-sdk on any supported platform.</p></main>',
      { etag: '"etag-1"' }
    );
    await sync();
    server.requests.length = 0;
    const result = await sync();
    expect(server.requestsFor('/docs/install.html')[0]!.headers['if-none-match']).toBe('"etag-1"');
    expect(result.counts.updated).toBe(0);
    expect(locations()).toContain('/docs/install.html');
  });
});
