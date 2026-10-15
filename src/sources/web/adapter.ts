import type { Dispatcher } from 'undici';
import { CRAWL_DEFAULTS, MIN_PAGE_TEXT_CHARS } from '../../config/defaults.js';
import type { WebSourceConfig } from '../../config/schema.js';
import { parseHtml } from '../../indexing/html.js';
import { parseMarkdownPage } from '../../indexing/markdown.js';
import { buildDocument } from '../../indexing/passages.js';
import { AsyncQueue } from '../../utils/async-queue.js';
import {
  createFetchDispatcher,
  FetchError,
  GoneFetchError,
  OutOfScopeError,
  type SafeFetchResult,
  SsrfBlockedError,
  safeFetch,
  TransientFetchError,
} from '../../utils/ssrf.js';
import { createScopeMatcher, defaultPathPrefix, normalizeUrl, type ScopeMatcher } from '../../utils/url.js';
import { USER_AGENT } from '../../version.js';
import type { AdapterContext, DiscoveryStatus, ItemOutcome, SourceAdapter } from '../adapter.js';
import { RateLimiter } from './rate-limiter.js';
import { ALLOW_ALL, disallowAll, parseRobots, type RobotsPolicy } from './robots.js';
import { gunzipLimited, isGzip, parseSitemap } from './sitemap.js';

