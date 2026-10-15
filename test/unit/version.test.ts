import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { USER_AGENT, VERSION } from '../../src/version.js';

describe('Version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
    expect(USER_AGENT).toContain(`Citepath/${VERSION}`);
  });
});
