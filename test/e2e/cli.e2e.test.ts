/**
 * End-to-end tests against the built CLI (run `npm run build` first; CI does).
 * They exercise real processes: stdio MCP, the HTTP server, and killing a sync mid-run.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FixtureServer } from '../fixtures/server.js';
import { copyDir, DOCS_FIXTURE, makeTempDir } from '../helpers.js';

const CLI = path.resolve(__dirname, '../../dist/interfaces/cli/index.js');

describe('Built CLI (end to end)', () => {
  let tmp: string;
  let env: NodeJS.ProcessEnv;

  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });

  beforeAll(() => {
    if (!fs.existsSync(CLI))
      throw new Error('dist/ not found: run `npm run build` before `npm run test:e2e`.');
    tmp = makeTempDir('citepath-e2e-');
    copyDir(DOCS_FIXTURE, path.join(tmp, 'docs'));
    env = {
      ...process.env,
      CITEPATH_CONFIG: path.join(tmp, 'config.json'),
      CITEPATH_DATA_DIR: path.join(tmp, 'data'),
      CITEPATH_LOG_LEVEL: 'warn',
    };
    expect(run('add', 'nimbus', '--path', path.join(tmp, 'docs'), '--sync').status).toBe(0);
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prints its version', () => {
    const result = run('--version');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('serves MCP over stdio with protocol-only stdout', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp'],
      env: env as Record<string, string>,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'e2e', version: '1.0.0' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_passage', 'list_sources', 'search_passages']);
    const result = await client.callTool({
      name: 'search_passages',
      arguments: { query: 'getUserName', limit: 1 },
    });
    expect((result.structuredContent as any).results[0].path).toBe('api/client.md');
    await client.close();
  });

  it('writes nothing but JSON-RPC messages to stdout in MCP mode', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop()!;
      lines.push(...parts.filter((l) => l.trim()));
    });
    const init = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
    };
    child.stdin.write(`${JSON.stringify(init)}\n`);
    await waitFor(() => lines.length >= 1, 10_000);
    child.stdin.end();
    await new Promise((resolve) => child.on('exit', resolve));
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    expect(JSON.parse(lines[0]!).result.serverInfo.name).toBe('citepath');
  });

  it('serves the local HTTP API on loopback', async () => {
    const child = spawn(process.execPath, [CLI, 'serve', '--port', '0'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    await waitFor(() => /listening on (http:\/\/\S+)/.test(stderr), 10_000);
    const url = /listening on (http:\/\/\S+)/.exec(stderr)![1]!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${url}/v1/search?q=getUserName&limit=1`);
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).results[0].path).toBe('api/client.md');
    await stop(child);
  });

  describe('interrupted syncs', () => {
    let server: FixtureServer;
    let siteEnv: NodeJS.ProcessEnv;
    // Async: the fixture server runs in this process, so a blocking spawnSync would deadlock it.
    const runSite = (...args: string[]) => runAsync(args, siteEnv);

    beforeAll(async () => {
      server = new FixtureServer();
      const origin = await server.start(null); // Empty site: only the pages defined below
      const siteTmp = makeTempDir('citepath-e2e-site-');
      siteEnv = {
        ...env,
        CITEPATH_CONFIG: path.join(siteTmp, 'config.json'),
        CITEPATH_DATA_DIR: path.join(siteTmp, 'data'),
      };
      // Many pages so a crawl takes a while once responses are slowed down.
      const links = Array.from({ length: 40 }, (_, i) => `<a href="/docs/p${i}.html">Page ${i}</a>`).join(
        ' '
      );
      server.setHtml(
        '/docs/',
        `<main><h1>Index</h1><p>All pages of the slow fixture site are listed here.</p>${links}</main>`
      );
      for (let i = 0; i < 40; i++) {
        server.setHtml(
          `/docs/p${i}.html`,
          `<main><h1>Page ${i}</h1><p>Content of slow fixture page number ${i} about topic${i}.</p></main>`
        );
      }
      const add = await runSite(
        'add',
        'site',
        '--url',
        `${origin}/docs/`,
        '--discovery',
        'crawl',
        '--allow-private-network'
      );
      expect(add.status, `${add.stdout}\n${add.stderr}`).toBe(0);
      // Raise the request rate so slowness below comes from response delays only.
      const config = JSON.parse(fs.readFileSync(siteEnv.CITEPATH_CONFIG!, 'utf8'));
      config.sources[0].requests_per_second = 50;
      fs.writeFileSync(siteEnv.CITEPATH_CONFIG!, JSON.stringify(config));
      const first = await runSite('sync', 'site');
      expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    }, 60_000);

    afterAll(async () => {
      await server.close();
    });

    const exportIndex = async () => (await runSite('export')).stdout;

    it('keeps the previous index when a sync process is killed (SIGKILL) and recovers the lock', async () => {
      const before = await exportIndex();
      expect(before).toContain('topic39');

      // Every page now changes and responds slowly.
      for (let i = 0; i < 40; i++) {
        server.setHtml(
          `/docs/p${i}.html`,
          `<main><h1>Page ${i}</h1><p>Rewritten content for page ${i}, new subject.</p></main>`,
          {
            delayMs: 150,
          }
        );
      }
      server.requests.length = 0;
      const child = spawn(process.execPath, [CLI, 'sync', 'site'], { env: siteEnv, stdio: 'ignore' });
      await waitFor(() => server.requests.filter((r) => r.path.startsWith('/docs/p')).length >= 5, 15_000);
      child.kill('SIGKILL');
      await new Promise((resolve) => child.on('exit', resolve));

      // The index is exactly as before, and still searchable.
      expect(await exportIndex()).toBe(before);
      const search = await runSite('search', 'topic12', '--json');
      expect(search.status).toBe(0);
      expect(JSON.parse(search.stdout).results.length).toBeGreaterThan(0);

      // The next sync detects the dead process's lock and completes.
      const status = await runSite('status', 'site', '--json');
      expect(JSON.parse(status.stdout).lock).not.toBeNull();
      for (let i = 0; i < 40; i++) server.set(`/docs/p${i}.html`, { ...serverRoute(i), delayMs: 0 });
      const rerun = await runSite('sync', 'site', '--json');
      expect(rerun.status).toBe(0);
      const summary = JSON.parse(rerun.stdout)[0];
      expect(summary.warnings.join(' ')).toMatch(/stale lock/);
      expect(summary.counts.updated).toBe(40);
    }, 60_000);

    it.skipIf(process.platform === 'win32')(
      'stops cleanly on Ctrl-C (SIGINT) without changing the index',
      async () => {
        const before = await exportIndex();
        for (let i = 0; i < 40; i++) {
          server.setHtml(
            `/docs/p${i}.html`,
            `<main><h1>Page ${i}</h1><p>Third version of page ${i} with other words.</p></main>`,
            {
              delayMs: 150,
            }
          );
        }
        server.requests.length = 0;
        const child = spawn(process.execPath, [CLI, 'sync', 'site'], {
          env: siteEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', (chunk) => (output += chunk));
        await waitFor(() => server.requests.filter((r) => r.path.startsWith('/docs/p')).length >= 5, 15_000);
        child.kill('SIGINT');
        const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
        expect(code).toBe(1);
        expect(output).toMatch(/interrupted/);
        expect(await exportIndex()).toBe(before);
        expect(JSON.parse((await runSite('status', 'site', '--json')).stdout).lock).toBeNull();
      },
      60_000
    );
  });
});

function serverRoute(i: number) {
  return {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<main><h1>Page ${i}</h1><p>Rewritten content for page ${i}, new subject.</p></main>`,
  };
}

function runAsync(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.on('exit', resolve));
}
