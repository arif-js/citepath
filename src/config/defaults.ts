/**
 * Default limits. Values are documented in docs/configuration.md;
 * change them in both places together.
 */

export const CRAWL_DEFAULTS = {
  maxPages: 5000,
  maxDepth: 20,
  maxResponseBytes: 10 * 1024 * 1024,
  timeoutMs: 15_000,
  maxRedirects: 5,
  concurrency: 4,
  requestsPerSecond: 2,
  maxRetries: 2,
  maxRetryAfterMs: 60_000,
  maxSitemaps: 50,
} as const;

export const LOCAL_DEFAULTS = {
  maxFileBytes: 2 * 1024 * 1024,
  include: ['**/*.md', '**/*.mdx', '**/*.markdown', '**/*.txt'],
} as const;

export const SYNC_DEFAULTS = {
  massDeleteThreshold: 0.5,
  lockHeartbeatMs: 10_000,
  staleLockMs: 120_000,
} as const;

export const SEARCH_LIMITS = {
  defaultLimit: 5,
  maxLimit: 25,
  perDocumentCap: 2,
  excerptChars: 1500,
  responseBytes: 32 * 1024,
  queryChars: 512,
  maxNeighbors: 3,
  candidateMultiplier: 10,
  maxCandidates: 250,
} as const;

export const CHUNK_DEFAULTS = {
  targetChars: 1200,
  maxChars: 2000,
  overlapChars: 150,
} as const;

/** Minimum extracted characters for a web page to count as real content. */
export const MIN_PAGE_TEXT_CHARS = 40;
