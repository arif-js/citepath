import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFetchDispatcher, parseRetryAfter, SsrfBlockedError, safeFetch } from '../../src/utils/ssrf.js';

/** Minimal HTTP CONNECT proxy that records tunnel targets. */
function startConnectProxy(): Promise<{ server: http.Server; url: string; targets: string[] }> {
  const targets: string[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  server.on('connect', (req, clientSocket, head) => {
    targets.push(req.url ?? '');
    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, targets });
    })
  );
}

describe('Proxy support', () => {
  const saved = { ...process.env };
  let target: http.Server;
  let targetPort: number;

  beforeEach(async () => {
    target = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('through the proxy');
    });
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    targetPort = (target.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    process.env = { ...saved };
    target.closeAllConnections();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  it('routes requests through HTTP(S)_PROXY when set', async () => {
    const proxy = await startConnectProxy();
    process.env.HTTP_PROXY = proxy.url;
    process.env.HTTPS_PROXY = proxy.url;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    const { dispatcher, viaProxy } = createFetchDispatcher({ allowPrivateNetwork: true });
    expect(viaProxy).toBe(true);
    const result = await safeFetch(`http://localhost:${targetPort}/`, {
      dispatcher,
      viaProxy,
      allowPrivateNetwork: true,
    });
    expect(result.body).toBe('through the proxy');
    expect(proxy.targets).toEqual([`localhost:${targetPort}`]);
    await dispatcher.close();
    proxy.server.closeAllConnections();
    await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
  });

  it('still blocks private targets by pre-resolving them when a proxy is used', async () => {
    const proxy = await startConnectProxy();
    process.env.HTTP_PROXY = proxy.url;
    const { dispatcher, viaProxy } = createFetchDispatcher();
    await expect(safeFetch(`http://localhost:${targetPort}/`, { dispatcher, viaProxy })).rejects.toThrow(
      SsrfBlockedError
    );
    expect(proxy.targets).toEqual([]);
    await dispatcher.close();
    await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
  });
});

describe('Retry-After parsing', () => {
  it('parses delta-seconds and HTTP dates', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});
