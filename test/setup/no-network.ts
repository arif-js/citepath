/**
 * Vitest setup file: tests must never reach the internet (AGENTS.md rule 8).
 * Any outbound TCP connection or DNS lookup to a non-loopback host throws.
 * Loopback stays available for the local fixture HTTP server.
 */
import dns from 'node:dns';
import net from 'node:net';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '::ffff:127.0.0.1']);

function isLoopback(host: unknown): boolean {
  if (typeof host !== 'string' || host === '') return true; // Unix sockets / default host
  return LOOPBACK_HOSTS.has(host) || host.startsWith('127.');
}

function blocked(host: unknown): Error {
  return new Error(`Network access blocked in tests: attempted connection to ${String(host)}`);
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(this: net.Socket, ...args: any[]) {
  const first = args[0];
  let host: unknown;
  if (Array.isArray(first)) {
    // Internal normalized form: [options, callback]
    host = first[0]?.host;
  } else if (first && typeof first === 'object') {
    host = first.host;
  } else if (typeof first === 'number') {
    host = typeof args[1] === 'string' ? args[1] : 'localhost';
  } else if (typeof first === 'string') {
    host = ''; // IPC path
  }
  if (!isLoopback(host)) throw blocked(host);
  return (originalConnect as any).apply(this, args);
} as typeof net.Socket.prototype.connect;

const originalLookup = dns.lookup;
(dns as any).lookup = function patchedLookup(hostname: string, ...rest: any[]) {
  if (!isLoopback(hostname)) {
    const callback = rest[rest.length - 1];
    const err = Object.assign(blocked(hostname), { code: 'ENOTFOUND' });
    if (typeof callback === 'function') {
      process.nextTick(() => callback(err));
      return {};
    }
    throw err;
  }
  return (originalLookup as any).call(dns, hostname, ...rest);
};

const originalPromisesLookup = dns.promises.lookup;
(dns.promises as any).lookup = function patchedPromisesLookup(hostname: string, ...rest: any[]) {
  if (!isLoopback(hostname)) {
    return Promise.reject(Object.assign(blocked(hostname), { code: 'ENOTFOUND' }));
  }
  return (originalPromisesLookup as any).call(dns.promises, hostname, ...rest);
};
