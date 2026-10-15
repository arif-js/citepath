import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDataDirectory } from '../../src/utils/paths.js';

describe('Data Directory Resolution', () => {
  const originalEnv = process.env.CITEPATH_DATA_DIR;

  beforeEach(() => {
    delete process.env.CITEPATH_DATA_DIR;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.CITEPATH_DATA_DIR = originalEnv;
    } else {
      delete process.env.CITEPATH_DATA_DIR;
    }
  });

  it('respects explicit override parameter as highest precedence', () => {
    process.env.CITEPATH_DATA_DIR = '/env/path';
    const result = getDataDirectory('/custom/override');
    expect(result).toBe(path.resolve('/custom/override'));
  });

  it('respects CITEPATH_DATA_DIR environment variable', () => {
    process.env.CITEPATH_DATA_DIR = '/tmp/my-citepath-data';
    const result = getDataDirectory();
    expect(result).toBe(path.resolve('/tmp/my-citepath-data'));
  });

  it('resolves to platform-appropriate path when no override or env is provided', () => {
    const result = getDataDirectory();
    const platform = process.platform;
    const home = os.homedir();

    if (platform === 'darwin') {
      expect(result).toBe(path.join(home, 'Library', 'Application Support', 'citepath'));
    } else if (platform === 'win32') {
      expect(result).toContain('citepath');
    } else {
      expect(result).toBe(path.join(home, '.local', 'share', 'citepath'));
    }
  });
});
