import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import { normalizeText } from '../utils/encoding.js';
import type { Block, BlockKind, ParsedDocument } from './blocks.js';
import { type ChunkOptions, chunkBlocks } from './chunker.js';
import type { HtmlDocument } from './html.js';

export interface MarkdownChunk {
  heading: string;
  headingLevel: number;
  headingPath: string[];
  slug: string;
  text: string;
  lineStart: number; // 1-indexed
  lineEnd: number; // 1-indexed
  occurrenceIndex: number;
}

export interface ParseMarkdownOptions {
  documentTitle?: string;
  /** Treat input as MDX: remove import/export lines and JSX component tags. */
  mdx?: boolean;
}

/**
 * Generates a GitHub-style URL slug from heading text (Unicode letters and numbers kept).
 */
export function generateSlug(heading: string): string {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-');
}

const FRONT_MATTER_LINE = /^([\w-]+\s*:.*|\s+.*|-\s.*|#.*|)$/;

/**
 * Extracts YAML front matter (between a leading "---" and the next "---").
 * Only simple `key: value` pairs are read; the body keeps its original line offset.
 * A leading thematic break followed by ordinary Markdown is not mistaken for front matter.
 */
export function extractFrontMatter(rawContent: string): {
  frontMatter: Record<string, string>;
  body: string;
  bodyLineOffset: number;
} {
  const lines = rawContent.split(/\r?\n/);
  const none = { frontMatter: {}, body: rawContent, bodyLineOffset: 0 };
  if (lines[0]?.trim() !== '---') return none;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---' || lines[i]?.trim() === '...') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return none;

  const fmLines = lines.slice(1, endIdx);
  if (!fmLines.every((line) => FRONT_MATTER_LINE.test(line))) return none;
  if (!fmLines.some((line) => /^[\w-]+\s*:/.test(line))) return none;

  const metadata: Record<string, string> = {};
  for (const line of fmLines) {
    const match = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value !== '' && value !== '|' && value !== '>') metadata[match[1]!] = value;
  }

  return {
    frontMatter: metadata,
    body: lines.slice(endIdx + 1).join('\n'),
    bodyLineOffset: endIdx + 1,
  };
}

/**
 * Removes MDX-only syntax while keeping the line count (so line ranges stay exact):
 * top-level import/export statements, JSX comments, and lines that only open or close
 * a JSX component. Fenced code is left untouched.
 */
export function stripMdx(source: string): string {
  const lines = source.split('\n');
  let fence: string | null = null;
  return lines
    .map((line) => {
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
      if (fenceMatch) {
        if (fence === null) fence = fenceMatch[1]![0]!;
        else if (fenceMatch[1]![0] === fence) fence = null;
        return line;
      }
      if (fence !== null) return line;
      if (/^\s*(import|export)\s/.test(line)) return '';
      let out = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      // Whole-line component tags: <Tabs>, </Tabs>, <Note type="x" />
      if (/^\s*<\/?[A-Z][\w.]*(\s[^>]*)?\/?>\s*$/.test(out)) return '';
      // Inline component tags keep their text content.
      out = out.replace(/<\/?[A-Z][\w.]*(\s[^>]*)?\/?>/g, '');
      return out;
    })
    .join('\n');
}

