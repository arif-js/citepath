import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSafeDispatcher,
  createSafeLookup,
  FetchError,
  GoneFetchError,
  isBlockedIp,
  isUrlInScope,
  OutOfScopeError,
  PermanentFetchError,
  SsrfBlockedError,
  safeFetch,
  stripIpBrackets,
  TransientFetchError,
} from '../../src/utils/ssrf.js';

async function classificationOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    expect(err).toBeInstanceOf(FetchError);
    return (err as FetchError).classification;
  }
}

describe('SSRF Protection and Safe Fetch', () => {
  describe('IP Classification & Bracket Stripping', () => {
    it('blocks IPv4 loopback, private, link-local, and metadata addresses', () => {
      expect(isBlockedIp('127.0.0.1')).toBe(true);
      expect(isBlockedIp('0.0.0.0')).toBe(true);
      expect(isBlockedIp('10.0.0.1')).toBe(true);
      expect(isBlockedIp('172.16.0.1')).toBe(true);
      expect(isBlockedIp('172.31.255.255')).toBe(true);
      expect(isBlockedIp('192.168.1.100')).toBe(true);
      expect(isBlockedIp('169.254.169.254')).toBe(true);
      expect(isBlockedIp('100.64.0.1')).toBe(true);
    });

    it('permits public IPv4 and IPv6 addresses', () => {
      expect(isBlockedIp('8.8.8.8')).toBe(false);
      expect(isBlockedIp('1.1.1.1')).toBe(false);
      expect(isBlockedIp('93.184.216.34')).toBe(false);
      expect(isBlockedIp('172.32.0.1')).toBe(false); // Just outside 172.16.0.0/12
      expect(isBlockedIp('2606:4700:4700::1111')).toBe(false);
      expect(isBlockedIp('[2606:4700:4700::1111]')).toBe(false);
      expect(isBlockedIp('::ffff:93.184.216.34')).toBe(false);
    });

    it('strips enclosing brackets from IPv6 hostnames', () => {
      expect(stripIpBrackets('[::1]')).toBe('::1');
      expect(stripIpBrackets('[fe80::1]')).toBe('fe80::1');
      expect(stripIpBrackets('127.0.0.1')).toBe('127.0.0.1');
    });

    it('blocks IPv6 loopback, link-local, and mapped addresses with and without brackets', () => {
      expect(isBlockedIp('[::1]')).toBe(true);
      expect(isBlockedIp('::1')).toBe(true);
      expect(isBlockedIp('[::ffff:127.0.0.1]')).toBe(true);
      expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
      expect(isBlockedIp('[fe80::1]')).toBe(true);
      expect(isBlockedIp('fe80::1')).toBe(true);
    });

    it('blocks NAT64 (64:ff9b::/96) embedded private IPv4 addresses', () => {
      expect(isBlockedIp('64:ff9b::127.0.0.1')).toBe(true);
      expect(isBlockedIp('[64:ff9b::127.0.0.1]')).toBe(true);
      expect(isBlockedIp('64:ff9b::10.0.0.1')).toBe(true);
      expect(isBlockedIp('64:ff9b::192.168.1.1')).toBe(true);
      expect(isBlockedIp('64:ff9b::169.254.169.254')).toBe(true);
      // Public IPv4 mapped via NAT64 is not private
      expect(isBlockedIp('64:ff9b::93.184.216.34')).toBe(false);
    });

    it('blocks 6to4 (2002::/16) embedded private IPv4 addresses', () => {
      // 127.0.0.1 in hex is 7f00:0001
      expect(isBlockedIp('2002:7f00:0001::')).toBe(true);
      expect(isBlockedIp('[2002:7f00:0001::]')).toBe(true);
      // 10.0.0.1 in hex is 0a00:0001
      expect(isBlockedIp('2002:0a00:0001::')).toBe(true);
      // 192.168.1.1 in hex is c0a8:0101
      expect(isBlockedIp('2002:c0a8:0101::')).toBe(true);
      // 93.184.216.34 in hex is 5db8:d822 (public example.com)
      expect(isBlockedIp('2002:5db8:d822::')).toBe(false);
    });
  });

  describe('createSafeLookup handling autoSelectFamily (options.all: true)', () => {
    it('returns an array of address objects when options.all is true', () => {
      const mockResolver = (_host: string, cb: any) => {
        cb(null, [{ address: '93.184.216.34', family: 4 }]);
      };

      const lookup = createSafeLookup({ dnsResolver: mockResolver });
      lookup('example.com', { all: true } as any, (err: any, addresses: any) => {
        expect(err).toBeNull();
        expect(Array.isArray(addresses)).toBe(true);
        expect(addresses[0]).toEqual({ address: '93.184.216.34', family: 4 });
      });
    });

    it('returns a single address string when options.all is false', () => {
      const mockResolver = (_host: string, cb: any) => {
        cb(null, [{ address: '93.184.216.34', family: 4 }]);
      };

      const lookup = createSafeLookup({ dnsResolver: mockResolver });
      lookup('example.com', { all: false } as any, (err: any, address: any, family: any) => {
        expect(err).toBeNull();
        expect(address).toBe('93.184.216.34');
        expect(family).toBe(4);
      });
    });

    it('rejects hostnames resolving to blocked IPs with an error array when options.all is true', () => {
      const mockResolver = (_host: string, cb: any) => {
        cb(null, [{ address: '127.0.0.1', family: 4 }]);
      };

      const lookup = createSafeLookup({ dnsResolver: mockResolver });
      lookup('evil.internal', { all: true } as any, (err: any, addresses: any) => {
        expect(err).toBeInstanceOf(SsrfBlockedError);
        expect(addresses).toEqual([]);
      });
    });
  });

  describe('Real Local Server Integration (No Mocked fetchFn)', () => {
    let localServer: http.Server;
    let localPort: number;

    beforeAll(async () => {
      localServer = http.createServer((req, res) => {
        if (req.url === '/hello') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Hello from local server');
        } else if (req.url === '/redirect-in-scope') {
          res.writeHead(302, { Location: '/hello' });
          res.end();
        } else if (req.url === '/redirect-out-of-scope') {
          res.writeHead(302, { Location: 'https://external-domain.com/page' });
          res.end();
        } else if (req.url === '/big-stream') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.write('a'.repeat(2000));
          res.end('b'.repeat(2000));
        } else if (req.url === '/conditional') {
          if (req.headers['if-none-match'] === '"v1"') {
            res.writeHead(304, { ETag: '"v1"' });
            res.end();
          } else {
            res.writeHead(200, { ETag: '"v1"' });
            res.end('fresh content');
          }
        } else if (req.url === '/forbidden') {
          res.writeHead(403);
          res.end('Bot check');
        } else if (req.url === '/bad-request') {
          res.writeHead(400);
          res.end('Bad request');
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });

      await new Promise<void>((resolve) => {
        localServer.listen(0, '127.0.0.1', () => {
          const addr = localServer.address() as any;
          localPort = addr.port;
          resolve();
        });
      });
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => {
        localServer.close(() => resolve());
      });
    });

    it('fetches local server by hostname (localhost) using real dispatcher when allowPrivateNetwork is true', async () => {
      const dispatcher = createSafeDispatcher({ allowPrivateNetwork: true });
      const result = await safeFetch(`http://localhost:${localPort}/hello`, {
        allowPrivateNetwork: true,
        dispatcher,
      });

      expect(result.status).toBe(200);
      expect(result.body).toBe('Hello from local server');
    });

    it('blocks direct IPv6 bracket literals [::1], [::ffff:127.0.0.1], and [fe80::1] when allowPrivateNetwork is false', async () => {
      await expect(
        safeFetch(`http://[::1]:${localPort}/hello`, { allowPrivateNetwork: false })
      ).rejects.toThrow(SsrfBlockedError);

      await expect(
        safeFetch(`http://[::ffff:127.0.0.1]:${localPort}/hello`, { allowPrivateNetwork: false })
      ).rejects.toThrow(SsrfBlockedError);

      await expect(
        safeFetch(`http://[fe80::1]:${localPort}/hello`, { allowPrivateNetwork: false })
      ).rejects.toThrow(SsrfBlockedError);
    });

    it('aborts body streaming when decompressed bytes exceed limit', async () => {
      const dispatcher = createSafeDispatcher({ allowPrivateNetwork: true });
      await expect(
        safeFetch(`http://127.0.0.1:${localPort}/big-stream`, {
          allowPrivateNetwork: true,
          dispatcher,
          maxResponseSizeBytes: 500, // 500 bytes limit
        })
      ).rejects.toThrow(/exceeded limit of 500 bytes/);
    });

    it('classifies a hostname resolving to a blocked address as blocked, not transient', async () => {
      // localhost resolves to loopback; the error is raised inside undici's connect and wrapped
      const err = await safeFetch(`http://localhost:${localPort}/hello`).catch((e) => e);
      expect(err).toBeInstanceOf(SsrfBlockedError);
      expect((err as SsrfBlockedError).classification).toBe('blocked');
    });

    it('returns notModified on 304 for conditional requests instead of failing', async () => {
      const fresh = await safeFetch(`http://127.0.0.1:${localPort}/conditional`, {
        allowPrivateNetwork: true,
      });
      expect(fresh.status).toBe(200);
      expect(fresh.notModified).toBe(false);
      expect(fresh.body).toBe('fresh content');

      const cached = await safeFetch(`http://127.0.0.1:${localPort}/conditional`, {
        allowPrivateNetwork: true,
        headers: { 'If-None-Match': '"v1"' },
      });
      expect(cached.status).toBe(304);
      expect(cached.notModified).toBe(true);
      expect(cached.body).toBe('');
    });

    it('follows in-scope redirects through the real dispatcher', async () => {
      const result = await safeFetch(`http://127.0.0.1:${localPort}/redirect-in-scope`, {
        allowPrivateNetwork: true,
        scope: { origin: `http://127.0.0.1:${localPort}`, pathPrefix: '/' },
      });
      expect(result.status).toBe(200);
      expect(result.finalUrl).toBe(`http://127.0.0.1:${localPort}/hello`);
      expect(result.redirectCount).toBe(1);
      expect(result.body).toBe('Hello from local server');
    });

    it('classifies 403 and 400 as permanent failures, not removal evidence', async () => {
      const opts = { allowPrivateNetwork: true };
      expect(await classificationOf(safeFetch(`http://127.0.0.1:${localPort}/forbidden`, opts))).toBe(
        'permanent'
      );
      expect(await classificationOf(safeFetch(`http://127.0.0.1:${localPort}/bad-request`, opts))).toBe(
        'permanent'
      );
    });

    it('classifies 404 from a real server as gone', async () => {
      const opts = { allowPrivateNetwork: true };
      expect(await classificationOf(safeFetch(`http://127.0.0.1:${localPort}/missing`, opts))).toBe('gone');
    });
  });

  describe('Scope and Error Classification', () => {
    it('correctly matches URLs in scope', () => {
      const scope = { origin: 'https://docs.example.com', pathPrefix: '/v1/' };
      expect(isUrlInScope('https://docs.example.com/v1/intro', scope)).toBe(true);
      expect(isUrlInScope('https://docs.example.com/v1/', scope)).toBe(true);
      expect(isUrlInScope('https://docs.example.com/v2/intro', scope)).toBe(false);
      expect(isUrlInScope('https://other.example.com/v1/intro', scope)).toBe(false);
    });

    it('classifies redirect leaving scope as OutOfScopeError (classification: skipped)', async () => {
      const mockFetch = async (url: string) => {
        if (url === 'https://docs.example.com/v1/guide') {
          return new Response(null, {
            status: 301,
            headers: { Location: 'https://docs.example.com/blog/post' },
          });
        }
        return new Response('ok', { status: 200 });
      };

      try {
        await safeFetch('https://docs.example.com/v1/guide', {
          scope: { origin: 'https://docs.example.com', pathPrefix: '/v1/' },
          fetchFn: mockFetch as any,
        });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(OutOfScopeError);
        expect((err as OutOfScopeError).classification).toBe('skipped');
      }
    });

    it('classifies only 404 and 410 as gone', async () => {
      for (const status of [404, 410]) {
        const mockFetch = async () => new Response('Gone', { status });
        const err = await safeFetch('https://example.com/missing', { fetchFn: mockFetch as any }).catch(
          (e) => e
        );
        expect(err).toBeInstanceOf(GoneFetchError);
        expect((err as GoneFetchError).classification).toBe('gone');
        expect((err as GoneFetchError).statusCode).toBe(status);
      }
    });

    it('classifies 500, 503, 429, and 408 as TransientFetchError', async () => {
      for (const status of [500, 503, 429, 408]) {
        const mockFetch = async () => new Response('Try later', { status });
        const err = await safeFetch('https://example.com/crash', { fetchFn: mockFetch as any }).catch(
          (e) => e
        );
        expect(err).toBeInstanceOf(TransientFetchError);
        expect((err as TransientFetchError).classification).toBe('transient');
        expect((err as TransientFetchError).statusCode).toBe(status);
      }
    });

    it('classifies 401, 403, other 4xx, and unhandled 3xx as permanent', async () => {
      for (const status of [401, 403, 400, 418, 300]) {
        const mockFetch = async () => new Response('No', { status });
        const err = await safeFetch('https://example.com/page', { fetchFn: mockFetch as any }).catch(
          (e) => e
        );
        expect(err).toBeInstanceOf(PermanentFetchError);
        expect((err as PermanentFetchError).statusCode).toBe(status);
      }
    });

    it('rejects unsupported protocols', async () => {
      await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(PermanentFetchError);
      await expect(safeFetch('gopher://example.com/')).rejects.toThrow(PermanentFetchError);
    });

    it('enforces the maximum redirect limit', async () => {
      let counter = 0;
      const mockFetch = async () => {
        counter++;
        return new Response(null, {
          status: 302,
          headers: { Location: `https://example.com/hop-${counter}` },
        });
      };

      const err = await safeFetch('https://example.com/start', {
        maxRedirects: 3,
        fetchFn: mockFetch as any,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(PermanentFetchError);
      expect((err as Error).message).toMatch(/Max redirects exceeded/);
      expect(counter).toBe(4); // Initial request + 3 allowed redirects
    });

    it('blocks redirects to private addresses on any hop', async () => {
      const mockFetch = async (url: string) => {
        if (url === 'https://example.com/start') {
          return new Response(null, {
            status: 302,
            headers: { Location: 'http://169.254.169.254/latest/meta-data/' },
          });
        }
        return new Response('secret', { status: 200 });
      };

      await expect(safeFetch('https://example.com/start', { fetchFn: mockFetch as any })).rejects.toThrow(
        SsrfBlockedError
      );
    });
  });
});
