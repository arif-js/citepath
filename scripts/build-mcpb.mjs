// Packs dist/ and the production dependencies into two bundles. Run `npm run build` first. Needs
// network access for `npm ci`, and the zip command.
//
// - citepath-<version>.mcpb: follows the MCPB spec; attached to GitHub releases for Claude Desktop.
// - citepath-<version>.smithery.mcpb: the same files, but manifest.tools carries each tool's full
//   definition, which Smithery requires and the MCPB validator rejects. Publish this one to Smithery.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { MCPB_CLI_VERSION, mcpbManifest } from './mcpb-manifest.mjs';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stage = path.join(root, '.mcpb-build');
const output = path.join(root, `citepath-${pkg.version}.mcpb`);
const smitheryOutput = path.join(root, `citepath-${pkg.version}.smithery.mcpb`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

if (!fs.existsSync(path.join(root, pkg.bin.citepath))) {
  throw new Error(`${pkg.bin.citepath} is missing. Run npm run build first.`);
}

/** Starts the built MCP server in memory and returns its tools/list result. Listing tools never opens the index. */
async function listServerTools() {
  const imp = (file) => import(pathToFileURL(path.join(root, file)).href);
  const { createMcpServer } = await imp('dist/interfaces/mcp/server.js');
  const { silentLogger } = await imp('dist/utils/logger.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const noIndex = () => {
    throw new Error('tools/list does not need an index');
  };
  await createMcpServer(noIndex, silentLogger).connect(serverTransport);
  const client = new Client({ name: 'build-mcpb', version: pkg.version });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

const tools = await listServerTools();

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage);
for (const entry of ['dist', 'schema', 'package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
  fs.cpSync(path.join(root, entry), path.join(stage, entry), { recursive: true });
}
execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: stage,
  stdio: 'inherit',
});
fs.rmSync(path.join(stage, 'package-lock.json'));
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(mcpbManifest(pkg, tools), null, 2)}\n`);

const mcpb = ['-y', `@anthropic-ai/mcpb@${MCPB_CLI_VERSION}`];
execFileSync(npx, [...mcpb, 'validate', path.join(stage, 'manifest.json')], { stdio: 'inherit' });
fs.rmSync(output, { force: true });
execFileSync(npx, [...mcpb, 'pack', stage, output], { stdio: 'inherit' });

// Smithery variant: replace manifest.json at the archive root with the full-tools manifest.
const smitheryManifestDir = path.join(stage, '.smithery');
fs.mkdirSync(smitheryManifestDir);
fs.writeFileSync(
  path.join(smitheryManifestDir, 'manifest.json'),
  `${JSON.stringify(mcpbManifest(pkg, tools, { fullTools: true }), null, 2)}\n`
);
fs.copyFileSync(output, smitheryOutput);
execFileSync('zip', ['-q', '-j', smitheryOutput, path.join(smitheryManifestDir, 'manifest.json')]);

fs.rmSync(stage, { recursive: true, force: true });
process.stderr.write(`Wrote ${path.relative(root, output)} and ${path.relative(root, smitheryOutput)}\n`);
