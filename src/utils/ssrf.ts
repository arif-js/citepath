import dns from 'node:dns';
import net from 'node:net';
import { Agent, type Dispatcher, EnvHttpProxyAgent, type Response, fetch as undiciFetch } from 'undici';
import { decodeHtmlBytes } from './encoding.js';

/**
 * How a failed fetch should be treated by sync:
 * - gone: the resource no longer exists (404/410). The ONLY classification that is removal evidence.
 * - transient: may succeed later (timeouts, network errors, 408/429/5xx). Keep the previous version.
 * - permanent: cannot be indexed as-is (401/403, other 4xx, size or redirect limits). Keep the
 *   previous version and report the failure; never treat as removal evidence.
 * - skipped: outside the configured crawl scope.
 * - blocked: refused by SSRF rules (private, loopback, link-local, or metadata address).
 */
export type FetchErrorClassification = 'gone' | 'transient' | 'permanent' | 'skipped' | 'blocked';

export class FetchError extends Error {
  constructor(
    message: string,
    public readonly classification: FetchErrorClassification,
    public readonly statusCode?: number,
    public readonly originalError?: unknown
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export class SsrfBlockedError extends FetchError {
  constructor(message: string) {
    super(message, 'blocked');
    this.name = 'SsrfBlockedError';
  }
}

export class OutOfScopeError extends FetchError {
  constructor(message: string) {
    super(message, 'skipped');
    this.name = 'OutOfScopeError';
  }
}

export class TransientFetchError extends FetchError {
  constructor(
    message: string,
    statusCode?: number,
    originalError?: unknown,
    /** Server-requested delay from a Retry-After header (429/503), in milliseconds. */
    public readonly retryAfterMs?: number
  ) {
    super(message, 'transient', statusCode, originalError);
    this.name = 'TransientFetchError';
  }
}

/** Parses Retry-After (delta-seconds or HTTP date) into milliseconds from `now`. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

export class PermanentFetchError extends FetchError {
  constructor(message: string, statusCode?: number, originalError?: unknown) {
    super(message, 'permanent', statusCode, originalError);
    this.name = 'PermanentFetchError';
  }
}

export class GoneFetchError extends FetchError {
  constructor(message: string, statusCode: number) {
    super(message, 'gone', statusCode);
    this.name = 'GoneFetchError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUSES = new Set([408, 425, 429]);

/**
 * undici wraps errors thrown from the connect-time lookup in a generic
 * TypeError("fetch failed"). Walk the cause chain (and AggregateError members)
 * to recover our own classified error, e.g. an SsrfBlockedError.
 */
function findFetchErrorCause(err: unknown, depth = 0): FetchError | undefined {
  if (depth > 5 || err === null || typeof err !== 'object') return undefined;
  if (err instanceof FetchError) return err;
  if (err instanceof AggregateError) {
    for (const inner of err.errors) {
      const found = findFetchErrorCause(inner, depth + 1);
      if (found) return found;
    }
  }
  return findFetchErrorCause((err as { cause?: unknown }).cause, depth + 1);
}

async function discardBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    // The body may already be closed; nothing to release.
  }
}

/**
 * Strips enclosing square brackets from IPv6 hostnames (e.g. "[::1]" -> "::1").
 */
export function stripIpBrackets(host: string): string {
  return host.replace(/^\[|\]$/gu, '').trim();
}

/**
 * Checks if an IPv4 address falls within private, loopback, or metadata ranges.
 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IPs are rejected
  }

  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (Private network)
  if (a === 10) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local & cloud metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (Private network: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (Private network)
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 (Multicast)
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 (Reserved)
  if (a >= 240) return true;

  return false;
}

/**
 * Parses an IPv6 string into 8 16-bit words.
 * Returns null if malformed.
 */
