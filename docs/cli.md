# CLI reference

All commands accept these global options:

| Option | Meaning |
| --- | --- |
| `--config <file>` | Config file (default: platform config directory, or `CITEPATH_CONFIG`). |
| `--data-dir <dir>` | Index directory (or `CITEPATH_DATA_DIR`). |
| `--json` | Machine-readable output on stdout. Errors are printed as `{"error": {"code", "message"}}` on stderr. |
| `-v, --verbose` | Progress logs on stderr. |
| `-q, --quiet` | Errors only. |
| `-h, --help` | Help for the command. |

Commands never prompt when stdin/stdout is not a terminal; anything that would need confirmation requires a flag instead.

## Setup

### `citepath init`

Creates the config file (and its JSON Schema) if it does not exist.

### `citepath add <id> --url <url>... | --path <dir>... [options]`

Adds a source to the config. Repeat `--url` or `--path` to add several sources in one command, for example `citepath add team --path ./docs --path ../api/docs`. A single value uses `<id>` as given; several values get `<id>-1`, `<id>-2`, ... in the order given, and `--name` becomes `<name> (1)`, `<name> (2)`, .... All other options apply to every source. One command adds either web or local sources, not both.

Every value is checked before anything is written; if one is invalid, nothing is added:

- `--url` must be an absolute `http://` or `https://` URL with a host and no user name or password. `nextjs.org/docs` is rejected with a hint to use `https://nextjs.org/docs`.
- `--path` must be an existing directory. Relative paths resolve from the current directory and are stored as absolute paths.
- The same location may not be given twice, and none of the resulting IDs may already exist.

With `--json`, the output is `{ "added": [<source>, ...] }`, a list even for one source. Options:

| Option | Applies to | Config key |
| --- | --- | --- |
| `--name <name>` | both | `name` |
| `--include <glob>` (repeatable) | both | `include` |
| `--exclude <glob>` (repeatable) | both | `exclude` |
| `--discovery auto\|sitemap\|crawl` | web | `discovery` |
| `--max-pages <n>`, `--max-depth <n>` | web | `max_pages`, `max_depth` |
| `--content-selector <css>` | web | `content_selector` |
| `--allow-private-network` | web | `allow_private_network` |
| `--base-url <url>`, `--url-style repository\|site` | local | `base_url`, `url_style` |
| `--sync` | both | Sync immediately after adding. |

Other settings (rate limits, timeouts) can be edited in the config file. See [Configuration](configuration.md).

### `citepath remove <id> [--yes]`

Removes the source from the config and deletes all of its indexed content. Asks for confirmation in a terminal; requires `--yes` otherwise. Also removes index data for sources you deleted from the config by hand.

## Indexing

### `citepath sync [id...] [--allow-mass-delete]`

Syncs the given sources, or all of them. Prints a summary per source. Press Ctrl-C to stop; the index is left unchanged. See [How sync works](sync.md) for removal rules and exit codes.

While a sync runs, progress goes to stderr. In a terminal it is one status line, updated in place: items fetched so far (ok, failed, excluded, gone), elapsed time, and the current URL or file. When stderr is not a terminal, a plain line is printed every 100 items and when the sync starts writing to the index. `--json` and `--quiet` turn progress off. Web sources are crawled at 2 requests per second by default, so a large site can take many minutes; the counter shows the sync is still working.

### `citepath sources`

Lists sources with document and passage counts and the last sync status.

### `citepath status [id]`

Without an ID: config path, index path, schema version, and all sources. With an ID: the full summary of the last sync (failures, removals, warnings) and any lock.

### `citepath unlock <id>`

Clears a sync lock left behind by a crashed process.

### `citepath compact`

Optimizes the search index and reclaims disk space after large deletions.

## Searching

### `citepath search <query...> [--limit <n>] [--source <id>]... [--path-prefix <prefix>]`

Searches all configured sources. `--path-prefix` keeps results whose URL or file path starts with the prefix. Human output fences each passage as untrusted document text; `--json` prints the [result contract](result-contract.md).

### `citepath get <passage-id> [--neighbors <n>]`

Prints a passage in full, with up to 3 neighboring passages before and after it.

## Data

### `citepath export [--source <id>]... [--output <file>]`

Writes every source, document, and passage as JSON Lines (one JSON object per line, with a `type` field of `export`, `source`, `document`, or `passage`). Writes to stdout unless `--output` is given.

### `citepath eval <file> [--k <n>] [--min-recall <0-1>]`

Measures retrieval quality. See [Evaluation](evaluation.md).

## Integrations

### `citepath mcp`

Runs the MCP server over stdio. See [MCP setup](mcp.md). An MCP client starts this command; it waits silently for the client and writes only protocol messages to stdout. When you run it by hand in a terminal, it prints a short note on stderr saying so (`--quiet` hides it). Press Ctrl-C to exit.

### `citepath serve [--host <host>] [--port <port>] [--token <token>]`

Runs the read-only local HTTP API (default `127.0.0.1:7345`). See [Local API](api.md).
