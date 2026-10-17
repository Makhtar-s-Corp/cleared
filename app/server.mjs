#!/usr/bin/env node
// The Cleared app server. Its reads are GET and HEAD: data and files from the
// board snapshot and the ledger. Its only writes are the three gestures of the
// human (clear to land, send back, answer), the sign-in and passkey routes
// they need, and a browser's request to be notified; nothing starts or stops a
// team, nothing talks to the release service, and nothing is sent from here.
// Every connection is checked first: peer address, Host header, then the
// access token or session. A write needs more: the session cookie (never the
// bearer token), the anti-forgery header, a same-origin request, and for the
// gestures that change a ticket's course or turn a device's notifications on
// or off a passkey confirmation.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowed, TAILSCALE, bearerToken, hostAllowed, sameToken } from './lib/access.mjs';
import { attempts, COOKIE, cookieValue, sameSecret, sessionStore } from './lib/session.mjs';
import { originInfo } from './lib/actions.mjs';
import { diffSnapshots, envelope, frame } from './lib/events.mjs';
import { message } from '../lib/i18n.mjs';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/actions.js': ['actions.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/register': ['register.html', 'text/html; charset=utf-8'],
  '/register.js': ['register.js', 'text/javascript; charset=utf-8'],
  '/notify.js': ['notify.js', 'text/javascript; charset=utf-8'],
};
// The only things served without the token: the sign-in page and its two files.
const OPEN = {
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/style.css': FILES['/style.css'],
  // The two typefaces, served by the app itself (nothing is loaded from another site). No data in them.
  '/fonts/Geist-Variable.woff2': ['fonts/Geist-Variable.woff2', 'font/woff2'],
  '/fonts/GeistMono-Variable.woff2': ['fonts/GeistMono-Variable.woff2', 'font/woff2'],
  // What makes the app installable on a phone and shows its notifications. The browser fetches them
  // without the token (the manifest without any credential); no data in them.
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icons/icon-192.png': ['icons/icon-192.png', 'image/png'],
  '/icons/icon-512.png': ['icons/icon-512.png', 'image/png'],
  '/icons/apple-touch-icon.png': ['icons/apple-touch-icon.png', 'image/png'],
};
const HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store', 'cross-origin-resource-policy': 'same-origin',
};
export const ROUTES = ['GET /', 'GET /app.js', 'GET /actions.js', 'GET /notify.js', 'GET /style.css', 'GET /register', 'GET /register.js', 'GET /fonts/:file', 'GET /login', 'GET /login.js',
  'GET /manifest.webmanifest', 'GET /sw.js', 'GET /icons/:file', 'GET /api/snapshot', 'GET /api/me', 'GET /api/messages', 'GET /api/notifications', 'GET /api/tickets/:id', 'GET /media/:id', 'GET /events'];
// Everything that writes. All need the session cookie and the anti-forgery header, except sign-in (the access token).
export const WRITES = ['POST /session', 'POST /session/logout', 'POST /api/actions/challenge', 'POST /api/actions/confirm', 'POST /api/actions/undo',
  'POST /api/actions/answer', 'POST /api/passkeys/options', 'POST /api/passkeys/finish',
  'POST /api/notifications/challenge', 'POST /api/notifications/subscribe', 'POST /api/notifications/unsubscribe'];

// A page carries no text of its own: every element marked data-i takes its words from the catalog, in the language
// the owner chose, and so do data-i-aria / data-i-title / data-i-placeholder for the attributes a screen reader or a tooltip shows.
const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ATTRIBUTES = { aria: 'aria-label', title: 'title', placeholder: 'placeholder' };
export function page(html, language) {
  const words = (key) => escape(message(key, language));
  return html
    .replace(/<html lang="[a-z-]+">/, `<html lang="${language === 'fr' ? 'fr' : 'en'}">`)
    .replace(/(<([a-z0-9]+)\b[^>]*\sdata-i="(app_[a-z_]+)"[^>]*>)([^<]*)(<\/\2>)/g, (_, open, tag, key, old, close) => `${open}${words(key)}${close}`)
    .replace(/\sdata-i-(aria|title|placeholder)="(app_[a-z_]+)"/g, (_, kind, key) => ` ${ATTRIBUTES[kind]}="${words(key)}"`);
}

const MESSAGE_KEYS = (language) => {
  const out = {};
  for (const name of ['en', 'fr']) {
    if (name !== 'en' && name !== language) continue;
    const catalog = JSON.parse(readFileSync(join(here, '..', 'lib', 'i18n', `${name}.json`), 'utf8'));
    for (const [key, value] of Object.entries(catalog)) if (key.startsWith('app_')) out[key] = value;
  }
  return out;
};

