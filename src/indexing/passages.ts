import { computeContentHash, computeDocumentId, computePassageId } from '../utils/id.js';
import type { ParsedDocument } from './blocks.js';
import { type ChunkOptions, chunkBlocks } from './chunker.js';
import { extractCodeTerms } from './tokenizer.js';

/**
 * Version of the extraction + chunking pipeline. Bump it whenever parsing, chunking,
 * or tokenization changes output, so the next sync re-processes existing documents.
 */
export const PARSER_VERSION = 1;

export interface PassageRecord {
  id: string;
  ordinal: number;
  headingPath: string[];
  anchor?: string;
  lineStart?: number;
  lineEnd?: number;
  text: string;
  contentHash: string;
  occurrenceIndex: number;
  /** Space-separated identifier subterms for the FTS code_terms column. */
  codeTerms: string;
}

export interface DocumentRecord {
  id: string;
  sourceId: string;
  /** Normalized identity: canonical URL (web) or POSIX path relative to the root (local). */
  location: string;
  title: string;
  contentHash: string;
  metadata: Record<string, string>;
  passages: PassageRecord[];
}

/**
 * The FTS heading_path value for a passage. The top heading is dropped when it repeats the page
 * title, which has its own column; otherwise every passage on a page would rank on the title twice,
 * and one-line sections would outrank sections that actually discuss the query.
 */
export function ftsHeadingPath(title: string, headingPath: string[]): string {
  const [first, ...rest] = headingPath;
  const repeatsTitle = first !== undefined && first.trim().toLowerCase() === title.trim().toLowerCase();
  return (repeatsTitle ? rest : headingPath).join(' / ');
}

/** The FTS code_terms value for a passage. Also used to rebuild the FTS index in migrations. */
export function passageCodeTerms(headingPath: string[], text: string): string {
  return extractCodeTerms(`${headingPath.join(' ')} ${text}`).join(' ');
}

/** Builds the stored document and its passages (with stable IDs) from parsed content. */
export function buildDocument(
  sourceId: string,
  location: string,
  parsed: ParsedDocument,
  options: ChunkOptions = {}
): DocumentRecord {
  const documentId = computeDocumentId(sourceId, location);
  const chunks = chunkBlocks(parsed.blocks, options);
  const passages: PassageRecord[] = chunks.map((chunk, ordinal) => ({
    id: computePassageId(documentId, chunk.headingPath, chunk.occurrenceIndex),
    ordinal,
    headingPath: chunk.headingPath,
    anchor: chunk.anchor,
    lineStart: chunk.lineStart,
    lineEnd: chunk.lineEnd,
    text: chunk.text,
    contentHash: computeContentHash(chunk.text),
    occurrenceIndex: chunk.occurrenceIndex,
    codeTerms: passageCodeTerms(chunk.headingPath, chunk.text),
  }));

  // Covers everything a citation shows, so any visible change produces a new hash.
  const contentHash = computeContentHash(
    JSON.stringify([
      parsed.title,
      passages.map((p) => [p.headingPath, p.anchor ?? null, p.lineStart ?? null, p.lineEnd ?? null, p.text]),
    ])
  );

  return {
    id: documentId,
    sourceId,
    location,
    title: parsed.title,
    contentHash,
    metadata: parsed.metadata,
    passages,
  };
}
