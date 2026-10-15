import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';
import { getConfigPath, getDataDirectory, resolveConfigRelativePath } from '../utils/paths.js';
import { type CitepathConfig, ConfigSchema, type SourceConfig } from './schema.js';

export interface LoadedConfig {
  config: CitepathConfig;
  /** Absolute path of the config file (whether or not it exists). */
  configPath: string;
  configDir: string;
  exists: boolean;
  dataDir: string;
}

export interface LoadConfigOptions {
  configPath?: string; // --config
  dataDir?: string; // --data-dir
}

/** Formats zod issues as "sources[1].url: must be ..." lines that name the offending key. */
export function formatIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>
): string {
  return issues
    .map((issue) => {
      const location = issue.path.reduce<string>((acc, part) => {
        if (typeof part === 'number') return `${acc}[${part}]`;
        return acc ? `${acc}.${String(part)}` : String(part);
      }, '');
      return `  - ${location || '(root)'}: ${issue.message}`;
    })
    .join('\n');
}

export function parseConfig(raw: unknown, configPath: string): CitepathConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(`Invalid config file ${configPath}:\n${formatIssues(result.error.issues)}`);
  }
  return result.data;
}

/**
 * Loads the config file. A missing file is not an error: it yields an empty
 * source list so read-only commands work before `citepath init`.
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const configPath = getConfigPath(options.configPath);
  const configDir = path.dirname(configPath);

  let config: CitepathConfig;
  let exists = true;
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      throw new ConfigError(`Cannot read config file ${configPath}: ${err?.message ?? err}`);
    }
    exists = false;
    text = '';
  }

  if (exists) {
    let raw: unknown;
    try {
      raw = JSON.parse(text.replace(/^﻿/, ''));
    } catch (err: any) {
      throw new ConfigError(`Config file ${configPath} is not valid JSON: ${err?.message ?? err}`);
    }
    config = parseConfig(raw, configPath);
  } else {
    config = ConfigSchema.parse({ sources: [] });
  }

  const dataDir = getDataDirectory(options.dataDir, config.data_dir, configDir);
  return { config, configPath, configDir, exists, dataDir };
}

export function findSource(loaded: LoadedConfig, id: string): SourceConfig | undefined {
  return loaded.config.sources.find((source) => source.id === id);
}

/** Absolute root directory of a local source. */
export function localSourceRoot(source: { path: string }, configDir: string): string {
  return resolveConfigRelativePath(source.path, configDir);
}