export function appServer({ source, token, ranges = TAILSCALE, language = 'en', hosts = [], pollMs = 2000, heartbeatMs = 15000, actions = null, notifications = null, origin = '', owner = '', now = () => Date.now() }) {
  const text = (response, status, body, type = 'text/plain; charset=utf-8', extra = {}) =>
    response.writeHead(status, { ...HEADERS, 'content-type': type, ...extra }).end(body);
  const json = (response, status, value) => text(response, status, JSON.stringify(value), 'application/json; charset=utf-8');
  const send = async (response, request, [file, type]) => {
    try {
      const body = await readFile(join(PUBLIC, file));
      text(response, 200, request.method === 'HEAD' ? undefined : type.startsWith('text/html') ? page(body.toString('utf8'), language) : body, type, type === 'font/woff2' ? { 'cache-control': 'public, max-age=86400' } : {}); }
    catch { text(response, 503, message('http_unavailable', language)); }
  };
  const streams = new Set();
  const unwatch = source.watch?.(() => { cached = null; for (const entry of streams) entry.tick(); }) ?? (() => {});
  const sessions = sessionStore({ now });
  const failures = attempts({ now });
  const configured = originInfo(origin);
  const loopback = (address) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
  // Secure whenever the browser's connection is encrypted: TLS here, or a proxy on this machine (tailscale serve) that says so.
  const encrypted = (request) => Boolean(request.socket.encrypted) || (loopback(request.socket.remoteAddress) && request.headers['x-forwarded-proto'] === 'https');
  const expectedOrigin = (request) => configured?.origin ?? `${encrypted(request) ? 'https' : 'http'}://${request.headers.host}`;
  const body = (request) => new Promise((resolve, reject) => {
    let data = '', size = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => { size += chunk.length; if (size > 16384) { reject(Object.assign(new Error('big'), { status: 413, code: 'too_big' })); request.destroy(); } else data += chunk; });
    request.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(Object.assign(new Error('json'), { status: 400, code: 'json' })); } });
    request.on('error', reject);
  });
  // One read at a time, shared by every page: a slow source is never asked twice at once.
  let reading = null, readAt = 0, cached = null;
  const read = () => {
    if (cached && Date.now() - readAt < pollMs / 2) return Promise.resolve(cached);
    reading ??= Promise.resolve().then(() => source.snapshot()).then((value) => { cached = value; readAt = Date.now(); return value; }).finally(() => { reading = null; });
    return reading;
  };

  const server = createServer(async (request, response) => {
    if (!allowed(request.socket.remoteAddress, ranges)) return text(response, 403, message('http_forbidden', language), undefined, { connection: 'close' });
    if (!hostAllowed(request.headers.host, hosts)) return text(response, 421, message('http_forbidden', language), undefined, { connection: 'close' });
    // Reads, and the few writes in WRITES. Anything else is refused before any routing happens.
    if (!['GET', 'HEAD', 'POST'].includes(request.method)) return text(response, 405, 'Method not allowed', undefined, { allow: 'GET, HEAD, POST' });
    let url;
    try { url = new URL(request.url, 'http://x'); } catch { return text(response, 400, message('http_bad_request', language)); }
    const path = url.pathname;
    const mine = sessions.get(cookieValue(request.headers.cookie, COOKIE));
    const signedIn = Boolean(mine) || sameToken(bearerToken(request.headers.authorization), token);

    if (request.method === 'POST') return write(request, response, path, mine);
    if (OPEN[path]) return send(response, request, OPEN[path]);
    if (!signedIn) {
      if (path === '/') return text(response, 302, '', undefined, { location: '/login' });
      // The address that registers a passkey carries a grant after the #; the sign-in page must not take it for a token.
      if (path === '/register') return text(response, 302, '', undefined, { location: '/login?next=register' });
      return text(response, 401, 'Token required');
    }
    try {
      if (FILES[path]) return await send(response, request, FILES[path]);
      if (path === '/api/snapshot') return json(response, 200, await read());
      if (path === '/api/me') {
        if (!mine) return text(response, 401, 'Session required');
        return json(response, 200, { csrf: mine.csrf, device: mine.device, owner, actions: actions ? actions.status(mine) : null });
      }
      if (path === '/api/messages') return json(response, 200, MESSAGE_KEYS(language));
      if (path === '/api/notifications') {
        if (!mine) return text(response, 401, 'Session required');
        return json(response, 200, notifications ? notifications.status() : { available: false, reason: 'off', publicKey: null, devices: 0 });
      }
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
      if (path === '/events') return request.method === 'HEAD' ? text(response, 200, undefined, 'text/event-stream; charset=utf-8') : stream(request, response);
    } catch {
      // The reason stays in the server; the browser gets no detail, no path.
      return text(response, 503, message('http_unavailable', language));
    }
    return text(response, 404, message('http_not_found', language));
  });

  // ---- the writes ---------------------------------------------------------------
  async function write(request, response, path, mine) {
    const error = (status, code) => json(response, status, { error: code });
    try {
      if (path === '/session') {
        // Sign-in: the access token comes in a header (never in the address) and a session cookie goes back.
        const peer = request.socket.remoteAddress;
        // A right token always gets in (the peer may be a proxy on this machine that others share); wrong ones are counted and slowed.
        if (!sameToken(bearerToken(request.headers.authorization), token)) {
          if (failures.blocked(peer)) return text(response, 429, 'Too many attempts', undefined, { 'retry-after': '60' });
          failures.fail(peer); return text(response, 401, 'Token required');
        }
        const made = sessions.create(request.headers['user-agent'], { encrypted: encrypted(request) });
        return text(response, 204, undefined, undefined, { 'set-cookie': `${COOKIE}=${made.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${made.maxAge}${encrypted(request) || configured?.secure ? '; Secure' : ''}` });
      }
      if (!WRITES.includes(`POST ${path}`)) return text(response, 404, message('http_not_found', language));
      // Every other write: the session cookie, not the token; the anti-forgery header; a request from this very site.
      if (!mine) return error(401, 'session');
      if (!sameSecret(request.headers['x-csrf-token'], mine.csrf)) return error(403, 'csrf');
      // With an https address configured, a session made over plain http (its cookie could have travelled in the clear) writes nothing.
      if (configured?.secure && !mine.encrypted) return error(403, 'insecure_session');
      if (request.headers.origin !== expectedOrigin(request) || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')) return error(403, 'origin');
      if (!String(request.headers['content-type'] || '').startsWith('application/json')) return error(415, 'type');
      if (path === '/session/logout') { sessions.revoke(cookieValue(request.headers.cookie, COOKIE)); return text(response, 204, undefined, undefined, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); }
      // Notifications: a browser of the human asks to be told (or no longer), confirmed with the passkey. Nothing is sent from here.
      if (path.startsWith('/api/notifications/')) {
        if (!notifications) return error(503, 'unavailable');
        const input = await body(request);
        return json(response, 200, await notifications[path.slice('/api/notifications/'.length)](mine, input));
      }
      if (!actions) return error(503, 'unavailable');
      const input = await body(request);
      const run = { '/api/actions/challenge': 'begin', '/api/actions/confirm': 'confirm', '/api/actions/undo': 'undo', '/api/actions/answer': 'answer',
        '/api/passkeys/options': 'registerOptions', '/api/passkeys/finish': 'registerFinish' }[path];
      return json(response, 200, await actions[run](mine, input));
    } catch (caught) {
      if (caught?.status) return error(caught.status, caught.code);
      return error(500, 'failed');
    }
  }

  async function stream(request, response) {
    response.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    response.write('retry: 3000\n\n');
    let last = null, healthy = false, busy = false, stopped = false;
    const tick = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const next = await read();
        if (stopped) return;
        if (!last) response.write(frame(envelope('snapshot', next)));
        else for (const event of diffSnapshots(last, next)) response.write(frame(event));
        last = next; healthy = true;
      } catch { healthy = false; } // a failed read is silence: no heartbeat follows, so the page says the link is lost
      finally { busy = false; }
    };
    const poll = setInterval(tick, pollMs);
    // The heartbeat only says "alive" while the reads succeed.
    const beat = setInterval(() => { if (healthy) response.write(frame(envelope('heartbeat', {}))); }, heartbeatMs);
    const entry = { response, tick, stop: () => { stopped = true; clearInterval(poll); clearInterval(beat); streams.delete(entry); } };
    streams.add(entry);
    request.on('close', entry.stop);
    await tick();
  }
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  const close = server.close.bind(server);
  server.close = (callback) => { unwatch(); actions?.stop?.(); for (const entry of [...streams]) { entry.stop(); entry.response.end(); } server.closeAllConnections?.(); return close(callback); };
  return server;
}
