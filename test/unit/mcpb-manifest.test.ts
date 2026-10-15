import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error: plain ESM build script without type declarations
import { mcpbManifest } from '../../scripts/mcpb-manifest.mjs';
import { createMcpServer, MCP_TOOL_NAMES } from '../../src/interfaces/mcp/server.js';
import { silentLogger } from '../../src/utils/logger.js';

const root = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

async function listServerTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const noIndex = () => {
    throw new Error('tools/list does not need an index');
  };
  await createMcpServer(noIndex, silentLogger).connect(serverTransport);
  const client = new Client({ name: 'mcpb-test', version: '1.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('MCPB manifest', () => {
  let manifest: any;
  beforeAll(async () => {
    manifest = mcpbManifest(pkg, await listServerTools());
  });

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

  it('keeps tools to name and description, as the MCPB spec requires', () => {
    for (const tool of manifest.tools) expect(Object.keys(tool).sort()).toEqual(['description', 'name']);
  });

  it("includes each tool's full definition in the Smithery variant", async () => {
    // Smithery rejects a bundle whose manifest tools lack an inputSchema object.
    const smithery = mcpbManifest(pkg, await listServerTools(), { fullTools: true });
    for (const tool of smithery.tools) {
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object' });
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });
});
