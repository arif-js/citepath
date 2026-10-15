import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { DatabaseSync } from 'node:sqlite';
import { type ParseArgsConfig, parseArgs } from 'node:util';
import { SEARCH_LIMITS } from '../../config/defaults.js';
import { findSource, formatIssues, type LoadedConfig, loadConfig } from '../../config/load.js';
import { type SourceConfig, SourceConfigSchema } from '../../config/schema.js';
import { writeConfig } from '../../config/write.js';
import { type EvalReport, readEvalFile, runEvaluation } from '../../core/eval.js';
import { compactIndex, exportLines } from '../../core/export.js';
import { getPassage, listSources, type RetrievalContext, search } from '../../core/retrieval.js';
import { type SyncSummary, syncSource } from '../../core/sync.js';
import { indexPath, openIndex } from '../../store/db.js';
import { LATEST_SCHEMA_VERSION } from '../../store/migrations.js';
import { deleteSourceData, forceUnlock, getLock, isLockStale, latestRun } from '../../store/repo.js';
import { CitepathError, ConfigError, ExitCode, NotFoundError, UsageError } from '../../utils/errors.js';
import { createLogger, type Logger, type LogLevel } from '../../utils/logger.js';
import { VERSION } from '../../version.js';
import { formatPassageWithContext, formatSearch, formatSources } from '../format.js';
import { startHttpServer } from '../http/server.js';
import { serveMcpStdio } from '../mcp/server.js';
import { createSyncProgress, type SyncProgressReporter } from './progress.js';

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whether stdin/stdout are interactive (prompts are only shown when true). */
  isTTY: boolean;
  /** Whether stderr is a terminal (sync progress redraws one line in place when true). */
  stderrIsTTY?: boolean;
  /** Terminal width of stderr, when known. */
  columns?: number;
  cwd: string;
  /** Interrupt signal (Ctrl-C) for long-running commands. */
  signal?: AbortSignal;
  /** Asks a yes/no question; only used when isTTY. */
  confirm?: (question: string) => Promise<boolean>;
}