export function parseIpv6Words(ip: string): number[] | null {
  const clean = stripIpBrackets(ip).toLowerCase();

  const lastColon = clean.lastIndexOf(':');
  if (lastColon === -1) return null;

  const suffix = clean.slice(lastColon + 1);
  let v4Words: [number, number] | null = null;
  let prefix = clean;

  if (suffix.includes('.')) {
    const v4 = suffix.split('.').map(Number);
    if (v4.length !== 4 || v4.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
      return null;
    }
    const [a, b, c, d] = v4 as [number, number, number, number];
    v4Words = [(a << 8) | b, (c << 8) | d];
    prefix = clean[lastColon - 1] === ':' ? clean.slice(0, lastColon + 1) : clean.slice(0, lastColon);
  }

  const parts = prefix.split('::');
  if (parts.length > 2) return null;

  const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const right = parts[1] ? parts[1].split(':').filter(Boolean) : [];

  const targetLength = v4Words ? 6 : 8;
  const zerosNeeded = targetLength - (left.length + right.length);
  if (parts.length === 1 && zerosNeeded !== 0) return null;
  if (zerosNeeded < 0) return null;

  const words: number[] = [];
  for (const w of left) words.push(parseInt(w, 16));
  for (let i = 0; i < zerosNeeded; i++) words.push(0);
  for (const w of right) words.push(parseInt(w, 16));
  if (v4Words) words.push(...v4Words);

  return words.length === 8 ? words : null;
}

/**
 * Checks if an IPv6 address falls within private, loopback, metadata,
 * NAT64 (64:ff9b::/96), or 6to4 (2002::/16) embedded private IPv4 ranges.
 */
export function isPrivateIpv6(ip: string): boolean {
  const words = parseIpv6Words(ip);
  if (!words) return true; // Malformed IPs are rejected

  // Loopback (::1) and unspecified (::)
  const isAllZero = words.slice(0, 7).every((w) => w === 0);
  if (isAllZero && (words[7] === 0 || words[7] === 1)) return true;

  // IPv4-mapped IPv6 (::ffff:w.x.y.z)
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const w6 = words[6]!;
    const w7 = words[7]!;
    const v4Str = `${w6 >> 8}.${w6 & 0xff}.${w7 >> 8}.${w7 & 0xff}`;
    return isPrivateIpv4(v4Str);
  }

  // NAT64 prefix (64:ff9b::/96)
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    const w6 = words[6]!;
    const w7 = words[7]!;
    const v4Str = `${w6 >> 8}.${w6 & 0xff}.${w7 >> 8}.${w7 & 0xff}`;
    return isPrivateIpv4(v4Str);
  }

  // 6to4 prefix (2002::/16)
  if (words[0] === 0x2002) {
    const w1 = words[1]!;
    const w2 = words[2]!;
    const v4Str = `${w1 >> 8}.${w1 & 0xff}.${w2 >> 8}.${w2 & 0xff}`;
    return isPrivateIpv4(v4Str);
  }

  const w0 = words[0]!;

  // Link-local (fe80::/10: fe80 through febf)
  if ((w0 & 0xffc0) === 0xfe80) return true;

  // Unique local addresses (fc00::/7: fc00 through fdff)
  if ((w0 & 0xfe00) === 0xfc00) return true;

  // Multicast (ff00::/8)
  if ((w0 & 0xff00) === 0xff00) return true;

  // Documentation (2001:db8::/32)
  if (w0 === 0x2001 && words[1] === 0x0db8) return true;

  return false;
}

/**
 * Checks if an IP address is private, loopback, link-local, or cloud metadata.
 * Strips square brackets before evaluating.
 */
export function isBlockedIp(ip: string): boolean {
  const clean = stripIpBrackets(ip);
  const family = net.isIP(clean);
  if (family === 4) {
    return isPrivateIpv4(clean);
  }
  if (family === 6 || clean.includes(':')) {
    return isPrivateIpv6(clean);
  }
  return true; // Not a valid IP -> blocked
}

export interface CrawlScope {
  origin: string; // e.g. "https://docs.example.com"
  pathPrefix: string; // e.g. "/guide/" or "/"
}

/**
 * Verifies that a target URL stays strictly within crawl scope (origin + path prefix).
 */