const SOFT_404 =
  /(^|\W)(404|page not found|not found|page (does not|doesn't|doesn’t) exist|no longer exists)(\W|$)/i;
const SOFT_404_MAX_TEXT = 3000;
const HTML_TYPES = /text\/html|application\/xhtml\+xml/i;
const MARKDOWN_TYPES = /text\/(?:x-)?markdown/i;

export interface WebAdapterOptions {
  /** Base delay for retrying transient failures without Retry-After (doubles per attempt). */
  retryBaseDelayMs?: number;
}

interface QueueEntry {
  url: string;
  depth: number;
}

interface FetchOutcome {
  outcomes: ItemOutcome[];
  links: string[];
  /** The page was fetched and parsed (its links are trustworthy for discovery). */
  fetched: boolean;
  /** Canonical URL declared by a non-canonical copy; it must be fetched itself. */
  canonicalToFetch?: string;
}

export class WebSourceAdapter implements SourceAdapter {
  readonly discovery: DiscoveryStatus = { complete: true, reasons: [] };
  private readonly matcher: ScopeMatcher;
  private readonly origin: string;
  private readonly limits: {
    maxPages: number;
    maxDepth: number;
    maxResponseBytes: number;
    timeoutMs: number;
    maxRedirects: number;
    concurrency: number;
    requestsPerSecond: number;
  };

  constructor(
    private readonly config: WebSourceConfig,
    private readonly options: WebAdapterOptions = {}
  ) {
    const start = new URL(config.url);
    this.origin = start.origin;
    this.matcher = createScopeMatcher({
      origin: start.origin,
      pathPrefix: config.path_prefix ?? defaultPathPrefix(config.url),
      include: config.include,
      exclude: config.exclude,
    });
    this.limits = {
      maxPages: config.max_pages ?? CRAWL_DEFAULTS.maxPages,
      maxDepth: config.max_depth ?? CRAWL_DEFAULTS.maxDepth,
      maxResponseBytes: config.max_response_bytes ?? CRAWL_DEFAULTS.maxResponseBytes,
      timeoutMs: config.timeout_ms ?? CRAWL_DEFAULTS.timeoutMs,
      maxRedirects: config.max_redirects ?? CRAWL_DEFAULTS.maxRedirects,
      concurrency: config.concurrency ?? CRAWL_DEFAULTS.concurrency,
      requestsPerSecond: config.requests_per_second ?? CRAWL_DEFAULTS.requestsPerSecond,
    };
  }

  isInScope(location: string): boolean {
    return this.matcher(location);
  }

  private normalize(url: string): string {
    return normalizeUrl(url, this.config.query_params ?? 'drop');
  }

  private markIncomplete(reason: string): void {
    this.discovery.complete = false;
    if (!this.discovery.reasons.includes(reason)) this.discovery.reasons.push(reason);
  }

  async *run(context: AdapterContext): AsyncIterable<ItemOutcome> {
    const queue = new AsyncQueue<ItemOutcome>();
    const { dispatcher, viaProxy } = createFetchDispatcher({
      allowPrivateNetwork: this.config.allow_private_network,
    });
    const crawl = this.crawl(context, queue, dispatcher, viaProxy)
      .then(() => queue.close())
      .catch((err) => queue.fail(err));
    try {
      yield* queue;
      await crawl;
    } finally {
      await dispatcher.close().catch(() => undefined);
    }
  }

  private fetchOptions(dispatcher: Dispatcher, viaProxy: boolean) {
    return {
      dispatcher,
      viaProxy,
      allowPrivateNetwork: this.config.allow_private_network,
      timeoutMs: this.limits.timeoutMs,
      maxRedirects: this.limits.maxRedirects,
      maxResponseSizeBytes: this.limits.maxResponseBytes,
      userAgent: USER_AGENT,
    };
  }

  private async loadRobots(
    context: AdapterContext,
    dispatcher: Dispatcher,
    viaProxy: boolean
  ): Promise<RobotsPolicy> {
    const robotsUrl = `${this.origin}/robots.txt`;
    try {
      const result = await safeFetch(robotsUrl, {
        ...this.fetchOptions(dispatcher, viaProxy),
        maxResponseSizeBytes: 512 * 1024,
      });
      return parseRobots(robotsUrl, result.body);
    } catch (err) {
      // RFC 9309: 4xx means no restrictions; 5xx or unreachable means assume complete disallow.
      if (
        err instanceof FetchError &&
        (err.classification === 'gone' || err.classification === 'permanent')
      ) {
        return ALLOW_ALL;
      }
      const reason = `robots.txt unavailable (${(err as Error).message}); nothing was crawled`;
      context.logger.warn('robots.txt unavailable; skipping crawl', { url: robotsUrl });
      return disallowAll(reason);
    }
  }

  /** Fetches sitemaps (following sitemap indexes) and returns in-scope page URLs. */
  private async loadSitemaps(
    context: AdapterContext,
    candidates: string[],
    fetchOne: (url: string) => Promise<SafeFetchResult>
  ): Promise<{ urls: string[]; fetchedAny: boolean; failures: string[] }> {
    const pending = [...candidates];
    const seenSitemaps = new Set<string>();
    const urls = new Set<string>();
    const failures: string[] = [];
    let fetchedAny = false;

    while (pending.length > 0) {
      const sitemapUrl = pending.shift()!;
      if (seenSitemaps.has(sitemapUrl)) continue;
      if (seenSitemaps.size >= CRAWL_DEFAULTS.maxSitemaps) {
        failures.push(`more than ${CRAWL_DEFAULTS.maxSitemaps} sitemaps; the rest were ignored`);
        break;
      }
      seenSitemaps.add(sitemapUrl);
      try {
        const result = await fetchOne(sitemapUrl);
        let xmlBytes: Buffer = result.bytes;
        if (isGzip(xmlBytes)) xmlBytes = gunzipLimited(xmlBytes, this.limits.maxResponseBytes);
        const parsed = parseSitemap(xmlBytes.toString('utf8'));
        fetchedAny = true;
        for (const entry of parsed.urls) {
          let absolute: string;
          try {
            absolute = new URL(entry, sitemapUrl).href;
          } catch {
            continue;
          }
          if (parsed.isIndex) pending.push(absolute);
          else if (this.matcher(absolute)) urls.add(absolute);
        }
      } catch (err) {
        const missing = err instanceof GoneFetchError;
        if (!missing) failures.push(`sitemap ${sitemapUrl} failed: ${(err as Error).message}`);
        context.logger.info('sitemap not used', { url: sitemapUrl, reason: (err as Error).message });
      }
    }
    return { urls: [...urls].sort(), fetchedAny, failures };
  }

  private async crawl(
    context: AdapterContext,
    out: AsyncQueue<ItemOutcome>,
    dispatcher: Dispatcher,
    viaProxy: boolean
  ): Promise<void> {
    const robots = await this.loadRobots(context, dispatcher, viaProxy);
    if (!robots.available) {
      this.markIncomplete(robots.reason ?? 'robots.txt unavailable');
      return;
    }

    const intervalMs = Math.max(1000 / this.limits.requestsPerSecond, robots.crawlDelayMs ?? 0);
    const limiter = new RateLimiter(intervalMs);
    const baseOptions = this.fetchOptions(dispatcher, viaProxy);
    const politeFetch = async (url: string, headers?: Record<string, string>) => {
      await limiter.wait();
      return safeFetch(url, { ...baseOptions, headers, scope: (u) => this.matcher(u) || u.href === url });
    };

    // Discovery: sitemap (explicit or auto-detected) or link crawling.
    const mode = this.config.discovery ?? 'auto';
    let sitemapUrls: string[] | undefined;
    if (mode !== 'crawl') {
      const candidates = this.config.sitemap_urls?.length
        ? this.config.sitemap_urls
        : robots.sitemaps.length > 0
          ? robots.sitemaps
          : [`${this.origin}/sitemap.xml`];
      const loaded = await this.loadSitemaps(context, candidates, async (url) => {
        await limiter.wait();
        return safeFetch(url, { ...baseOptions, scope: undefined });
      });
      if (mode === 'sitemap') {
        if (!loaded.fetchedAny) this.markIncomplete('no sitemap could be fetched');
        for (const failure of loaded.failures) this.markIncomplete(failure);
        sitemapUrls = loaded.urls;
      } else if (loaded.fetchedAny && loaded.urls.length > 0) {
        for (const failure of loaded.failures) this.markIncomplete(failure);
        sitemapUrls = loaded.urls;
      }
    }

    const followLinks = sitemapUrls === undefined;
    const visited = new Set<string>();
    const queue: QueueEntry[] = [];
    const enqueue = (url: string, depth: number) => {
      const key = this.normalize(url);
      if (visited.has(key)) return;
      visited.add(key);
      queue.push({ url, depth });
    };
    enqueue(this.config.url, 0);
    for (const url of sitemapUrls ?? []) enqueue(url, 0);

    const emittedLocations = new Set<string>();
    let pagesStarted = 0;
    let failedWithUnknownLinks = 0;
    let depthLimited = false;

    const processEntry = async (entry: QueueEntry) => {
      const result = await this.fetchPage(context, entry.url, politeFetch, limiter, emittedLocations);
      for (const outcome of result.outcomes) out.push(outcome);
      // A non-canonical copy points at its canonical page: make sure that page is fetched.
      if (result.canonicalToFetch) enqueue(result.canonicalToFetch, entry.depth);

      if (!followLinks) return;
      if (!result.fetched) {
        failedWithUnknownLinks++;
        return;
      }
      for (const link of result.links) {
        if (!this.matcher(link) || visited.has(this.normalize(link))) continue;
        if (entry.depth + 1 > this.limits.maxDepth) {
          depthLimited = true;
          continue;
        }
        enqueue(link, entry.depth + 1);
      }
    };

    // Worker pool over a queue that grows while crawling.
    let active = 0;
    await new Promise<void>((resolve, reject) => {
      const pump = () => {
        if (context.signal?.aborted) {
          if (active === 0) resolve();
          return;
        }
        while (active < this.limits.concurrency && queue.length > 0) {
          const entry = queue.shift()!;
          if (!robots.isAllowed(entry.url)) {
            out.push({
              kind: 'excluded',
              location: this.normalize(entry.url),
              reason: 'disallowed by robots.txt',
            });
            continue;
          }
          if (pagesStarted >= this.limits.maxPages) {
            this.markIncomplete(`max_pages limit (${this.limits.maxPages}) reached`);
            queue.length = 0;
            break;
          }
          pagesStarted++;
          active++;
          processEntry(entry)
            .then(() => {
              active--;
              pump();
            })
            .catch(reject);
        }
        if (active === 0 && queue.length === 0) resolve();
      };
      pump();
    });

    if (context.signal?.aborted) this.markIncomplete('sync was interrupted');
    if (depthLimited) this.markIncomplete(`max_depth limit (${this.limits.maxDepth}) reached`);
    if (failedWithUnknownLinks > 0) {
      this.markIncomplete(
        `${failedWithUnknownLinks} page(s) could not be fetched, so their links were not followed`
      );
    }
  }

  private async fetchPage(
    context: AdapterContext,
    url: string,
    politeFetch: (url: string, headers?: Record<string, string>) => Promise<SafeFetchResult>,
    limiter: RateLimiter,
    emittedLocations: Set<string>
  ): Promise<FetchOutcome> {
    const requestKey = this.normalize(url);
    const known = context.lookup(requestKey);
    const knownLocation = known?.location ?? requestKey;
    const headers: Record<string, string> = {};
    if (known?.reusable) {
      if (known.etag) headers['If-None-Match'] = known.etag;
      if (known.lastModified) headers['If-Modified-Since'] = known.lastModified;
    }

    const maxRetries = CRAWL_DEFAULTS.maxRetries;
    const baseDelay = this.options.retryBaseDelayMs ?? 1000;
    let result: SafeFetchResult | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await politeFetch(url, headers);
        break;
      } catch (err) {
        const failed = (
          classification: 'transient' | 'permanent' | 'blocked',
          reason: string
        ): FetchOutcome => ({
          outcomes: [{ kind: 'failed', location: knownLocation, classification, reason }],
          links: [],
          fetched: false,
        });
        if (err instanceof TransientFetchError) {
          const retryAfter = err.retryAfterMs;
          const tooLong = retryAfter !== undefined && retryAfter > CRAWL_DEFAULTS.maxRetryAfterMs;
          if (attempt < maxRetries && !tooLong && !context.signal?.aborted) {
            const delay = retryAfter ?? baseDelay * 2 ** attempt;
            if (retryAfter !== undefined) limiter.pushBack(retryAfter);
            else await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          return failed('transient', err.message);
        }
        if (err instanceof GoneFetchError) {
          return {
            outcomes: [{ kind: 'gone', location: knownLocation, reason: err.message }],
            links: [],
            fetched: false,
          };
        }
        if (err instanceof OutOfScopeError) {
          return {
            outcomes: [
              { kind: 'excluded', location: knownLocation, reason: 'redirects outside the crawl scope' },
            ],
            links: [],
            // The redirect itself is a definitive answer; there are no links to follow.
            fetched: true,
          };
        }
        if (err instanceof SsrfBlockedError) return failed('blocked', err.message);
        if (err instanceof FetchError) return failed('permanent', err.message);
        return failed('transient', (err as Error).message ?? String(err));
      }
    }

    if (result.notModified) {
      return {
        outcomes: [
          {
            kind: 'unchanged',
            location: knownLocation,
            etag: known?.etag,
            lastModified: known?.lastModified,
          },
        ],
        links: [],
        fetched: true,
      };
    }

    const isMarkdown = MARKDOWN_TYPES.test(result.contentType);
    if (!isMarkdown && !HTML_TYPES.test(result.contentType)) {
      return {
        outcomes: [
          {
            kind: 'failed',
            location: knownLocation,
            classification: 'permanent',
            reason: `unsupported content type ${result.contentType || '(none)'}`,
          },
        ],
        links: [],
        fetched: true,
      };
    }

    const parsed = isMarkdown
      ? parseMarkdownPage(result.body, result.finalUrl)
      : parseHtml(result.body, result.finalUrl, { contentSelector: this.config.content_selector });
    const links = parsed.links;
    const finalKey = this.normalize(result.finalUrl);
    const canonical =
      parsed.canonicalUrl && this.matcher(parsed.canonicalUrl) ? parsed.canonicalUrl : result.finalUrl;
    const location = this.normalize(canonical);
    const outcomes: ItemOutcome[] = [];

    // Earlier locations for this content (redirect sources, non-canonical URLs) are aliases.
    const aliases = [...new Set([requestKey, finalKey])].filter((key) => key !== location);
    for (const alias of aliases) {
      outcomes.push({
        kind: 'excluded',
        location: alias,
        reason: `duplicate of ${location}`,
        aliasOf: location,
        url: alias,
      });
    }

    // A seed page outside include/exclude globs is crawled for links but not indexed.
    if (!this.matcher(location)) return { outcomes, links, fetched: true };

    // Only the canonical page itself supplies content. Copies that point elsewhere become
    // aliases, so the stored content never depends on which URL happened to finish first.
    if (location !== finalKey) return { outcomes, links, fetched: true, canonicalToFetch: canonical };

    if (parsed.noindex) {
      outcomes.push({ kind: 'excluded', location, reason: 'page is marked noindex' });
      return { outcomes, links, fetched: true };
    }

    const headingText = parsed.blocks.find((b) => b.kind === 'heading')?.headingText ?? '';
    if (
      (SOFT_404.test(parsed.title) || SOFT_404.test(headingText)) &&
      parsed.textLength < SOFT_404_MAX_TEXT
    ) {
      outcomes.push({
        kind: 'failed',
        location,
        classification: 'permanent',
        reason: 'page looks like an error page served with HTTP 200 (soft 404)',
      });
      return { outcomes, links, fetched: true };
    }
    if (parsed.textLength < MIN_PAGE_TEXT_CHARS) {
      outcomes.push({
        kind: 'failed',
        location,
        classification: 'permanent',
        reason: 'little or no text extracted (the page may require JavaScript)',
      });
      return { outcomes, links, fetched: true };
    }

    if (emittedLocations.has(location)) return { outcomes, links, fetched: true };
    emittedLocations.add(location);

    const lastModifiedHeader = result.headers.get('last-modified') ?? undefined;
    const lastModifiedDate = lastModifiedHeader ? new Date(lastModifiedHeader) : undefined;
    outcomes.push({
      kind: 'document',
      location,
      url: canonical,
      document: buildDocument(this.config.id, location, parsed),
      alternateUrls: aliases,
      etag: result.headers.get('etag') ?? undefined,
      lastModified: lastModifiedHeader,
      updatedAt:
        lastModifiedDate && !Number.isNaN(lastModifiedDate.getTime())
          ? lastModifiedDate.toISOString()
          : undefined,
    });
    return { outcomes, links, fetched: true };
  }
}
