/**
 * Minimal structured logger.
 *
 * Rules (AGENTS.md):
 * - Writes to stderr only. stdout belongs to command output and the MCP protocol.
 * - Never log document bodies or secrets. Pass identifiers (URLs, paths, counts) as fields.
 * - Nothing is ever sent over the network.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  level: LogLevel;
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  write?: (line: string) => void;
}

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  return lower in LEVEL_ORDER ? (lower as LogLevel) : undefined;
}

function formatFields(fields: LogFields | undefined): string {
  if (!fields) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = String(value);
    parts.push(`${key}=${/[\s"=]/.test(text) ? JSON.stringify(text) : text}`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? parseLogLevel(process.env.CITEPATH_LOG_LEVEL) ?? 'warn';
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));

  const emit = (msgLevel: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields) => {
    if (LEVEL_ORDER[msgLevel] > LEVEL_ORDER[level]) return;
    write(`[citepath] ${msgLevel}: ${message}${formatFields(fields)}`);
  };

  return {
    level,
    error: (message, fields) => emit('error', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    info: (message, fields) => emit('info', message, fields),
    debug: (message, fields) => emit('debug', message, fields),
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });
