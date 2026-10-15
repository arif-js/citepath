import * as cheerio from 'cheerio';
import { normalizeText } from '../utils/encoding.js';
import type { Block, ParsedDocument } from './blocks.js';

/** Structural view of domhandler nodes (cheerio does not re-export their types). */
interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
  parent?: DomNode | null;
}

export interface HtmlDocument extends ParsedDocument {
  /** Absolute canonical URL from <link rel="canonical">, if present and valid. */
  canonicalUrl?: string;
  /** Absolute http(s) links found anywhere on the page (fragment removed), for discovery. */
  links: string[];
  /** <meta name="robots" content="noindex"> (or name="citepath"). */
  noindex: boolean;
  /** Characters of extracted text across all blocks. */
  textLength: number;
}

export interface ParseHtmlOptions {
  /** CSS selector for the main content region (per-source override). */
  contentSelector?: string;
}

const REMOVE_EVERYWHERE = 'script, style, noscript, template, svg, canvas, iframe, object, embed, link, meta';

const REMOVE_IN_MAIN = [
  'nav',
  'aside',
  'form',
  'button',
  'footer',
  '[role="navigation"]',
  '[role="search"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[hidden]',
  '[aria-hidden="true"]',
  '[class*="cookie" i]',
  '[id*="cookie" i]',
  '[class*="edit-this-page" i]',
  '[class*="breadcrumb" i]',
  '[class*="table-of-contents" i]',
  '[class*="skip-link" i]',
].join(', ');

const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'img',
  'ins',
  'kbd',
  'label',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
  'br',
]);

const HEADING = /^h([1-6])$/;

function isHiddenByStyle(node: DomNode): boolean {
  const style = node.attribs?.style?.replace(/\s+/g, '').toLowerCase() ?? '';
  return style.includes('display:none') || style.includes('visibility:hidden');
}

function collapse(text: string): string {
  return text.replace(/[ \t\r\n\f ]+/g, ' ').trim();
}

/** Inline text of a node, with inline code wrapped in backticks. */
function inlineText(node: DomNode): string {
  if (node.type === 'text') return node.data ?? '';
  if (node.type !== 'tag' || isHiddenByStyle(node)) return '';
  if (node.name === 'br') return '\n';
  if (node.name === 'img') return node.attribs?.alt ? ` ${node.attribs.alt} ` : '';
  const inner = (node.children ?? []).map(inlineText).join('');
  if (node.name === 'code' && !hasAncestor(node, 'pre')) {
    const trimmed = inner.trim();
    return trimmed ? `\`${trimmed}\`` : '';
  }
  return inner;
}

/** Raw text with whitespace preserved (for <pre>). */
function rawText(node: DomNode): string {
  if (node.type === 'text') return node.data ?? '';
  if (node.type !== 'tag') return '';
  if (node.name === 'br') return '\n';
  return (node.children ?? []).map(rawText).join('');
}

function hasAncestor(node: DomNode, name: string): boolean {
  let current = node.parent;
  while (current) {
    if (current.name === name) return true;
    current = current.parent;
  }
  return false;
}

