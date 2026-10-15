/**
 * Tokenization and query construction for FTS5 retrieval.
 *
 * Handles:
 * - Technical identifiers: camelCase, snake_case, dotted.names, --flags
 * - Unicode text: \p{L}\p{N} support (accented Latin like 'Größe', CJK via Intl.Segmenter, etc.)
 * - Natural language queries: OR-of-terms ranked by BM25 with all-term match boost
 * - FTS5 syntax safety: escapes/quotes terms so operators (AND, OR, NOT, NEAR),
 *   punctuation (., -, (, ), :, *, ^, {, }) never trigger syntax errors.
 */

const CJK_REGEX = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/**
 * Splits an identifier into its constituent word parts.
 * Uses Unicode-aware letter/number classification (\p{L}, \p{N}, \p{Ll}, \p{Lu})
 * and Intl.Segmenter for CJK scripts.
 *
 * E.g.:
 * - 'getUserName' -> ['get', 'user', 'name']
 * - 'user_profile_id' -> ['user', 'profile', 'id']
 * - 'GrößenOrdnung' -> ['größen', 'ordnung']
 * - 'system.config.load' -> ['system', 'config', 'load']
 * - '--force-dry-run' -> ['force', 'dry', 'run']
 * - 'ユーザー認証' -> ['ユーザー', '認証']
 */
export function splitIdentifier(identifier: string): string[] {
  const clean = identifier.replace(/^[-_.]+|[-_.]+$/gu, '');
  if (!clean) return [];

  // Split camelCase / PascalCase transitions using Unicode classes. An acronym followed by a
  // word splits before the word ("XMLHttp" -> "XML Http"), but a plural acronym stays whole
  // ("IDs", "APIs", "URLs"), so it does not produce stray one-letter terms.
  const camelSplit = clean
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, '$1 $2')
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}]{2,})/gu, '$1 $2');

  // Split by separators (_, -, ., whitespace)
  const parts = camelSplit.split(/[-_.\s]+/u);

  const result: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim().toLowerCase();
    if (!trimmed) continue;

    if (CJK_REGEX.test(trimmed)) {
      const segments = Array.from(wordSegmenter.segment(trimmed))
        .filter((s) => s.isWordLike)
        .map((s) => s.segment.toLowerCase());
      if (segments.length > 0) {
        result.push(...segments);
      } else {
        result.push(trimmed);
      }
    } else {
      result.push(trimmed);
    }
  }

  return result;
}

/**
 * Extracts all code identifier subterms, technical tokens, and words from document text.
 * Stored in an FTS code_terms column to make identifiers and CJK words searchable.
 */
export function extractCodeTerms(text: string): string[] {
  const terms = new Set<string>();

  // Match sequences of Unicode letters, numbers, underscores, dots, and hyphens
  const matches = text.match(/[\p{L}\p{N}_.-]+/gu) || [];

  for (const match of matches) {
    const clean = match.replace(/^[-_.]+|[-_.]+$/gu, '');
    if (!clean) continue;

    const parts = splitIdentifier(clean);
    if (parts.length > 1) {
      for (const p of parts) {
        terms.add(p);
      }
      // Add adjacent bigrams (especially useful for CJK compounds like ユーザー認証)
      for (let i = 0; i < parts.length - 1; i++) {
        terms.add(`${parts[i]}${parts[i + 1]}`);
      }
      // Add full collapsed version
      terms.add(parts.join(''));
    } else if (parts.length === 1) {
      terms.add(parts[0]!);
    } else {
      terms.add(clean.toLowerCase());
    }
  }

  return Array.from(terms);
}

/** English function words ignored in multi-word queries (never in identifiers or code). */
const STOPWORDS = new Set(
  (
    'a about an and any are as at be been but by can could did do does doing for from had has have how i ' +
    'if in into is it its me my of on or our should so than that the their them then there these they this ' +
    'to was we were what when where which while who why will with would you your'
  ).split(' ')
);

/**
 * Escapes a token for safe inclusion in an FTS5 MATCH phrase.
 * Double quotes within the token are escaped by doubling them ("").
 */
export function escapeFtsToken(token: string): string {
  return token.replace(/"/g, '""');
}

/**
 * Constructs a safe, ranked FTS5 MATCH query expression from arbitrary user input.
 *
 * Strategies:
 * 1. Sanitization: All terms are safely quoted, preventing syntax errors on special chars
 *    (--force, a.b.c, foo(, AND, OR, NOT, quotes, parens, etc.).
 * 2. Natural language retrieval: Combines terms using OR ranked by BM25, so queries like
 *    "how do I configure authentication" return relevant matches even if not every word matches.
 * 3. Exact/All-terms boost: If multiple terms are present, also includes an AND conjunction
 *    to boost documents matching all query terms.
 * 4. Identifier & CJK expansion: Code terms and CJK phrases match either the exact compound
 *    or its subcomponents.
 */
export function buildFtsQuery(userInput: string): string | null {
  if (!userInput || userInput.trim().length === 0) {
    return null;
  }

  // Extract query tokens containing Unicode letters, numbers, underscores, dots, hyphens
  const rawTokens = userInput.match(/[\p{L}\p{N}_.-]+/gu) || [];
  if (rawTokens.length === 0) {
    return null;
  }

  const singleTermClauses: string[] = [];

  // Drop common English function words when the query also has content words, so
  // "how do I configure authentication" ranks by "configure" and "authentication".
  const strippedTokens = rawTokens.map((t) => t.replace(/^[-_.]+|[-_.]+$/gu, '')).filter(Boolean);
  const contentTokens = strippedTokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  const tokens = contentTokens.length > 0 ? contentTokens : strippedTokens;

  for (const stripped of tokens) {
    const parts = splitIdentifier(stripped);

    if (parts.length > 1) {
      const exactEscaped = escapeFtsToken(stripped);
      const collapsedEscaped = escapeFtsToken(parts.join(''));
      const subpartsAnd = parts.map((p) => `"${escapeFtsToken(p)}"`).join(' AND ');
      const phraseMatch = parts.map((p) => `"${escapeFtsToken(p)}"`).join(' + ');

      singleTermClauses.push(
        `("${exactEscaped}" OR "${collapsedEscaped}" OR (${subpartsAnd}) OR (${phraseMatch}))`
      );
    } else {
      const escaped = escapeFtsToken(stripped);
      singleTermClauses.push(`"${escaped}"`);
    }
  }

  if (singleTermClauses.length === 0) {
    return null;
  }

  if (singleTermClauses.length === 1) {
    return singleTermClauses[0]!;
  }

  // Multi-term query:
  // Disjunction of terms (OR) ranked by BM25, with an all-term conjunction (AND) boost
  const orDisjunction = singleTermClauses.join(' OR ');
  const andConjunction = singleTermClauses.join(' AND ');

  return `(${orDisjunction}) OR (${andConjunction})`;
}
