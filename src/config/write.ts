import fs from 'node:fs';
import path from 'node:path';
import type { CitepathConfig } from './schema.js';
import { buildJsonSchema } from './schema.js';

export const SCHEMA_FILE_NAME = 'citepath.schema.json';

/** Writes a file atomically: write a temp file in the same directory, then rename over the target. */
export function writeFileAtomic(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Writes the config file (pretty JSON) and a local copy of the JSON Schema next to it,
 * so editors validate the file offline via a relative "$schema" reference.
 */
export function writeConfig(configPath: string, config: CitepathConfig): void {
  const { $schema: _ignored, ...rest } = config;
  const ordered = { $schema: `./${SCHEMA_FILE_NAME}`, ...rest };
  writeFileAtomic(configPath, `${JSON.stringify(ordered, null, 2)}\n`);
  writeFileAtomic(
    path.join(path.dirname(configPath), SCHEMA_FILE_NAME),
    `${JSON.stringify(buildJsonSchema(), null, 2)}\n`
  );
}