function codeLanguage(pre: DomNode): string {
  const classes = [pre.attribs?.class ?? '', ...(pre.children ?? []).map((c) => c.attribs?.class ?? '')].join(
    ' '
  );
  return /(?:language|lang)-([\w+#.-]+)/.exec(classes)?.[1] ?? '';
}

function headingAnchor(node: DomNode): string | undefined {
  if (node.attribs?.id) return node.attribs.id;
  const stack = [...(node.children ?? [])];
  while (stack.length > 0) {
    const child = stack.shift()!;
    if (child.type === 'tag') {
      const id = child.attribs?.id ?? (child.name === 'a' ? child.attribs?.name : undefined);
      if (id) return id;
      stack.push(...(child.children ?? []));
    }
  }
  // <section id="x"><h2>…</h2> pattern: the heading is the container's first content element.
  // Empty anchor targets before it (Sphinx: <span id="tut-x"></span>) do not count as content.
  const parent = node.parent;
  const siblings = parent?.children ?? [];
  let emptyTarget: string | undefined;
  for (let i = siblings.indexOf(node) - 1; i >= 0; i--) {
    const sibling = siblings[i]!;
    const hasText =
      sibling.type === 'text' ? Boolean(sibling.data?.trim()) : Boolean(rawText(sibling).trim());
    if (hasText) return emptyTarget; // Content before the heading: only adjacent empty targets count.
    if (sibling.type === 'tag') emptyTarget ??= sibling.attribs?.id ?? sibling.attribs?.name;
  }
  return parent?.attribs?.id ?? emptyTarget;
}

function listText(list: DomNode, depth: number): string {
  const ordered = list.name === 'ol';
  const lines: string[] = [];
  let index = 1;
  for (const item of list.children ?? []) {
    if (item.type !== 'tag' || item.name !== 'li') continue;
    const own = collapse(
      (item.children ?? [])
        .filter((c) => c.name !== 'ul' && c.name !== 'ol')
        .map(inlineOrBlockText)
        .join(' ')
    );
    const marker = ordered ? `${index++}.` : '-';
    lines.push(`${'  '.repeat(depth)}${marker} ${own}`);
    for (const nested of item.children ?? []) {
      if (nested.name === 'ul' || nested.name === 'ol') lines.push(listText(nested, depth + 1));
    }
  }
  return lines.join('\n');
}

/** Text of a node that may contain both inline and block children (e.g. <li><p>…</p></li>). */
function inlineOrBlockText(node: DomNode): string {
  if (node.type === 'tag' && node.name === 'pre') return rawText(node);
  return inlineText(node);
}

function tableText(table: DomNode): string {
  const rows: string[] = [];
  const visit = (node: DomNode) => {
    if (node.type !== 'tag') return;
    if (node.name === 'tr') {
      const cells = (node.children ?? [])
        .filter((c) => c.type === 'tag' && (c.name === 'td' || c.name === 'th'))
        .map((c) => collapse(inlineText(c)).replace(/\|/g, '\\|'));
      if (cells.some((c) => c.length > 0)) rows.push(`| ${cells.join(' | ')} |`);
      return;
    }
    (node.children ?? []).forEach(visit);
  };
  visit(table);
  return rows.join('\n');
}

function extractBlocks(root: DomNode): Block[] {
  const blocks: Block[] = [];
  let inline = '';

  const flush = () => {
    const text = collapse(inline);
    if (text) blocks.push({ kind: 'paragraph', text });
    inline = '';
  };

  const walk = (node: DomNode) => {
    if (node.type === 'text') {
      inline += node.data ?? '';
      return;
    }
    if (node.type !== 'tag' || isHiddenByStyle(node)) return;
    const name = node.name ?? '';

    if (INLINE_TAGS.has(name)) {
      inline += inlineText(node);
      return;
    }

    flush();
    const heading = HEADING.exec(name);
    if (heading) {
      const text = collapse(inlineText(node))
        .replace(/[#¶§]\s*$/, '')
        .trim();
      if (text) {
        blocks.push({
          kind: 'heading',
          level: Number(heading[1]),
          headingText: text,
          text: `${'#'.repeat(Number(heading[1]))} ${text}`,
          anchor: headingAnchor(node),
        });
      }
      return;
    }

    switch (name) {
      case 'p': {
        const text = collapse(inlineText(node));
        if (text) blocks.push({ kind: 'paragraph', text });
        return;
      }
      case 'pre': {
        const code = rawText(node).replace(/^\n+|\s+$/g, '');
        if (code) blocks.push({ kind: 'code', text: `\`\`\`${codeLanguage(node)}\n${code}\n\`\`\`` });
        return;
      }
      case 'ul':
      case 'ol': {
        const text = listText(node, 0);
        if (text.trim()) blocks.push({ kind: 'list', text });
        return;
      }
      case 'dl': {
        const lines = (node.children ?? [])
          .filter((c) => c.type === 'tag' && (c.name === 'dt' || c.name === 'dd'))
          .map((c) => (c.name === 'dt' ? `- ${collapse(inlineText(c))}` : `  ${collapse(inlineText(c))}`));
        if (lines.length > 0) blocks.push({ kind: 'list', text: lines.join('\n') });
        return;
      }
      case 'table': {
        const text = tableText(node);
        if (text) blocks.push({ kind: 'table', text });
        return;
      }
      case 'blockquote': {
        const inner = extractBlocks(node)
          .map((b) => b.text)
          .join('\n\n');
        if (inner.trim()) {
          blocks.push({
            kind: 'quote',
            text: inner
              .split('\n')
              .map((line) => `> ${line}`)
              .join('\n'),
          });
        }
        return;
      }
      case 'hr':
        return;
      default:
        (node.children ?? []).forEach(walk);
        flush();
    }
  };

  (root.children ?? []).forEach(walk);
  flush();
  return blocks;
}

function resolveHttpUrl(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href.trim(), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Extracts readable content from an HTML page:
 * - discovery links are collected from the whole page before anything is removed;
 * - scripts, styles, and embedded objects are removed everywhere;
 * - the main region is the per-source selector, then <main>, <article>, [role=main], <body>;
 * - navigation, sidebars, forms, footers, hidden elements, and common boilerplate are removed;
 * - headings keep their element id as the deep-link anchor; code is kept verbatim.
 */
export function parseHtml(html: string, pageUrl: string, options: ParseHtmlOptions = {}): HtmlDocument {
  const $ = cheerio.load(normalizeText(html));
  const baseHref = $('base[href]').first().attr('href');
  const base = resolveHttpUrl(baseHref, pageUrl) ?? pageUrl;

  const links = new Set<string>();
  $('a[href]').each((_, el) => {
    const resolved = resolveHttpUrl($(el).attr('href'), base);
    if (resolved) links.add(resolved);
  });

  const canonicalUrl = resolveHttpUrl($('link[rel~="canonical"]').first().attr('href'), base);
  const robots = [
    $('meta[name="robots" i]').attr('content') ?? '',
    $('meta[name="citepath" i]').attr('content') ?? '',
  ].join(',');
  const noindex = /\bnoindex\b/i.test(robots);
  const metaDescription = $('meta[name="description" i]').attr('content')?.trim();

  const pageTitle = collapse($('title').first().text());
  $(REMOVE_EVERYWHERE).remove();

  let main = options.contentSelector ? $(options.contentSelector).first() : $([]);
  if (main.length === 0) main = $('main').first();
  if (main.length === 0) main = $('article').first();
  if (main.length === 0) main = $('[role="main"]').first();
  const usingBody = main.length === 0;
  if (usingBody) main = $('body').first();
  if (main.length === 0) main = $.root();

  main.find(REMOVE_IN_MAIN).remove();
  if (usingBody) main.find('header').remove();

  const root = main.get(0) as unknown as DomNode | undefined;
  const blocks = root ? extractBlocks(root) : [];
  const firstH1 = blocks.find((b) => b.kind === 'heading' && b.level === 1)?.headingText;
  const textLength = blocks.reduce((n, b) => n + (b.kind === 'heading' ? 0 : b.text.length), 0);

  const metadata: Record<string, string> = {};
  if (metaDescription) metadata.description = metaDescription;

  return {
    title: pageTitle || firstH1 || '',
    blocks,
    metadata,
    canonicalUrl,
    links: [...links],
    noindex,
    textLength,
  };
}
