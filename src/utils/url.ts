import picomatch from 'picomatch';

export type QueryParamMode = 'drop' | 'keep';

const TRACKING_PARAM = /^(utm_[a-z]+|gclid|fbclid|mc_cid|mc_eid|ref_src)$/i;
const INDEX_FILE = /\/index\.(html?|php)$/i;

/**
 * Normalizes a URL for identity and deduplication (docs/sync.md, "Duplicates"):
 * lowercase scheme and host, drop the fragment, drop default ports, collapse index files,
 * strip a trailing slash (except at the root), and drop or canonicalize the query string.
 * The original URL is still what gets fetched; this is only the identity key.
 */
export function normalizeUrl(input: string | URL, queryParams: QueryParamMode = 'drop'): string {
  const url = new URL(typeof input === 'string' ? input : input.href);
  url.hash = '';
  url.username = '';
  url.password = '';

  let pathname = url.pathname.replace(INDEX_FILE, '/');
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  url.pathname = pathname;

  if (queryParams === 'drop') {
    url.search = '';
  } else {
    const params = [...url.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM.test(key))
      .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
    url.search = new URLSearchParams(params).toString();
  }
  return url.href;
}

/**
 * Default crawl scope path prefix for a start URL: the URL's directory.
 * "/reference" -> "/reference/", "/docs/" -> "/docs/", "/docs/intro.html" -> "/docs/".
 */
export function defaultPathPrefix(startUrl: string): string {
  const { pathname } = new URL(startUrl);
  if (pathname.endsWith('/')) return pathname;
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  if (lastSegment.includes('.')) return pathname.slice(0, pathname.lastIndexOf('/') + 1);
  return `${pathname}/`;
}

export interface UrlScope {
  origin: string;
  pathPrefix: string;
  include?: string[];
  exclude?: string[];
}

/** Path-prefix check that treats "/docs" and "/docs/" as the same subtree root. */
export function pathHasPrefix(pathname: string, prefix: string): boolean {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  const normalizedPath = pathname.endsWith('/') ? pathname : `${pathname}/`;
  return normalizedPath.startsWith(normalizedPrefix);
}

export type ScopeMatcher = (url: string | URL) => boolean;

/** Builds a matcher for origin + path prefix + include/exclude globs (matched against the URL path). */
export function createScopeMatcher(scope: UrlScope): ScopeMatcher {
  const include = scope.include?.length ? picomatch(scope.include, { dot: true }) : undefined;
  const exclude = scope.exclude?.length ? picomatch(scope.exclude, { dot: true }) : undefined;
  return (input) => {
    let url: URL;
    try {
      url = typeof input === 'string' ? new URL(input) : input;
    } catch {
      return false;
    }
    if (url.origin !== scope.origin) return false;
    if (!pathHasPrefix(url.pathname, scope.pathPrefix)) return false;
    let pathname = url.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Keep the encoded form if it is not valid percent-encoding.
    }
    if (include && !include(pathname)) return false;
    if (exclude?.(pathname)) return false;
    return true;
  };
}

/** Escapes LIKE wildcards so user-supplied prefixes match literally (use with ESCAPE '\\'). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
