# How sync works

`citepath sync` brings the index up to date with your sources. The guiding rule is that **a bad sync never destroys good data**.

## What happens during a sync

1. Citepath takes a lock for the source, so two syncs of the same source cannot run at once.
2. It reads every file (local) or fetches every page (web) and records what it found in a staging area. Searches keep using the existing index the whole time.
3. When the source has been read, all changes are applied in **one database transaction**: new documents are added, changed ones replaced, and removals applied.

If the sync fails or is interrupted before step 3 finishes (Ctrl-C, a crash, `kill -9`, power loss), nothing changes. The index stays exactly as it was and remains searchable.

## When a document is removed

Only on positive evidence:

| Situation | Removed? |
| --- | --- |
| The page returns 404 or 410, or the file was deleted | Yes |
| The page is now outside the configured scope, excluded by a glob, disallowed by robots.txt, or marked `noindex` | Yes |
| The page now redirects to another page, or declares another page as canonical | Yes, and its URL is recorded as an alternate of that page |
| The page was not found during a **complete** crawl | Yes |
| Timeout, connection error, DNS failure, 5xx, 429 | **No**, the previous version is kept |
| 401, 403 (often bot protection), other 4xx, too large, too many redirects | **No**, reported as a failure |
| The page looks like an error page served with HTTP 200 ("soft 404"), or has almost no text (JavaScript-rendered) | **No**, reported as a failure |
| The source directory is missing, or robots.txt cannot be fetched | **No**, the whole sync fails or is marked incomplete |

### Complete and incomplete discovery

A crawl is incomplete when Citepath could not see the whole site, because:

- robots.txt or a sitemap could not be fetched;
- `max_pages` or `max_depth` was reached;
- some pages failed, so their links were never followed.

After an incomplete crawl, Citepath does not remove documents just because it did not see them. The sync summary lists the reasons.

## Mass-deletion guard

If one sync would remove more than half of a source's documents (and more than 3), Citepath removes nothing and tells you why. This protects you from a site outage, a site that briefly serves empty pages, or a mistyped path. If the removal is expected (for example, you deleted a docs section on purpose), run:

```sh
citepath sync <id> --allow-mass-delete
```

The threshold can be changed with `mass_delete_threshold` (0 to 1) per source or globally.

## Changes and stable IDs

- Unchanged content keeps the same passage IDs across syncs, so citations stay valid.
- An edited section keeps its ID and gets a new `content_hash`.
- Renamed or moved files and pages get new IDs.
- Re-syncing a website sends `If-None-Match`/`If-Modified-Since`, so unchanged pages are not downloaded again.
- Upgrading Citepath to a version with a new parser, or changing a source's settings, re-processes every document on the next sync.

## Duplicates

The same content at several URLs is stored once:

- a page that declares `<link rel="canonical">` is stored under its canonical URL;
- identical pages without a canonical link are stored under the alphabetically first URL;
- the other URLs are recorded as alternates.

## Locks

If a sync process crashes, its lock is detected as stale on the next run (the process no longer exists, or it stopped updating its heartbeat for 2 minutes) and is taken over automatically. To clear one manually:

```sh
citepath unlock <id>
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every source synced cleanly. |
| 1 | A sync failed or was interrupted (the index was not changed for that source). |
| 2 | Usage or configuration error. |
| 3 | Completed, but with failures, incomplete discovery, or the mass-deletion guard triggered. |

Use `citepath status <id>` (or `--json`) to see the last sync summary, including every failure and removal with its reason.

## Running on a schedule

Citepath has no background scheduler. Use cron, a CI job, or launchd/systemd timers, for example:

```cron
0 3 * * * citepath sync --quiet
```
