import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CliIO, runCli } from '../../src/interfaces/cli/main.js';
import { VERSION } from '../../src/version.js';
import { copyDir, DOCS_FIXTURE, makeTempDir } from '../helpers.js';

describe('CLI', () => {
  let tmp: string;
  let root: string;
  let configPath: string;
  let dataDir: string;

  beforeEach(() => {
    tmp = makeTempDir();
    root = path.join(tmp, 'docs');
    copyDir(DOCS_FIXTURE, root);
    configPath = path.join(tmp, 'cfg', 'config.json');
    dataDir = path.join(tmp, 'data');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function cli(...args: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY: false, cwd: tmp };
    const code = await runCli([...args, '--config', configPath, '--data-dir', dataDir], io);
    return { code, out: out.join(''), err: err.join('') };
  }
  const json = async (...args: string[]) => {
    const result = await cli(...args, '--json');
    return { ...result, data: result.out ? JSON.parse(result.out) : undefined };
  };

  it('prints help and version without a config', async () => {
    const out: string[] = [];
    const io: CliIO = { stdout: (t) => out.push(t), stderr: () => {}, isTTY: false, cwd: tmp };
    expect(await runCli(['--version'], io)).toBe(0);
    expect(out.join('')).toBe(`${VERSION}\n`);
    out.length = 0;
    expect(await runCli(['--help'], io)).toBe(0);
    expect(out.join('')).toContain('Commands:');
    out.length = 0;
    expect(await runCli(['search', '--help'], io)).toBe(0);
    expect(out.join('')).toContain('Usage: citepath search');
  });

  it('runs the full workflow: init, add, sync, sources, status, search, get', async () => {
    expect((await json('init')).data).toMatchObject({ created: true });
    expect((await json('init')).data).toMatchObject({ created: false });
    expect(fs.existsSync(path.join(tmp, 'cfg', 'citepath.schema.json'))).toBe(true);

    const add = await json('add', 'nimbus', '--path', 'docs', '--name', 'Nimbus', '--sync');
    expect(add.code).toBe(0);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.sources[0]).toMatchObject({ id: 'nimbus', type: 'local', path: root, name: 'Nimbus' });

    const sources = await json('sources');
    expect(sources.data.sources[0]).toMatchObject({ id: 'nimbus', documents: 11 });

    const status = await json('status', 'nimbus');
    expect(status.data.last_sync.counts.documents_total).toBe(11);

    const search = await json('search', 'getUserName', '-n', '1');
    expect(search.data.results[0].path).toBe('api/client.md');

    const human = await cli('search', 'getUserName', '-n', '1');
    expect(human.out).toContain('Source: Nimbus — api/client.md#L13-L20');

    const get = await json('get', search.data.results[0].id, '--neighbors', '1');
    expect(get.data.passage.id).toBe(search.data.results[0].id);
  });

  it('reports usage errors with exit code 2 and JSON errors with --json', async () => {
    await cli('init');
    expect((await cli('add', 'x', '--url', 'https://a.test', '--path', root)).code).toBe(2);
    expect((await cli('add', 'x', '--url', 'https://a.test/', '--base-url', 'https://b.test')).code).toBe(2);
    expect((await cli('add', 'Bad Id', '--path', root)).err).toMatch(/id:/);
    expect((await cli('add', 'x', '--path', path.join(tmp, 'missing'))).err).toMatch(/directory not found/);
    await cli('add', 'nimbus', '--path', root);
    expect((await cli('add', 'nimbus', '--path', root)).err).toMatch(/already exists/);
    expect((await cli('frobnicate')).code).toBe(2);
    expect((await cli('search', '--bogus-flag', 'x')).code).toBe(2);
    const empty = await json('search', '   ');
    expect(empty.code).toBe(2);
    expect(JSON.parse(empty.err)).toEqual({ error: { code: 'usage_error', message: expect.any(String) } });
    expect((await cli('sync', 'nope')).code).toBe(2);
  });

  it('exits 3 when a sync completes with failures and 1 when it fails', async () => {
    await cli('add', 'nimbus', '--path', root);
    fs.writeFileSync(path.join(root, 'binary.md'), Buffer.from([0, 1, 2, 3]));
    const partial = await json('sync');
    expect(partial.code).toBe(3);
    expect(partial.data[0].status).toBe('completed_with_failures');

    fs.rmSync(root, { recursive: true });
    const failed = await cli('sync');
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/failed/);
  });

  it('shows sync progress on stderr, but not with --json or --quiet', async () => {
    await cli('add', 'nimbus', '--path', root);
    const plain = await cli('sync');
    expect(plain.code).toBe(0);
    expect(plain.err).toContain('Syncing nimbus...');
    expect(plain.err).toMatch(/nimbus: \d+ items fetched, writing to the index/);
    expect(plain.err).not.toContain('\r');

    for (const flag of ['--json', '--quiet']) {
      const silent = await cli('sync', flag);
      expect(silent.code).toBe(0);
      expect(silent.err).toBe('');
    }
  });

  it('adds one source per repeated --path, numbering the IDs, and syncs them all', async () => {
    const second = path.join(tmp, 'more-docs');
    copyDir(DOCS_FIXTURE, second);
    const add = await json('add', 'team', '--path', 'docs', '--path', second, '--name', 'Team', '--sync');
    expect(add.code).toBe(0);
    expect(add.data.map((s: { source_id: string }) => s.source_id)).toEqual(['team-1', 'team-2']);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.sources).toEqual([
      expect.objectContaining({ id: 'team-1', type: 'local', path: root, name: 'Team (1)' }),
      expect.objectContaining({ id: 'team-2', type: 'local', path: second, name: 'Team (2)' }),
    ]);

    const urls = await json('add', 'web', '--url', 'https://a.example/docs', '--url', 'https://b.example/');
    expect(urls.code).toBe(0);
    expect(urls.data.added.map((s: { id: string; url: string }) => [s.id, s.url])).toEqual([
      ['web-1', 'https://a.example/docs'],
      ['web-2', 'https://b.example/'],
    ]);
  });

  it('keeps the given ID for a single location and reports it as a one-item list', async () => {
    const add = await json('add', 'nimbus', '--path', root);
    expect(add.code).toBe(0);
    expect(add.data.added).toEqual([expect.objectContaining({ id: 'nimbus', path: root })]);
  });

  it('validates every location before adding anything', async () => {
    const notDir = path.join(root, 'notes.txt');
    const cases: [string[], RegExp][] = [
      [
        ['--url', 'nextjs.org/docs'],
        /nextjs\.org\/docs: not an absolute URL; did you mean https:\/\/nextjs\.org\/docs\?/,
      ],
      [['--url', 'docs'], /expected something like https:\/\/example\.com\/docs/],
      [['--url', 'ftp://example.com/docs'], /unsupported scheme "ftp:"/],
      [['--url', 'https://user:pw@example.com/'], /must not contain a user name or password/],
      [['--path', 'missing'], /missing: directory not found/],
      [['--path', notDir], /notes\.txt: not a directory/],
      [['--path', root, '--path', 'docs'], /given more than once/],
      [['--url', 'https://a.example/', '--path', root], /but not both/],
      [['--url', 'https://ok.example/', '--url', 'bad'], /--url bad: not an absolute URL/],
    ];
    for (const [flags, message] of cases) {
      const result = await cli('add', 'x', ...flags);
      expect(result.code, flags.join(' ')).toBe(2);
      expect(result.err).toMatch(message);
    }
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('refuses numbered IDs that already exist', async () => {
    await cli('add', 'team-2', '--path', root);
    const second = path.join(tmp, 'more-docs');
    copyDir(DOCS_FIXTURE, second);
    const result = await cli('add', 'team', '--path', root, '--path', second);
    expect(result.code).toBe(2);
    expect(result.err).toContain('A source with id "team-2" already exists.');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.sources.map((s: { id: string }) => s.id)).toEqual(['team-2']);
  });

  it('requires --yes to remove a source when not interactive, then deletes everything', async () => {
    await cli('add', 'nimbus', '--path', root, '--sync');
    const refused = await cli('remove', 'nimbus');
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/--yes/);

    const removed = await json('remove', 'nimbus', '--yes');
    expect(removed.data).toMatchObject({ removed: 'nimbus', documents: 11, removed_from_config: true });
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).sources).toEqual([]);
    const sources = await json('sources');
    expect(sources.data).toMatchObject({ sources: [], orphaned: [] });
    expect((await cli('remove', 'nimbus', '--yes')).code).toBe(2);
  });

  it('removes orphaned index data for sources deleted from the config by hand', async () => {
    await cli('add', 'nimbus', '--path', root, '--sync');
    fs.writeFileSync(configPath, JSON.stringify({ sources: [] }));
    expect((await json('sources')).data.orphaned).toEqual([{ id: 'nimbus', documents: 11 }]);
    expect((await cli('remove', 'nimbus', '--yes')).code).toBe(0);
    expect((await json('sources')).data.orphaned).toEqual([]);
  });

  it('exports JSONL to a file and compacts the index', async () => {
    await cli('add', 'nimbus', '--path', root, '--sync');
    const exportPath = path.join(tmp, 'export.jsonl');
    const exported = await cli('export', '-o', exportPath);
    expect(exported.code).toBe(0);
    const lines = fs
      .readFileSync(exportPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: 'export', format: 'citepath-jsonl' });
    expect(lines.filter((l) => l.type === 'source')).toHaveLength(1);
    expect(lines.filter((l) => l.type === 'document')).toHaveLength(11);
    const passages = lines.filter((l) => l.type === 'passage');
    expect(passages.length).toBeGreaterThan(10);
    expect(passages[0]).toHaveProperty('text');
    expect(exported.err).toMatch(/Exported 1 sources, 11 documents/);

    const compact = await json('compact');
    expect(compact.code).toBe(0);
    expect(compact.data.after).toBeGreaterThan(0);
  });

  it('clears a lock with unlock', async () => {
    await cli('add', 'nimbus', '--path', root, '--sync');
    expect((await json('unlock', 'nimbus')).data).toEqual({ unlocked: false });
  });

  it('evaluates retrieval and fails below the minimum recall', async () => {
    await cli('add', 'nimbus', '--path', root, '--sync');
    const evalFile = path.join(tmp, 'eval.json');
    fs.writeFileSync(
      evalFile,
      JSON.stringify({
        k: 3,
        questions: [
          { id: 'auth', question: 'How do I configure authentication?', expected: ['getting-started.md'] },
          { id: 'missing', question: 'Where is the billing page?', expected: ['billing.md'] },
        ],
      })
    );
    const ok = await json('eval', evalFile);
    expect(ok.code).toBe(0);
    expect(ok.data).toMatchObject({ k: 3, questions: 2, hit_rate: 0.5, recall_at_k: 0.5, not_in_index: 1 });
    expect(ok.data.results[1].expected[0].status).toBe('not_in_index');

    const strict = await cli('eval', evalFile, '--min-recall', '0.9');
    expect(strict.code).toBe(3);
    expect(strict.err).toMatch(/below the required 0.9/);
  });
});
