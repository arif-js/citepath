import type { DocumentRecord } from '../indexing/passages.js';
import type { Logger } from '../utils/logger.js';

/**
 * Source adapter contract (docs/sync.md explains how sync uses it).
 *
 * Adapters stream one outcome per discovered item and report whether discovery was
 * complete. Sync removal depends on these signals, so adapters must never collapse them:
 * - `document`  : content fetched and parsed (sync compares content hashes for unchanged)
 * - `unchanged` : the server confirmed the stored version is current (HTTP 304)
 * - `gone`      : 404/410 or file deleted: removal evidence
 * - `excluded`  : outside scope, disallowed by robots.txt, noindex, or a duplicate of
 *                 another document: remove any stored copy
 * - `failed`    : could not be indexed this time (transient, permanent, blocked, soft-404,
 *                 thin or unsupported content): keep the stored version
 */
export type ItemOutcome =
  | {
      kind: 'document';
      location: string;
      document: DocumentRecord;
      /** Link target for citations (web: canonical or final URL; local: mapped base URL). */
      url?: string;
      /** POSIX path relative to the source root (local sources). */
      path?: string;
      /** Other URLs that resolve to this document (redirect sources, duplicates). */
      alternateUrls?: string[];
      etag?: string;
      lastModified?: string;
      /** Source-reported modification time (ISO 8601), when known. */
      updatedAt?: string;
      commitSha?: string;
      dirty?: boolean;
    }
  | { kind: 'unchanged'; location: string; etag?: string; lastModified?: string }
  | { kind: 'gone'; location: string; reason: string }
  | { kind: 'excluded'; location: string; reason: string; aliasOf?: string; url?: string }
  | {
      kind: 'failed';
      location: string;
      classification: 'transient' | 'permanent' | 'blocked';
      reason: string;
    };

/** What sync already has stored for a location (used for conditional requests). */
export interface KnownDocument {
  location: string;
  etag?: string;
  lastModified?: string;
  /** False when the parser or source config changed: force a full re-fetch. */
  reusable: boolean;
}

export interface AdapterContext {
  logger: Logger;
  signal?: AbortSignal;
  /** Looks up a stored document by location or alternate URL. */
  lookup(locationOrUrl: string): KnownDocument | undefined;
}

export interface DiscoveryStatus {
  complete: boolean;
  /** Why discovery was incomplete (for the sync summary). */
  reasons: string[];
}

export interface SourceAdapter {
  /** Streams outcomes. Throws SourceUnavailableError if the source cannot be read at all. */
  run(context: AdapterContext): AsyncIterable<ItemOutcome>;
  /** Valid after `run` finishes. */
  readonly discovery: DiscoveryStatus;
  /**
   * True if a stored document location is still inside the configured scope.
   * Documents outside scope are removed even when discovery was incomplete.
   */
  isInScope(location: string): boolean;
}

/** The whole source is unreachable (missing directory, unreachable host). Nothing is removed. */
export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}