const GLOBAL_OPTIONS = {
  config: { type: 'string' },
  'data-dir': { type: 'string' },
  json: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

const COMMANDS: Record<string, { usage: string; summary: string }> = {
  init: { usage: 'citepath init', summary: 'Create the config file if it does not exist' },
  add: {
    usage:
      'citepath add <id> (--url <url>... | --path <dir>...) [--name <name>] [--include <glob>]... [--exclude <glob>]...\n' +
      '    [--base-url <url>] [--url-style repository|site] [--discovery auto|sitemap|crawl] [--max-pages <n>]\n' +
      '    [--max-depth <n>] [--content-selector <css>] [--allow-private-network] [--sync]',
    summary: 'Add a documentation source to the config',
  },
  remove: {
    usage: 'citepath remove <id> [--yes]',
    summary: 'Remove a source and delete its indexed content',
  },
  sources: { usage: 'citepath sources', summary: 'List sources with document counts and sync status' },
  status: { usage: 'citepath status [id]', summary: 'Show index location and the last sync summary' },
  sync: { usage: 'citepath sync [id...] [--allow-mass-delete]', summary: 'Fetch, index, and update sources' },
  search: {
    usage: 'citepath search <query...> [--limit <n>] [--source <id>]... [--path-prefix <prefix>]',
    summary: 'Search indexed passages',
  },
  get: {
    usage: 'citepath get <passage-id> [--neighbors <n>]',
    summary: 'Show a passage with surrounding context',
  },
  export: {
    usage: 'citepath export [--source <id>]... [--output <file>]',
    summary: 'Export indexed content as JSONL',
  },
  eval: {
    usage: 'citepath eval <file> [--k <n>] [--min-recall <0-1>]',
    summary: 'Measure retrieval quality against expected sources',
  },
  compact: { usage: 'citepath compact', summary: 'Optimize the search index and reclaim disk space' },
  unlock: { usage: 'citepath unlock <id>', summary: 'Clear a sync lock left by a crashed process' },
  mcp: { usage: 'citepath mcp', summary: 'Run the read-only MCP server over stdio' },
  serve: {
    usage: 'citepath serve [--host <host>] [--port <port>] [--token <token>]',
    summary: 'Run the read-only local HTTP API (default 127.0.0.1:7345)',
  },
};

function helpText(command?: string): string {
  if (command && COMMANDS[command]) {
    return `Usage: ${COMMANDS[command]!.usage}\n\n${COMMANDS[command]!.summary}.\n\n${globalHelp()}`;
  }
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  const list = Object.entries(COMMANDS)
    .map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`)
    .join('\n');
  return `Citepath ${VERSION}: cited search over your documentation, for AI assistants and apps.

Usage: citepath <command> [options]

Commands:
${list}

Run "citepath <command> --help" for command options.

${globalHelp()}`;
}

function globalHelp(): string {
  return `Global options:
  --config <file>     Config file (default: platform config dir; env CITEPATH_CONFIG)
  --data-dir <dir>    Index directory (env CITEPATH_DATA_DIR)
  --json              Machine-readable output
  -v, --verbose       Detailed logs on stderr
  -q, --quiet         Errors only on stderr
  -h, --help          Show help`;
}

interface Parsed {
  values: Record<string, string | boolean | string[] | undefined>;
  positionals: string[];
}

function parse(args: string[], options: ParseArgsConfig['options']): Parsed {
  try {
    const result = parseArgs({
      args,
      options: { ...GLOBAL_OPTIONS, ...options },
      allowPositionals: true,
      strict: true,
    });
    return { values: result.values as Parsed['values'], positionals: result.positionals };
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function intOption(value: unknown, name: string, min = 0): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new UsageError(`--${name} must be an integer >= ${min}.`);
  return n;
}

class Session {
  private db: DatabaseSync | undefined;
  readonly loaded: LoadedConfig;
  readonly logger: Logger;
  readonly json: boolean;
  readonly quiet: boolean;
  /** Set while a sync status line is on screen, so log lines can clear it first. */
  progress: SyncProgressReporter | undefined;

  constructor(
    values: Parsed['values'],
    readonly io: CliIO
  ) {
    const level: LogLevel | undefined = values.verbose ? 'info' : values.quiet ? 'error' : undefined;
    this.logger = createLogger({
      level,
      write: (line) => {
        this.progress?.clear();
        io.stderr(`${line}\n`);
      },
    });
    this.json = Boolean(values.json);
    this.quiet = Boolean(values.quiet);
    this.loaded = loadConfig({
      configPath: values.config as string | undefined,
      dataDir: values['data-dir'] as string | undefined,
    });
  }

  index(): DatabaseSync {
    this.db ??= openIndex(this.loaded.dataDir);
    return this.db;
  }

  context(): RetrievalContext {
    return { db: this.index(), loaded: this.loaded };
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  out(human: string, data: unknown): void {
    this.io.stdout(this.json ? `${JSON.stringify(data, null, 2)}\n` : `${human}\n`);
  }
}

function summaryLine(s: SyncSummary): string {
  const c = s.counts;
  const seconds = (s.duration_ms / 1000).toFixed(1);
  const head =
    s.status === 'failed' || s.status === 'interrupted'
      ? `${s.source_id}: ${s.status} after ${seconds}s. ${s.error ?? ''}`
      : `${s.source_id}: ${s.status.replace(/_/g, ' ')} in ${seconds}s. ${c.added} added, ${c.updated} updated, ` +
        `${c.unchanged} unchanged, ${c.removed} removed, ${c.failed} failed, ${c.excluded} excluded ` +
        `(${c.documents_total} documents indexed)`;
  const lines = [head.trim()];
  for (const w of s.warnings) lines.push(`  warning: ${w}`);
  for (const f of s.failed.slice(0, 10)) lines.push(`  failed: ${f.location}: ${f.reason}`);
  if (s.failed.length > 10) lines.push(`  ... and ${s.counts.failed - 10} more failures (see --json)`);
  for (const r of s.removed.slice(0, 10)) lines.push(`  removed: ${r.location} (${r.reason})`);
  return lines.join('\n');
}

function evalText(report: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Questions: ${report.questions}   k=${report.k}`,
    `Hit rate@${report.k}: ${pct(report.hit_rate)}   Recall@${report.k}: ${pct(report.recall_at_k)}   MRR: ${report.mrr.toFixed(3)}`,
  ];
  if (report.not_in_index > 0) {
    lines.push(
      `${report.not_in_index} expected source(s) are not in the index (sync them or fix the eval file).`
    );
  }
  for (const r of report.results) {
    lines.push('', `${r.hit ? 'PASS' : 'MISS'} ${r.id}: ${r.question}`);
    for (const e of r.expected) {
      const detail = e.status === 'found' ? `found at rank ${e.rank}` : e.status.replace(/_/g, ' ');
      lines.push(`  expected ${e.expected}: ${detail}`);
    }
    for (const got of r.retrieved) lines.push(`  ${got.rank}. ${got.citation_url}`);
  }
  return lines.join('\n');
}

