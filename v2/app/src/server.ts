// The app's HTTP handler: the sign-in page and its form, the 30-day
// cookie session, the shell pages, the catalogs, the page's own files, and
// /api/service/*, handed to the data source (proxy.ts) for the signed-in
// user. It holds no key and signs nothing (plan, section 7).
//
// Every write needs the session cookie, the session's anti-forgery token in
// X-CSRF-Token, an Origin equal to the app's own address (or
// CLEARED_V2_APP_ORIGIN) and, when the browser sends it,
// Sec-Fetch-Site: same-origin; the sign-in form needs the last two. A Host
// that is not the app's own is refused (421), so a name pointed at
// 127.0.0.1 from another site reaches nothing. The pages load nothing
// inline and nothing from another site (Content-Security-Policy).
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join } from 'node:path';
import type { User } from '../../src/modules/registry.ts';
import { requestPath } from '../../src/server.ts';
import type { UserId } from '../../src/session/contract.ts';
import { translator, type Translate } from '../public/i18n.ts';
import { isScreen, loadCatalog, type Language, type Screen } from './catalog.ts';
import { sendJson, type DataSource } from './proxy.ts';
import { clearedCookie, readCookie, sessionCookie, type CookieSession, type CookieSessions } from './session-cookie.ts';
import type { LoginThrottle } from './users.ts';

export type AppOptions = {
  readonly users: { verify(name: string, password: string): Promise<User | undefined>; get(id: UserId): Promise<User | undefined> };
  readonly sessions: CookieSessions;
  readonly throttle: LoginThrottle;
  readonly source: DataSource;
  readonly language: Language;
  readonly project: string;
  readonly publicOrigin?: string | undefined;
  readonly publicDir?: string;
};

export const PUBLIC_DIR = new URL('../public/', import.meta.url).pathname;

const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
};

const TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// The screens a signed-in person can open, and the stub each one mounts.
const PAGES: readonly { readonly path: RegExp; readonly screen: Exclude<Screen, 'shell'> }[] = [
  { path: /^\/$/, screen: 'tower' },
  { path: /^\/inbox$/, screen: 'inbox' },
  { path: /^\/sessions(?:\/[A-Za-z0-9_-]{1,64})?$/, screen: 'session' },
];

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const LOGO = '<svg class="logo" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 L22 20 H2 Z"/></svg>';