export function isUrlInScope(targetUrl: string | URL, scope: CrawlScope): boolean {
  const parsed = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
  if (parsed.origin !== scope.origin) {
    return false;
  }
  const prefix = scope.pathPrefix.endsWith('/') ? scope.pathPrefix : scope.pathPrefix + '/';
  const pathname = parsed.pathname.endsWith('/') ? parsed.pathname : parsed.pathname + '/';
  return pathname.startsWith(prefix) || parsed.pathname === scope.pathPrefix;
}

/**
 * Creates a connect-time DNS lookup function for Undici Agent.
 * Correctly handles lookup options.all (returns array of records for autoSelectFamily).
 */
export function createSafeLookup(options?: {
  allowPrivateNetwork?: boolean;
  dnsResolver?: (
    hostname: string,
    callback: (err: Error | null, records: Array<{ address: string; family: number }>) => void
  ) => void;
}) {
  const allowPrivate = options?.allowPrivateNetwork ?? false;

  return (hostname: string, lookupOptions: any, callback: any) => {
    const isAll = typeof lookupOptions === 'object' && lookupOptions !== null && Boolean(lookupOptions.all);
    const cleanHost = stripIpBrackets(hostname);

    // If cleanHost is directly an IP literal
    if (net.isIP(cleanHost)) {
      if (!allowPrivate && isBlockedIp(cleanHost)) {
        const err = new SsrfBlockedError(`SSRF blocked: IP connection to ${hostname} is disallowed`);
        return isAll ? callback(err, []) : callback(err, '', 4);
      }
      const family = net.isIP(cleanHost);
      return isAll ? callback(null, [{ address: cleanHost, family }]) : callback(null, cleanHost, family);
    }

    const resolver =
      options?.dnsResolver ||
      ((host, cb) => {
        dns.lookup(host, { all: true }, (err, records) => {
          if (err) return cb(err, []);
          cb(null, records);
        });
      });

    resolver(cleanHost, (err, records) => {
      if (err) {
        return isAll ? callback(err, []) : callback(err, '', 4);
      }
      if (!records || records.length === 0) {
        const notFoundErr = new Error(`DNS resolution returned no addresses for ${hostname}`);
        return isAll ? callback(notFoundErr, []) : callback(notFoundErr, '', 4);
      }

      if (!allowPrivate) {
        for (const record of records) {
          const cleanRecordIp = stripIpBrackets(record.address);
          if (isBlockedIp(cleanRecordIp)) {
            const ssrfErr = new SsrfBlockedError(
              `SSRF blocked: ${hostname} resolved to blocked address ${record.address}`
            );
            return isAll ? callback(ssrfErr, []) : callback(ssrfErr, '', 4);
          }
        }
      }

      if (isAll) {
        callback(null, records);
      } else {
        const first = records[0]!;
        callback(null, first.address, first.family);
      }
    });
  };
}

/**
 * Creates an SSRF-safe Undici Agent.
 */
export function createSafeDispatcher(options?: {
  allowPrivateNetwork?: boolean;
  dnsResolver?: (
    hostname: string,
    callback: (err: Error | null, addresses: Array<{ address: string; family: number }>) => void
  ) => void;
}): Dispatcher {
  return new Agent({
    connect: {
      lookup: createSafeLookup(options) as any,
    },
  });
}

/** True when standard proxy environment variables are set. */
export function hasProxyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
}

export interface FetchDispatcher {
  dispatcher: Dispatcher;
  /**
   * True when requests go through an HTTP(S)_PROXY. The proxy resolves target hosts,
   * so safeFetch must check the target's resolved addresses itself before each hop.
   */
  viaProxy: boolean;
}

/**
 * Creates the dispatcher a crawler should use. Without proxy variables, address checks
 * happen at connect time (no DNS-rebinding window). With HTTP(S)_PROXY/NO_PROXY set,
 * undici's EnvHttpProxyAgent is used and targets are pre-resolved and checked instead.
 */