const MCP_TERMINAL_NOTE =
  'Citepath MCP server running on stdio. It is meant to be started by an MCP client, not used directly.\n' +
  'Register it with your assistant, for example: claude mcp add citepath -- citepath mcp\n' +
  'Waiting for a client. Press Ctrl-C to exit.\n';

/** Why a --url value cannot be used, or undefined when it is a valid start URL. */
function urlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return /^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)
      ? `not an absolute URL; did you mean https://${value}?`
      : 'not an absolute URL; expected something like https://example.com/docs';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return `unsupported scheme "${url.protocol}"; use http:// or https://`;
  if (!url.hostname) return 'missing a host name';
  if (url.username || url.password) return 'must not contain a user name or password';
  return undefined;
}

/** Why a --path value cannot be used, or undefined when it is an existing directory. */
function pathProblem(dir: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return 'directory not found';
  }
  return stat.isDirectory() ? undefined : 'not a directory';
}

/**
 * Builds one source per --url or --path value. A single value keeps the given ID; several
 * values get "<id>-1", "<id>-2", ... in the order given. Every value is checked before
 * anything is written, so a bad value adds nothing.
 */
function buildSourcesFromFlags(
  id: string,
  values: Parsed['values'],
  cwd: string,
  loaded: LoadedConfig
): SourceConfig[] {
  const urls = (values.url as string[] | undefined) ?? [];
  // The config is global, so store an absolute path rather than one relative to this shell.
  const dirs = ((values.path as string[] | undefined) ?? []).map((d) => path.resolve(cwd, d));
  if (urls.length > 0 === dirs.length > 0)
    throw new UsageError('Pass --url <url> or --path <dir> (each can be repeated), but not both.');
  const isWeb = urls.length > 0;
  const targets = isWeb ? urls : dirs;

  const problems: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const problem = isWeb ? urlProblem(target) : pathProblem(target);
    if (problem) problems.push(`  ${isWeb ? '--url' : '--path'} ${target}: ${problem}`);
    else if (seen.has(target)) problems.push(`  ${target}: given more than once`);
    seen.add(target);
  }
  if (problems.length > 0) throw new UsageError(`Invalid source location:\n${problems.join('\n')}`);

  const ids = targets.length === 1 ? [id] : targets.map((_, i) => `${id}-${i + 1}`);
  for (const sourceId of ids) {
    if (findSource(loaded, sourceId)) throw new UsageError(`A source with id "${sourceId}" already exists.`);
  }
  return targets.map((target, i) =>
    buildSourceFromFlags(
      ids[i]!,
      values,
      isWeb ? { url: target } : { dir: target },
      targets.length > 1 ? i + 1 : undefined
    )
  );
}

