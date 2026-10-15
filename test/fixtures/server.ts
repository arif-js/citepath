/**
 * Controllable local HTTP server for crawl and sync tests. Never reaches the internet.
 *
 * - Serves files from a directory (default: test/fixtures/site) with `{{ORIGIN}}`
 *   replaced by the server's origin, so sitemaps can contain absolute URLs.
 * - Routes can be added, replaced, or removed between syncs to simulate site changes.
 * - Supports ETag-based 304 responses, delays, and streaming bodies.
 * - Records every request (path and headers) for assertions.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

export interface FixtureRoute {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Enables conditional requests: 304 when If-None-Match matches. */
  etag?: string;
  delayMs?: number;
  /** Full control; overrides the other fields. */
  handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void;
}

export interface RecordedRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  at: number;
}

export const SITE_DIR = path.resolve(__dirname, 'site');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

export class FixtureServer {
  private server: http.Server | undefined;
  private routes = new Map<string, FixtureRoute>();
  readonly requests: RecordedRequest[] = [];
  origin = '';

  async start(siteDir: string | null = SITE_DIR): Promise<string> {
    if (siteDir) this.loadDirectory(siteDir);
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${port}`;
    return this.origin;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  url(p: string): string {
    return `${this.origin}${p}`;
  }

  /** Loads every file under `dir` as a route; `index.html` also serves its directory path. */
  loadDirectory(dir: string): void {
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const rel = `/${path.relative(dir, full).split(path.sep).join('/')}`;
        const ext = path.extname(entry.name);
        const route: FixtureRoute = {
          status: 200,
          headers: { 'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream' },
          body: fs.readFileSync(full),
        };
        this.routes.set(rel, route);
        if (entry.name === 'index.html') {
          this.routes.set(rel.slice(0, -'index.html'.length), route);
        }
      }
    };
    walk(dir);
  }

  set(p: string, route: FixtureRoute): void {
    this.routes.set(p, route);
  }

  setHtml(p: string, html: string, extra: Partial<FixtureRoute> = {}): void {
    this.routes.set(p, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html, ...extra });
  }

  setStatus(p: string, status: number, headers: Record<string, string> = {}): void {
    this.routes.set(p, { status, headers, body: '' });
  }

  remove(p: string): void {
    this.routes.delete(p);
  }

  requestsFor(p: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path === p);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const reqPath = req.url ?? '/';
    this.requests.push({ path: reqPath, headers: req.headers, at: Date.now() });
    const pathname = reqPath.split('?')[0]!;
    const route = this.routes.get(reqPath) ?? this.routes.get(pathname);

    const respond = () => {
      if (!route) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      if (route.handler) {
        route.handler(req, res);
        return;
      }
      const headers = { ...(route.headers ?? {}) };
      if (route.etag) {
        headers.ETag = route.etag;
        if (req.headers['if-none-match'] === route.etag) {
          res.writeHead(304, { ETag: route.etag });
          res.end();
          return;
        }
      }
      let body = route.body ?? '';
      const type = headers['Content-Type'] ?? '';
      // Substitute {{ORIGIN}} in UTF-8 text only; other charsets are served byte-for-byte.
      const isUtf8Text = /text|xml/.test(type) && !/charset=(?!utf-8)/i.test(type);
      if (isUtf8Text) body = Buffer.from(body).toString('utf8').replaceAll('{{ORIGIN}}', this.origin);
      res.writeHead(route.status ?? 200, headers);
      res.end(body);
    };

    if (route?.delayMs) setTimeout(respond, route.delayMs);
    else respond();
  }
}
