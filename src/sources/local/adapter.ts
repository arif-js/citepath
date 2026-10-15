import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import ignore, { type Ignore } from 'ignore';
import picomatch from 'picomatch';
import { LOCAL_DEFAULTS } from '../../config/defaults.js';
import type { LocalSourceConfig } from '../../config/schema.js';
import type { ParsedDocument } from '../../indexing/blocks.js';
import { parseMarkdown, parsePlainText } from '../../indexing/markdown.js';
import { buildDocument } from '../../indexing/passages.js';
import { decodeLocalText, looksBinary } from '../../utils/encoding.js';
import { isPathInside } from '../../utils/paths.js';
import {
  type AdapterContext,
  type DiscoveryStatus,
  type ItemOutcome,
  type SourceAdapter,
  SourceUnavailableError,
} from '../adapter.js';

const execFileAsync = promisify(execFile);

/** Directory names never descended into (in addition to hidden directories). */
const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  'venv',
  'site-packages',
]);

interface GitignoreLayer {
  /** Directory of the .gitignore, relative to the root (POSIX, '' for the root). */
  base: string;
  matcher: Ignore;
}

interface GitInfo {
  commitSha: string;
  dirtyPaths: Set<string>;
}

/** Maps a root-relative file path to its public URL (without fragment). */
export function mapLocalUrl(
  relPath: string,
  baseUrl: string | undefined,
  style: 'repository' | 'site' = 'repository'
): string | undefined {
  if (!baseUrl) return undefined;
  const base = baseUrl.replace(/\/+$/, '');
  let mapped = relPath;
  if (style === 'site') {
    mapped = mapped.replace(/\.(md|mdx|markdown)$/i, '');
    mapped = mapped.replace(/(^|\/)(index|readme)$/i, '$1');
  }
  const encoded = mapped
    .split('/')
    .filter((segment, i, all) => segment.length > 0 || i === all.length - 1)
    .map(encodeURIComponent)
    .join('/');
  return encoded ? `${base}/${encoded}` : `${base}/`;
}

async function readGitInfo(root: string): Promise<GitInfo | undefined> {
  try {
    // --show-prefix gives the root's path inside the repository, so no filesystem path
    // comparison is needed (Windows short 8.3 names and symlinks would break that).
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--show-prefix', 'HEAD'], {
      timeout: 10_000,
      windowsHide: true,
    });
    const lines = stdout.split(/\r?\n/);
    const prefix = (lines[0] ?? '').trim();
    const commitSha = (lines[1] ?? '').trim();
    if (!/^[0-9a-f]{40,64}$/.test(commitSha)) return undefined;

    const status = await execFileAsync(
      'git',
      ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'],
      { timeout: 10_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
    );
    const dirtyPaths = new Set<string>();
    const entries = status.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const repoRel = entry.slice(3); // Always relative to the repository root, with "/" separators
      if (code.includes('R') || code.includes('C')) i++; // Rename/copy: next entry is the original path
      if (repoRel.startsWith(prefix)) dirtyPaths.add(repoRel.slice(prefix.length));
    }
    return { commitSha, dirtyPaths };
  } catch {
    return undefined; // Not a Git checkout, or git is not installed.
  }
}

export interface LocalAdapterOptions {
  /** Absolute root directory (already resolved against the config file). */
  root: string;
}

export class LocalSourceAdapter implements SourceAdapter {
  readonly discovery: DiscoveryStatus = { complete: true, reasons: [] };
  private readonly include: picomatch.Matcher;
  private readonly exclude: picomatch.Matcher | undefined;
  private readonly maxFileBytes: number;

  constructor(
    private readonly config: LocalSourceConfig,
    private readonly options: LocalAdapterOptions
  ) {
    const includeGlobs = config.include?.length ? config.include : [...LOCAL_DEFAULTS.include];
    this.include = picomatch(includeGlobs, { dot: true });
    this.exclude = config.exclude?.length ? picomatch(config.exclude, { dot: true }) : undefined;
    this.maxFileBytes = config.max_file_bytes ?? LOCAL_DEFAULTS.maxFileBytes;
  }

  isInScope(location: string): boolean {
    return this.include(location) && !this.exclude?.(location);
  }

  private markIncomplete(reason: string): void {
    this.discovery.complete = false;
    this.discovery.reasons.push(reason);
  }

  async *run(context: AdapterContext): AsyncIterable<ItemOutcome> {
    const root = this.options.root;
    let rootReal: string;
    try {
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) throw new SourceUnavailableError(`${root} is not a directory`);
      rootReal = fs.realpathSync(root);
    } catch (err: any) {
      if (err instanceof SourceUnavailableError) throw err;
      throw new SourceUnavailableError(
        `Cannot read source directory ${root}: ${err?.code ?? err?.message ?? err}`
      );
    }