function inlinePlainText(token: Token | undefined): string {
  if (!token?.children) return token?.content?.trim() ?? '';
  return token.children
    .map((child) => {
      if (child.type === 'text' || child.type === 'code_inline') return child.content;
      if (child.type === 'softbreak' || child.type === 'hardbreak') return ' ';
      if (child.type === 'image') return child.content;
      return '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

const OPEN_KINDS: Record<string, BlockKind> = {
  paragraph_open: 'paragraph',
  bullet_list_open: 'list',
  ordered_list_open: 'list',
  blockquote_open: 'quote',
  table_open: 'table',
  dl_open: 'list',
};

const md = new MarkdownIt({ html: true });

/**
 * Parses Markdown into blocks. Block text is the verbatim source lines (so code and
 * tables are preserved exactly); line numbers are 1-indexed in the original file.
 */
export function parseMarkdown(markdownSource: string, options: ParseMarkdownOptions = {}): ParsedDocument {
  const source = normalizeText(markdownSource);
  const { frontMatter, body, bodyLineOffset } = extractFrontMatter(source);
  const content = options.mdx ? stripMdx(body) : body;
  const bodyLines = content.split('\n');
  const tokens = md.parse(content, {});
  const slugCounts = new Map<string, number>();
  const blocks: Block[] = [];

  const sliceLines = (map: [number, number]) => {
    const text = bodyLines.slice(map[0], map[1]).join('\n').replace(/\s+$/, '');
    return { text, lineStart: bodyLineOffset + map[0] + 1, lineEnd: bodyLineOffset + map[1] };
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.level !== 0) continue;

    if (token.type === 'heading_open' && token.map) {
      const headingText = inlinePlainText(tokens[i + 1]);
      const base = generateSlug(headingText) || 'section';
      const count = slugCounts.get(base) ?? 0;
      slugCounts.set(base, count + 1);
      blocks.push({
        kind: 'heading',
        level: Number.parseInt(token.tag.slice(1), 10) || 1,
        headingText,
        anchor: count === 0 ? base : `${base}-${count}`,
        ...sliceLines(token.map),
      });
      continue;
    }

    const kind = OPEN_KINDS[token.type];
    if (kind && token.map) {
      blocks.push({ kind, ...sliceLines(token.map) });
      continue;
    }
    if ((token.type === 'fence' || token.type === 'code_block') && token.map) {
      blocks.push({ kind: 'code', ...sliceLines(token.map) });
      continue;
    }
    if (token.type === 'html_block' && token.map) {
      const raw = sliceLines(token.map);
      const withoutComments = raw.text.replace(/<!--[\s\S]*?-->/g, '').trim();
      if (withoutComments.length > 0) blocks.push({ kind: 'other', ...raw });
    }
  }

  const firstH1 = blocks.find((b) => b.kind === 'heading' && b.level === 1)?.headingText;
  const title = frontMatter.title || firstH1 || options.documentTitle || '';
  return { title, blocks, metadata: frontMatter };
}

/**
 * Parses a web page served as Markdown (`text/markdown`) into the same shape as an HTML page:
 * blocks, absolute http(s) links for discovery, and the extracted text length.
 */
export function parseMarkdownPage(markdownSource: string, pageUrl: string): HtmlDocument {
  const parsed = parseMarkdown(markdownSource);
  const links = new Set<string>();
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === 'link_open') {
        const href = token.attrGet('href');
        if (href) {
          try {
            const url = new URL(href, pageUrl);
            url.hash = '';
            if (url.protocol === 'http:' || url.protocol === 'https:') links.add(url.toString());
          } catch {
            // Not a usable URL.
          }
        }
      }
      if (token.children) visit(token.children);
    }
  };
  visit(md.parse(normalizeText(markdownSource), {}));
  const textLength = parsed.blocks.reduce((sum, block) => sum + block.text.length, 0);
  return { ...parsed, links: [...links], noindex: false, textLength };
}

/** Parses plain text into paragraph blocks separated by blank lines. */
export function parsePlainText(textSource: string, title: string): ParsedDocument {
  const lines = normalizeText(textSource).split('\n');
  const blocks: Block[] = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const blank = i === lines.length || lines[i]!.trim() === '';
    if (!blank && start === -1) start = i;
    if (blank && start !== -1) {
      blocks.push({
        kind: 'paragraph',
        text: lines.slice(start, i).join('\n'),
        lineStart: start + 1,
        lineEnd: i,
      });
      start = -1;
    }
  }
  return { title, blocks, metadata: {} };
}

/**
 * Parses a Markdown document into heading-based chunks with exact 1-indexed line ranges.
 * See chunkBlocks for the splitting rules.
 */
export function parseMarkdownChunks(
  markdownSource: string,
  options: ParseMarkdownOptions & ChunkOptions = {}
): MarkdownChunk[] {
  const parsed = parseMarkdown(markdownSource, options);
  const fallbackHeading = options.documentTitle || parsed.metadata.title || '';
  return chunkBlocks(parsed.blocks, options).map((chunk) => ({
    heading: chunk.headingPath[chunk.headingPath.length - 1] ?? fallbackHeading,
    headingLevel: chunk.level,
    headingPath: chunk.headingPath,
    slug: chunk.anchor ?? '',
    text: chunk.text,
    lineStart: chunk.lineStart ?? 1,
    lineEnd: chunk.lineEnd ?? 1,
    occurrenceIndex: chunk.occurrenceIndex,
  }));
}