function head(language: Language, title: string): string {
  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<link rel="stylesheet" href="/style.css">
<script src="/theme.ts"></script>
</head>`;
}

export function loginPage(t: Translate, language: Language, message?: string): string {
  return `${head(language, t('login_title'))}
<body class="login-page">
<main class="login">
<div class="login-brand">${LOGO}<span class="name">${escape(t('app_name'))}</span></div>
<form class="login-card" method="post" action="/login">
<h1>${escape(t('login_title'))}</h1>
${message ? `<p class="login-error" role="alert">${escape(message)}</p>` : ''}
<label for="name">${escape(t('login_name'))}</label>
<input id="name" name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="32" autofocus>
<label for="password">${escape(t('login_phrase'))}</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">
<button class="primary" type="submit">${escape(t('login_submit'))}</button>
</form>
</main>
</body>
</html>
`;
}

export function shellPage(t: Translate, language: Language, options: { readonly screen: Exclude<Screen, 'shell'>; readonly project: string; readonly user: User; readonly source: DataSource['kind'] }): string {
  const tab = (screen: Exclude<Screen, 'shell'>, href: string, label: string, extra = '') =>
    `<a href="${href}"${options.screen === screen ? ' aria-current="page"' : ''}>${escape(label)}${extra}</a>`;
  const initial = options.user.name.slice(0, 1).toUpperCase();
  return `${head(language, `${t('app_name')} · ${t(`title_${options.screen}`)}`)}
<body data-screen="${options.screen}" data-source="${options.source}">
<a class="skip" href="#screen">${escape(t('skip_to_content'))}</a>
<header class="top">
<div class="bar">
<a class="brand" href="/">${LOGO}<span class="name">${escape(t('app_name'))}</span></a>
${options.project ? `<span class="slash" aria-hidden="true">/</span><span class="project">${escape(options.project)}</span>` : ''}
<nav class="views" aria-label="${escape(t('nav_label'))}">
${tab('tower', '/', t('nav_tower'))}
${tab('inbox', '/inbox', t('nav_inbox'), `<span class="count" id="inbox-count" hidden></span>`)}
${tab('session', '/sessions', t('nav_sessions'))}
<span aria-disabled="true" title="${escape(t('nav_tickets_later'))}">${escape(t('nav_tickets'))}</span>
</nav>
<div class="right">
${options.source === 'fixtures' ? `<span class="source-pill">${escape(t('source_fixtures'))}</span>` : ''}
<time class="clock" id="clock"></time>
<button class="icon theme" id="theme" type="button" aria-label="${escape(t('theme_dark'))}" data-dark="${escape(t('theme_dark'))}" data-light="${escape(t('theme_light'))}"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path class="moon" d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/><circle class="sun" cx="12" cy="12" r="4.5"/><path class="sun" d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/></svg></button>
<details class="me">
<summary class="avatar" aria-label="${escape(t('signed_in_as', { name: options.user.name }))}">${escape(initial)}</summary>
<div class="menu">
<p>${escape(t('signed_in_as', { name: options.user.name }))}</p>
<button class="plain" id="sign-out" type="button">${escape(t('sign_out'))}</button>
</div>
</details>
</div>
</div>
</header>
<main id="screen" class="screen"></main>
<script type="module" src="/app.ts"></script>
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
  const publicDir = options.publicDir ?? PUBLIC_DIR;
  const shellT = translator(loadCatalog('shell', options.language));
  const stripped = new Map<string, string>();

  const send = (response: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': 'no-store', ...headers });
    response.end(body);
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

  const csrfOk = (request: IncomingMessage, cookie: CookieSession) =>
    request.headers['x-csrf-token'] === cookie.csrf && sameOrigin(request);

  async function signIn(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!sameOrigin(request)) return send(response, 403, loginPage(shellT, options.language, shellT('login_refused')));
    const body = await readBody(request, 4096);
    const form = new URLSearchParams(body ?? '');
    const name = (form.get('name') ?? '').trim();
    const password = form.get('password') ?? '';
    const peer = request.socket.remoteAddress ?? 'unknown';
    const wait = options.throttle.blocked(peer, name);
    if (wait > 0) {
      const minutes = Math.max(1, Math.ceil(wait / 60));
      return send(response, 429, loginPage(shellT, options.language, shellT('login_throttled', { minutes })), undefined, { 'retry-after': String(wait) });
    }
    const user = body === undefined ? undefined : await options.users.verify(name, password);
    if (!user) {
      options.throttle.failed(peer, name);
      return send(response, 401, loginPage(shellT, options.language, shellT('login_wrong')));
    }
    const made = options.sessions.create(user.id);
    redirect(response, '/', { 'set-cookie': sessionCookie(made.id) });
  }

  async function serveFile(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
    const parts = path.split('/').slice(1);
    if (parts.length === 0 || parts.length > 2 || !parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) return false;
    const type = TYPES[extname(path)];
    if (!type) return false;
    let body: Buffer | string;
    try {
      const file = join(publicDir, ...parts);
      if (extname(path) === '.ts') {
        let code = stripped.get(file);
        if (code === undefined) {
          code = stripTypeScriptTypes(await readFile(file, 'utf8'));
          stripped.set(file, code);
        }
        body = code;
      } else body = await readFile(file);
    } catch {
      return false;
    }
    response.writeHead(200, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), 'cache-control': type === 'font/woff2' ? 'public, max-age=86400' : 'no-cache' });
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
      return send(response, 200, loginPage(shellT, options.language));
    }

    if (path.startsWith('/api/')) {
      const mine = await session(request);
      if (!mine) return sendJson(response, 401, { error: 'sign in first' });
      if (path === '/api/me') {
        if (!read) return sendJson(response, 405, { error: 'method not allowed' });
        return sendJson(response, 200, { user: mine.user, csrf: mine.cookie.csrf, language: options.language, project: options.project, source: options.source.kind });
      }
      if (path.startsWith('/api/service/')) {
        if (!read && !csrfOk(request, mine.cookie)) return sendJson(response, 403, { error: 'refused: missing anti-forgery token or another origin' });
        const rest = path.slice('/api/service/'.length);
        if (!rest || rest.split('/').some((part) => part === '' || part === '.' || part === '..' || /%2f|%5c/i.test(part))) return sendJson(response, 404, { error: 'not found' });
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
      return sendJson(response, 200, loadCatalog(screen, options.language));
    }

    const page = PAGES.find((p) => p.path.test(path));
    if (page) {
      const mine = await session(request);
      if (!mine) return redirect(response, '/login');
      return send(response, 200, shellPage(shellT, options.language, { screen: page.screen, project: options.project, user: mine.user, source: options.source.kind }));
    }

    if (await serveFile(request, response, path)) return;
    send(response, 404, 'not found', 'text/plain; charset=utf-8');
  }

  return (request, response) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
    if (!hostAllowed(request)) return send(response, 421, 'this server does not answer for that host name', 'text/plain; charset=utf-8');
    route(request, response).catch((error: unknown) => {
      console.error(`cleared-v2-app: ${request.method} failed (${error instanceof Error ? error.name : typeof error})`);
      if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
      else response.destroy();
    });
  };
}

