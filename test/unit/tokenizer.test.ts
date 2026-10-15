import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildFtsQuery, extractCodeTerms, splitIdentifier } from '../../src/indexing/tokenizer.js';

describe('Tokenizer and FTS Query Construction', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE VIRTUAL TABLE passages_fts USING fts5(
        title,
        heading_path,
        text,
        code_terms
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe('splitIdentifier with Unicode Support', () => {
    it('splits camelCase identifiers with ASCII and Unicode characters', () => {
      expect(splitIdentifier('getUserName')).toEqual(['get', 'user', 'name']);
      expect(splitIdentifier('parseJSONResponse')).toEqual(['parse', 'json', 'response']);
      expect(splitIdentifier('GrößenOrdnung')).toEqual(['größen', 'ordnung']);
    });

    it('splits snake_case identifiers', () => {
      expect(splitIdentifier('user_profile_id')).toEqual(['user', 'profile', 'id']);
      expect(splitIdentifier('MAX_RETRY_COUNT')).toEqual(['max', 'retry', 'count']);
    });

    it('splits dotted names', () => {
      expect(splitIdentifier('system.config.load')).toEqual(['system', 'config', 'load']);
      expect(splitIdentifier('a.b.c')).toEqual(['a', 'b', 'c']);
    });

    it('splits CLI flags and kebab-case', () => {
      expect(splitIdentifier('--force')).toEqual(['force']);
      expect(splitIdentifier('--dry-run')).toEqual(['dry', 'run']);
      expect(splitIdentifier('my-custom-flag')).toEqual(['my', 'custom', 'flag']);
    });

    it('handles CJK and edge cases gracefully', () => {
      expect(splitIdentifier('ユーザー認証')).toEqual(['ユーザー', '認証']);
      expect(splitIdentifier('')).toEqual([]);
      expect(splitIdentifier('---')).toEqual([]);
      expect(splitIdentifier('...')).toEqual([]);
    });
  });

  describe('extractCodeTerms with Unicode', () => {
    it('extracts technical identifiers, German umlauts, and CJK terms', () => {
      const text = 'Call getUserName(id) with --dry-run. Die maximale Größe ist 10MB. ユーザー認証のAPI.';
      const terms = extractCodeTerms(text);

      expect(terms).toContain('get');
      expect(terms).toContain('user');
      expect(terms).toContain('name');
      expect(terms).toContain('getusername');
      expect(terms).toContain('dry');
      expect(terms).toContain('run');
      expect(terms).toContain('größe');
      expect(terms).toContain('ユーザー認証');
    });
  });

  describe('FTS5 Syntax Safety', () => {
    const dangerousInputs = [
      '--force',
      'a.b.c',
      'foo(',
      'AND',
      'OR',
      'NOT',
      '"',
      '*',
      '^',
      ':',
      '{',
      '}',
      '(',
      ')',
      'NEAR(a, b)',
      'AND OR NOT',
      '--dry-run && rm -rf /',
      'field:value',
      'test*prefix',
      '{"json": true}',
      'SELECT * FROM users;',
      '   ',
      '',
    ];

    for (const input of dangerousInputs) {
      it(`never throws FTS5 syntax error for input: ${JSON.stringify(input)}`, () => {
        const query = buildFtsQuery(input);
        if (query === null) {
          return;
        }

        expect(() => {
          db.prepare('SELECT * FROM passages_fts WHERE passages_fts MATCH ?').all(query);
        }).not.toThrow();
      });
    }
  });

  describe('Natural Language Queries and BM25 Ranking', () => {
    beforeEach(() => {
      const insert = db.prepare(`
        INSERT INTO passages_fts(title, heading_path, text, code_terms)
        VALUES (?, ?, ?, ?)
      `);

      const text1 = 'How to configure authentication tokens for API access.';
      insert.run('Auth Guide', 'Authentication / Setup', text1, extractCodeTerms(text1).join(' '));

      const text2 = 'Setting up network proxies and firewalls.';
      insert.run('Network Guide', 'Networking', text2, extractCodeTerms(text2).join(' '));

      const text3 = 'Die maximale Größe für Uploads beträgt 50 Megabytes.';
      insert.run('German Docs', 'Uploads', text3, extractCodeTerms(text3).join(' '));

      const text4 = 'ユーザー認証を行うためのクライアントライブラリです。';
      insert.run('Japanese Docs', 'Auth', text4, extractCodeTerms(text4).join(' '));
    });

    it('returns relevant results for natural language questions where not all words match', () => {
      // "how do I configure authentication" contains "do" and "I" which are not in the document
      const query = buildFtsQuery('how do I configure authentication');
      expect(query).not.toBeNull();

      const stmt = db.prepare(`
        SELECT title, bm25(passages_fts) as score
        FROM passages_fts
        WHERE passages_fts MATCH ?
        ORDER BY score
      `);

      const results = stmt.all(query!) as any[];
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].title).toBe('Auth Guide');
    });

    it('finds documents containing Unicode characters like "Größe"', () => {
      const query = buildFtsQuery('Größe');
      const results = db
        .prepare('SELECT title FROM passages_fts WHERE passages_fts MATCH ?')
        .all(query!) as any[];
      expect(results.map((r) => r.title)).toContain('German Docs');
    });

    it('finds documents containing CJK characters like "ユーザー認証"', () => {
      const query = buildFtsQuery('ユーザー認証');
      const results = db
        .prepare('SELECT title FROM passages_fts WHERE passages_fts MATCH ?')
        .all(query!) as any[];
      expect(results.map((r) => r.title)).toContain('Japanese Docs');
    });
  });

  describe('Findability of Technical Terms', () => {
    beforeEach(() => {
      const insert = db.prepare(`
        INSERT INTO passages_fts(title, heading_path, text, code_terms)
        VALUES (?, ?, ?, ?)
      `);

      const text1 = 'The function getUserName retrieves account profile for given user ID.';
      insert.run('User API', 'Users / Profile', text1, extractCodeTerms(text1).join(' '));

      const text2 = 'Configuration option user_profile_id is stored in local settings.';
      insert.run('Settings API', 'Config', text2, extractCodeTerms(text2).join(' '));

      const text3 = 'System parameters are read through system.config.load at startup.';
      insert.run('System API', 'Startup', text3, extractCodeTerms(text3).join(' '));

      const text4 = 'Use the --force flag to override prompts, or --dry-run for testing.';
      insert.run('CLI Usage', 'Commands', text4, extractCodeTerms(text4).join(' '));
    });

    it('finds getUserName when searching "user"', () => {
      const query = buildFtsQuery('user')!;
      const results = db.prepare('SELECT * FROM passages_fts WHERE passages_fts MATCH ?').all(query) as any[];
      expect(results.map((r) => r.title)).toContain('User API');
    });

    it('finds getUserName when searching "getUserName"', () => {
      const query = buildFtsQuery('getUserName')!;
      const results = db.prepare('SELECT * FROM passages_fts WHERE passages_fts MATCH ?').all(query) as any[];
      expect(results.map((r) => r.title)).toContain('User API');
    });

    it('finds user_profile_id when searching "snake_case" subterms', () => {
      const query1 = buildFtsQuery('profile')!;
      const res1 = db.prepare('SELECT * FROM passages_fts WHERE passages_fts MATCH ?').all(query1) as any[];
      expect(res1.map((r) => r.title)).toContain('Settings API');

      const query2 = buildFtsQuery('user_profile_id')!;
      const res2 = db.prepare('SELECT * FROM passages_fts WHERE passages_fts MATCH ?').all(query2) as any[];
      expect(res2.map((r) => r.title)).toContain('Settings API');
    });

    it('finds system.config.load when searching "foo.bar" style or subterms', () => {
      const query1 = buildFtsQuery('system.config.load')!;
      const res1 = db.prepare('SELECT * FROM passages_fts WHERE passages_fts MATCH ?').all(query1) as any[];
      expect(res1.map((r) => r.title)).toContain('System API');

      const query2 = buildFtsQuery('config')!;
      const res2 = db.prepare('SELECT * FROM passages_fts WHERE passages_fts MATCH ?').all(query2) as any[];
      expect(res2.map((r) => r.title)).toContain('System API');
    });

    it('finds --force when searching "--force" or "force"', () => {
      const query1 = buildFtsQuery('--force')!;
      const res1 = db.prepare('SELECT * FROM passages_fts WHERE passages_fts MATCH ?').all(query1) as any[];
      expect(res1.map((r) => r.title)).toContain('CLI Usage');

      const query2 = buildFtsQuery('force')!;
      const res2 = db.prepare('SELECT * FROM passages_fts WHERE passages_fts MATCH ?').all(query2) as any[];
      expect(res2.map((r) => r.title)).toContain('CLI Usage');
    });
  });

  describe('Regressions found during end-to-end testing', () => {
    it('keeps plural acronyms whole instead of producing one-letter terms', () => {
      expect(splitIdentifier('IDs')).toEqual(['ids']);
      expect(splitIdentifier('APIs')).toEqual(['apis']);
      expect(splitIdentifier('getIDsForUser')).toEqual(['get', 'ids', 'for', 'user']);
      expect(splitIdentifier('XMLHttpRequest')).toEqual(['xml', 'http', 'request']);
      expect(extractCodeTerms('the deleted version IDs')).not.toContain('i');
    });

    it('drops English stopwords from multi-word queries but keeps them when nothing else remains', () => {
      expect(buildFtsQuery('how do I configure authentication')).toBe(
        '("configure" OR "authentication") OR ("configure" AND "authentication")'
      );
      expect(buildFtsQuery('how')).toBe('"how"');
      expect(buildFtsQuery('the')).toBe('"the"');
    });
  });
});
