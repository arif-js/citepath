# Evaluating retrieval

`citepath eval` checks whether searches return the documents you expect. Use it to compare settings, catch regressions after re-indexing, or gate a CI job.

## Eval file

```json
{
  "k": 5,
  "questions": [
    {
      "id": "auth",
      "question": "How do I configure authentication?",
      "expected": ["guides/authentication.md"]
    },
    {
      "id": "rate-limits",
      "question": "What happens when I hit the rate limit?",
      "expected": [
        "https://docs.example.com/api/errors",
        { "path": "reference/errors.md", "anchor": "e_rate_limited" }
      ],
      "sources": ["api-docs"]
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `k` | Results considered per question (1-25, default 5). Overridden by `--k`. |
| `questions[].question` | Sent to the same search used by the CLI, MCP, and API. |
| `questions[].expected` | Documents that should appear. A string starting with `http` is a URL; any other string is a path relative to a local source root. An object can add `source` and an `anchor` (heading slug or HTML id) to require a specific section. |
| `questions[].sources` | Optional: only search these sources. |
| `questions[].id`, `notes` | For your reference. |

Expected URLs are normalized the same way as indexed pages, so `https://Docs.example.com/guide/` matches `https://docs.example.com/guide`, and redirect and alias URLs match their canonical page.

## Running

```sh
citepath eval eval.json
citepath eval eval.json --k 10 --min-recall 0.8   # exit code 3 if recall@10 < 0.8
citepath eval eval.json --json > report.json
```

## Metrics

| Metric | Meaning |
| --- | --- |
| Hit rate@k | Share of questions where at least one expected document is in the top k. |
| Recall@k | Average share of each question's expected documents found in the top k. |
| MRR | Mean reciprocal rank of the first expected document (1.0 means always ranked first). |

Each expected document gets one of three statuses:

- **found at rank N**.
- **indexed but not retrieved**: the document is in the index but search did not surface it. Improve the question wording, the document's headings, or the source's `content_selector`.
- **not in index**: the document is not indexed at all. Check the source's scope and globs, run `citepath sync`, or fix the eval file.

The report also lists the citations that were retrieved for every question, for manual review.

## In this repository

`npm run eval:fixtures` runs `test/eval/fixtures.eval.json` against the fixture corpus in CI. Changes to tokenization, ranking, or chunking must keep it passing and report before/after numbers.