export function createFetchDispatcher(options: { allowPrivateNetwork?: boolean } = {}): FetchDispatcher {
  if (hasProxyEnv()) return { dispatcher: new EnvHttpProxyAgent(), viaProxy: true };
  return { dispatcher: createSafeDispatcher(options), viaProxy: false };
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = stripIpBrackets(hostname);
  if (net.isIP(host)) return; // IP literals are checked separately
  let records: Array<{ address: string }>;
  try {
    records = await dns.promises.lookup(host, { all: true });
  } catch (err: any) {
    throw new TransientFetchError(`DNS lookup failed for ${host}: ${err?.message ?? err}`, undefined, err);
  }
  const blocked = records.find((r) => isBlockedIp(r.address));
  if (blocked)
    throw new SsrfBlockedError(`SSRF blocked: ${host} resolved to blocked address ${blocked.address}`);
}

export interface SafeFetchOptions {
  allowPrivateNetwork?: boolean;
  maxRedirects?: number;
  maxResponseSizeBytes?: number;
  timeoutMs?: number;
  /** Crawl scope: origin + path prefix, or a predicate (e.g. including include/exclude globs). */
  scope?: CrawlScope | ((url: URL) => boolean);
  headers?: Record<string, string>; // e.g. If-None-Match / If-Modified-Since for conditional requests
  userAgent?: string;
  dispatcher?: Dispatcher;
  /** Set when `dispatcher` routes through a proxy; enables pre-resolution address checks. */
  viaProxy?: boolean;
  fetchFn?: typeof undiciFetch;
}

export interface SafeFetchResult {
  status: number;
  headers: Headers;
  /** Body decoded using the BOM, Content-Type charset, or <meta charset> (UTF-8 fallback). */
  body: string;
  /** Raw (decompressed) body bytes. Empty when notModified is true. */
  bytes: Buffer;
  contentType: string;
  notModified: boolean; // True on 304: the previously indexed version is still current
  finalUrl: string;
  redirectCount: number;
}

function inScope(scope: SafeFetchOptions['scope'], url: URL): boolean {
  if (!scope) return true;
  return typeof scope === 'function' ? scope(url) : isUrlInScope(url, scope);
}

/**
 * Performs an SSRF-safe HTTP GET request.
 * - Enforces connect-time address inspection on all hops.
 * - Strips IP brackets to prevent [::1] loopback bypass.
 * - Streams decompressed body with running byte count.
 * - Keeps timeout active throughout request and body download.
 * - Cancels redirect and error response bodies.
 * - Returns notModified on 304 instead of failing.
 * - Classifies every failure (see FetchErrorClassification); only `gone` is removal evidence.
 */
