import { describe, expect, it } from 'vitest';
import { extractFrontMatter, parseMarkdownChunks } from '../../src/indexing/markdown.js';

describe('Markdown Line Mapping and Chunking', () => {
  it('extracts front matter and determines body line offset correctly', () => {
    const doc = `---
title: "My Guide"
author: "Alice"
---

# Introduction

Here is the intro.
`;

    const { frontMatter, bodyLineOffset } = extractFrontMatter(doc);
    expect(frontMatter.title).toBe('My Guide');
    expect(frontMatter.author).toBe('Alice');
    expect(bodyLineOffset).toBe(4); // Lines 0, 1, 2, 3 are front matter; line 4 is the blank line before # Introduction
  });

  it('maps exact line ranges for headings, paragraphs, code fences, and lists', () => {
    // Construct sample markdown with known line numbers
    const lines = [
      '# API Overview', // Line 1
      '', // Line 2
      'This document describes our REST API.', // Line 3
      'It supports JSON payloads.', // Line 4
      '', // Line 5
      '## Authentication', // Line 6
      '', // Line 7
      'Pass your bearer token in the header:', // Line 8
      '', // Line 9
      '```bash', // Line 10
      'curl -H "Authorization: Bearer $TOKEN" \\', // Line 11
      '  https://api.example.com/v1/status', // Line 12
      '```', // Line 13
      '', // Line 14
      '### Scopes', // Line 15
      '', // Line 16
      '- read:users', // Line 17
      '- write:users', // Line 18
      '- admin:all', // Line 19
    ];

    const markdown = lines.join('\n');
    const chunks = parseMarkdownChunks(markdown);

    expect(chunks.length).toBe(3);

    // Chunk 1: # API Overview
    const c1 = chunks[0]!;
    expect(c1.heading).toBe('API Overview');
    expect(c1.headingLevel).toBe(1);
    expect(c1.headingPath).toEqual(['API Overview']);
    expect(c1.lineStart).toBe(1);
    expect(c1.lineEnd).toBe(4);
    expect(c1.text).toContain('This document describes our REST API.');

    // Chunk 2: ## Authentication
    const c2 = chunks[1]!;
    expect(c2.heading).toBe('Authentication');
    expect(c2.headingLevel).toBe(2);
    expect(c2.headingPath).toEqual(['API Overview', 'Authentication']);
    expect(c2.lineStart).toBe(6);
    expect(c2.lineEnd).toBe(13);
    // Verifies code block is verbatim inside the passage text
    expect(c2.text).toContain('```bash\ncurl -H "Authorization: Bearer $TOKEN"');

    // Chunk 3: ### Scopes
    const c3 = chunks[2]!;
    expect(c3.heading).toBe('Scopes');
    expect(c3.headingLevel).toBe(3);
    expect(c3.headingPath).toEqual(['API Overview', 'Authentication', 'Scopes']);
    expect(c3.lineStart).toBe(15);
    expect(c3.lineEnd).toBe(19);
    expect(c3.text).toContain('- read:users');
    expect(c3.text).toContain('- admin:all');
  });

  it('preserves line numbers correctly when front matter is present', () => {
    const lines = [
      '---', // Line 1
      'title: Configuration Guide', // Line 2
      '---', // Line 3
      '', // Line 4
      '# Database Config', // Line 5
      '', // Line 6
      'Set `DATABASE_URL` in `.env`.', // Line 7
    ];

    const markdown = lines.join('\n');
    const chunks = parseMarkdownChunks(markdown);

    expect(chunks.length).toBe(1);
    const chunk = chunks[0]!;
    expect(chunk.heading).toBe('Database Config');
    expect(chunk.lineStart).toBe(5);
    expect(chunk.lineEnd).toBe(7);
  });

  it('handles documents without any headings gracefully', () => {
    const lines = [
      'This is a simple plain markdown document.',
      'It has no headings at all.',
      '',
      '```js',
      'console.log("hello");',
      '```',
    ];

    const markdown = lines.join('\n');
    const chunks = parseMarkdownChunks(markdown, { documentTitle: 'Readme' });

    expect(chunks.length).toBe(1);
    const chunk = chunks[0]!;
    expect(chunk.heading).toBe('Readme');
    expect(chunk.lineStart).toBe(1);
    expect(chunk.lineEnd).toBe(6);
    expect(chunk.text).toContain('console.log("hello");');
  });

  it('keeps repeated identical headings distinct with unique slugs and occurrenceIndex', () => {
    const lines = [
      '# Tools',
      '',
      '## Options',
      'Options for tool 1.',
      '',
      '## Subtool',
      '',
      '## Options',
      'Options for tool 2.',
    ];

    const markdown = lines.join('\n');
    const chunks = parseMarkdownChunks(markdown);

    const optionsChunks = chunks.filter((c) => c.heading === 'Options');
    expect(optionsChunks.length).toBe(2);

    expect(optionsChunks[0]!.slug).toBe('options');
    expect(optionsChunks[0]!.occurrenceIndex).toBe(0);

    expect(optionsChunks[1]!.slug).toBe('options-1');
    expect(optionsChunks[1]!.occurrenceIndex).toBe(1);
  });

  it('generates clean Unicode slugs for non-ASCII and CJK headings', () => {
    const lines = ['# Größe der Datei', 'Text', '', '## ユーザー認証ガイド', 'Text'];

    const chunks = parseMarkdownChunks(lines.join('\n'));
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.slug).toBe('größe-der-datei');
    expect(chunks[1]!.slug).toBe('ユーザー認証ガイド');
  });
});
