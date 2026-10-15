/**
 * Recognizes documentation versions in URLs and paths ("/docs/15/app/x", "/v2/guide").
 * Used to group copies of a page across versions in search, and to warn after a sync.
 */

/**
 * Path segments that name a documentation version: "15", "v2", "1.4", "2.x", "v3.1.0", and the
 * aliases "latest", "stable", "current". Two-digit numbers at most, so "404" and "2024" are not
 * versions.
 */
const VERSION_SEGMENT = /^(?:v?\d{1,2}(?:\.(?:\d+|x)){0,2}|v\d+(?:\.\d+)*|latest|stable|current)$/i;
const CURRENT_ALIASES = new Set(['latest', 'stable', 'current']);

function splitLocation(location: string): { origin: string; segments: string[] } {
  try {
    const url = new URL(location);
    return { origin: url.origin, segments: url.pathname.split('/').filter(Boolean) };
  } catch {
    // A local path relative to the source root.
    return { origin: '', segments: location.split('/').filter(Boolean) };
  }
}

/**
 * Identifies the same page across documentation versions: "/docs/15/app/x" and "/docs/app/x" share
 * a key. `versioned` is false for the current copy (no version segment, or "latest"/"stable").
 */
export function documentFamily(sourceId: string, location: string): { key: string; versioned: boolean } {
  const { origin, segments } = splitLocation(location);
  let versioned = false;
  const rest = segments.filter((segment) => {
    if (!VERSION_SEGMENT.test(segment)) return true;
    if (!CURRENT_ALIASES.has(segment.toLowerCase())) versioned = true;
    return false;
  });
  return { key: JSON.stringify([sourceId, origin, rest.join('/')]), versioned };
}

/**
 * The path up to and including the first old-version segment, as an exclude glob base:
 * "https://x/docs/15/app/y" -> "/docs/15/", "15/guides/a.md" -> "15/". Undefined for current pages.
 */
export function versionFolder(location: string): string | undefined {
  const { origin, segments } = splitLocation(location);
  const index = segments.findIndex(
    (segment) => VERSION_SEGMENT.test(segment) && !CURRENT_ALIASES.has(segment.toLowerCase())
  );
  if (index < 0) return undefined;
  const folder = segments.slice(0, index + 1).join('/');
  return origin ? `/${folder}/` : `${folder}/`;
}
