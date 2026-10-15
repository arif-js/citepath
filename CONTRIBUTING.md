# Contributing to Citepath

Thanks for helping. Bug reports, documentation fixes, fixture pages that break extraction, and code changes are all welcome.

## Before you start

- **Bugs:** open an issue with the command you ran, what you expected, and what happened. Output of `citepath status <id> --json` or `--json` search results helps.
- **Features:** open an issue first. Citepath keeps a deliberately small core; [docs/design.md](docs/design.md) lists the principles and what is out of scope, and [docs/limitations.md](docs/limitations.md) lists known gaps.
- **Security issues:** do not open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

Requires Node.js 22.16 or later.

```sh
git clone https://github.com/arif-js/citepath.git
cd citepath
npm ci            # installs dependencies
npm run build     # builds dist/ (npm link then puts `citepath` on your PATH)
```

| Task | Command |
| --- | --- |
| Unit and integration tests (no network access) | `npm test` |
| End-to-end tests against the built CLI | `npm run build && npm run test:e2e` |
| Retrieval quality gate on the fixture corpus | `npm run eval:fixtures` |
| 100k-passage benchmark (slow) | `npm run bench` |
| Lint / format | `npm run lint` / `npm run format` |
| Type check | `npm run typecheck` |
| Regenerate the config JSON Schema | `npm run schema:update` |

Run a single test file with `npx vitest run test/unit/tokenizer.test.ts`, or by name with `npx vitest run -t "pattern"`.

Stack: TypeScript (ESM) on Node.js, SQLite FTS5 via the built-in `node:sqlite` (no native add-ons), Vitest, Biome, and the MCP TypeScript SDK.

## Project layout

| Path | Contents |
| --- | --- |
| `src/interfaces/` | CLI, MCP server, HTTP API (thin layers over core) |
| `src/core/` | Retrieval, sync, evaluation, export |
| `src/indexing/` | Markdown/HTML extraction, chunking, tokenizer |
| `src/sources/` | Local-folder and website adapters |
| `src/store/` | SQLite schema, migrations, data access |
| `src/config/` | Config schema, loading, default limits |
| `test/fixtures/` | Markdown and HTML corpora and a local HTTP fixture server |

[AGENTS.md](AGENTS.md) describes the architecture rules, invariants, and known pitfalls in detail. It is written for AI coding agents but applies equally to human contributors.

## Rules every change must keep

- No telemetry and no network calls except to sources the user configured.
- No required paid service or API key.
- Indexed text is untrusted; MCP and API stay read-only.
- A failed or interrupted sync never removes documents.
- Tests never reach the internet. Crawl tests use the local fixture server, and a guard blocks other connections.

## Pull requests

1. Keep each pull request focused on one change.
2. Add tests for new behavior, and a regression test for every bug fix.
3. If you change tokenization, ranking, or chunking, include `npm run eval:fixtures` results before and after.
4. Update the docs in `docs/` when you change CLI flags, config keys, defaults, or the result contract.
5. Make sure `npm run lint`, `npm run typecheck`, `npm test`, and `npm run test:e2e` pass. CI runs them on Linux, macOS, and Windows.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

## Releasing (maintainers)

Releases are published by CI from a version tag; nobody publishes from a laptop.

```sh
npm version patch        # or minor; updates package.json and creates the tag
git push --follow-tags   # pushes the commit and the tag
```

The [Release workflow](.github/workflows/release.yml) then runs lint, type check, tests, end-to-end tests, and the eval gate; publishes the package to npm with provenance; and creates a GitHub Release with the same tarball and SHA-256 checksums. npm publishing uses trusted publishing, so no npm token is stored anywhere; npm accepts releases only from this workflow.

`npm version` also copies the new version into `server.json`, and the workflow then publishes it to the [MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.arif-js/citepath`, logging in through GitHub OIDC ([MCP Registry workflow](.github/workflows/mcp-registry.yml)). It first waits for npm to serve the new version. If the registry step fails, run that workflow by hand on `main` to retry. The registry checks that the `mcpName` in the published package matches the name in `server.json`; a unit test keeps the two files in step.

The release also attaches `citepath-<version>.mcpb`, an [MCPB bundle](https://github.com/modelcontextprotocol/mcpb) of the built CLI and its production dependencies, built by `npm run mcpb` ([scripts/build-mcpb.mjs](scripts/build-mcpb.mjs); the manifest comes from [scripts/mcpb-manifest.mjs](scripts/mcpb-manifest.mjs)). Smithery and Claude Desktop install the server from it. To update the [Smithery listing](https://smithery.ai/servers/arif-js/citepath), upload the new bundle there or run `npx @smithery/cli mcp publish ./citepath-<version>.mcpb -n arif-js/citepath`.
