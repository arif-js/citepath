// The MCPB manifest (https://github.com/modelcontextprotocol/mcpb) for the citepath bundle that
// Smithery and Claude Desktop install. Built from package.json so the version never drifts.

/** MCPB packer version used by scripts/build-mcpb.mjs. */
export const MCPB_CLI_VERSION = '2.1.2';

export function mcpbManifest(pkg) {
  return {
    manifest_version: '0.3',
    name: pkg.name,
    display_name: 'Citepath',
    version: pkg.version,
    description: pkg.description,
    long_description:
      'Citepath indexes documentation websites and local Markdown, MDX, or text folders on your machine, ' +
      'and lets your assistant search them. Every result is a ranked passage with a link to the exact ' +
      'page section or file lines it came from. No account, no API keys, no telemetry.\n\n' +
      'The tools are read-only. Add and sync documentation with the citepath CLI ' +
      '(`npm install -g citepath`, then `citepath add my-docs --path ./docs --sync`); this server ' +
      'searches whatever the CLI has indexed.',
    author: { name: 'arif-js', url: 'https://github.com/arif-js' },
    repository: { type: 'git', url: 'https://github.com/arif-js/citepath.git' },
    homepage: 'https://github.com/arif-js/citepath#readme',
    documentation: 'https://github.com/arif-js/citepath/blob/main/docs/mcp.md',
    support: 'https://github.com/arif-js/citepath/issues',
    license: pkg.license,
    keywords: pkg.keywords,
    server: {
      type: 'node',
      entry_point: pkg.bin.citepath,
      mcp_config: {
        command: 'node',
        args: [`\${__dirname}/${pkg.bin.citepath}`, 'mcp'],
      },
    },
    tools: [
      { name: 'search', description: 'Search indexed documentation; returns ranked, cited passages.' },
      { name: 'get_passage', description: 'Read a passage in full, with surrounding passages.' },
      { name: 'list_sources', description: 'List documentation sources and their sync status.' },
    ],
    tools_generated: false,
    compatibility: {
      platforms: ['darwin', 'win32', 'linux'],
      runtimes: { node: pkg.engines.node },
    },
  };
}
