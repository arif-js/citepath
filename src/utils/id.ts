import { createHash } from 'node:crypto';

/**
 * Computes a stable document ID using sha256 over an unambiguous JSON array.
 * Unambiguous encoding ensures no collisions like source "a" + loc "bc" vs source "ab" + loc "c".
 */
export function computeDocumentId(sourceId: string, normalizedLocation: string): string {
  const payload = JSON.stringify([sourceId, normalizedLocation]);
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Computes a stable passage ID using sha256 over an unambiguous JSON array.
 */
export function computePassageId(documentId: string, headingPath: string[], occurrenceIndex: number): string {
  const payload = JSON.stringify([documentId, headingPath, occurrenceIndex]);
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Computes a content hash for change detection.
 */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
