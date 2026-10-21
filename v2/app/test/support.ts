// Starts the app's handler on a free loopback port with a temporary ledger,
// and signs a user in, for the app's tests.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import users, { SqliteUsers, type PasswordParams } from '../../src/modules/users.ts';
import { applyTables } from '../../src/store/db.ts';
import { createAppHandler, type AppOptions } from '../src/server.ts';
import { CookieSessions, SESSION_TABLES } from '../src/session-cookie.ts';
import { LoginThrottle } from '../src/users.ts';
import type { DataSource } from '../src/proxy.ts';

export const FAST: PasswordParams = { algorithm: 'argon2id', memory: 64, passes: 1, parallelism: 1, saltLength: 16, tagLength: 32 };
export const PASSWORD = 'a long passphrase';

export function openLedger(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path);
  applyTables(db, [...users.tables, ...SESSION_TABLES]);
  return db;
}

export type Running = {
  readonly base: string;
  readonly origin: string;
  readonly server: Server;
  readonly directory: SqliteUsers;
  readonly sessions: CookieSessions;
  close(): Promise<void>;
};

const unused: DataSource = {
  kind: 'service',
  forward(_request, response) {
    response.writeHead(599);
    response.end();
  },
};

export async function startApp(options: { readonly db?: DatabaseSync; readonly source?: DataSource; readonly throttle?: LoginThrottle; readonly extra?: Partial<AppOptions> } = {}): Promise<Running> {
  const db = options.db ?? openLedger();
  const directory = new SqliteUsers(db, { params: FAST });
  const sessions = new CookieSessions(db);
  const handler = createAppHandler({
    users: directory, sessions, throttle: options.throttle ?? new LoginThrottle(), source: options.source ?? unused,
    language: 'en', project: 'Guestbook', ...options.extra,
  });
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    base: origin, origin, server, directory, sessions,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// A form sign-in as a browser sends it: same origin, url-encoded.
export function login(app: Running, name: string, password: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: app.origin, 'sec-fetch-site': 'same-origin', ...headers },
    body: new URLSearchParams({ name, password }).toString(),
  });
}

// The cookie pair (name=value) a response sets, ready for a Cookie header.
export function cookieOf(response: Response): string {
  const set = response.headers.get('set-cookie') ?? '';
  return set.split(';')[0] ?? '';
}

export async function signedIn(app: Running, name = 'alex'): Promise<{ cookie: string; csrf: string; id: string }> {
  const user = (await app.directory.list()).find((u) => u.name === name) ?? await app.directory.add(name, PASSWORD);
  const cookie = cookieOf(await login(app, name, PASSWORD));
  const me = await fetch(`${app.base}/api/me`, { headers: { cookie } });
  const body = await me.json() as { csrf: string };
  return { cookie, csrf: body.csrf, id: user.id };
}
