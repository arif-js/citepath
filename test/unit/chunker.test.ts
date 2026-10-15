import { describe, expect, it } from 'vitest';
import { chunkBlocks } from '../../src/indexing/chunker.js';
import { parseMarkdown, parsePlainText, stripMdx } from '../../src/indexing/markdown.js';
import { buildDocument } from '../../src/indexing/passages.js';

function paragraph(words: number, seed: string): string {
  return Array.from({ length: words }, (_, i) => `${seed}${i}`).join(' ');
}

describe('Chunking', () => {
  it('splits long sections on block boundaries within the size limit, with line ranges', () => {
    const paras = Array.from({ length: 8 }, (_, i) => paragraph(60, `w${i}x`));
    const md = ['# Long', '', ...paras.flatMap((p) => [p, ''])].join('\n');
    const chunks = chunkBlocks(parseMarkdown(md).blocks);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(2000);
      expect(chunk.headingPath).toEqual(['Long']);
    }
    expect(chunks.map((c) => c.occurrenceIndex)).toEqual(chunks.map((_, i) => i));
    expect(chunks[0]!.lineStart).toBe(1);
    expect(chunks[chunks.length - 1]!.lineEnd).toBe(17);
    // Every paragraph appears in some chunk.
    for (const p of paras) expect(chunks.some((c) => c.text.includes(p))).toBe(true);
  });

  it('never splits a code block that fits within the maximum', () => {
    const code = [
      '```js',
      ...Array.from({ length: 40 }, (_, i) => `const value${i} = compute(${i});`),
      '```',
    ].join('\n');
    const md = ['# Code', '', paragraph(150, 'intro'), '', code, '', paragraph(50, 'outro')].join('\n');
    const chunks = chunkBlocks(parseMarkdown(md).blocks);
    expect(chunks.filter((c) => c.text.includes('```js')).length).toBe(1);
    const withCode = chunks.find((c) => c.text.includes('```js'))!;
    expect(withCode.text).toContain('const value39 = compute(39);');
  });

  it('splits a single oversized block by lines', () => {
    const code = [
      '```',
      ...Array.from({ length: 200 }, (_, i) => `line_${i} = ${'x'.repeat(20)}`),
      '```',
    ].join('\n');
    const chunks = chunkBlocks(parseMarkdown(`# Huge\n\n${code}`).blocks);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(2000);
  });

  it('drops heading-only sections but keeps their heading in child breadcrumbs', () => {
    const chunks = chunkBlocks(parseMarkdown('# Guide\n\n## Install\n\nRun the installer.').blocks);
    expect(chunks.map((c) => c.headingPath)).toEqual([['Guide', 'Install']]);
  });

  it('chunks plain text by paragraphs with line ranges', () => {
    const doc = parsePlainText('First paragraph.\n\nSecond\nparagraph.\n', 'notes');
    expect(doc.title).toBe('notes');
    expect(doc.blocks.map((b) => [b.lineStart, b.lineEnd])).toEqual([
      [1, 1],
      [3, 4],
    ]);
  });
});

describe('MDX handling', () => {
  it('removes imports, exports, JSX comments, and component tags while keeping line numbers', () => {
    const source = [
      "import Tabs from '@theme/Tabs';",
      'export const meta = {};',
      '',
      '# Install',
      '',
      '<Tabs>',
      '<TabItem value="npm">',
      'Run `npm install`. {/* note */}',
      '</TabItem>',
      '</Tabs>',
      '',
      '```jsx',
      'import X from "y"; <Tabs />',
      '```',
    ].join('\n');
    const stripped = stripMdx(source);
    expect(stripped.split('\n').length).toBe(source.split('\n').length);
    expect(stripped).not.toContain('import Tabs');
    expect(stripped).not.toContain('<TabItem');
    expect(stripped).toContain('Run `npm install`.');
    expect(stripped).toContain('import X from "y"; <Tabs />'); // Code fences untouched

    const doc = parseMarkdown(source, { mdx: true });
    const heading = doc.blocks.find((b) => b.kind === 'heading')!;
    expect(heading.lineStart).toBe(4);
  });
});

describe('Document building', () => {
  it('produces stable passage IDs and a content hash that changes with content', () => {
    const md = '# A\n\nAlpha text.\n\n## B\n\nBeta text with getUserName.';
    const one = buildDocument('src', 'docs/a.md', parseMarkdown(md));
    const two = buildDocument('src', 'docs/a.md', parseMarkdown(md));
    expect(one.passages.map((p) => p.id)).toEqual(two.passages.map((p) => p.id));
    expect(one.contentHash).toBe(two.contentHash);
    expect(one.passages[1]!.codeTerms.split(' ')).toEqual(expect.arrayContaining(['get', 'user', 'name']));

    const edited = buildDocument('src', 'docs/a.md', parseMarkdown(md.replace('Beta text', 'Beta changed')));
    expect(edited.passages.map((p) => p.id)).toEqual(one.passages.map((p) => p.id));
    expect(edited.contentHash).not.toBe(one.contentHash);
    expect(edited.passages[1]!.contentHash).not.toBe(one.passages[1]!.contentHash);
  });

  it('uses front matter title, then the first h1, then the fallback', () => {
    expect(parseMarkdown('---\ntitle: FM Title\n---\n# H1\n\nx').title).toBe('FM Title');
    expect(parseMarkdown('# H1 Title\n\nx').title).toBe('H1 Title');
    expect(parseMarkdown('Just text', { documentTitle: 'file' }).title).toBe('file');
  });

  it('does not mistake a leading thematic break for front matter', () => {
    const doc = parseMarkdown('---\n\nSome intro paragraph.\n\n---\n\n# Heading\n\nBody.');
    expect(doc.metadata).toEqual({});
    expect(doc.blocks.some((b) => b.text.includes('Some intro paragraph.'))).toBe(true);
  });
});
