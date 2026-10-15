// Packs dist/ and the production dependencies into citepath-<version>.mcpb, the bundle Smithery and
// Claude Desktop install. Run `npm run build` first. Needs network access for `npm ci`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MCPB_CLI_VERSION, mcpbManifest } from './mcpb-manifest.mjs';

const root = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stage = path.join(root, '.mcpb-build');
const output = path.join(root, `citepath-${pkg.version}.mcpb`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

if (!fs.existsSync(path.join(root, pkg.bin.citepath))) {
  throw new Error(`${pkg.bin.citepath} is missing. Run npm run build first.`);
}

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
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(mcpbManifest(pkg), null, 2)}\n`);

const mcpb = ['-y', `@anthropic-ai/mcpb@${MCPB_CLI_VERSION}`];
execFileSync(npx, [...mcpb, 'validate', path.join(stage, 'manifest.json')], { stdio: 'inherit' });
fs.rmSync(output, { force: true });
execFileSync(npx, [...mcpb, 'pack', stage, output], { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
process.stderr.write(`Wrote ${path.relative(root, output)}\n`);
