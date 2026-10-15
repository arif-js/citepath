import fs from 'node:fs';
import { z } from 'zod';
import { SEARCH_LIMITS } from '../config/defaults.js';
import { formatIssues } from '../config/load.js';
import { ConfigError, UsageError } from '../utils/errors.js';
import { normalizeUrl } from '../utils/url.js';
import { type RetrievalContext, search } from './retrieval.js';

/**
 * Retrieval evaluation (docs/evaluation.md): for each question, run the same search the
 * interfaces use and check whether the expected sources appear in the top k results.
 */

const ExpectedSchema = z.union([
  z.string().min(1),
  z.strictObject({
    source: z.string().optional(),
    url: z.string().optional(),
    path: z.string().optional(),
    anchor: z.string().optional(),
  }),
]);

export const EvalFileSchema = z.strictObject({
  $schema: z.string().optional(),
  k: z.number().int().min(1).max(SEARCH_LIMITS.maxLimit).optional(),
  questions: z
    .array(
      z.strictObject({
        id: z.string().min(1).optional(),
        question: z.string().min(1),
        expected: z.array(ExpectedSchema).min(1),
        sources: z.array(z.string()).optional(),
        notes: z.string().optional(),
      })
    )
    .min(1),
});

export type EvalFile = z.infer<typeof EvalFileSchema>;
type Expected = z.infer<typeof ExpectedSchema>;

export type ExpectedStatus = 'found' | 'indexed_not_retrieved' | 'not_in_index';

export interface ExpectedResult {
  expected: string;
  status: ExpectedStatus;
  /** 1-based rank of the first matching passage (when found). */
  rank?: number;
}

export interface QuestionResult {
  id: string;
  question: string;
  hit: boolean;
  recall: number;
  reciprocal_rank: number;
  expected: ExpectedResult[];
  retrieved: Array<{ rank: number; citation_url: string; title: string; heading_path: string[] }>;
}

export interface EvalReport {
  k: number;
  questions: number;
  hit_rate: number;
  recall_at_k: number;
  mrr: number;
  not_in_index: number;
  results: QuestionResult[];
}

export function readEvalFile(filePath: string): EvalFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new UsageError(`Evaluation file not found: ${filePath}`);
    throw new ConfigError(`Evaluation file ${filePath} is not valid JSON: ${err?.message ?? err}`);
  }
  const parsed = EvalFileSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConfigError(`Invalid evaluation file ${filePath}:\n${formatIssues(parsed.error.issues)}`);
  return parsed.data;
}

function describeExpected(expected: Expected): string {
  if (typeof expected === 'string') return expected;
  const target = expected.url ?? expected.path ?? '';
  const anchor = expected.anchor ? `#${expected.anchor.replace(/^#/, '')}` : '';
  return `${expected.source ? `${expected.source}:` : ''}${target}${anchor}`;
}

/** Resolves an expected source to the document IDs it refers to (empty: not in the index). */
function resolveExpected(
  context: RetrievalContext,
  expected: Expected,
  allowedSources: string[]
): Set<string> {
  const spec =
    typeof expected === 'string'
      ? /^https?:\/\//i.test(expected)
        ? { url: expected }
        : { path: expected }
      : expected;
  const sources = spec.source ? [spec.source] : allowedSources;
  if (sources.length === 0) return new Set();
  const placeholders = sources.map(() => '?').join(', ');
  let rows: Array<{ id: string }> = [];
  if (spec.url) {
    let normalized: string;
    try {
      normalized = normalizeUrl(spec.url);
    } catch {
      return new Set();
    }
    rows = context.db
      .prepare(
        `SELECT id FROM documents WHERE source_id IN (${placeholders})
         AND (location = ? OR url = ? OR id IN (SELECT document_id FROM document_urls WHERE url = ?))`
      )
      .all(...sources, normalized, spec.url, normalized) as Array<{ id: string }>;
  } else if (spec.path) {
    const p = spec.path.replace(/\\/g, '/').replace(/^\.\//, '');
    rows = context.db
      .prepare(`SELECT id FROM documents WHERE source_id IN (${placeholders}) AND path = ?`)
      .all(...sources, p) as Array<{ id: string }>;
  }
  return new Set(rows.map((r) => r.id));
}

export function runEvaluation(context: RetrievalContext, file: EvalFile, kOverride?: number): EvalReport {
  const k = kOverride ?? file.k ?? SEARCH_LIMITS.defaultLimit;
  if (!Number.isInteger(k) || k < 1 || k > SEARCH_LIMITS.maxLimit) {
    throw new UsageError(`k must be between 1 and ${SEARCH_LIMITS.maxLimit}.`);
  }
  const configured = context.loaded.config.sources.map((s) => s.id);
  const passageInfo = context.db.prepare('SELECT document_id, anchor FROM passages WHERE id = ?');

  const results: QuestionResult[] = file.questions.map((q, index) => {
    const allowed = q.sources?.length ? q.sources : configured;
    const response = search(context, { query: q.question, limit: k, source_ids: q.sources });
    const retrieved = response.results.map((r) => ({
      ...r,
      info: passageInfo.get(r.id) as { document_id: string; anchor: string | null },
    }));

    const expected: ExpectedResult[] = q.expected.map((exp) => {
      const docIds = resolveExpected(context, exp, allowed);
      const label = describeExpected(exp);
      if (docIds.size === 0) return { expected: label, status: 'not_in_index' };
      const anchor = typeof exp === 'object' && exp.anchor ? exp.anchor.replace(/^#/, '') : undefined;
      const position = retrieved.findIndex(
        (r) => docIds.has(r.info.document_id) && (anchor === undefined || r.info.anchor === anchor)
      );
      return position >= 0
        ? { expected: label, status: 'found', rank: position + 1 }
        : { expected: label, status: 'indexed_not_retrieved' };
    });

    const found = expected.filter((e) => e.status === 'found');
    const firstRank = found.length > 0 ? Math.min(...found.map((e) => e.rank!)) : 0;
    return {
      id: q.id ?? `q${index + 1}`,
      question: q.question,
      hit: found.length > 0,
      recall: found.length / expected.length,
      reciprocal_rank: firstRank > 0 ? 1 / firstRank : 0,
      expected,
      retrieved: retrieved.map((r, i) => ({
        rank: i + 1,
        citation_url: r.citation_url,
        title: r.title,
        heading_path: r.heading_path,
      })),
    };
  });

  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  return {
    k,
    questions: results.length,
    hit_rate: round(mean(results.map((r) => (r.hit ? 1 : 0)))),
    recall_at_k: round(mean(results.map((r) => r.recall))),
    mrr: round(mean(results.map((r) => r.reciprocal_rank))),
    not_in_index: results.reduce(
      (n, r) => n + r.expected.filter((e) => e.status === 'not_in_index').length,
      0
    ),
    results,
  };
}
