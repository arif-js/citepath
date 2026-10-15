# Configuration

Citepath reads one JSON config file that lists your documentation sources. The index (a SQLite database) lives in a separate data directory. Nothing is stored anywhere else, and nothing is sent anywhere.

## Where files live

| | Default location | Override |
| --- | --- | --- |
| Config file | macOS: `~/Library/Application Support/citepath/config.json`<br>Linux: `$XDG_CONFIG_HOME/citepath/config.json` (or `~/.config/citepath/config.json`)<br>Windows: `%APPDATA%\citepath\config.json` | `--config <file>` or `CITEPATH_CONFIG` |
| Index | macOS: `~/Library/Application Support/citepath/`<br>Linux: `$XDG_DATA_HOME/citepath/` (or `~/.local/share/citepath/`)<br>Windows: `%LOCALAPPDATA%\citepath\` | `--data-dir <dir>`, `CITEPATH_DATA_DIR`, or `data_dir` in the config |

Precedence is always: command-line flag, then environment variable, then config file, then default.

`citepath init` creates the config file and writes `citepath.schema.json` next to it, so editors such as VS Code can autocomplete and validate the file offline.

## Example

```json
{
  "$schema": "./citepath.schema.json",
  "sources": [
    {
      "id": "react",
      "type": "web",
      "url": "https://react.dev/reference/react",
      "max_pages": 2000
    },
    {
      "id": "team-docs",
      "type": "local",
      "path": "/Users/me/work/handbook/docs",
      "base_url": "https://github.com/acme/handbook/blob/main/docs"
    }
  ]
}
```

You can edit the file by hand or use `citepath add` and `citepath remove`. Invalid files are rejected with an error that names the offending key, for example `sources[1].url: must be an absolute http(s) URL`.

## Source IDs

Every source has an `id`: 1 to 63 lowercase letters, digits, `-` or `_`. Choose it once. Passage IDs, and therefore citations, are derived from it, so renaming a source means re-indexing it under the new ID.

## Website sources (`"type": "web"`)

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | required | Start URL. |
| `path_prefix` | directory of `url` | Only URLs under this path are crawled. `https://react.dev/reference` → `/reference/`. |
| `discovery` | `auto` | `auto`: use a sitemap if one is found (from `sitemap_urls`, robots.txt, or `/sitemap.xml`), otherwise follow links. `sitemap`: sitemap only. `crawl`: follow links only. |
| `sitemap_urls` | | Sitemaps to use instead of auto-detection. Sitemap indexes and `.gz` files are supported. |
| `include`, `exclude` | | Globs matched against the URL path, e.g. `"/docs/v2/**"`. |
| `content_selector` | | CSS selector for the main content region when `<main>`/`<article>` detection picks the wrong part of the page. |
| `query_params` | `drop` | `drop` treats `?a=1` and `?a=2` as the same page; `keep` keeps query strings (tracking parameters are still removed). |
| `max_pages` | 5000 | Pages fetched per sync. Reaching it marks discovery incomplete. |
| `max_depth` | 20 | Link depth from the start URL (link crawling only). |
| `max_response_bytes` | 10 MB | Per page, after decompression. |
| `timeout_ms` | 15000 | Per request, including the body download. |
| `max_redirects` | 5 | Redirects followed per request. Every hop is checked against scope and network rules. |
| `concurrency` | 4 | Parallel requests. |
| `requests_per_second` | 2 | Request rate to the host. A robots.txt `Crawl-delay` slows this further. |
| `allow_private_network` | `false` | Allow private, loopback, and link-local addresses (e.g. an intranet docs site). |
| `mass_delete_threshold` | 0.5 | See [How sync works](sync.md#mass-deletion-guard). |

The crawler identifies itself as `Citepath/<version> (+https://github.com/arif-js/cite-path)` and follows robots.txt for the `Citepath` user agent (or `*`).

Only static HTML is indexed. Pages that need JavaScript to render, PDFs, and other file types are reported in the sync summary and skipped.

## Local sources (`"type": "local"`)

| Key | Default | Meaning |
| --- | --- | --- |
| `path` | required | Directory to index. Relative paths resolve from the config file's directory; `citepath add --path` stores an absolute path. |
| `include` | `**/*.md`, `**/*.mdx`, `**/*.markdown`, `**/*.txt` | File globs relative to `path`. |
| `exclude` | | File globs to skip. |
| `base_url` | | Public URL that corresponds to `path`, used to build clickable citations. |
| `url_style` | `repository` | `repository`: `<base_url>/<file>#L10-L20` (GitHub, GitLab). `site`: `<base_url>/<file without extension>#<heading-slug>` (a published docs site). |
| `max_file_bytes` | 2 MB | Larger files are skipped and reported. |
| `mass_delete_threshold` | 0.5 | See [How sync works](sync.md#mass-deletion-guard). |

Always skipped:
- hidden files and directories
- `node_modules`, `vendor`, `dist`, `build`, `out`, `target`, `coverage`, `__pycache__`, `venv`, and `site-packages`
- anything matched by `.gitignore` files inside `path`
- binary files

Symlinks are followed only when they resolve inside `path`. When the directory is a Git checkout, each document records the commit SHA and whether the file had uncommitted changes.

Without `base_url`, citations are relative paths with line ranges, such as `guides/setup.md#L12-L30`.

## Global settings

| Key | Meaning |
| --- | --- |
| `data_dir` | Index location (overridden by `--data-dir` and `CITEPATH_DATA_DIR`). |
| `mass_delete_threshold` | Default for all sources. |

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CITEPATH_CONFIG` | Config file path. |
| `CITEPATH_DATA_DIR` | Index directory. |
| `CITEPATH_LOG_LEVEL` | `silent`, `error`, `warn` (default), `info`, or `debug`. Logs go to stderr and never include document text. |
| `CITEPATH_API_TOKEN` | Bearer token for `citepath serve`. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | Route crawling through a proxy. Target hosts are still checked against the private-network rules before each request. |
| `NODE_EXTRA_CA_CERTS` | Trust an additional certificate authority (for example, a corporate TLS proxy). |

## Search limits

| Limit | Value |
| --- | --- |
| Results per query | 5 by default, 25 maximum |
| Passages per document in one response (all versions of a page count as one document) | 2 |
| Characters of text per result | 1,500 (`get` returns the full passage) |
| Response size | 32 KB |
| Query length | 512 characters |
| Neighbors returned by `get` | 3 per side |

Responses say when anything was shortened (`truncated`, `query_truncated`).

### Versioned documentation

Sites that keep old versions under a version folder (`/docs/15/…`, `/v2/…`, `/1.4/…`, `/latest/…`) produce near-identical copies of the same section. Search returns one copy of each section and uses the current, unversioned copy when it matches. Pages that exist only in an older version still appear. To search one version, filter with `--path-prefix` (for example `https://nextjs.org/docs/15/`); to leave old versions out of the index entirely, add the source with `--include` or `--exclude` (for example `--include '/docs/app/**'`).

A path segment counts as a version when it looks like `15`, `v2`, `1.4`, `2.x`, `v3.1.0`, `latest`, `stable`, or `current`. Numbers with three or more digits (`404`, `2024`) are not versions.
