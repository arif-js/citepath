/**
 * Error types shared across layers. Interfaces translate these into exit codes
 * (CLI), tool errors (MCP), or HTTP status codes (local API).
 */

export const ExitCode = {
  Ok: 0,
  RuntimeError: 1,
  UsageError: 2,
  CompletedWithFailures: 3,
} as const;

export class CitepathError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = ExitCode.RuntimeError
  ) {
    super(message);
    this.name = 'CitepathError';
  }
}

/** Invalid user input: bad flags, empty query, unknown source ID. */
export class UsageError extends CitepathError {
  constructor(message: string) {
    super(message, ExitCode.UsageError);
    this.name = 'UsageError';
  }
}

/** Invalid or unreadable configuration file. */
export class ConfigError extends CitepathError {
  constructor(message: string) {
    super(message, ExitCode.UsageError);
    this.name = 'ConfigError';
  }
}

/** The index cannot be opened safely (for example, created by a newer version). */
export class IndexError extends CitepathError {
  constructor(message: string) {
    super(message, ExitCode.RuntimeError);
    this.name = 'IndexError';
  }
}

/** Another sync holds the lock for a source. */
export class LockError extends CitepathError {
  constructor(message: string) {
    super(message, ExitCode.RuntimeError);
    this.name = 'LockError';
  }
}

export class NotFoundError extends CitepathError {
  constructor(message: string) {
    super(message, ExitCode.UsageError);
    this.name = 'NotFoundError';
  }
}
