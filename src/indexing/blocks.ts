/**
 * Format-neutral document structure. Markdown, HTML, and plain-text parsers produce
 * blocks; the chunker turns blocks into passages. Keeping one intermediate form means
 * splitting rules, IDs, and line ranges behave the same for every source type.
 */

export type BlockKind = 'heading' | 'paragraph' | 'code' | 'table' | 'list' | 'quote' | 'other';

export interface Block {
  kind: BlockKind;
  /** Text as it should appear in a passage (verbatim Markdown for local files). */
  text: string;
  /** Heading level 1-6 (headings only). */
  level?: number;
  /** Plain heading text for breadcrumbs (headings only). */
  headingText?: string;
  /** Deep-link anchor: HTML element id or generated Markdown slug (headings only). */
  anchor?: string;
  /** 1-indexed inclusive line range in the original file (local files only). */
  lineStart?: number;
  lineEnd?: number;
}

export interface ParsedDocument {
  title: string;
  blocks: Block[];
  metadata: Record<string, string>;
}
