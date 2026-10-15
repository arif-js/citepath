# Known limitations

These are known gaps in the current release, not bugs.

- **JavaScript-rendered sites** are not indexed. Citepath reads static HTML only; pages that need a browser to render are reported in the sync summary and skipped.
- **Sites behind a login** are not supported.
- **File formats:** PDF, Office documents, reStructuredText, and AsciiDoc are not indexed. Local sources index Markdown, MDX, and plain text.
- **Keyword search only.** Search is full-text (BM25), so it matches words, not meaning. English word forms match each other through stemming ("caching" finds "cache" and "cached"), but synonyms do not: a question worded very differently from your docs ("sign in" vs. "authentication") can miss. Stemming is English-only; other languages match exact words. Semantic search with a local model may be added later.
- **Languages without spaces between words** (Chinese, Japanese, Korean) are segmented with the runtime's word segmenter, which is less precise than for English.
- **No built-in scheduler.** Run `citepath sync` from cron, CI, or a system timer.
- **One user.** The local API supports a single access token, not per-user permissions.
