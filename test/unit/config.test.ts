import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, localSourceRoot } from '../../src/config/load.js';
import { SCHEMA_FILE_NAME, writeConfig } from '../../src/config/write.js';
import { ConfigError } from '../../src/utils/errors.js';

describe('Config loading and writing', () => {
  let dir: string;
  let configPath: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'citepath-config-'));
    configPath = path.join(dir, 'config.json');
    delete process.env.CITEPATH_CONFIG;
    delete process.env.CITEPATH_DATA_DIR;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('treats a missing config file as an empty source list', () => {
    const loaded = loadConfig({ configPath });
    expect(loaded.exists).toBe(false);
    expect(loaded.config.sources).toEqual([]);
  });

  it('round-trips a config and writes a local JSON Schema next to it', () => {
    writeConfig(configPath, {
      sources: [
        { id: 'site', type: 'web', url: 'https://docs.example.com/guide/' },
        { id: 'notes', type: 'local', path: './notes', base_url: 'https://github.com/acme/notes/blob/main' },
      ],
    });
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(raw.$schema).toBe(`./${SCHEMA_FILE_NAME}`);
    expect(fs.existsSync(path.join(dir, SCHEMA_FILE_NAME))).toBe(true);

    const loaded = loadConfig({ configPath });
    expect(loaded.exists).toBe(true);
    expect(loaded.config.sources.map((s) => s.id)).toEqual(['site', 'notes']);
  });

  it('resolves local source paths relative to the config file', () => {
    writeConfig(configPath, { sources: [{ id: 'notes', type: 'local', path: './notes' }] });
    const loaded = loadConfig({ configPath });
    const source = loaded.config.sources[0]!;
    expect(source.type).toBe('local');
    expect(localSourceRoot(source as { path: string }, loaded.configDir)).toBe(path.join(dir, 'notes'));
  });

  it('names the offending key for invalid config', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        sources: [
          { id: 'ok', type: 'web', url: 'ftp://nope' },
          { id: 'Bad ID', type: 'local', path: '.' },
        ],
      })
    );
    expect(() => loadConfig({ configPath })).toThrow(ConfigError);
    try {
      loadConfig({ configPath });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('sources[0].url');
      expect(message).toContain('sources[1].id');
    }
  });

  it('rejects unknown keys and duplicate source IDs', () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        sources: [
          { id: 'a', type: 'local', path: '.', typo_key: true },
          { id: 'a', type: 'local', path: '.' },
        ],
      })
    );
    try {
      loadConfig({ configPath });
      expect.fail('should throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/typo_key/);
      expect(message).toMatch(/duplicate source id "a"/);
    }
  });

  it('reports invalid JSON clearly', () => {
    fs.writeFileSync(configPath, '{ "sources": [ }');
    expect(() => loadConfig({ configPath })).toThrow(/not valid JSON/);
  });

  it('applies data directory precedence: flag > env > config file', () => {
    writeConfig(configPath, { data_dir: './index-data', sources: [] });
    expect(loadConfig({ configPath }).dataDir).toBe(path.join(dir, 'index-data'));

    process.env.CITEPATH_DATA_DIR = path.join(dir, 'from-env');
    expect(loadConfig({ configPath }).dataDir).toBe(path.join(dir, 'from-env'));

    expect(loadConfig({ configPath, dataDir: path.join(dir, 'from-flag') }).dataDir).toBe(
      path.join(dir, 'from-flag')
    );
  });

  it('uses CITEPATH_CONFIG when no --config flag is given', () => {
    process.env.CITEPATH_CONFIG = configPath;
    writeConfig(configPath, { sources: [{ id: 'env', type: 'local', path: '.' }] });
    expect(loadConfig().config.sources[0]!.id).toBe('env');
  });
});
