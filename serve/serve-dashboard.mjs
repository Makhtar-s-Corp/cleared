#!/usr/bin/env node
// Serves the one page of the dashboard, to the Tailscale network only.
//
// Listening on the Tailscale address is not enough: a container on the host
// reaches that address too. So every connection is checked: a peer whose
// address is outside the allowed ranges is refused, whatever it asks for.
// One file, no directory listing, no dependency.
//
//   serve-dashboard.mjs <address> <port> <index.html> [<allowed CIDR>...]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { loadConf, section } from '../lib/conf.mjs';
import { message } from '../lib/i18n.mjs';

// The ranges Tailscale hands out to the machines of a network.
export const TAILSCALE = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48'];

const bits = (address) => {
  if (isIP(address) === 4) return address.split('.').map((part) => Number(part).toString(2).padStart(8, '0')).join('');
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.map((group) => parseInt(group, 16).toString(2).padStart(16, '0')).join('');
};

export function allowed(peer, ranges) {
  // An IPv4 peer met on an IPv6 socket is written ::ffff:a.b.c.d.
  const address = (peer || '').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '').replace(/%.*$/, '');
  if (!isIP(address)) return false;
  return ranges.some((range) => {
    const [network, length] = range.split('/');
    return isIP(network) === isIP(address) && bits(address).startsWith(bits(network).slice(0, Number(length)));
  });
}

export function dashboardServer({ file, ranges = TAILSCALE, language = 'en' }) {
  const server = createServer(async (request, response) => {
    if (!allowed(request.socket.remoteAddress, ranges)) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(message('http_forbidden', language));
      return;
    }
    let path;
    try {
      path = new URL(request.url, 'http://x').pathname;
    } catch {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }).end(message('http_bad_request', language));
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method) || (path !== '/' && path !== '/index.html')) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(message('http_not_found', language));
      return;
    }
    // The app replaced this page: send the reader there when it is configured.
    if (process.env.CLEARED_APP_URL && (path === '/' || path === '/index.html')) {
      response.writeHead(302, { location: process.env.CLEARED_APP_URL, 'cache-control': 'no-store' }).end();
      return;
    }
    try {
      const page = await readFile(file);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(request.method === 'HEAD' ? undefined : page);
    } catch {
      response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end(message('http_unavailable', language));
    }
  });
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  return server;
}

// Run as a command (the path may hold a space, an accent or a symbolic link).
const command = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (command) {
  const [address, port, file, ...ranges] = process.argv.slice(2);
  if (!address || !port || !file) {
    process.stderr.write('usage: serve-dashboard.mjs <address> <port> <index.html> [<allowed CIDR>...]\n');
    process.exit(64);
  }
  dashboardServer({ file, ranges: ranges.length ? ranges : TAILSCALE, language: section(loadConf(), 'owner').language || 'en' }).listen(Number(port), address, () => {
    process.stdout.write(`dashboard on http://${address}:${port}/, for ${(ranges.length ? ranges : TAILSCALE).join(', ')} only\n`);
  });
}