    const git = await readGitInfo(rootReal);
    const visitedDirs = new Set<string>([rootReal]);

    const walk = async function* (
      this: LocalSourceAdapter,
      absDir: string,
      relDir: string,
      layers: GitignoreLayer[]
    ): AsyncGenerator<ItemOutcome> {
      if (context.signal?.aborted) throw context.signal.reason ?? new Error('Aborted');

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch (err: any) {
        this.markIncomplete(`cannot read directory ${relDir || '.'}: ${err?.code ?? err}`);
        return;
      }

      const ownLayers = [...layers];
      const gitignore = entries.find((e) => e.name === '.gitignore' && e.isFile());
      if (gitignore) {
        try {
          const matcher = ignore().add(fs.readFileSync(path.join(absDir, '.gitignore'), 'utf8'));
          ownLayers.push({ base: relDir, matcher });
        } catch (err: any) {
          context.logger.warn('cannot read .gitignore', { dir: relDir || '.', error: err?.code });
        }
      }

      const isIgnored = (rel: string, isDir: boolean) =>
        ownLayers.some((layer) => {
          const local = layer.base ? rel.slice(layer.base.length + 1) : rel;
          return local.length > 0 && layer.matcher.ignores(isDir ? `${local}/` : local);
        });

      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        const abs = path.join(absDir, entry.name);

        let isDir = entry.isDirectory();
        let isFile = entry.isFile();
        let realAbs = abs;
        if (entry.isSymbolicLink()) {
          try {
            realAbs = fs.realpathSync(abs);
          } catch {
            context.logger.info('skipping broken symlink', { path: rel });
            continue;
          }
          if (!isPathInside(realAbs, rootReal)) {
            if (this.include(rel)) {
              yield {
                kind: 'excluded',
                location: rel,
                reason: 'symlink resolves outside the source root',
              };
            }
            continue;
          }
          const stat = fs.statSync(realAbs);
          isDir = stat.isDirectory();
          isFile = stat.isFile();
        }

        if (isDir) {
          if (DEFAULT_IGNORED_DIRS.has(entry.name) || isIgnored(rel, true)) continue;
          const realDir = isPathInside(realAbs, rootReal) ? fs.realpathSync(realAbs) : realAbs;
          if (visitedDirs.has(realDir)) {
            context.logger.info('skipping directory already visited (symlink loop)', { path: rel });
            continue;
          }
          visitedDirs.add(realDir);
          yield* walk.call(this, realAbs, rel, ownLayers);
          continue;
        }

        if (!isFile || !this.isInScope(rel) || isIgnored(rel, false)) continue;
        yield await this.readFile(realAbs, rel, git);
      }
    };

    yield* walk.call(this, rootReal, '', []);
  }

  private async readFile(abs: string, rel: string, git: GitInfo | undefined): Promise<ItemOutcome> {
    let stat: fs.Stats;
    let bytes: Buffer;
    try {
      stat = fs.statSync(abs);
      if (stat.size > this.maxFileBytes) {
        return {
          kind: 'failed',
          location: rel,
          classification: 'permanent',
          reason: `file is ${stat.size} bytes, over the ${this.maxFileBytes}-byte limit`,
        };
      }
      bytes = fs.readFileSync(abs);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { kind: 'gone', location: rel, reason: 'file deleted during sync' };
      return {
        kind: 'failed',
        location: rel,
        classification: 'transient',
        reason: `cannot read file: ${err?.code}`,
      };
    }
    if (looksBinary(bytes)) {
      return { kind: 'failed', location: rel, classification: 'permanent', reason: 'binary file' };
    }

    const decoded = decodeLocalText(bytes);
    const fileTitle = path.posix.basename(rel).replace(/\.[^.]+$/, '');
    const ext = path.posix.extname(rel).toLowerCase();
    let parsed: ParsedDocument;
    if (ext === '.md' || ext === '.markdown')
      parsed = parseMarkdown(decoded.text, { documentTitle: fileTitle });
    else if (ext === '.mdx') parsed = parseMarkdown(decoded.text, { documentTitle: fileTitle, mdx: true });
    else parsed = parsePlainText(decoded.text, fileTitle);
    if (decoded.fallback) parsed.metadata.encoding = decoded.encoding;

    const document = buildDocument(this.config.id, rel, parsed);
    return {
      kind: 'document',
      location: rel,
      document,
      path: rel,
      url: mapLocalUrl(rel, this.config.base_url, this.config.url_style),
      updatedAt: stat.mtime.toISOString(),
      commitSha: git?.commitSha,
      dirty: git ? git.dirtyPaths.has(rel) : undefined,
    };
  }
}
