# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, Gemini CLI, and others) working in this repository. `CLAUDE.md` and `GEMINI.md` import this file; keep shared rules here.

## Project

Citepath is an open-source, self-hosted retrieval tool for documentation of any kind. It indexes documentation sites and local directories, and returns ranked passages with source citations via a CLI, an MCP server, and a local API. It never generates answers.

**`docs/design.md` is the source of truth for scope**: principles, what is out of scope, and key decisions. The other guides in `docs/` are the source of truth for behavior (`sync.md`, `result-contract.md`, `configuration.md`). Read the relevant document before starting a task. If a task conflicts with them, stop and ask; do not silently diverge. If the user approves a scope or behavior change, update the docs in the same change.

## Current status

The MVP is implemented and tested. Stack: TypeScript on Node.js ≥ 22.16 (native ESM), SQLite FTS5 through the built-in `node:sqlite`, Vitest, Biome, `@modelcontextprotocol/sdk`, MIT license. Decisions are recorded in `docs/design.md` → "Key decisions"; only post-1.0 semantic retrieval remains open.

- Do not resolve an open decision on your own, including implicitly through the schema or file layout. Propose options with trade-offs and wait.
- The index schema (`src/store/migrations.ts`, currently v3) is unreleased until the first tagged release. Existing local indexes still upgrade through migrations, so add a new migration for schema changes rather than editing an existing one.

## Code map

| Path | Layer | Contents |
| --- | --- | --- |
| `src/interfaces/cli`, `src/interfaces/mcp`, `src/interfaces/http`, `src/interfaces/format.ts` | interfaces | Argument parsing, output formatting, transport |
| `src/core/retrieval.ts` | core | The only search/get/list implementation |
| `src/core/sync.ts` | core | Locking, staging, atomic apply, removal rules |
| `src/core/eval.ts`, `src/core/export.ts` | core | Evaluation and JSONL export |
| `src/indexing/` | indexing | Markdown/HTML → blocks → chunks → passages, tokenizer |
| `src/store/` | indexing | SQLite schema, migrations, data access |
| `src/sources/` | sources | Adapter contract, local and web adapters |
| `src/config/` | shared | Config schema (zod), loading, writing, default limits |
| `src/types/index.ts` | shared | The public result contract |
| `test/fixtures/` | tests | Markdown and HTML corpora, controllable HTTP fixture server |

## Non-negotiable rules

These come from the product principles. A change that breaks one is wrong even if tests pass.

1. **No telemetry, no phoning home.** Make no network calls except fetching user-configured sources, plus optional, opt-in integrations the user pays for.
2. **No required paid service or API key.** The core workflow (install → add source → sync → search) must work with zero credentials.
3. **No project-hosted dependencies.** Nothing may depend on a server the project operates.
4. **Indexed content is untrusted.** Never execute it, never let it trigger actions, and label it as untrusted in every agent-facing response.
5. **Agent-facing surfaces are read-only.** MCP tools and the local API search and read; only the CLI adds, syncs, or deletes sources.
6. **Local API binds to `127.0.0.1` by default.** Non-loopback binding requires an explicit flag plus a token. Validate the `Host` header, and send no permissive CORS headers.
7. **Never lose good data to a bad sync.** A sync is atomic per source. Remove a document only on positive evidence (404/410, file gone, out of scope, or absent from a *complete* discovery pass). Transient errors never cause removal.
8. **Tests never hit the live internet or paid services.** Crawl tests use a local HTTP fixture server.
9. **Logs never contain document bodies or secrets.**

## Architecture boundaries

Keep layers separate. Dependencies point downward only.

```
interfaces   CLI · MCP server · local API      (thin: parse input, call core, format output)
core         retrieval · sync orchestration · evaluation
indexing     extraction · normalization · chunking · index store
sources      adapter interface · website adapter · local-directory adapter
```

