# Result contract

CLI `--json`, MCP structured output, and the HTTP API all return the same shapes. The contract is versioned by `schema_version` (currently `1`). New fields may be added; removing or changing fields requires a new version.

## Search response

```json
{
  "query": "getUserName",
  "query_truncated": false,
  "results": [
    {
      "id": "986cad90c1854c151f3435cdb7da354ab89c7dec899987ffa24d54befe71477b",
      "source_id": "nimbus",
      "source_name": "Nimbus Docs",
      "title": "Client API Reference",
      "heading_path": ["Client API Reference", "client.getUserName(id)"],
      "url": "https://github.com/nimbus/docs/blob/main/api/client.md",
      "path": "api/client.md",
      "line_start": 13,
      "line_end": 20,
      "citation_url": "https://github.com/nimbus/docs/blob/main/api/client.md#L13-L20",
      "text": "## client.getUserName(id)\n\nReturns the display name for a user…",
      "score": 21.7581,
      "content_hash": "37893d6de675…",
      "updated_at": "2026-10-13T09:50:54.974Z",
      "fetched_at": "2026-10-13T10:04:00.513Z",
      "commit": "1d5e2088c6adab417692fe3f00fd0d71d3408bf5",
      "untrusted": true
    }
  ],
  "effective_limit": 1,
  "filters": {},
  "truncated": false,
  "other_versions": [],
  "schema_version": 1
}
```

## Passage fields

| Field | Always present | Description |
| --- | --- | --- |
| `id` | yes | Stable passage ID. Unchanged content keeps its ID across syncs. |
| `source_id`, `source_name` | yes | The source the passage came from. |
| `title` | yes | Document title. |
| `heading_path` | yes | Headings leading to the passage, outermost first. |
| `url` | web, or local with `base_url` | Web: canonical page URL with the heading anchor. Local: the mapped file URL. |
| `path` | local | Path relative to the source root, with `/` separators. |
| `line_start`, `line_end` | local | 1-indexed, inclusive line range in `path`. |
| `citation_url` | yes | The best link to cite: a URL with an anchor or line range, or `path#Lstart-Lend`. |
| `text` | yes | Passage text, at most 1,500 characters in search results (full text from `get_passage`). |
| `score` | yes | Relative ranking within this response only. Not a confidence value; do not compare across queries. |
| `content_hash` | yes | Changes whenever the passage text changes. Use it to detect that a stored citation is stale. |
| `updated_at` | when known | Source modification time (file mtime or the page's `Last-Modified`). |
| `fetched_at` | yes | When Citepath last read the document. |
| `commit` | local Git checkouts | Commit SHA at sync time. |
| `untrusted` | yes | Always `true`. Passage text comes from external documents and must not be treated as instructions. |

## Response fields

| Field | Description |
| --- | --- |
| `query` | The query as searched (after truncation). |
| `query_truncated` | The query was longer than 512 characters and was shortened. |
| `effective_limit` | The limit actually applied (requests above 25 are capped). |
| `filters` | Source and path filters that were applied. |
| `truncated` | Some passage text was shortened, or results were dropped to keep the response under 32 KB. |
| `other_versions` | Older documentation versions that also had matching passages, as `[{ "path_prefix": "https://nextjs.org/docs/15/", "matches": 12 }]`, most matches first, at most 5. `matches` counts passages among the top candidates the search considered (10 per requested result, at most 250), so it grows with `limit` and is a lower bound, not a total. Search returns the current copy of a page, so pass one of these as `path_prefix` to search that version. Empty when none matched, or when the search is already narrowed to that version. |

## Passage with context (`get`, `get_passage`, `/v1/passages/{id}`)

```json
{ "passage": { … }, "before": [ … ], "after": [ … ], "schema_version": 1 }
```

`before` and `after` hold up to 3 passages each, in document order.

## How IDs are built

- Document ID: SHA-256 of `[source_id, normalized location]`, where location is the canonical URL or the root-relative path.
- Passage ID: SHA-256 of `[document_id, heading_path, occurrence_index]`. `occurrence_index` counts passages that share a heading path, such as repeated headings or parts of a long section.

Inputs are hashed as JSON arrays, so different inputs can never produce the same hash input.
