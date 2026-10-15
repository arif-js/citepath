import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CliIO, runCli } from '../../src/interfaces/cli/main.js';
import { makeTempDir } from '../helpers.js';

// The real server reads process.stdin until it closes; replace it so the command returns.
vi.mock('../../src/interfaces/mcp/server.js', () => ({ serveMcpStdio: vi.fn(async () => {}) }));

describe('citepath mcp', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function mcp(isTTY: boolean, ...flags: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIO = { stdout: (t) => out.push(t), stderr: (t) => err.push(t), isTTY, cwd: tmp };
    const args = ['mcp', '--config', path.join(tmp, 'config.json'), '--data-dir', path.join(tmp, 'data')];
    const code = await runCli([...args, ...flags], io);
    return { code, out: out.join(''), err: err.join('') };
  }

  it('explains itself on stderr when run by hand in a terminal', async () => {
    const result = await mcp(true);
    expect(result.code).toBe(0);
    expect(result.out).toBe('');
    expect(result.err).toContain('MCP server running on stdio');
    expect(result.err).toContain('claude mcp add citepath -- citepath mcp');
    expect(result.err).toContain('Press Ctrl-C to exit.');
  });

  it('prints nothing when started by a client over pipes, or with --quiet', async () => {
    expect(await mcp(false)).toEqual({ code: 0, out: '', err: '' });
    expect(await mcp(true, '--quiet')).toEqual({ code: 0, out: '', err: '' });
  });
});