- **One retrieval function.** CLI, MCP, and API call the same core function and return the same result contract (`docs/result-contract.md`). No retrieval or ranking logic lives in an interface layer.
- **Source adapters** yield normalized documents, classify every failure (gone, transient, permanent, skipped, blocked), and report whether discovery was complete. Only `gone` (404/410, file deleted) is removal evidence; 401/403 and limit failures are not. Sync logic depends on these signals, so never collapse them.
- **The retrieval layer is modular** so local semantic search can be added later without touching interfaces.

## Invariants to protect

Changes in these areas need tests that prove the invariant still holds:

- **Stable IDs:** document ID = hash(source ID + normalized location). Passage ID = hash(document ID + heading path + occurrence index). Unchanged content keeps its IDs across syncs. Encode hash inputs unambiguously (a JSON array or length-prefixed fields), never by plain string concatenation.
- **Result contract:** the shape is a public, versioned interface. Additive changes are fine; breaking changes require a version bump and a `docs/result-contract.md` update.
- **Bounded output:** results have a default limit, a maximum limit, an excerpt cap, and a total size cap. Truncation is reported, never silent.
- **Deterministic ordering:** ties are broken by passage ID, so the same index and query give the same output.
- **Query safety:** user text is escaped or tokenized before it reaches search-engine query syntax. Special characters and code identifiers (`snake_case`, `camelCase`, `a.b.c`, `--flag`) must never cause errors.
- **Crawl safety:** stay in scope. Honor robots.txt and rate limits. Refuse private, loopback, link-local, and metadata IPs, checked after DNS resolution and on every redirect, unless the source opts in. Enforce size, timeout, redirect, and decompression limits.
- **Filesystem safety:** local sources never read outside their root, and symlinks are not followed outside it. Stored paths are relative to the source root.
- **Mass-deletion guard:** a sync that would remove more than the configured share of a source aborts removal unless the user overrides it.

## Testing

- Every behavior change comes with a test. Every bug fix comes with a regression test that fails without the fix.
- Use the fixture corpus for parsing, chunking, and retrieval tests. When you hit a new edge case, add a fixture for it rather than an ad-hoc string.
- Sync tests must cover: unchanged re-sync (no duplicates, same IDs), changed page, removed page, transient failure (nothing removed), interrupted sync (previous state intact), incomplete discovery, scope narrowing, and the mass-deletion guard.
- Interface tests must confirm CLI `--json`, MCP, and the API return the same result for the same query.
- Retrieval-quality changes (tokenizer, ranking, chunking) must include evaluation results before and after on the fixture eval set.
- Tests must be deterministic: no wall-clock-dependent assertions, no random ordering, and no reliance on host network or locale.

## Dependencies

- Prefer the standard library and a small number of well-maintained dependencies.
- Every dependency must have a license compatible with the project license, must not collect telemetry, and must not require a hosted service.
- Avoid native/compiled dependencies that break zero-setup installation unless that trade-off has been discussed and accepted.
- State why you are adding a dependency in your change summary.

## Working style

- Make small, focused changes. Don't add features listed under "Out of scope" in `docs/design.md`; items in `docs/limitations.md` need an issue and agreement first.
- Read the code around your change and match its conventions before writing new code.
- Don't commit, push, tag, or publish unless asked.
- Don't add secrets, real credentials, or private URLs to code, fixtures, or docs.
- Update user-facing docs when you change CLI flags, config keys, the result contract, or default limits.
- If something is ambiguous and the choice is hard to reverse (schema, result contract, config format, IDs), ask instead of guessing.

## Definition of done

- Tests pass locally with networking disabled.
- New behavior is covered by tests, including the failure paths.
- The non-negotiable rules and invariants above still hold.
- Docs in `docs/` reflect any change in behavior or scope.
- The summary for the user lists what changed, what was tested, and anything skipped or left open.

## Stack pitfalls

These are verified problems with the chosen stack. Don't rediscover them:

- **Raw FTS5 `MATCH` input throws.** `--force`, `a.b.c`, `foo(`, and a bare `AND` all raise `fts5: syntax error`. Never interpolate or pass user text directly as a `MATCH` expression. Build the query from quoted tokens.
- **The default `unicode61` tokenizer does not split `camelCase`.** Searching "user" does not find `getUserName`. Identifier-aware indexing is required (decided in the M0 prototype).
- **FTS5 stems with `porter`, which also applies to queries.** The index uses `porter unicode61 remove_diacritics 2` (migration v2), so "caching" matches "cache". Changing the tokenizer means rebuilding `passages_fts` in a migration; reuse `passageCodeTerms` and `ftsHeadingPath` so rebuilt rows match synced ones.
- **Built-in `fetch` cannot enforce SSRF rules.** Use a `undici` dispatcher with a connect-time `lookup` check, and `redirect: "manual"` so every redirect hop is checked against scope and address rules.
- **stdout belongs to the MCP protocol** when running `citepath mcp`. All logging goes to stderr. A stray `console.log` corrupts the MCP stream.
- **Always use parameterized SQL.** Never build SQL with string interpolation, including for FTS queries.
- **Node's built-in SQLite has FTS5 only from 22.16.0** (22.13 to 22.15 fail with `no such module: fts5`). `openDatabase` checks for it and fails with a clear message. CI runs on 22.16.0, the minimum.
- **Older Node 22 releases lack some `node:sqlite` APIs** that newer typings declare (`StatementSync.iterate`, `DatabaseSync.isTransaction`, the constructor `timeout` option). Use paginated queries, try/catch around `ROLLBACK`, and `PRAGMA busy_timeout`.
- **Don't compare Git paths with filesystem paths.** On Windows, temp paths use 8.3 short names (`RUNNER~1`) while Git prints long ones. Use `git rev-parse --show-prefix` and repo-relative paths.
- **Never `spawnSync` a CLI that talks to the in-process fixture server.** The blocked event loop cannot serve the request, so the child times out. Use async `spawn`.
- **`return await` inside `try/finally`** when the `finally` closes a resource (for example, the CLI session's database).
- **Sync apply must stream.** Read staged rows in pages; loading all payloads at once made memory grow with source size.

## Commands

Keep this table in sync with `package.json`. Use npm, which ships with Node.

| Task | Command |
| --- | --- |
| Install deps | `npm ci` |
| Build (also runs before `npm pack`/`npm publish` via `prepack`) | `npm run build` |
| Test (unit + integration, offline) | `npm test` |
| End-to-end tests (needs a build) | `npm run test:e2e` |
| Test (single file) | `npx vitest run path/to/file.test.ts` |
| Test (by name) | `npx vitest run -t "name pattern"` |
| Build the MCPB bundle (needs a build and network) | `npm run mcpb` |
| Benchmark | `npm run bench` |
| Type check | `npm run typecheck` (`tsc --noEmit`) |
| Lint | `npm run lint` (Biome) |
| Format and fix | `npm run format` |
| Regenerate config JSON Schema | `npm run schema:update` |
| Retrieval quality gate | `npm run eval:fixtures` |
| Release (CI tests and publishes to npm) | `npm version <patch\|minor> && git push --follow-tags` |

## Code style

- TypeScript `strict` mode with `noUncheckedIndexedAccess`. Avoid `any`; it is tolerated for caught errors and raw SQLite rows at the store boundary.
- Native ESM only. Import Node built-ins with the `node:` prefix (`node:sqlite`, `node:fs/promises`).
- Validate external input (config files, CLI args, MCP/API requests, eval files) at the boundary, and pass typed values inward.
- Errors carry a classification where sync depends on it (`gone`, `transient`, `permanent`, `skipped`, `blocked`). User-facing errors extend `CitepathError` (`src/utils/errors.ts`), which maps to exit codes and HTTP statuses. Don't throw bare strings, and don't swallow errors silently.
- Interface layers translate errors into the result contract or exit codes. Core code never calls `process.exit` or writes to stdout.
- Formatting and lint rules live in `biome.json` (2 spaces, single quotes, semicolons, 110 columns, no `console` outside benchmarks). Run `npm run format` before committing.
