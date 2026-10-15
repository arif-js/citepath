// Runs from the npm "version" lifecycle script: copies the new package.json version into server.json
// (the MCP Registry entry) so both always describe the same release.
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const server = JSON.parse(fs.readFileSync('server.json', 'utf8'));

server.version = pkg.version;
for (const p of server.packages) {
  if (p.identifier === pkg.name) p.version = pkg.version;
}
fs.writeFileSync('server.json', `${JSON.stringify(server, null, 2)}\n`);