function buildSourceFromFlags(
  id: string,
  values: Parsed['values'],
  target: { url?: string; dir?: string },
  ordinal: number | undefined
): SourceConfig {
  const { url, dir } = target;
  const candidate: Record<string, unknown> = { id };
  if (values.name) candidate.name = ordinal === undefined ? values.name : `${values.name} (${ordinal})`;
  if (values.include) candidate.include = values.include;
  if (values.exclude) candidate.exclude = values.exclude;
  if (url) {
    Object.assign(candidate, { type: 'web', url });
    if (values.discovery) candidate.discovery = values.discovery;
    if (values['max-pages'] !== undefined)
      candidate.max_pages = intOption(values['max-pages'], 'max-pages', 1);
    if (values['max-depth'] !== undefined)
      candidate.max_depth = intOption(values['max-depth'], 'max-depth', 0);
    if (values['content-selector']) candidate.content_selector = values['content-selector'];
    if (values['allow-private-network']) candidate.allow_private_network = true;
    for (const flag of ['base-url', 'url-style']) {
      if (values[flag]) throw new UsageError(`--${flag} only applies to local (--path) sources.`);
    }
  } else {
    Object.assign(candidate, { type: 'local', path: dir });
    if (values['base-url']) candidate.base_url = values['base-url'];
    if (values['url-style']) candidate.url_style = values['url-style'];
    for (const flag of ['discovery', 'max-pages', 'max-depth', 'content-selector', 'allow-private-network']) {
      if (values[flag]) throw new UsageError(`--${flag} only applies to web (--url) sources.`);
    }
  }
  const parsed = SourceConfigSchema.safeParse(candidate);
  if (!parsed.success) throw new UsageError(`Invalid source "${id}":\n${formatIssues(parsed.error.issues)}`);
  return parsed.data;
}

async function runSync(session: Session, ids: string[], allowMassDelete: boolean): Promise<number> {
  const { config } = session.loaded;
  const targets = ids.length > 0 ? ids.map((id) => findSource(session.loaded, id) ?? id) : config.sources;
  const unknown = targets.filter((t): t is string => typeof t === 'string');
  if (unknown.length > 0)
    throw new NotFoundError(`Unknown source ${unknown.map((u) => `"${u}"`).join(', ')}.`);
  if (targets.length === 0)
    throw new UsageError('No sources configured. Add one with: citepath add <id> --url|--path');

  const summaries: SyncSummary[] = [];
  for (const source of targets as SourceConfig[]) {
    if (session.io.signal?.aborted) break;
    const showProgress = !session.json && !session.quiet;
    if (showProgress) session.io.stderr(`Syncing ${source.id}...\n`);
    const progress = showProgress
      ? createSyncProgress(source.id, {
          stderr: session.io.stderr,
          interactive: session.io.stderrIsTTY === true,
          columns: session.io.columns,
        })
      : undefined;
    session.progress = progress;
    let summary: SyncSummary;
    try {
      summary = await syncSource(session.index(), session.loaded, source, {
        allowMassDelete,
        signal: session.io.signal,
        logger: session.logger,
        onProgress: progress ? (p) => progress.update(p) : undefined,
      });
    } finally {
      progress?.done();
      session.progress = undefined;
    }
    summaries.push(summary);
    if (!session.json) session.io.stdout(`${summaryLine(summary)}\n`);
  }
  if (session.json) session.io.stdout(`${JSON.stringify(summaries, null, 2)}\n`);
  if (summaries.some((s) => s.status === 'failed' || s.status === 'interrupted'))
    return ExitCode.RuntimeError;
  if (summaries.some((s) => s.status === 'completed_with_failures')) return ExitCode.CompletedWithFailures;
  return ExitCode.Ok;
}

async function dispatch(command: string, args: string[], io: CliIO): Promise<number> {
  const spec: Record<string, ParseArgsConfig['options']> = {
    init: {},
    add: {
      url: { type: 'string', multiple: true },
      path: { type: 'string', multiple: true },
      name: { type: 'string' },
      include: { type: 'string', multiple: true },
      exclude: { type: 'string', multiple: true },
      'base-url': { type: 'string' },
      'url-style': { type: 'string' },
      discovery: { type: 'string' },
      'max-pages': { type: 'string' },
      'max-depth': { type: 'string' },
      'content-selector': { type: 'string' },
      'allow-private-network': { type: 'boolean' },
      sync: { type: 'boolean' },
    },
    remove: { yes: { type: 'boolean', short: 'y' } },
    sources: {},
    list: {},
    status: {},
    sync: { 'allow-mass-delete': { type: 'boolean' } },
    search: {
      limit: { type: 'string', short: 'n' },
      source: { type: 'string', multiple: true },
      'path-prefix': { type: 'string' },
    },
    get: { neighbors: { type: 'string' } },
    export: { source: { type: 'string', multiple: true }, output: { type: 'string', short: 'o' } },
    eval: { k: { type: 'string' }, 'min-recall': { type: 'string' } },
    compact: {},
    unlock: {},
    mcp: {},
    serve: { host: { type: 'string' }, port: { type: 'string' }, token: { type: 'string' } },
  };
  const options = spec[command];
  if (!options)
    throw new UsageError(`Unknown command "${command}". Run "citepath --help" for the list of commands.`);
  const { values, positionals } = parse(args, options);
  if (values.help) {
    io.stdout(`${helpText(command === 'list' ? 'sources' : command)}\n`);
    return ExitCode.Ok;
  }

  const session = new Session(values, io);
  try {
    switch (command) {
      case 'init': {
        if (session.loaded.exists) {
          session.out(`Config already exists: ${session.loaded.configPath}`, {
            config_path: session.loaded.configPath,
            created: false,
          });
          return ExitCode.Ok;
        }
        writeConfig(session.loaded.configPath, { sources: [] });
        session.out(
          `Created ${session.loaded.configPath}\nNext: citepath add <id> --url <docs-url> | --path <docs-dir>`,
          { config_path: session.loaded.configPath, created: true }
        );
        return ExitCode.Ok;
      }

      case 'add': {
        const id = positionals[0];
        if (!id || positionals.length > 1) throw new UsageError(`Usage: ${COMMANDS.add!.usage}`);
        const sources = buildSourcesFromFlags(id, values, io.cwd, session.loaded);
        const config = { ...session.loaded.config, sources: [...session.loaded.config.sources, ...sources] };
        writeConfig(session.loaded.configPath, config);
        session.loaded.config.sources.push(...sources);
        const ids = sources.map((s) => s.id);
        const added = sources.map((s) => `Added ${s.id} (${s.type === 'web' ? s.url : s.path})`).join('\n');
        if (!values.sync) {
          session.out(
            `${added}\nConfig: ${session.loaded.configPath}\nNext: citepath sync ${ids.join(' ')}`,
            {
              added: sources,
            }
          );
          return ExitCode.Ok;
        }
        if (!session.json) io.stdout(`${added}\nConfig: ${session.loaded.configPath}\n`);
        return await runSync(session, ids, false);
      }

      case 'remove': {
        const id = positionals[0];
        if (!id || positionals.length > 1) throw new UsageError(`Usage: ${COMMANDS.remove!.usage}`);
        const inConfig = findSource(session.loaded, id);
        const db = session.index();
        const lock = getLock(db, id);
        if (lock && !isLockStale(lock))
          throw new UsageError(`Source "${id}" is being synced right now; try again later.`);
        const hasData =
          (db.prepare('SELECT 1 FROM sources WHERE id = ?').get(id) ??
            db.prepare('SELECT 1 FROM documents WHERE source_id = ? LIMIT 1').get(id)) !== undefined;
        if (!inConfig && !hasData) throw new NotFoundError(`Unknown source "${id}".`);
        if (!values.yes) {
          if (!io.isTTY || !io.confirm) {
            throw new UsageError(`Refusing to remove "${id}" without confirmation. Re-run with --yes.`);
          }
          if (!(await io.confirm(`Remove source "${id}" and delete its indexed content? [y/N] `))) {
            io.stderr('Cancelled.\n');
            return ExitCode.Ok;
          }
        }
        const deleted = deleteSourceData(db, id);
        if (inConfig) {
          writeConfig(session.loaded.configPath, {
            ...session.loaded.config,
            sources: session.loaded.config.sources.filter((s) => s.id !== id),
          });
        }
        session.out(
          `Removed ${id}: deleted ${deleted.documents} documents and ${deleted.passages} passages` +
            (inConfig ? ' and removed it from the config.' : '.'),
          { removed: id, ...deleted, removed_from_config: Boolean(inConfig) }
        );
        return ExitCode.Ok;
      }

      case 'sources':
      case 'list': {
        const result = listSources(session.context());
        session.out(formatSources(result), result);
        return ExitCode.Ok;
      }

      case 'status': {
        const db = session.index();
        const id = positionals[0];
        if (!id) {
          const result = listSources(session.context());
          const header = [
            `Config: ${session.loaded.configPath}${session.loaded.exists ? '' : ' (not created yet; run citepath init)'}`,
            `Index:  ${indexPath(session.loaded.dataDir)} (schema v${LATEST_SCHEMA_VERSION})`,
          ].join('\n');
          session.out(`${header}\n\n${formatSources(result)}`, {
            config_path: session.loaded.configPath,
            index_path: indexPath(session.loaded.dataDir),
            index_schema_version: LATEST_SCHEMA_VERSION,
            ...result,
          });
          return ExitCode.Ok;
        }
        const source = findSource(session.loaded, id);
        if (!source) throw new NotFoundError(`Unknown source "${id}".`);
        const run = latestRun(db, id);
        const summary = run?.summary_json ? (JSON.parse(run.summary_json) as SyncSummary) : undefined;
        const lock = getLock(db, id);
        const sourceStatus = listSources(session.context()).sources.find((s) => s.id === id)!;
        const human = [
          formatSources({ sources: [sourceStatus], orphaned: [], schema_version: 1 }),
          lock
            ? `Lock: held by pid ${lock.pid} on ${lock.hostname} since ${lock.started_at}${isLockStale(lock) ? ' (stale)' : ''}`
            : '',
          summary ? `\nLast sync:\n${summaryLine(summary)}` : run ? `\nLast sync: ${run.status}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        session.out(human, { source: sourceStatus, lock: lock ?? null, last_sync: summary ?? null });
        return ExitCode.Ok;
      }

      case 'sync':
        return await runSync(session, positionals, Boolean(values['allow-mass-delete']));

      case 'search': {
        const query = positionals.join(' ');
        if (!query.trim()) throw new UsageError(`Usage: ${COMMANDS.search!.usage}`);
        const result = search(session.context(), {
          query,
          limit: intOption(values.limit, 'limit', 1),
          source_ids: values.source as string[] | undefined,
          path_prefix: values['path-prefix'] as string | undefined,
        });
        session.out(formatSearch(result), result);
        return ExitCode.Ok;
      }

      case 'get': {
        const id = positionals[0];
        if (!id || positionals.length > 1) throw new UsageError(`Usage: ${COMMANDS.get!.usage}`);
        const neighbors = intOption(values.neighbors, 'neighbors', 0) ?? 0;
        if (neighbors > SEARCH_LIMITS.maxNeighbors) {
          throw new UsageError(`--neighbors must be at most ${SEARCH_LIMITS.maxNeighbors}.`);
        }
        const result = getPassage(session.context(), id, neighbors);
        session.out(formatPassageWithContext(result), result);
        return ExitCode.Ok;
      }

      case 'export': {
        const output = values.output as string | undefined;
        const sources = values.source as string[] | undefined;
        const db = session.index();
        let fd: number | undefined;
        if (output) fd = fs.openSync(path.resolve(io.cwd, output), 'w', 0o600);
        const generator = exportLines(db, sources);
        let next = generator.next();
        try {
          while (!next.done) {
            if (fd !== undefined) fs.writeSync(fd, `${next.value}\n`);
            else io.stdout(`${next.value}\n`);
            next = generator.next();
          }
        } finally {
          if (fd !== undefined) fs.closeSync(fd);
        }
        if (output) {
          const c = next.value;
          io.stderr(
            `Exported ${c.sources} sources, ${c.documents} documents, ${c.passages} passages to ${output}\n`
          );
        }
        return ExitCode.Ok;
      }

      case 'eval': {
        const file = positionals[0];
        if (!file || positionals.length > 1) throw new UsageError(`Usage: ${COMMANDS.eval!.usage}`);
        const minRecall = values['min-recall'] === undefined ? undefined : Number(values['min-recall']);
        if (minRecall !== undefined && (!Number.isFinite(minRecall) || minRecall < 0 || minRecall > 1)) {
          throw new UsageError('--min-recall must be a number between 0 and 1.');
        }
        const report = runEvaluation(
          session.context(),
          readEvalFile(path.resolve(io.cwd, file)),
          intOption(values.k, 'k', 1)
        );
        session.out(evalText(report), report);
        if (minRecall !== undefined && report.recall_at_k < minRecall) {
          io.stderr(`Recall@${report.k} ${report.recall_at_k} is below the required ${minRecall}.\n`);
          return ExitCode.CompletedWithFailures;
        }
        return ExitCode.Ok;
      }

      case 'compact': {
        const sizes = compactIndex(session.index(), session.loaded.dataDir);
        const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
        session.out(`Compacted index: ${mb(sizes.before)} -> ${mb(sizes.after)}`, sizes);
        return ExitCode.Ok;
      }

      case 'unlock': {
        const id = positionals[0];
        if (!id || positionals.length > 1) throw new UsageError(`Usage: ${COMMANDS.unlock!.usage}`);
        const lock = forceUnlock(session.index(), id);
        session.out(
          lock ? `Cleared the sync lock for ${id} (pid ${lock.pid}).` : `No lock is held for ${id}.`,
          {
            unlocked: Boolean(lock),
          }
        );
        return ExitCode.Ok;
      }

      case 'mcp': {
        const db = session.index();
        // Re-read the config per request so newly added sources appear without a restart.
        const getContext = (): RetrievalContext => {
          try {
            return {
              db,
              loaded: {
                ...loadConfig({ configPath: session.loaded.configPath }),
                dataDir: session.loaded.dataDir,
              },
            };
          } catch {
            return { db, loaded: session.loaded };
          }
        };
        // An MCP client always connects through pipes; a terminal means someone ran this by hand.
        // stderr only: stdout belongs to the protocol.
        if (io.isTTY && !session.quiet) io.stderr(MCP_TERMINAL_NOTE);
        await serveMcpStdio(getContext, session.logger);
        return ExitCode.Ok;
      }

      case 'serve': {
        const db = session.index();
        const token = (values.token as string | undefined) ?? process.env.CITEPATH_API_TOKEN;
        const port = intOption(values.port, 'port', 0) ?? 7345;
        const getContext = (): RetrievalContext => {
          try {
            return {
              db,
              loaded: {
                ...loadConfig({ configPath: session.loaded.configPath }),
                dataDir: session.loaded.dataDir,
              },
            };
          } catch {
            return { db, loaded: session.loaded };
          }
        };
        const { server, url } = await startHttpServer(
          getContext,
          { host: values.host as string | undefined, port, token },
          session.logger
        );
        io.stderr(
          `Citepath API listening on ${url} (read-only${token ? ', token required' : ''}). Ctrl-C to stop.\n`
        );
        await new Promise<void>((resolve) => {
          if (io.signal?.aborted) return resolve();
          io.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return ExitCode.Ok;
      }

      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } finally {
    session.close();
  }
}

/**
 * Runs the CLI and returns the exit code. Errors are reported on stderr (as JSON with --json).
 */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(`${helpText(rest[0])}\n`);
    return ExitCode.Ok;
  }
  if (command === '--version' || command === '-V' || command === 'version') {
    io.stdout(`${VERSION}\n`);
    return ExitCode.Ok;
  }
  try {
    return await dispatch(command, rest, io);
  } catch (err) {
    const json = argv.includes('--json');
    const known = err instanceof CitepathError;
    const message = known ? err.message : `Unexpected error: ${(err as Error)?.stack ?? err}`;
    const code = known ? err.exitCode : ExitCode.RuntimeError;
    if (json) {
      const kind =
        err instanceof ConfigError ? 'config_error' : err instanceof UsageError ? 'usage_error' : 'error';
      io.stderr(`${JSON.stringify({ error: { code: kind, message } })}\n`);
    } else {
      io.stderr(`citepath: ${message}\n`);
    }
    return code;
  }
}

/** Real-terminal wiring: stdout/stderr, TTY prompts, and Ctrl-C handling. */
export function processIO(controller: AbortController): CliIO {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    stderrIsTTY: Boolean(process.stderr.isTTY),
    get columns() {
      return process.stderr.columns;
    },
    cwd: process.cwd(),
    signal: controller.signal,
    confirm: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(question);
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}
