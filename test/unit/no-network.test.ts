import dns from 'node:dns';
import net from 'node:net';
import { describe, expect, it } from 'vitest';

describe('Test network guard', () => {
  it('blocks outbound TCP connections to non-loopback hosts', () => {
    expect(() => net.connect({ host: '93.184.216.34', port: 80 })).toThrow(/Network access blocked/);
  });

  it('blocks DNS lookups for public hostnames', async () => {
    await expect(dns.promises.lookup('example.com')).rejects.toThrow(/Network access blocked/);
    const err = await new Promise<Error | null>((resolve) => dns.lookup('example.com', (e) => resolve(e)));
    expect(err?.message).toMatch(/Network access blocked/);
  });

  it('still allows loopback connections for the fixture server', async () => {
    const server = net.createServer((socket) => socket.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const data = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.on('data', (chunk) => resolve(chunk.toString()));
      socket.on('error', reject);
    });
    expect(data).toBe('ok');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
