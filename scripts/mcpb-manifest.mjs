// The MCPB manifest (https://github.com/modelcontextprotocol/mcpb) for the citepath bundle that
// Smithery and Claude Desktop install. Built from package.json and the tools the MCP server
// registers, so neither the version nor the tool definitions can drift.

/** MCPB packer version used by scripts/build-mcpb.mjs. */
export const MCPB_CLI_VERSION = '2.1.2';

/**
 * `tools` is the server's tools/list result. The MCPB spec (and Claude Desktop's validator) allows
 * only name and description per tool. Smithery copies manifest.tools into its server card, which
 * requires each tool's inputSchema, so `{ fullTools: true }` builds the Smithery variant.
 */
export function mcpbManifest(pkg, tools, { fullTools = false } = {}) {
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
    tools: tools.map(({ name, title, description, inputSchema, annotations }) =>
      fullTools ? { name, title, description, inputSchema, annotations } : { name, description }
    ),
    tools_generated: false,
    compatibility: {
      platforms: ['darwin', 'win32', 'linux'],
      runtimes: { node: pkg.engines.node },
    },
  };
}
