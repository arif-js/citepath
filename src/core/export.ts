import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { indexPath } from '../store/db.js';
import { listSourceRows } from '../store/repo.js';
import { RESULT_SCHEMA_VERSION } from '../types/index.js';

/**
 * Export (docs/cli.md, "export"): every source, document, and passage as JSONL,
 * streamed in pages so memory stays bounded for large indexes.
 */

const PAGE = 500;

export interface ExportCounts {
  sources: number;
  documents: number;
  passages: number;
}

export function* exportLines(db: DatabaseSync, sourceIds?: string[]): Generator<string, ExportCounts> {
  const counts: ExportCounts = { sources: 0, documents: 0, passages: 0 };
  const sources = listSourceRows(db).filter((s) => !sourceIds?.length || sourceIds.includes(s.id));

  yield JSON.stringify({ type: 'export', format: 'citepath-jsonl', schema_version: RESULT_SCHEMA_VERSION });
  for (const source of sources) {
    counts.sources++;
    yield JSON.stringify({
      type: 'source',
      id: source.id,
      source_type: source.type,
      created_at: source.created_at,
    });

    let lastDoc = '';
    while (true) {
      const docs = db
        .prepare(
          `SELECT id, source_id, location, url, path, title, content_hash, metadata_json, updated_at, fetched_at,
                  commit_sha, dirty FROM documents WHERE source_id = ? AND id > ? ORDER BY id LIMIT ?`
        )
        .all(source.id, lastDoc, PAGE) as Array<Record<string, any>>;
      if (docs.length === 0) break;
      for (const doc of docs) {
        lastDoc = doc.id;
        counts.documents++;
        const alternates = (
          db
            .prepare('SELECT url FROM document_urls WHERE document_id = ? ORDER BY url')
            .all(doc.id) as Array<{
            url: string;
          }>
        ).map((r) => r.url);
        yield JSON.stringify({
          type: 'document',
          id: doc.id,
          source_id: doc.source_id,
          location: doc.location,
          url: doc.url ?? undefined,
          path: doc.path ?? undefined,
          title: doc.title,
          content_hash: doc.content_hash,
          metadata: JSON.parse(doc.metadata_json ?? '{}'),
          alternate_urls: alternates,
          updated_at: doc.updated_at ?? undefined,
          fetched_at: doc.fetched_at,
          commit: doc.commit_sha ?? undefined,
          dirty: doc.dirty === null ? undefined : doc.dirty === 1,
        });

        const passages = db
          .prepare(
            `SELECT id, ordinal, heading_path_json, anchor, line_start, line_end, text, content_hash
             FROM passages WHERE document_id = ? ORDER BY ordinal`
          )
          .all(doc.id) as Array<Record<string, any>>;
        for (const p of passages) {
          counts.passages++;
          yield JSON.stringify({
            type: 'passage',
            id: p.id,
            document_id: doc.id,
            source_id: doc.source_id,
            ordinal: p.ordinal,
            heading_path: JSON.parse(p.heading_path_json),
            anchor: p.anchor ?? undefined,
            line_start: p.line_start ?? undefined,
            line_end: p.line_end ?? undefined,
            text: p.text,
            content_hash: p.content_hash,
          });
        }
      }
    }
  }
  return counts;
}

/** Rebuilds the FTS index segments and reclaims free pages. Returns sizes in bytes. */
export function compactIndex(db: DatabaseSync, dataDir: string): { before: number; after: number } {
  const size = () => {
    let total = 0;
    for (const suffix of ['', '-wal']) {
      try {
        total += fs.statSync(`${indexPath(dataDir)}${suffix}`).size;
      } catch {
        // File may not exist.
      }
    }
    return total;
  };
  const before = size();
  db.exec("INSERT INTO passages_fts(passages_fts) VALUES('optimize')");
  db.exec('VACUUM');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { before, after: size() };
}
