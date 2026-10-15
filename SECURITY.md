# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button (Security → Advisories) on this repository. Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports within 7 days and to agree on a disclosure date with you once a fix is ready.

## Supported versions

Citepath is pre-1.0. Security fixes are made on the latest release only.

## Security model

Citepath runs on your machine, fetches documentation you configure, and serves search results to AI assistants. These are the protections it is designed to provide; a way around any of them is a vulnerability:

- **No data leaves your machine** except requests to the documentation sources you configure. No telemetry, accounts, or project-operated services.
- **Indexed text is untrusted.** It is never executed. MCP and HTTP results label it as untrusted, and MCP text output fences it so a document cannot impersonate tool output.
- **Agent-facing interfaces are read-only.** The MCP server and HTTP API cannot add, sync, or delete sources.
- **The crawler stays in bounds:**
  - it refuses loopback, private, link-local, and cloud-metadata addresses unless a source opts in, checked after DNS resolution and on every redirect;
  - it stays inside the configured scope;
  - it enforces size, time, redirect, and decompression limits.
- **Local sources cannot escape their root** through `..` paths or symlinks.
- **The local API listens on loopback by default.** It checks the Host and Origin headers, sends no CORS headers, and requires a bearer token for any other interface.
- **Logs contain no document text or secrets.**

Out of scope:
- vulnerabilities in sites you choose to index;
- an attacker who can already modify your config file or index database;
- denial of service caused by sources you configured with very high limits.

## Dependencies

CI runs `npm audit --omit=dev --audit-level=high` on every change. Releases publish SHA-256 checksums for the packaged tarball.
