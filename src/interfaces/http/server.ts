import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getPassage, listSources, type RetrievalContext, search } from '../../core/retrieval.js';
import { CitepathError, NotFoundError, UsageError } from '../../utils/errors.js';
import type { Logger } from '../../utils/logger.js';
import { VERSION } from '../../version.js';

/**
 * Read-only local HTTP API (docs/api.md):
 * - binds to 127.0.0.1 by default; any other host requires an access token;
 * - on loopback, rejects requests whose Host header is not this server (DNS-rebinding
 *   protection); always rejects cross-origin browser requests; sends no CORS headers;
 * - GET only: /v1/health, /v1/sources, /v1/search, /v1/passages/:id.
 */

export interface HttpServerOptions {
  host?: string;
  port?: number;
  token?: string;
}

const MAX_URL_LENGTH = 4096;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase()) || host.startsWith('127.');
}

export function validateHttpOptions(options: HttpServerOptions): void {
  const host = options.host ?? '127.0.0.1';
  if (!isLoopbackHost(host) && !options.token) {
    throw new UsageError(
      `Refusing to listen on ${host} without an access token. Pass --token (or set CITEPATH_API_TOKEN), ` +
        'or keep the default 127.0.0.1.'
    );
  }
  if (options.token !== undefined && options.token.length < 16) {
    throw new UsageError('The access token must be at least 16 characters.');
  }
}

function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(json);
}

function sendError(res: http.ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

function parseIntParam(value: string | null, name: string): number | undefined {
  if (value === null || value === '') return undefined;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a non-negative integer.`);
  return Number(value);
}

export function createHttpServer(
  getContext: () => RetrievalContext,
  options: HttpServerOptions,
  logger: Logger
): http.Server {
  validateHttpOptions(options);
  const bindHost = options.host ?? '127.0.0.1';
  const loopbackOnly = isLoopbackHost(bindHost);
  let allowedHosts = new Set<string>();

  const server = http.createServer((req, res) => {
    try {
      if ((req.url ?? '').length > MAX_URL_LENGTH)
        return sendError(res, 414, 'uri_too_long', 'Request URL too long.');

      const hostHeader = (req.headers.host ?? '').toLowerCase();
      // On loopback, only exact local Host headers are accepted (blocks DNS rebinding). Non-loopback
      // binds already require a bearer token, which a rebinding page cannot know.
      if (loopbackOnly && !allowedHosts.has(hostHeader)) {
        return sendError(res, 403, 'forbidden_host', 'Host header does not match this server.');
      }
      const origin = req.headers.origin;
      if (origin && origin.replace(/^https?:\/\//i, '').toLowerCase() !== hostHeader) {
        return sendError(res, 403, 'forbidden_origin', 'Cross-origin requests are not allowed.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return sendError(res, 405, 'method_not_allowed', 'This API is read-only.');
      }
      if (options.token) {
        const auth = req.headers.authorization ?? '';
        const provided = /^Bearer\s+(.+)$/i.exec(auth)?.[1] ?? '';
        if (!tokensMatch(options.token, provided)) {
          res.setHeader('WWW-Authenticate', 'Bearer');
          return sendError(res, 401, 'unauthorized', 'A valid bearer token is required.');
        }
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = url.pathname.replace(/\/+$/, '');

      if (route === '/v1/health') return send(res, 200, { status: 'ok', version: VERSION });
      if (route === '/v1/sources') return send(res, 200, listSources(getContext()));
      if (route === '/v1/search') {
        const sourceIds = url.searchParams.getAll('source').filter(Boolean);
        const result = search(getContext(), {
          query: url.searchParams.get('q') ?? '',
          limit: parseIntParam(url.searchParams.get('limit'), 'limit'),
          source_ids: sourceIds.length > 0 ? sourceIds : undefined,
          path_prefix: url.searchParams.get('path_prefix') ?? undefined,
        });
        return send(res, 200, result);
      }
      const passageMatch = /^\/v1\/passages\/([^/]+)$/.exec(route);
      if (passageMatch) {
        const neighbors = parseIntParam(url.searchParams.get('neighbors'), 'neighbors') ?? 0;
        return send(res, 200, getPassage(getContext(), decodeURIComponent(passageMatch[1]!), neighbors));
      }
      return sendError(res, 404, 'not_found', 'Unknown endpoint.');
    } catch (err) {
      if (err instanceof NotFoundError) return sendError(res, 404, 'not_found', err.message);
      if (err instanceof UsageError) return sendError(res, 400, 'bad_request', err.message);
      if (err instanceof CitepathError) return sendError(res, 500, 'error', err.message);
      logger.error('HTTP request failed', { error: (err as Error)?.message });
      return sendError(res, 500, 'internal_error', 'Internal error.');
    }
  });

  server.on('listening', () => {
    const { port } = server.address() as AddressInfo;
    allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]'].map((name) => `${name}:${port}`));
  });
  return server;
}

/** Starts the API and resolves with the listening address. */
export async function startHttpServer(
  getContext: () => RetrievalContext,
  options: HttpServerOptions,
  logger: Logger
): Promise<{ server: http.Server; url: string }> {
  const server = createHttpServer(getContext, options, logger);
  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7345, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const display = host.includes(':') ? `[${host}]` : host;
  return { server, url: `http://${display}:${port}` };
}
