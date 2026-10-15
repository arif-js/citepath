# Citepath

Self-hosted search over your technical documentation, with citations, for AI assistants and apps.

> **Status: pre-release (0.1).** Expect breaking changes before 1.0.

## What it does

- **Indexes your docs:** documentation websites (from the sitemap or by following links, respecting robots.txt) and local Markdown, MDX, or text folders.
- **Returns cited passages:** each search result links to the exact page section or file lines it came from.
- **Understands code and plain English:** `getUserName`, `--dry-run`, and "how do I configure caching" all work.
- **Connects to AI assistants:** Claude Code, Cursor, and other MCP clients search your docs; your own tools use the CLI or a local HTTP API.
- **Runs locally:** no account, no API keys, no telemetry. Assistants get read-only access, and a failed sync never deletes good data.

Citepath finds passages; it doesn't write answers. Your assistant writes the answer from those passages and cites them, so you can check every claim.

## Demo

Index the current Next.js docs once, then search them:

```sh
citepath add nextjs --url https://nextjs.org/docs/app --include '/docs/app/**' --sync
```

![Searching the Next.js docs with citepath](docs/assets/demo.gif)

The same search works inside your assistant:

> **You:** Using citepath, how do I set how long cached data lives in Next.js?
>
> **Claude:** Add `'use cache'` to the function and call `cacheLife('hours')`, or pass `{ stale, revalidate, expire }`. This requires `cacheComponents: true` in `next.config.ts`.
> Sources: [cacheLife](https://nextjs.org/docs/app/api-reference/functions/cacheLife#preset-cache-profiles), [use cache](https://nextjs.org/docs/app/api-reference/directives/use-cache#time-based-revalidation), [cacheComponents](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents#usage)

## Who it's for

- **Developers using AI coding assistants:** answers based on the current docs of your frameworks and services, not on what the model remembers.
- **Builders of AI tools:** a retrieval layer that returns ranked, cited passages as JSON for any model.
- **Small teams:** internal wikis, runbooks, and docs folders searchable by assistants, without a hosted platform.
- **Open-source maintainers:** an easy way for users to connect your project's docs to their assistants.

## Why not RAG or web search?

**It is RAG: the retrieval half, run locally.** Instead of embeddings and a vector database, Citepath uses a keyword index. That means no embedding API or keys, exact matches on identifiers like `cacheLife`, the same results for the same query, and citations down to the section. The trade-off: it matches words, not meaning, so "sign in" won't find a page that only says "authentication".

**Web search is better for broad, one-off questions.** Citepath is better when:

- **the docs are private:** internal wikis, runbooks, and repo docs aren't on the web;
- **the version matters:** you choose what's indexed, and search prefers the current copy of a page over old versions;
- **you want less to read:** on the Next.js docs, 5 cited passages for "how do I set the cache lifetime" are about 4,200 characters, while the five pages they come from hold about 51,000 characters of text (the `cacheLife` page alone is about 1 MB of HTML);
- **you're offline,** or your assistant has no web search.

**"The model already knows the docs."** Only the version it was trained on. Fast-moving APIs, such as Next.js `cacheLife`, `cacheComponents`, or the new two-argument `revalidateTag`, are where models answer from outdated memory.

**"Why not paste the docs into the prompt?"** That works for a few pages. The Next.js docs are 845 pages; search picks the few passages that matter.

**Costs and limits.** Measured on a laptop with the Next.js and Vercel docs:

- **Free to run:** no account, API keys, or per-search fees. Searches take milliseconds (p95 13 ms across about 30,000 passages).
- **Setup time and disk:** syncing 845 Next.js pages took about 7.5 minutes at the polite default of 2 requests per second; the two sites use 83 MB.
- **Freshness:** results are as current as your last sync. There is no built-in scheduler, so run `citepath sync` from cron.
- **Not indexed:** sites that need JavaScript to render, PDFs, and docs behind a login.
- **Single user:** one API token, no per-user permissions.

Use something else for broad questions (web search), meaning-based search (embeddings), or team access control. See [Known limitations](docs/limitations.md).

## Quick start

Requires Node.js 22.16 or later.

```sh
npm install -g citepath

citepath add my-docs --path ~/work/project/docs --sync
citepath search "how do I configure authentication"

# Connect Claude Code (all projects)
claude mcp add citepath -s user -- citepath mcp
```

Run `/mcp` in Claude Code to check the connection. For other assistants and scope options, see [MCP setup](docs/mcp.md). To run from source, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

| Command | What it does |
| --- | --- |
| `citepath init` | Create the config file. |
| `citepath add <id> --url <url>` | Add a docs website. Repeat `--url` to add several. Add `--sync` to index right away. |
| `citepath add <id> --path <dir>` | Add a local docs folder. Repeat `--path` to add several. |
| `citepath remove <id>` | Remove a source and its indexed content. |
| `citepath sync [id...]` | Fetch and index sources, with live progress. Run again to pick up changes or retry failures. |
| `citepath sources` | List sources with document counts and last sync status. |
| `citepath status [id]` | Show index locations, or a source's last sync: failures, removals, warnings. |
| `citepath search "<query>"` | Find matching passages with citations. Filter with `--source`, `--path-prefix`, `--limit`. |
| `citepath get <passage-id>` | Show a passage in full, with `--neighbors <n>` for surrounding sections. |
| `citepath mcp` | MCP server for AI assistants. Your assistant starts it; you don't run it yourself. |
| `citepath serve` | Read-only local HTTP API on `127.0.0.1:7345`. |
| `citepath export`, `eval`, `compact`, `unlock` | Export as JSONL, measure search quality, optimize the index, clear a stuck sync lock. |

Global options: `--json`, `--quiet`, `--config <file>`, `--data-dir <dir>`. See the [CLI reference](docs/cli.md) for all options.

## Documentation

[CLI](docs/cli.md) · [Configuration](docs/configuration.md) · [How sync works](docs/sync.md) · [MCP setup](docs/mcp.md) · [Local API](docs/api.md) · [Result contract](docs/result-contract.md) · [Evaluation](docs/evaluation.md) · [Limitations](docs/limitations.md) · [Design](docs/design.md)

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), open an [issue](https://github.com/arif-js/cite-path/issues) before a larger feature, and report security problems privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
