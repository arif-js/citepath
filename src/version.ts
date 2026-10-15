import { createRequire } from 'node:module';

// package.json is the only place the version is set (npm version updates it). This file sits one
// level below the package root both as src/version.ts and as dist/version.js, and package.json is
// always included in the published package.
const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

/** Citepath version, read from package.json. */
export const VERSION: string = pkg.version;

export const USER_AGENT = `Citepath/${VERSION} (+https://github.com/arif-js/cite-path)`;

/** Product token matched against robots.txt user-agent groups. */
export const ROBOTS_USER_AGENT = 'Citepath';
