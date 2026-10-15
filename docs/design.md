# Design

This document records what Citepath is for, the principles every change must respect, what is deliberately out of scope, and the key technical decisions with their reasons. Behavior details live in the other guides in this folder.

## Purpose

Citepath indexes a team's technical documentation and returns relevant passages with source citations to AI assistants and applications. The core workflow: add a source, sync it, search it through MCP, the CLI, or the local API, and get passages that link back to where they came from. Citepath retrieves; it never generates answers.

It is built for:

- developers building AI assistants over product or engineering documentation;
- small teams that want cited answers without adopting a hosted knowledge platform;
- open-source maintainers who want to expose project documentation to MCP clients.

## Principles

- **No project-paid services.** Running Citepath never depends on hosting, APIs, or infrastructure the project pays for.
- **Free to run.** The core workflow works without API keys. Any optional integration must be opt-in, name the provider and likely cost to the user, and keep a free local path where practical.
- **Self-hosted and inspectable.** Users control their data and can inspect, export, and delete it. No telemetry, no accounts.
- **Source-grounded.** Every result carries enough provenance to verify where it came from.
- **Small, dependable core.** Sync correctness and retrieval quality come before a broad catalog of integrations.
- **Safe by default.** Indexed text is untrusted. Agent-facing interfaces are read-only, network listeners bind to loopback, and crawling stays inside configured boundaries.
- **Never lose good data to a bad sync.** A failed, partial, or interrupted sync leaves the last good index in place.

## Out of scope

Proposals in these areas will be declined unless the project's direction changes:

- hosted SaaS, paid plans, or infrastructure operated by the project;
- mandatory third-party API keys, or paid embedding and reranking services;
- a chatbot UI, website widget, Slack or Discord bots, helpdesk agents, or answer generation;
- enterprise identity, permissions, analytics, and compliance dashboards;
- MCP or API operations that modify sources or the index;
- a headless browser for crawling;
- many third-party connectors before the existing source types are solid.

Current gaps that may be addressed later are listed in [Known limitations](limitations.md).

## Key decisions

| Area | Decision | Why |
| --- | --- | --- |
| Runtime | TypeScript on Node.js ≥ 22.16, native ESM | One language for CLI, MCP, and API. 22.16 is the first Node 22 whose built-in SQLite includes FTS5 (22.13 to 22.15 lack it). |
| Storage and search | SQLite with FTS5 and BM25, through the built-in `node:sqlite` | Zero-setup install: no database server, no native add-ons to compile. |
| Search approach | Keyword search with code-aware tokenization; no semantic search yet | Works offline and free with deterministic results. Identifier parts are indexed in a separate column so `user` finds `getUserName`. Queries are always built from quoted tokens, so user input can never break the query syntax. English word forms match through Porter stemming. The page title is indexed once per passage (not again as the top heading), so short sections don't rank on the page title alone. |
| Configuration | One JSON file in the platform config directory; sources live there, the database holds only index and sync state | Reviewable and version-controllable. A JSON Schema is written alongside it for editor validation. Global by default so MCP clients find it from any directory. |
| Source IDs | User-chosen, immutable slugs | Passage IDs derive from them, so citations stay stable. |
| Sync | Stage everything, then apply in one transaction; remove only on positive evidence | Interrupted or failed syncs cannot corrupt or empty the index. See [How sync works](sync.md). |
| Web fetching | `undici` with a connect-time address check and manual redirects | Node's built-in `fetch` cannot check resolved IP addresses, which SSRF protection needs on every hop. |
| Markdown parsing | `markdown-it` | Reports source line positions, which local-file citations need. |
| Chunking | Split along headings; split long sections on block boundaries; keep small sections separate | Each citation points at the right heading. Merging small sections would attach text to the wrong anchor. |
| Raw page cache | Not stored | Parser upgrades re-fetch pages instead, avoiding stored copies of raw HTML. |
| Platforms | macOS, Linux, and Windows, tested in CI on Node 22.16 and 24 | |
| Tooling | Vitest (network blocked in tests), Biome | |
| Distribution | npm package `citepath`, published from CI on version tags with provenance | Matches the command name. Trusted publishing keeps npm tokens out of the repository, and provenance links each version to the commit that built it. |
| License | MIT | |

## Performance targets

Measured with `npm run bench` (10,000 Markdown files, about 100,000 passages, on an Apple Silicon laptop):

| Target | Result |
| --- | --- |
| Search p95 under 250 ms on a warm index | p95 ≈ 149 ms |
| Sync memory bounded regardless of source size | about 41 MB extra |
| Index 10,000 pages on a laptop | about 10 s, 207 MB index |

## Open questions

- Revisit semantic retrieval with an optional local model after the first release.
