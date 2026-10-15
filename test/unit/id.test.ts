import { describe, expect, it } from 'vitest';
import { computeContentHash, computeDocumentId, computePassageId } from '../../src/utils/id.js';

describe('Unambiguous ID Hashing', () => {
  it('prevents collisions from string concatenation boundaries', () => {
    // With naive string concatenation ("a" + "bc" === "ab" + "c"), these would collide!
    const id1 = computeDocumentId('a', 'bc');
    const id2 = computeDocumentId('ab', 'c');
    expect(id1).not.toBe(id2);

    const pass1 = computePassageId('doc-1', ['a', 'bc'], 0);
    const pass2 = computePassageId('doc-1', ['ab', 'c'], 0);
    expect(pass1).not.toBe(pass2);
  });

  it('produces deterministic and stable IDs for identical inputs', () => {
    const docId1 = computeDocumentId('react-docs', 'https://react.dev/reference/react');
    const docId2 = computeDocumentId('react-docs', 'https://react.dev/reference/react');
    expect(docId1).toBe(docId2);
    expect(docId1).toHaveLength(64); // sha256 hex length

    const passId1 = computePassageId(docId1, ['Hooks', 'useState'], 0);
    const passId2 = computePassageId(docId1, ['Hooks', 'useState'], 0);
    expect(passId1).toBe(passId2);
    expect(passId1).toHaveLength(64);
  });

  it('produces distinct IDs for different occurrence indices of repeated headings', () => {
    const docId = computeDocumentId('api-docs', '/docs/cli');
    const pass0 = computePassageId(docId, ['Options'], 0);
    const pass1 = computePassageId(docId, ['Options'], 1);
    expect(pass0).not.toBe(pass1);
  });

  it('computes sha256 content hashes', () => {
    const hash1 = computeContentHash('hello world');
    const hash2 = computeContentHash('hello world');
    const hash3 = computeContentHash('hello world!');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
  });
});
