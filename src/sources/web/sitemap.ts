import zlib from 'node:zlib';

export interface ParsedSitemap {
  /** True for <sitemapindex>: `urls` are nested sitemaps. */
  isIndex: boolean;
  urls: string[];
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** True if the body is gzip-compressed (magic bytes 1f 8b). */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Gunzips with an output cap so a small file cannot expand into a huge one. */
export function gunzipLimited(bytes: Uint8Array, maxOutputBytes: number): Buffer {
  return zlib.gunzipSync(bytes, { maxOutputLength: maxOutputBytes });
}

/** Extracts <loc> entries from a sitemap or sitemap index (namespaces and CDATA tolerated). */
export function parseSitemap(xml: string): ParsedSitemap {
  const isIndex = /<(?:\w+:)?sitemapindex[\s>]/i.test(xml);
  const urls: string[] = [];
  const locPattern = /<(?:\w+:)?loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/(?:\w+:)?loc>/gi;
  for (let match = locPattern.exec(xml); match; match = locPattern.exec(xml)) {
    const value = decodeXmlEntities(match[1]!.trim());
    if (value) urls.push(value);
  }
  return { isIndex, urls };
}
