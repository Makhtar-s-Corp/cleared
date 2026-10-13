#!/usr/bin/env node
// The Cleared app server. It only reads: GET and HEAD, nothing else, and every
// route below returns data or files. No route writes, moves a ticket, starts or
// stops anything. Every connection is checked first: peer address, Host
// header, then the access token (cookie or bearer header).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowed, TAILSCALE, bearerToken, cookieToken, hostAllowed, sameToken } from './lib/access.mjs';
import { diffSnapshots, envelope, frame } from './lib/events.mjs';
import { message } from '../lib/i18n.mjs';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
// The only things served without the token: the sign-in page and its two files.
const OPEN = {
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/style.css': FILES['/style.css'],
};
const HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin',
};
export const ROUTES = ['GET /', 'GET /app.js', 'GET /style.css', 'GET /login', 'GET /login.js', 'GET /session', 'GET /api/snapshot',
  'GET /api/messages', 'GET /api/tickets/:id', 'GET /media/:id', 'GET /events'];

const MESSAGE_KEYS = (language) => {
  const out = {};
  for (const name of ['en', 'fr']) {
    if (name !== 'en' && name !== language) continue;
    const catalog = JSON.parse(readFileSync(join(here, '..', 'lib', 'i18n', `${name}.json`), 'utf8'));
    for (const [key, value] of Object.entries(catalog)) if (key.startsWith('app_')) out[key] = value;
  }
  return out;
};

export function appServer({ source, token, ranges = TAILSCALE, language = 'en', hosts = [], pollMs = 2000, heartbeatMs = 15000 }) {
  const text = (response, status, body, type = 'text/plain; charset=utf-8', extra = {}) =>
    response.writeHead(status, { ...HEADERS, 'content-type': type, ...extra }).end(body);
  const json = (response, status, value) => text(response, status, JSON.stringify(value), 'application/json; charset=utf-8');
  const send = async (response, request, [file, type]) => {
    try { text(response, 200, request.method === 'HEAD' ? undefined : await readFile(join(PUBLIC, file)), type); }
    catch { text(response, 503, message('http_unavailable', language)); }
  };
  const streams = new Set();

  const server = createServer(async (request, response) => {
    if (!allowed(request.socket.remoteAddress, ranges)) return text(response, 403, message('http_forbidden', language), undefined, { connection: 'close' });
    if (!hostAllowed(request.headers.host, hosts)) return text(response, 421, message('http_forbidden', language), undefined, { connection: 'close' });
    // Reads only. Anything else is refused before any routing happens.
    if (!['GET', 'HEAD'].includes(request.method)) return text(response, 405, 'Read only', undefined, { allow: 'GET, HEAD' });
    let url;
    try { url = new URL(request.url, 'http://x'); } catch { return text(response, 400, message('http_bad_request', language)); }
    const path = url.pathname;
    const given = bearerToken(request.headers.authorization) || cookieToken(request.headers.cookie);
    const signedIn = sameToken(given, token);

    if (OPEN[path]) return send(response, request, OPEN[path]);
    if (path === '/session') {
      // Sign-in: the page sends the token in a header (never in the address) and gets a cookie back.
      if (!sameToken(bearerToken(request.headers.authorization), token)) return text(response, 401, 'Token required');
      return text(response, 204, undefined, undefined, { 'set-cookie': `cleared_app=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` });
    }
    if (!signedIn) {
      if (path === '/' ) return text(response, 302, '', undefined, { location: '/login' });
      return text(response, 401, 'Token required');
    }
    try {
      if (FILES[path]) return await send(response, request, FILES[path]);
      if (path === '/api/snapshot') return json(response, 200, await source.snapshot());
      if (path === '/api/messages') return json(response, 200, MESSAGE_KEYS(language));
      const ticket = /^\/api\/tickets\/([A-Za-z0-9._-]{1,40})$/.exec(path);
      if (ticket) {
        const detail = await source.ticket(ticket[1]);
        return detail ? json(response, 200, detail) : text(response, 404, message('http_not_found', language));
      }
      const media = /^\/media\/([a-f0-9]{64})$/.exec(path);
      if (media) {
        const image = await source.media?.(media[1]);
        return image ? text(response, 200, request.method === 'HEAD' ? undefined : image.body, image.mime) : text(response, 404, message('http_not_found', language));
      }
      if (path === '/events') return stream(request, response);
    } catch {
      // The reason stays in the server; the browser gets no detail, no path.
      return text(response, 503, message('http_unavailable', language));
    }
    return text(response, 404, message('http_not_found', language));
  });

  async function stream(request, response) {
    response.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    response.write('retry: 3000\n\n');
    let last;
    const tick = async () => {
      try {
        const next = await source.snapshot();
        if (!last) response.write(frame(envelope('snapshot', next)));
        else for (const event of diffSnapshots(last, next)) response.write(frame(event));
        last = next;
      } catch { /* a failed read is silence, not a stale "fresh" update: the client sees the heartbeat stop */ }
    };
    await tick();
    const poll = setInterval(tick, pollMs);
    const beat = setInterval(() => response.write(frame(envelope('heartbeat', {}))), heartbeatMs);
    const entry = { response, stop: () => { clearInterval(poll); clearInterval(beat); streams.delete(entry); } };
    streams.add(entry);
    request.on('close', entry.stop);
  }
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  const close = server.close.bind(server);
  server.close = (callback) => { for (const entry of [...streams]) { entry.stop(); entry.response.end(); } server.closeAllConnections?.(); return close(callback); };
  return server;
}
