// The app's HTTP handler: the sign-in page and its form, the 30-day
// cookie session, the shell pages, the catalogs, the page's own files, and
// /api/service/*, handed to the data source (proxy.ts) for the signed-in
// user. It holds no key and signs nothing (plan, section 7).
//
// The pages are React, bundled by Vite into dist/ (npm run build): the
// server writes the page's HTML (its language, the bundle's file names
// from dist/.vite/manifest.json) and serves dist/ as files. The service and
// this server are not built: Node runs them.
//
// One document for the whole app (docs/v2/ui-overhaul-plan.md, U1, lane
// 34): every screen's address answers the same shell page, and the page's
// router draws the screen, so moving between screens loads no document.
// The page names every screen's chunk and sheet; a screen's sheets carry
// media="not all" and the screens they belong to (data-screens), and the
// page turns on those of the screen it shows (web/lib/sheets.ts), so each
// screen keeps the cascade it had on a page of its own. An address that is
// no screen's still answers 404.
//
// Every write needs the session cookie, the session's anti-forgery token in
// X-CSRF-Token, an Origin equal to the app's own address (or
// CLEARED_V2_APP_ORIGIN) and, when the browser sends it,
// Sec-Fetch-Site: same-origin; the sign-in form needs the last two. A Host
// that is not the app's own is refused (421), so a name pointed at
// 127.0.0.1 from another site reaches nothing. The pages load nothing
// inline and nothing from another site (Content-Security-Policy).
//
// The Browser tab's page is framed from the preview listener's own origin
// (preview.ts, decision 20, lane 20): the policy's frame-src names it and
// nothing else, the page reads it from <body data-preview>, and the app's
// own origin never serves a preview, not even through /api/service/.
//
// The web terminal of a session taken over (/api/service/sessions/:id/terminal/*,
// decision 32, lane 31) is answered on the app's loopback address only: a
// Host of 127.0.0.1, localhost or [::1] at this server's port, reached on a
// loopback socket, never the public origin's; every post with the
// anti-forgery token and an Origin equal to that loopback address, the
// stream with the cookie and, when the browser sends it, Sec-Fetch-Site:
// same-origin. /api/me says whether the terminal is offered (`terminal`).
//
// Each page the server writes draws its own style nonce (decisions 32 and
// 33, lane 32): its response's policy gains style-src 'self' 'nonce-<value>'
// and the page holds the value in <meta property="csp-nonce">, which the
// session screen gives to the editor (EditorView.cspNonce) and to the
// terminal's shims (web/lib/style-nonce.ts). Nothing else changes: no
// 'unsafe-inline', script-src still default-src 'self', and a file, a
// catalog or an API answer carries the policy with no nonce.
//
// /api/notifications and its two writes are the app's own (notifications.ts):
// a browser of the signed-in person asks to be told, with the same checks
// as any write. The manifest, the service worker and the icons are served
// without a session, so the app can be added to a Home Screen.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join } from 'node:path';
import type { User } from '../../src/modules/registry.ts';
import { sameProof } from '../../src/modules/users.ts';
import { requestPath } from '../../src/server.ts';
import type { UserId } from '../../src/session/contract.ts';
import { translator, type Translate } from '../web/lib/i18n.ts';
import { isScreen, languageOf, loadCatalog, type Language, type Screen } from './catalog.ts';
import { deviceName, notificationsFrom, NotifyError, type Notifications } from './notifications.ts';
import { sendJson, type DataSource } from './proxy.ts';
import { clearedCookie, readCookie, sessionCookie, type CookieSession, type CookieSessions } from './session-cookie.ts';
import type { LoginThrottle } from './users.ts';

