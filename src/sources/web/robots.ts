import robotsParserModule from 'robots-parser';
import { ROBOTS_USER_AGENT } from '../../version.js';

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
  getSitemaps(): string[];
}

// robots-parser is CommonJS (`module.exports = fn`); its bundled types declare an ES default export.
const robotsParser = robotsParserModule as unknown as (url: string, contents: string) => Robot;

export interface RobotsPolicy {
  /** False when robots.txt could not be fetched (5xx or network error): crawl nothing. */
  available: boolean;
  isAllowed(url: string): boolean;
  /** Crawl-delay for Citepath (or *), in milliseconds. */
  crawlDelayMs?: number;
  sitemaps: string[];
  reason?: string;
}

export const ALLOW_ALL: RobotsPolicy = { available: true, isAllowed: () => true, sitemaps: [] };

/** RFC 9309: 5xx or unreachable robots.txt means "assume complete disallow" for this crawl. */
export function disallowAll(reason: string): RobotsPolicy {
  return { available: false, isAllowed: () => false, sitemaps: [], reason };
}

export function parseRobots(robotsUrl: string, text: string): RobotsPolicy {
  const robots = robotsParser(robotsUrl, text);
  const delaySeconds = robots.getCrawlDelay(ROBOTS_USER_AGENT);
  return {
    available: true,
    // undefined means the URL is not on this host; treat as allowed (scope is checked separately).
    isAllowed: (url) => robots.isAllowed(url, ROBOTS_USER_AGENT) !== false,
    crawlDelayMs: typeof delaySeconds === 'number' && delaySeconds > 0 ? delaySeconds * 1000 : undefined,
    sitemaps: robots.getSitemaps(),
  };
}
