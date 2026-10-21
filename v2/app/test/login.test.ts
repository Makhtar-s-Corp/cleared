import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { LoginThrottle, THROTTLE } from '../src/users.ts';
import { COOKIE_NAME, MAX_AGE_SECONDS } from '../src/session-cookie.ts';
import { PASSWORD, cookieOf, login, openLedger, signedIn, startApp } from './support.ts';

const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-app-login-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('a right password sets the session cookie: HttpOnly, Secure, SameSite=Strict, for 30 days', async () => {
  const app = await startApp();
  try {
    await app.directory.add('alex', PASSWORD);
    const response = await login(app, 'alex', PASSWORD);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), '/');
    const cookie = response.headers.get('set-cookie') ?? '';
    const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
    assert.match(pair ?? '', new RegExp(`^${COOKIE_NAME}=[A-Za-z0-9_-]{43}$`));
    assert.deepEqual(attributes.sort(), ['HttpOnly', `Max-Age=${30 * 24 * 60 * 60}`, 'Path=/', 'SameSite=Strict', 'Secure']);
    assert.equal(MAX_AGE_SECONDS, 2592000);
    const me = await fetch(`${app.base}/api/me`, { headers: { cookie: cookieOf(response) } });
    assert.equal(me.status, 200);
    const body = await me.json() as { user: { name: string }; csrf: string };
    assert.equal(body.user.name, 'alex');
    assert.match(body.csrf, /^[A-Za-z0-9_-]{43}$/);
  } finally {
    await app.close();
  }
});

test('a wrong password is refused, and after five failures even the right one is throttled', async () => {
  let now = 1_000_000;
  const app = await startApp({ throttle: new LoginThrottle({ now: () => now }) });
  try {
    await app.directory.add('alex', PASSWORD);
    const wrong = await login(app, 'alex', 'not it');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers.get('set-cookie'), null);
    assert.match(await wrong.text(), /That name and password do not match/);
    for (let i = 2; i <= THROTTLE.failures; i++) assert.equal((await login(app, 'alex', 'not it')).status, 401);
    const throttled = await login(app, 'alex', PASSWORD);
    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get('set-cookie'), null);
    assert.equal(throttled.headers.get('retry-after'), String(THROTTLE.windowSeconds));
    assert.match(await throttled.text(), /Too many attempts/);
    // Another name from the same peer is throttled too: the peer is counted.
    await app.directory.add('sam', PASSWORD);
    assert.equal((await login(app, 'sam', PASSWORD)).status, 429);
    now += THROTTLE.windowSeconds * 1000 + 1;
    assert.equal((await login(app, 'alex', PASSWORD)).status, 303);
  } finally {
    await app.close();
  }
});

test('failures are counted per name too, whatever the peer says it is', async () => {
  const throttle = new LoginThrottle();
  for (let i = 0; i < THROTTLE.failures; i++) throttle.failed(`peer-${i}`, 'alex');
  assert.equal(throttle.blocked('another-peer', 'alex') > 0, true);
  assert.equal(throttle.blocked('another-peer', 'sam'), 0);
});

test('a sign-in from another origin is refused before the password is checked', async () => {
  const app = await startApp();
  try {
    await app.directory.add('alex', PASSWORD);
    assert.equal((await login(app, 'alex', PASSWORD, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await login(app, 'alex', PASSWORD, { 'sec-fetch-site': 'cross-site' })).status, 403);
  } finally {
    await app.close();
  }
});

test('a write without the anti-forgery header, or with another one, or from another origin, is refused', async () => {
  const app = await startApp();
  try {
    const { cookie, csrf } = await signedIn(app);
    const post = (headers: Record<string, string>) => fetch(`${app.base}/api/service/tickets`, {
      method: 'POST', headers: { cookie, origin: app.origin, 'content-type': 'application/json', ...headers }, body: '{"title":"x","project":"p"}',
    });
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ 'x-csrf-token': 'A'.repeat(43) })).status, 403);
    assert.equal((await post({ 'x-csrf-token': csrf, origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({ 'x-csrf-token': csrf, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await post({ 'x-csrf-token': csrf })).status, 599, 'with all three it reaches the data source');
  } finally {
    await app.close();
  }
});

test('a session survives a restart of the app on the same ledger', async () => {
  const path = join(dir, 'ledger.db');
  const first = await startApp({ db: openLedger(path) });
  const { cookie } = await signedIn(first);
  await first.close();
  const second = await startApp({ db: openLedger(path) });
  try {
    const me = await fetch(`${second.base}/api/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as { user: { name: string } }).user.name, 'alex');
  } finally {
    await second.close();
  }
});

test('the ledger keeps a hash of the session id, never the id itself', async () => {
  const db = openLedger();
  const app = await startApp({ db });
  try {
    const { cookie } = await signedIn(app);
    const id = cookie.split('=')[1] ?? '';
    const dump = JSON.stringify(db.prepare('SELECT * FROM app_sessions').all());
    assert.ok(id.length > 0 && !dump.includes(id));
  } finally {
    await app.close();
  }
});

test('signing out ends the session; a page without a session goes to the sign-in page', async () => {
  const app = await startApp();
  try {
    const { cookie, csrf } = await signedIn(app);
    const out = await fetch(`${app.base}/logout`, { method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf } });
    assert.equal(out.status, 204);
    assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
    assert.equal((await fetch(`${app.base}/api/me`, { headers: { cookie } })).status, 401);
    const page = await fetch(`${app.base}/`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get('location'), '/login');
  } finally {
    await app.close();
  }
});

test('an expired session is refused', async () => {
  let now = Date.parse('2026-10-21T10:00:00.000Z');
  const db = openLedger();
  const app = await startApp({ db, extra: {} });
  const { CookieSessions } = await import('../src/session-cookie.ts');
  const sessions = new CookieSessions(db, { now: () => now });
  try {
    const user = await app.directory.add('alex', PASSWORD);
    const made = sessions.create(user.id);
    assert.equal(sessions.get(made.id)?.userId, user.id);
    now += MAX_AGE_SECONDS * 1000 + 1;
    assert.equal(sessions.get(made.id), undefined);
  } finally {
    await app.close();
  }
});

test('a request for another host name is refused', async () => {
  const app = await startApp();
  try {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const port = new URL(app.base).port;
      request({ host: '127.0.0.1', port, path: '/login', headers: { host: `rebound.example:${port}` } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); })
        .on('error', reject).end();
    });
    assert.equal(status, 421);
  } finally {
    await app.close();
  }
});