export type AppOptions = {
  readonly users: { verify(name: string, password: string): Promise<User | undefined>; get(id: UserId): Promise<User | undefined> };
  readonly sessions: CookieSessions;
  readonly throttle: LoginThrottle;
  readonly source: DataSource;
  readonly language: Language;                      // the fallback when neither the choice nor the browser names one (languageOf)
  readonly project: string;
  readonly publicOrigin?: string | undefined;
  readonly distDir?: string;                         // default: app/dist, Vite's build
  readonly notifications?: Notifications;            // default: from the environment, read on first use
  readonly previewOrigin?: string | undefined;       // the preview listener's origin (preview.ts); none: no frame at all
};

export const DIST_DIR = new URL('../dist/', import.meta.url).pathname;

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',   // not no-referrer: Chromium then sends Origin: null on a form POST, and the sign-in is refused
  'cross-origin-opener-policy': 'same-origin',
};

const TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',             // the bundle, the theme script and the service worker
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// The app's icons, by exact name: the guard leaves these out as binaries.
const ICONS = /^\/icons\/(?:icon-192|icon-512|apple-touch-icon)\.png$/;

// The screens a signed-in person can open, and the stub each one mounts.
const PAGES: readonly { readonly path: RegExp; readonly screen: Exclude<Screen, 'shell'> }[] = [
  { path: /^\/$/, screen: 'tower' },
  { path: /^\/inbox$/, screen: 'inbox' },
  { path: /^\/sessions(?:\/[A-Za-z0-9_-]{1,64})?$/, screen: 'session' },
  { path: /^\/(?:lead|plans\/[A-Za-z0-9_-]{1,64})$/, screen: 'lead' },
  { path: /^\/consumption$/, screen: 'consumption' },                    // the consumption of the agents (O15)
  { path: /^\/ask\/[A-Za-z0-9_-]{1,64}$/, screen: 'ask' },                // a question to the code (lane 27)
];

