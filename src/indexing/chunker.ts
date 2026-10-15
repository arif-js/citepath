import { CHUNK_DEFAULTS } from '../config/defaults.js';
import type { Block } from './blocks.js';

export interface Chunk {
  headingPath: string[];
  /** Level of the section heading (0 for content before the first heading). */
  level: number;
  anchor?: string;
  text: string;
  lineStart?: number;
  lineEnd?: number;
  /** Nth chunk sharing this heading path (repeated headings and size-split parts). */
  occurrenceIndex: number;
}

export interface ChunkOptions {
  targetChars?: number;
  maxChars?: number;
  overlapChars?: number;
}

interface Section {
  headingPath: string[];
  level: number;
  anchor?: string;
  heading?: Block;
  body: Block[];
}

const SEPARATOR = '\n\n';

function buildSections(blocks: Block[]): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ title: string; level: number }> = [];
  let current: Section = { headingPath: [], level: 0, body: [] };

  for (const block of blocks) {
    if (block.kind === 'heading') {
      sections.push(current);
      const level = block.level ?? 1;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ title: block.headingText ?? block.text, level });
      current = {
        headingPath: stack.map((h) => h.title),
        level,
        anchor: block.anchor,
        heading: block,
        body: [],
      };
    } else if (block.text.trim().length > 0) {
      current.body.push(block);
    }
  }
  sections.push(current);
  // Heading-only sections carry no content; their heading still appears in children's paths.
  return sections.filter((section) => section.body.length > 0);
}

/** Splits one oversized block by lines into pieces of at most `limit` characters. */
function splitBlockByLines(block: Block, limit: number): Block[] {
  const lines = block.text.split('\n');
  const pieces: Block[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;
  let pieceStart = block.lineStart;

  const flush = (endOffset: number) => {
    if (buffer.length === 0) return;
    const lineEnd = block.lineStart !== undefined ? block.lineStart + endOffset - 1 : undefined;
    pieces.push({ ...block, text: buffer.join('\n'), lineStart: pieceStart, lineEnd });
    pieceStart = lineEnd !== undefined ? lineEnd + 1 : undefined;
    buffer = [];
    bufferLen = 0;
  };

  lines.forEach((rawLine, index) => {
    // A single overlong line (e.g. minified content) is hard-wrapped.
    for (let start = 0; start < Math.max(rawLine.length, 1); start += limit) {
      const line = rawLine.slice(start, start + limit);
      if (bufferLen > 0 && bufferLen + 1 + line.length > limit) flush(index);
      buffer.push(line);
      bufferLen += line.length + 1;
    }
  });
  flush(lines.length);
  return pieces;
}

function joinText(blocks: Block[]): string {
  return blocks
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join(SEPARATOR);
}

function lineRange(blocks: Block[]): { lineStart?: number; lineEnd?: number } {
  const starts = blocks.map((b) => b.lineStart).filter((n): n is number => n !== undefined);
  const ends = blocks.map((b) => b.lineEnd).filter((n): n is number => n !== undefined);
  return {
    lineStart: starts.length > 0 ? Math.min(...starts) : undefined,
    lineEnd: ends.length > 0 ? Math.max(...ends) : undefined,
  };
}

function splitSection(section: Section, options: Required<ChunkOptions>): Block[][] {
  const all = section.heading ? [section.heading, ...section.body] : section.body;
  if (joinText(all).length <= options.maxChars) return [all];

  // Break oversized blocks first; code, tables, and lists stay whole when they fit.
  const units: Block[] = [];
  for (const block of all) {
    if (block.text.length > options.maxChars) units.push(...splitBlockByLines(block, options.targetChars));
    else units.push(block);
  }

  const parts: Block[][] = [];
  let current: Block[] = [];
  let currentLen = 0;
  for (const unit of units) {
    const addLen = unit.text.length + (current.length > 0 ? SEPARATOR.length : 0);
    if (current.length > 0 && currentLen + addLen > options.targetChars) {
      parts.push(current);
      const last = current[current.length - 1]!;
      // Carry a short trailing block into the next part for context.
      const carry = last.kind !== 'heading' && last.text.length <= options.overlapChars ? [last] : [];
      current = [...carry];
      currentLen = carry.reduce((n, b) => n + b.text.length, 0);
    }
    current.push(unit);
    currentLen += unit.text.length + (current.length > 1 ? SEPARATOR.length : 0);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/**
 * Turns blocks into passages:
 * - one passage per heading section, carrying the full heading breadcrumb;
 * - heading-only sections are dropped;
 * - sections longer than maxChars are split on block boundaries (never inside code,
 *   tables, or lists unless a single block exceeds maxChars), with a small overlap;
 * - very small sections stay separate so every citation points at the right heading.
 */
export function chunkBlocks(blocks: Block[], options: ChunkOptions = {}): Chunk[] {
  const resolved: Required<ChunkOptions> = {
    targetChars: options.targetChars ?? CHUNK_DEFAULTS.targetChars,
    maxChars: options.maxChars ?? CHUNK_DEFAULTS.maxChars,
    overlapChars: options.overlapChars ?? CHUNK_DEFAULTS.overlapChars,
  };

  const chunks: Chunk[] = [];
  const occurrences = new Map<string, number>();

  for (const section of buildSections(blocks)) {
    for (const part of splitSection(section, resolved)) {
      const text = joinText(part);
      if (text.length === 0) continue;
      const key = JSON.stringify(section.headingPath);
      const occurrenceIndex = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrenceIndex + 1);
      chunks.push({
        headingPath: section.headingPath,
        level: section.level,
        anchor: section.anchor,
        text,
        ...lineRange(part),
        occurrenceIndex,
      });
    }
  }
  return chunks;
}
