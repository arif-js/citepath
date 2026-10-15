# Using Citepath from an AI assistant (MCP)

`citepath mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio. Any MCP client can launch it.

## Tools

All tools are read-only. Adding, syncing, and removing sources is only possible from the CLI, so text inside indexed documents can never trigger changes.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `search` | `query` (required), `limit` (1-25), `source_ids`, `path_prefix` | Ranked passages with `citation_url`, title, heading path, and text, plus `other_versions` (older doc versions that also matched) |
| `get_passage` | `id` (required), `neighbors` (0-3) | The full passage plus surrounding passages |
| `list_sources` | none | Configured sources, document counts, last sync status |

Each tool returns two forms of the same result:
- **Structured output** (`structuredContent`) following the [result contract](result-contract.md).
- **Text output**, where every passage is fenced between `<<<BEGIN UNTRUSTED DOCUMENT TEXT>>>` and `<<<END UNTRUSTED DOCUMENT TEXT>>>` markers. A notice tells the model to treat it as reference material, not instructions.

## Client setup

Citepath is listed in the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.arif-js/citepath`, so clients that browse the registry can install it from there. Each [GitHub release](https://github.com/arif-js/citepath/releases) also includes `citepath-<version>.mcpb`, a bundle that Claude Desktop installs by opening the file and that [Smithery](https://smithery.ai/servers/arif-js/citepath) distributes; it needs Node.js 22.16 or later. However you install the server, add and sync sources with the `citepath` CLI: the MCP tools only search. The steps below set it up by hand.

Index something first:

```sh
citepath add my-docs --path ./docs --sync
```

Then register the server. If `citepath` is not on your `PATH`, use `node` with the absolute path to `dist/interfaces/cli/index.js` instead.

**Claude Code**

```sh
claude mcp add citepath -s user -- citepath mcp
```

`-s` sets where Claude Code saves the server, and so where citepath is available:

| Scope | Available in | Saved in |
| --- | --- | --- |
| `-s user` | All your projects | Your user settings (`~/.claude.json`) |
| `-s local` (the default without `-s`) | Only the project folder you ran the command in | Your user settings, under that project |
| `-s project` | Everyone who works on the project | `.mcp.json` in the project, for committing |

If you added it earlier without `-s`, it is in local scope, and adding it again there reports `MCP server citepath already exists in local config`. To make it available in all your projects, move it to user scope:

```sh
claude mcp remove citepath -s local
claude mcp add citepath -s user -- citepath mcp
```

Run `/mcp` in Claude Code to check that citepath is connected. You don't run `citepath mcp` yourself; Claude Code starts it.

**Claude Desktop, Cursor, and other JSON-configured clients**

```json
{
  "mcpServers": {
    "citepath": {
      "command": "citepath",
      "args": ["mcp"]
    }
  }
}
```

To use a non-default config or index, add `"env": { "CITEPATH_CONFIG": "/path/to/config.json" }`.

The server re-reads the config on every request, so sources you add later are picked up without restarting the client. Run `citepath sync` from a terminal or a scheduled job to keep the index fresh.

## Tips for prompts

- Ask the assistant to cite `citation_url` for every claim.
- Natural-language questions and exact identifiers both work: `how do I rotate API keys`, `getUserName`, `--dry-run`, `ERR_INVALID_TOKEN`.
- Use `get_passage` with `neighbors` when a result is cut off or needs surrounding context.
- Search prefers the current docs version. To ask about an older one ("in Next.js 15…"), the assistant can pass a `path_prefix` from `other_versions`.