// The page's policy: nothing inline, nothing from another site, and a frame
// only from the preview listener's origin when there is one (else as before).
// A page's response adds its style nonce; nothing else does.
export const contentPolicy = (previewOrigin?: string, styleNonce?: string): string =>
  `default-src 'self';${styleNonce ? ` style-src 'self' 'nonce-${styleNonce}';` : ''}${previewOrigin ? ` frame-src ${previewOrigin};` : ''} base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

// A fresh value for each page: 128 random bits, base64 as the policy writes a nonce.
export const styleNonce = (): string => randomBytes(16).toString('base64');

// A preview of a session (/api/sessions/:id/preview/...), which the app's origin never forwards.
const PREVIEW_PATH = /^sessions\/[^/]+\/preview(?:\/|$)/;
// The web terminal of a session (/api/sessions/:id/terminal/...), forwarded on the loopback address only.
const TERMINAL_PATH = /^sessions\/[^/]+\/terminal(?:\/|$)/;
const LOOPBACK_SOCKET = /^(?:127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// What a page needs from Vite's build: the entry's script and sheet, and
// each screen's chunk with its sheet, preloaded on that screen's page.
export type Bundle = {
  readonly script: string;
  readonly styles: readonly string[];
  readonly screens: Readonly<Record<string, { readonly script: string; readonly styles: readonly string[] }>>;
};

type ManifestChunk = { readonly file: string; readonly css?: readonly string[]; readonly imports?: readonly string[]; readonly isEntry?: boolean; readonly src?: string };

export class BuildMissing extends Error {
  override name = 'BuildMissing';
}

export function readBundle(distDir: string = DIST_DIR): Bundle {
  let manifest: Record<string, ManifestChunk>;
  try {
    manifest = JSON.parse(readFileSync(join(distDir, '.vite', 'manifest.json'), 'utf8')) as Record<string, ManifestChunk>;
  } catch {
    throw new BuildMissing('the web app is not built: run npm run build in v2/');
  }
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
  if (!entry) throw new BuildMissing('the web app\'s build has no entry: run npm run build in v2/');
  // A chunk's sheets in the order the cascade needs: the chunks it imports
  // first (the lead's sheet, which the inbox adapts), then its own.
  const sheets = (chunk: ManifestChunk, seen: Set<ManifestChunk> = new Set()): string[] => {
    if (seen.has(chunk)) return [];
    seen.add(chunk);
    const imported = (chunk.imports ?? []).flatMap((key) => { const next = manifest[key]; return next && !next.isEntry ? sheets(next, seen) : []; });
    return [...imported, ...(chunk.css ?? []).map((file) => `/${file}`)];
  };
  const screens: Record<string, { script: string; styles: readonly string[] }> = {};
  for (const chunk of Object.values(manifest)) {
    const screen = /^screens\/([a-z]+)\/[A-Z]/.exec(chunk.src ?? '')?.[1];
    if (screen) screens[screen] = { script: `/${chunk.file}`, styles: [...new Set(sheets(chunk))] };
  }
  return { script: `/${entry.file}`, styles: (entry.css ?? []).map((file) => `/${file}`), screens };
}

// The screens' sheets, each once, in an order that keeps each screen's
// own (the chunks it imports first), with the screens that use it.
export function screenSheets(bundle: Bundle): { readonly href: string; readonly screens: readonly string[] }[] {
  const sheets = new Map<string, string[]>();
  for (const [screen, own] of Object.entries(bundle.screens).sort(([a], [b]) => a.localeCompare(b))) {
    for (const href of own.styles) if (!bundle.styles.includes(href)) sheets.set(href, [...(sheets.get(href) ?? []), screen]);
  }
  return [...sheets].map(([href, screens]) => ({ href, screens }));
}

const FONTS = ['/fonts/Geist-Variable.woff2', '/fonts/GeistMono-Variable.woff2'];

function head(language: Language, title: string, bundle: Bundle, nonce: string, app = false): string {
  const sheets = [
    ...bundle.styles.map((href) => `<link rel="stylesheet" href="${escape(href)}">`),
    ...(app ? screenSheets(bundle).map(({ href, screens }) => `<link rel="stylesheet" href="${escape(href)}" media="not all" data-screens="${escape(screens.join(' '))}">`) : []),
  ].join('\n');
  const chunks = app ? Object.values(bundle.screens).map((own) => `\n<link rel="modulepreload" href="${escape(own.script)}">`).join('') : '';
  // The two faces every page sets, asked for before the sheet names them.
  const fonts = FONTS.map((href) => `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`).join('\n');
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="csp-nonce" nonce="${escape(nonce)}">
<title>${escape(title)}</title>
<meta name="theme-color" content="#FAFAFA">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">
${fonts}
${sheets}
<script src="/theme.js"></script>
<script type="module" src="${escape(bundle.script)}"></script>${chunks}
</head>`;
}

// The sign-in page: the form is drawn by the bundle (web/shell/Login.tsx)
// and posts here. The server's sentence (a wrong password, the throttle, a
// form from elsewhere) rides on the body, since the page runs no inline script.
export function loginPage(t: Translate, language: Language, bundle: Bundle, nonce: string, message?: string): string {
  return `${head(language, t('login_title'), bundle, nonce)}
<body class="login-page" data-screen="login"${message ? ` data-error="${escape(message)}"` : ''}>
<div id="root"></div>
</body>
</html>
`;
}

// The shell page, the same for every screen's address: the shell and the
// screens are drawn by the bundle (web/shell/App.tsx, its router naming the
// screen from the address, and the title with it); the body says what the
// header shows before /api/me answers.
export function shellPage(t: Translate, language: Language, bundle: Bundle, nonce: string, options: { readonly project: string; readonly user: User; readonly source: DataSource['kind']; readonly preview?: string | undefined }): string {
  return `${head(language, t('app_name'), bundle, nonce, true)}
<body data-screen="app" data-source="${options.source}" data-project="${escape(options.project)}" data-user="${escape(options.user.name)}"${options.preview ? ` data-preview="${escape(options.preview)}"` : ''}>
<div id="root"></div>
</body>
</html>
`;
}

function readBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(undefined);
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(undefined));
  });
}

export function createAppHandler(options: AppOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const distDir = options.distDir ?? DIST_DIR;
  // Each request's language (catalog.ts, languageOf), and the shell's words in it.
  const languageFor = (request: IncomingMessage): Language => languageOf(request.headers, options.language);
  const shellFor = (language: Language) => translator(loadCatalog('shell', language));
  // Read once, at the first page: a server started before the build says so on every page.
  let bundle: Bundle | undefined;
  const built = (): Bundle => (bundle ??= readBundle(distDir));

  const send = (response: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store', ...headers });
    response.end(body);
  };
  // A page: its own style nonce, in its response's policy and in its markup.
  const sendPage = (response: ServerResponse, status: number, render: (nonce: string) => string, headers: Record<string, string> = {}) => {
    const nonce = styleNonce();
    response.setHeader('content-security-policy', contentPolicy(options.previewOrigin, nonce));
    send(response, status, render(nonce), undefined, headers);
  };
  const redirect = (response: ServerResponse, location: string, headers: Record<string, string> = {}) => {
    response.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
    response.end();
  };

  // The Host must name this server: its own address and port, localhost
  // at that port, or the configured public origin.
  const hostAllowed = (request: IncomingMessage): boolean => {
    const host = request.headers.host;
    if (!host) return false;
    const { localAddress, localPort } = request.socket;
    const own = localAddress?.includes(':') ? `[${localAddress.replace(/^::ffff:/, '')}]` : localAddress;
    const allowed = new Set([`${own}:${localPort}`, `localhost:${localPort}`, `127.0.0.1:${localPort}`]);
    if (localAddress?.startsWith('::ffff:')) allowed.add(`${localAddress.slice(7)}:${localPort}`);
    if (options.publicOrigin) allowed.add(new URL(options.publicOrigin).host);
    return allowed.has(host.toLowerCase());
  };

  const sameOrigin = (request: IncomingMessage): boolean => {
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return false;
    const origin = request.headers.origin;
    return origin === `http://${request.headers.host}` || (options.publicOrigin !== undefined && origin === options.publicOrigin);
  };

  const session = async (request: IncomingMessage): Promise<{ id: string; cookie: CookieSession; user: User } | undefined> => {
    const id = readCookie(request.headers.cookie);
    const cookie = options.sessions.get(id);
    if (!id || !cookie) return undefined;
    const user = await options.users.get(cookie.userId);
    return user ? { id, cookie, user } : undefined;
  };

  // The request reached this server on its loopback address, by a loopback
  // name, and not through the public origin (decision 32).
  const loopback = (request: IncomingMessage): boolean => {
    const host = request.headers.host?.toLowerCase();
    const { localAddress, localPort } = request.socket;
    if (!host || !localAddress || !LOOPBACK_SOCKET.test(localAddress)) return false;
    if (options.publicOrigin !== undefined && host === new URL(options.publicOrigin).host) return false;
    return [`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`].includes(host);
  };

  // The terminal's own check, on top of the writes': its loopback address,
  // and an Origin (always on a post) equal to that address.
  const terminalOk = (request: IncomingMessage, read: boolean): boolean => {
    if (!loopback(request)) return false;
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return false;
    const origin = request.headers.origin;
    return origin === `http://${request.headers.host}` || (read && origin === undefined);
  };

  const csrfOk = (request: IncomingMessage, cookie: CookieSession) =>
    sameProof(request.headers['x-csrf-token'], cookie.csrf) && sameOrigin(request);

  // The address the browser used: the configured public origin when the
  // request names its host, else this server's own (hostAllowed has
  // already refused any other host).
  const browserOrigin = (request: IncomingMessage): string =>
    options.publicOrigin !== undefined && request.headers.host?.toLowerCase() === new URL(options.publicOrigin).host ? options.publicOrigin : `http://${request.headers.host}`;

  const notifications = options.notifications ?? notificationsFrom(process.env);

  async function notify(request: IncomingMessage, response: ServerResponse, path: string, mine: { cookie: CookieSession; user: User }): Promise<void> {
    const origin = browserOrigin(request);
    const method = request.method ?? 'GET';
    if (path === '/api/notifications') {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(response, 405, { error: 'method not allowed' });
      return sendJson(response, 200, await notifications.status(origin));
    }
    const gesture = path.slice('/api/notifications/'.length);
    if (gesture !== 'subscribe' && gesture !== 'unsubscribe') return sendJson(response, 404, { error: 'not found' });
    if (method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
    if (!csrfOk(request, mine.cookie)) return sendJson(response, 403, { error: 'refused: missing anti-forgery token or another origin' });
    const text = await readBody(request, 8192);
    let body: unknown;
    try { body = JSON.parse(text ?? ''); }
    catch { return sendJson(response, 400, { error: 'subscription' }); }
    try {
      return sendJson(response, 200, gesture === 'subscribe'
        ? await notifications.subscribe(origin, body, deviceName(mine.user.name, request.headers['user-agent']))
        : await notifications.unsubscribe(origin, body));
    } catch (error) {
      if (error instanceof NotifyError) return sendJson(response, error.status, { error: error.code });
      throw error;
    }
  }

  async function signIn(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const language = languageFor(request);
    const shellT = shellFor(language);
    if (!sameOrigin(request)) return sendPage(response, 403, (nonce) => loginPage(shellT, language, built(), nonce, shellT('login_refused')));
    const body = await readBody(request, 4096);
    const form = new URLSearchParams(body ?? '');
    const name = (form.get('name') ?? '').trim();
    const password = form.get('password') ?? '';
    const peer = request.socket.remoteAddress ?? 'unknown';
    // Counted before the password is checked: see users.ts.
    const attempt = options.throttle.start(peer, name);
    if (attempt.succeeded === undefined) {
      const minutes = Math.max(1, Math.ceil(attempt.wait / 60));
      return sendPage(response, 429, (nonce) => loginPage(shellT, language, built(), nonce, shellT('login_throttled', { minutes })), { 'retry-after': String(attempt.wait) });
    }
    const user = body === undefined ? undefined : await options.users.verify(name, password);
    if (!user) return sendPage(response, 401, (nonce) => loginPage(shellT, language, built(), nonce, shellT('login_wrong')));
    attempt.succeeded();
    const made = options.sessions.create(user.id);
    redirect(response, '/', { 'set-cookie': sessionCookie(made.id) });
  }

  // dist/ as files: Vite's hashed assets under /assets/ (kept a year: a
  // new build has new names), and app/public/ as Vite copied it.
  async function serveFile(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
    const parts = path.split('/').slice(1);
    if (parts.length === 0 || parts.length > 2 || !parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) return false;
    const type = TYPES[extname(path)];
    if (!type || (type === 'image/png' && !ICONS.test(path))) return false;
    let body: Buffer;
    try {
      body = await readFile(join(distDir, ...parts));
    } catch {
      return false;
    }
    const cache = parts[0] === 'assets' && parts.length === 2 ? 'public, max-age=31536000, immutable'
      : type === 'font/woff2' || type === 'image/png' ? 'public, max-age=86400' : 'no-cache';
    response.writeHead(200, { 'content-type': type, 'content-length': String(body.length), 'cache-control': cache });
    response.end(request.method === 'HEAD' ? undefined : body);
    return true;
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const path = requestPath(request.url ?? '/');
    if (path === undefined) return send(response, 400, 'bad request', 'text/plain; charset=utf-8');
    const read = method === 'GET' || method === 'HEAD';

    if (path === '/login') {
      if (method === 'POST') return signIn(request, response);
      if (!read) return send(response, 405, 'method not allowed', 'text/plain; charset=utf-8', { allow: 'GET, HEAD, POST' });
      if (await session(request)) return redirect(response, '/');
      const language = languageFor(request);
      return sendPage(response, 200, (nonce) => loginPage(shellFor(language), language, built(), nonce));
    }

    if (path.startsWith('/api/')) {
      const mine = await session(request);
      if (!mine) return sendJson(response, 401, { error: 'sign in first' });
      if (path === '/api/me') {
        if (!read) return sendJson(response, 405, { error: 'method not allowed' });
        return sendJson(response, 200, { user: mine.user, csrf: mine.cookie.csrf, language: languageFor(request), project: options.project, source: options.source.kind, terminal: loopback(request) });
      }
      if (path === '/api/notifications' || path.startsWith('/api/notifications/')) return notify(request, response, path, mine);
      if (path.startsWith('/api/service/')) {
        if (!read && !csrfOk(request, mine.cookie)) return sendJson(response, 403, { error: 'refused: missing anti-forgery token or another origin' });
        const rest = path.slice('/api/service/'.length);
        if (!rest || rest.split('/').some((part) => part === '' || part === '.' || part === '..' || /%2f|%5c/i.test(part))) return sendJson(response, 404, { error: 'not found' });
        if (PREVIEW_PATH.test(rest)) return sendJson(response, 404, { error: 'a preview is served by the preview listener only' });
        if (TERMINAL_PATH.test(rest) && !terminalOk(request, read)) return sendJson(response, 403, { error: 'the web terminal opens on this machine\'s browser only, at the app\'s loopback address' });
        const url = request.url ?? '';
        const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
        return options.source.forward(request, response, { method, path: `/api/${rest}${query}`, user: mine.user });
      }
      return sendJson(response, 404, { error: 'not found' });
    }

    if (path === '/logout') {
      if (method !== 'POST') return send(response, 405, 'method not allowed', 'text/plain; charset=utf-8', { allow: 'POST' });
      const mine = await session(request);
      if (!mine) return send(response, 401, '', 'text/plain; charset=utf-8');
      if (!csrfOk(request, mine.cookie)) return send(response, 403, '', 'text/plain; charset=utf-8');
      options.sessions.revoke(mine.id);
      response.writeHead(204, { 'set-cookie': clearedCookie(), 'cache-control': 'no-store' });
      return void response.end();
    }

    if (!read) return send(response, 405, 'method not allowed', 'text/plain; charset=utf-8', { allow: 'GET, HEAD' });

    const messages = /^\/messages\/([a-z]+)\.json$/.exec(path);
    if (messages) {
      const screen = messages[1] ?? '';
      if (!isScreen(screen)) return sendJson(response, 404, { error: 'not found' });
      return sendJson(response, 200, loadCatalog(screen, languageFor(request)));
    }

    const page = PAGES.find((p) => p.path.test(path));
    if (page) {
      const mine = await session(request);
      if (!mine) return redirect(response, '/login');
      const language = languageFor(request);
      return sendPage(response, 200, (nonce) => shellPage(shellFor(language), language, built(), nonce, { project: options.project, user: mine.user, source: options.source.kind, preview: options.previewOrigin }));
    }

    if (await serveFile(request, response, path)) return;
    send(response, 404, 'not found', 'text/plain; charset=utf-8');
  }

  const policy = contentPolicy(options.previewOrigin);
  return (request, response) => {
    response.setHeader('content-security-policy', policy);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    if (!hostAllowed(request)) return send(response, 421, 'this server does not answer for that host name', 'text/plain; charset=utf-8');
    route(request, response).catch((error: unknown) => {
      if (error instanceof BuildMissing) {
        console.error(`cleared-v2-app: ${error.message}`);
        if (!response.headersSent) return send(response, 503, error.message, 'text/plain; charset=utf-8');
      }
      console.error(`cleared-v2-app: ${request.method} failed (${error instanceof Error ? error.name : typeof error})`);
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
      else response.destroy();
    });
  };
}

