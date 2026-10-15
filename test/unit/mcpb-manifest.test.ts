import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: plain ESM build script without type declarations
import { mcpbManifest } from '../../scripts/mcpb-manifest.mjs';
import { MCP_TOOL_NAMES } from '../../src/interfaces/mcp/server.js';

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('MCPB manifest', () => {
  const manifest = mcpbManifest(pkg);

  it('follows package.json', () => {
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.description).toBe(pkg.description);
    expect(manifest.compatibility.runtimes.node).toBe(pkg.engines.node);
  });

  it('starts the MCP server from the bundled CLI', () => {
    expect(manifest.server.entry_point).toBe(pkg.bin.citepath);
    expect(fs.existsSync(path.join(root, 'src/interfaces/cli/index.ts'))).toBe(true);
    expect(manifest.server.mcp_config).toEqual({
      command: 'node',
      args: [`\${__dirname}/${pkg.bin.citepath}`, 'mcp'],
    });
  });

  it('lists exactly the MCP tools the server registers', () => {
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
  });
});
