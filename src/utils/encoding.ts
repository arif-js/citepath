/**
 * Character encoding detection and text normalization.
 * Uses the built-in TextDecoder (Node ships full ICU), so no extra dependency.
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf];

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && UTF8_BOM.every((b, i) => bytes[i] === b);
}

function bomEncoding(bytes: Uint8Array): string | undefined {
  if (hasUtf8Bom(bytes)) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return undefined;
}

function isSupportedEncoding(label: string): boolean {
  try {
    new TextDecoder(label);
    return true;
  } catch {
    return false;
  }
}

export function charsetFromContentType(contentType: string | null | undefined): string | undefined {
  const match = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '');
  return match?.[1]?.toLowerCase();
}

function charsetFromMeta(bytes: Uint8Array): string | undefined {
  // Per the HTML spec, the meta charset must appear in the first 1024 bytes.
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1');
  const direct = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
  return direct?.[1]?.toLowerCase();
}

/**
 * Decodes an HTML (or other text) response body.
 * Order: byte-order mark, then the Content-Type charset, then <meta charset>, then UTF-8.
 */
export function decodeHtmlBytes(
  bytes: Uint8Array,
  contentType?: string | null
): { text: string; encoding: string } {
  const candidates = [
    bomEncoding(bytes),
    charsetFromContentType(contentType),
    charsetFromMeta(bytes),
    'utf-8',
  ];
  const encoding = candidates.find((label) => label && isSupportedEncoding(label)) ?? 'utf-8';
  // TextDecoder strips a matching BOM by default.
  const text = new TextDecoder(encoding).decode(bytes);
  return { text, encoding };
}

/**
 * Decodes a local text file. Valid UTF-8 (with or without BOM) is decoded as such;
 * otherwise falls back to windows-1252 and reports it so sync can warn.
 */
export function decodeLocalText(bytes: Uint8Array): { text: string; encoding: string; fallback: boolean } {
  const bom = bomEncoding(bytes);
  if (bom && bom !== 'utf-8')
    return { text: new TextDecoder(bom).decode(bytes), encoding: bom, fallback: false };
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      encoding: 'utf-8',
      fallback: false,
    };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252', fallback: true };
  }
}

/** True if the bytes look binary (a NUL byte in the first 8 KB). */
export function looksBinary(bytes: Uint8Array): boolean {
  if (bomEncoding(bytes)?.startsWith('utf-16')) return false;
  const end = Math.min(bytes.length, 8192);
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/** Unicode NFC and LF line endings. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').normalize('NFC');
}
