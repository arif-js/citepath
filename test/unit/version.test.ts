import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { USER_AGENT, VERSION } from '../../src/version.js';

const readJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8'));

describe('Version', () => {
  it('matches package.json', () => {
    const pkg = readJson('package.json');
    expect(VERSION).toBe(pkg.version);
    expect(USER_AGENT).toContain(`Citepath/${VERSION}`);
  });

  it('matches the MCP Registry entry in server.json', () => {
    // The registry checks that the npm package's mcpName equals the server.json name, and the release
    // workflow publishes server.json as is, so both versions must follow package.json.
    const pkg = readJson('package.json');
    const server = readJson('server.json');
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([
      expect.objectContaining({ registryType: 'npm', identifier: pkg.name, version: pkg.version }),
    ]);
  });

  it('has a valid glama.json file', () => {
    const glama = readJson('glama.json');
    expect(glama.$schema).toBe('https://glama.ai/mcp/schemas/server.json');
    expect(glama.maintainers).toContain('arif-js');
  });
});