export async function safeFetch(
  initialUrl: string,
  options: SafeFetchOptions = {}
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? 5;
  const maxSizeBytes = options.maxResponseSizeBytes ?? 10 * 1024 * 1024; // 10MB
  const timeoutMs = options.timeoutMs ?? 10000;
  const fetchFn = options.fetchFn ?? undiciFetch;

  const dispatcher =
    options.dispatcher ??
    createSafeDispatcher({
      allowPrivateNetwork: options.allowPrivateNetwork,
    });

  let currentUrl = initialUrl;
  let redirectCount = 0;

  while (true) {
    const parsedUrl = new URL(currentUrl);

    // Protocol check
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new PermanentFetchError(`Unsupported protocol ${parsedUrl.protocol}`);
    }

    // Direct IP literal check with brackets stripped
    const cleanHostname = stripIpBrackets(parsedUrl.hostname);
    if (net.isIP(cleanHostname) && !options.allowPrivateNetwork && isBlockedIp(cleanHostname)) {
      throw new SsrfBlockedError(`SSRF blocked: IP literal ${parsedUrl.hostname} is private or blocked`);
    }

    // Scope check: redirect out of scope = skipped
    if (!inScope(options.scope, parsedUrl)) {
      throw new OutOfScopeError(`URL ${currentUrl} is out of the configured crawl scope`);
    }

    // Through a proxy the connect-time check sees the proxy, not the target: check the target here.
    if (options.viaProxy && !options.allowPrivateNetwork) {
      await assertPublicHost(parsedUrl.hostname);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new TransientFetchError(`Request timed out after ${timeoutMs}ms: ${currentUrl}`));
    }, timeoutMs);

    try {
      let response: Response;
      try {
        const headers: Record<string, string> = { ...(options.headers ?? {}) };
        if (options.userAgent) headers['User-Agent'] = options.userAgent;
        response = await fetchFn(currentUrl, {
          method: 'GET',
          headers,
          dispatcher,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch (networkErr: any) {
        // Surface our own classified errors (e.g. SsrfBlockedError from the lookup) unchanged
        const classified = findFetchErrorCause(networkErr);
        if (classified) {
          throw classified;
        }
        if (networkErr?.name === 'AbortError') {
          throw new TransientFetchError(`Request timed out: ${currentUrl}`, undefined, networkErr);
        }
        // Classify standard network failures (DNS, connect) as transient
        throw new TransientFetchError(
          `Network connection error: ${networkErr?.message ?? String(networkErr)}`,
          undefined,
          networkErr
        );
      }

      // 304 Not Modified: the previously indexed version is still current
      if (response.status === 304) {
        await discardBody(response);
        return {
          status: 304,
          headers: response.headers,
          body: '',
          bytes: Buffer.alloc(0),
          contentType: response.headers.get('content-type') ?? '',
          notModified: true,
          finalUrl: currentUrl,
          redirectCount,
        };
      }

      // Follow redirects manually so every hop is re-checked for scope and SSRF
      if (REDIRECT_STATUSES.has(response.status)) {
        await discardBody(response);

        const location = response.headers.get('location');
        if (!location) {
          throw new PermanentFetchError(
            `Redirect response ${response.status} missing Location header`,
            response.status
          );
        }

        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new PermanentFetchError(`Max redirects exceeded (${maxRedirects})`);
        }

        // Resolve relative redirect against current URL
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      // Every non-2xx status is classified explicitly; only 404/410 count as removal evidence
      if (response.status < 200 || response.status >= 300) {
        await discardBody(response);
        const status = response.status;

        if (status === 404 || status === 410) {
          throw new GoneFetchError(`Resource gone (${status}): ${currentUrl}`, status);
        }
        if (TRANSIENT_STATUSES.has(status) || (status >= 500 && status < 600)) {
          throw new TransientFetchError(
            `HTTP ${status} (retry later): ${currentUrl}`,
            status,
            undefined,
            parseRetryAfter(response.headers.get('retry-after'))
          );
        }
        // 401/403 (often bot protection), other 4xx, and unhandled 3xx: failed, not removed
        throw new PermanentFetchError(`HTTP ${status}: ${currentUrl}`, status);
      }

      // Check Content-Length header limit before body streaming
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
        await discardBody(response);
        throw new PermanentFetchError(
          `Response size ${contentLength} bytes exceeds limit of ${maxSizeBytes} bytes`
        );
      }

      // Stream body with running byte count while timer remains active
      let bytes = Buffer.alloc(0);
      if (response.body) {
        const reader = response.body.getReader();
        let receivedBytes = 0;
        const chunks: Uint8Array[] = [];

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              receivedBytes += value.byteLength;
              if (receivedBytes > maxSizeBytes) {
                await reader.cancel();
                throw new PermanentFetchError(`Decompressed body exceeded limit of ${maxSizeBytes} bytes`);
              }
              chunks.push(value);
            }
          }
        } catch (streamErr: any) {
          try {
            await reader.cancel();
          } catch {}
          // Size-limit and timeout errors are already classified; mid-body
          // connection failures (e.g. reset) are transient.
          throw (
            findFetchErrorCause(streamErr) ??
            new TransientFetchError(
              `Connection failed while reading body: ${currentUrl}`,
              response.status,
              streamErr
            )
          );
        }

        bytes = Buffer.concat(chunks);
      }

      const contentType = response.headers.get('content-type') ?? '';
      return {
        status: response.status,
        headers: response.headers,
        body: decodeHtmlBytes(bytes, contentType).text,
        bytes,
        contentType,
        notModified: false,
        finalUrl: currentUrl,
        redirectCount,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
