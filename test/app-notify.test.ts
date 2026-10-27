import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appServer, ROUTES, WRITES } from '../app/server.ts';
import { demoSource } from '../app/sources/demo.ts';
import { createNotifications } from '../app/lib/notifications.ts';
import { createActions } from '../app/lib/actions.ts';
import { notifySettings } from '../lib/notify/contract.ts';
import { notifyStore } from '../lib/notify/store.ts';

// What the app answers a session's JSON request, and a signed-in browser.
type Reply = { challengeId: string; [key: string]: unknown };
type Browser = {
  cookie: string;
  post(path: string, body?: object, over?: Record<string, string>): Promise<Response>;
  json(path: string, body?: object, over?: Record<string, string>): Promise<{ status: number; body: Reply }>;
};

const TOKEN = 'c'.repeat(64);
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); }); });
const pub = join(import.meta.dirname, '..', 'app', 'public');
const browserKeys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: e.getPublicKey().toString('base64url'), auth: Buffer.from('fedcba9876543210').toString('base64url') }; };
const SUBSCRIPTION = { endpoint: 'https://fcm.googleapis.com/fcm/send/dev-1', keys: browserKeys() };

async function rig({ notify = {}, env = {}, withNotifications = true }: { notify?: Record<string, string>; env?: Record<string, string>; withNotifications?: boolean } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = join(mkdtempSync(join(tmpdir(), 'cleared-app-notify-')), 'notify');
  dirs.push(dir.replace(/\/notify$/, ''));
  const records: { detail: string }[] = [];
  // The service's own settings come from its environment (here, the test's), never from agents.conf.
  const settings = notifySettings({ sections: { notify: { vapid_subject: 'mailto:ops@example.org', ...notify } } }, env);
  const store = notifyStore(dir, { create: true });
  const source = demoSource();
  // The gestures' confirmation, as the app wires it (app/main.ts).
  let shift = 0;
  const actions = createActions({ source, origin: base, now: () => Date.now() + shift,
    run: async () => ({ ok: true }), record: (e) => records.push(e) });
  const notifications = withNotifications ? createNotifications({ settings, store, origin: base, record: (e) => records.push(e), confirm: actions }) : null;
  const server = appServer({ source, token: TOKEN, ranges: ['127.0.0.0/8'], pollMs: 50, heartbeatMs: 80, actions, notifications, origin: base, owner: 'alice' });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const call = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: 'manual', ...init });
  // A session opened with the access token: the human's (decisions log, D18).
  const signIn = async (agent = 'Mozilla/5.0 (iPhone)'): Promise<Browser> => {
    const signed = await call('/session', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'user-agent': agent } });
    const cookie = signed.headers.get('set-cookie')!.split(';')[0]!;
    const me = await (await call('/api/me', { headers: { cookie } })).json() as { csrf: string };
    const post = (path: string, body: object = {}, over: Record<string, string> = {}) => call(path, { method: 'POST', headers: { cookie, 'x-csrf-token': me.csrf, origin: base, 'content-type': 'application/json', ...over }, body: JSON.stringify(body) });
    const json = async (path: string, body?: object, over?: Record<string, string>) => { const r = await post(path, body, over); return { status: r.status, body: await r.json().catch(() => ({})) as Reply }; };
    return { cookie, post, json };
  };
  // Turn notifications on (or off) for a subscription: the session asks, then confirms what it asked for.
  const confirmed = async (browser: Browser, op: string, payload: object) => {
    const asked = await browser.json('/api/notifications/challenge', { op, ...payload });
    if (asked.status !== 200) return asked;
    return browser.json(`/api/notifications/${op}`, { ...payload, challengeId: asked.body.challengeId });
  };
  return { base, dir, store, records, call, signIn, confirmed, later: (ms: number) => { shift += ms; }, close: () => new Promise((r) => { server.close(r); }) };
}
const subscriptionFor = (n: number) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/dev-${n}`, keys: browserKeys() });

test('the app is installable: manifest, service worker and icons are served without the token and carry no data', async () => {
  const r = await rig();
  try {
    const manifest = await r.call('/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type')!, /^application\/manifest\+json/);
    const body = await manifest.json() as { display: string; start_url: string; icons: { sizes: string }[] };
    assert.equal(body.display, 'standalone');
    assert.equal(body.start_url, '/');
    assert.deepEqual(body.icons.map((i) => i.sizes), ['192x192', '512x512']);
    for (const icon of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png']) {
      const response = await r.call(icon);
      assert.equal(response.status, 200, icon);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.deepEqual([...Buffer.from(await response.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    }
    const worker = await r.call('/sw.js');
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get('content-type')!, /javascript/);
    assert.equal(worker.headers.get('cache-control'), 'no-store');
    assert.equal((await r.call('/icons/other.png')).status, 401, 'only the listed files are open');
    assert.equal((await r.call('/notify.js')).status, 401, 'the page script needs the token like the others');
    const html = readFileSync(join(pub, 'index.html'), 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png">/);
    assert.ok(ROUTES.includes('GET /manifest.webmanifest') && ROUTES.includes('GET /sw.js') && ROUTES.includes('GET /api/notifications'));
    assert.ok(WRITES.includes('POST /api/notifications/challenge') && WRITES.includes('POST /api/notifications/subscribe') && WRITES.includes('POST /api/notifications/unsubscribe'));
  } finally { await r.close(); }
});

test('the service worker caches nothing and opens only an address of the app itself', () => {
  const code = readFileSync(join(pub, 'sw.js'), 'utf8');
  assert.doesNotMatch(code, /addEventListener\('fetch'|caches\.|importScripts|fetch\(/, 'no request is answered or made by the worker');
  assert.match(code, /url\.origin === self\.location\.origin/);
  assert.doesNotMatch(code.replace(/sameOrigin\([^)]*\)/g, ''), /openWindow\((?!url\))/, 'openWindow is given the checked address only');
  const js = readFileSync(join(pub, 'notify.js'), 'utf8');
  assert.match(js, /userVisibleOnly: true/);
  assert.match(js, /'x-csrf-token'/);
  assert.doesNotMatch(js, /passkey|navigator\.credentials/, 'no passkey: the session confirms, like the gestures');
  assert.match(js, /\/api\/notifications\/challenge/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML/);
  const app = readFileSync(join(pub, 'app.js'), 'utf8');
  assert.match(app, /#ticket=\(\[A-Za-z0-9\._-\]\{1,40\}\)\$/, 'a notification opens one ticket identifier, nothing else from the address');
  const login = readFileSync(join(pub, 'login.js'), 'utf8');
  assert.match(login, /ticket=\[A-Za-z0-9\._-\]\{1,40\}/, 'the sign-in page does not take a ticket address for a token');
});

test('subscribing is confirmed by the signed-in session: the access token alone, a wrong anti-forgery token, another origin, no challenge or another session\'s write nothing', async () => {
  const r = await rig();
  try {
    const body = JSON.stringify({ subscription: SUBSCRIPTION });
    const json = { 'content-type': 'application/json' };
    assert.equal((await r.call('/api/notifications', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 401, 'the token reads the board, not the notification settings');
    assert.equal((await r.call('/api/notifications/subscribe', { method: 'POST', body, headers: { ...json, authorization: `Bearer ${TOKEN}`, origin: r.base } })).status, 401, 'the token is not a session');

    const human = await r.signIn();
    const status = await (await r.call('/api/notifications', { headers: { cookie: human.cookie } })).json() as { available: boolean; reason: string | null; publicKey: string };
    assert.equal(status.available, true, 'no passkey to register first');
    assert.equal(status.reason, null);
    assert.equal(Buffer.from(status.publicKey, 'base64url').length, 65, 'the service key, made at first use');
    assert.equal((await human.post('/api/notifications/subscribe', { subscription: SUBSCRIPTION }, { 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await human.post('/api/notifications/challenge', { op: 'subscribe', subscription: SUBSCRIPTION }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await human.post('/api/notifications/subscribe', { subscription: SUBSCRIPTION }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.deepEqual(await human.json('/api/notifications/subscribe', { subscription: SUBSCRIPTION }), { status: 403, body: { error: 'challenge' } }, 'no challenge asked');
    const other = await r.signIn('Mozilla/5.0 (Macintosh)');
    const asked = await human.json('/api/notifications/challenge', { op: 'subscribe', subscription: SUBSCRIPTION });
    assert.deepEqual(Object.keys(asked.body), ['challengeId'], 'no key ceremony to answer');
    assert.deepEqual(await other.json('/api/notifications/subscribe', { subscription: SUBSCRIPTION, challengeId: asked.body.challengeId }), { status: 403, body: { error: 'challenge' } }, 'a challenge belongs to the session that asked for it, and is gone once tried');
    assert.equal(r.store.subscriptions().length, 0, 'nothing kept from a refused request');

    r.records.length = 0;
    assert.deepEqual(await r.confirmed(human, 'subscribe', { subscription: SUBSCRIPTION }), { status: 200, body: { ok: true, devices: 1 } });
    assert.deepEqual(r.store.subscriptions().map((s) => s.endpoint), [SUBSCRIPTION.endpoint]);
    assert.match(r.store.subscriptions()[0]!.device!, /^iPhone · /);
    const noted = r.records.map((e) => JSON.parse(e.detail)).filter((e) => e.gesture === 'notifications');
    assert.deepEqual(noted.map((e) => e.result), ['subscribed']);
    for (const e of r.records) assert.doesNotMatch(e.detail, /googleapis|dev-1|p256dh/, 'the ledger never gets the address or the keys');

    // Turning it off is confirmed the same way.
    assert.deepEqual(await human.json('/api/notifications/unsubscribe', { endpoint: SUBSCRIPTION.endpoint }), { status: 403, body: { error: 'challenge' } });
    assert.equal(r.store.subscriptions().length, 1);
    assert.deepEqual(await r.confirmed(human, 'unsubscribe', { endpoint: SUBSCRIPTION.endpoint }), { status: 200, body: { ok: true, removed: true, devices: 0 } });
  } finally { await r.close(); }
});

test('a confirmation is fresh and for one subscription and one purpose: stale, another address, other keys or the other gesture are refused, and it is used once', async () => {
  const r = await rig();
  try {
    const human = await r.signIn();
    const other = subscriptionFor(2);
    const answer = async (op: string, payload: object) => {
      const asked = await human.json('/api/notifications/challenge', { op, ...payload });
      assert.equal(asked.status, 200);
      return { challengeId: asked.body.challengeId };
    };
    assert.deepEqual(await human.json('/api/notifications/subscribe', { subscription: other, ...(await answer('subscribe', { subscription: SUBSCRIPTION })) }), { status: 403, body: { error: 'changed' } }, 'another address');
    assert.deepEqual(await human.json('/api/notifications/subscribe', { subscription: { ...SUBSCRIPTION, keys: browserKeys() }, ...(await answer('subscribe', { subscription: SUBSCRIPTION })) }), { status: 403, body: { error: 'changed' } }, 'other keys');
    assert.deepEqual(await human.json('/api/notifications/unsubscribe', { endpoint: SUBSCRIPTION.endpoint, ...(await answer('subscribe', { subscription: SUBSCRIPTION })) }), { status: 403, body: { error: 'challenge' } }, 'the other gesture');
    assert.deepEqual(await human.json('/api/actions/confirm', { ...(await answer('subscribe', { subscription: SUBSCRIPTION })) }), { status: 403, body: { error: 'challenge' } }, 'never a ticket\'s gesture');
    // A stale confirmation: the challenge lives two minutes.
    const stale = await answer('subscribe', { subscription: SUBSCRIPTION });
    r.later(121000);
    assert.deepEqual(await human.json('/api/notifications/subscribe', { subscription: SUBSCRIPTION, ...stale }), { status: 403, body: { error: 'challenge' } }, 'stale');
    const once = await answer('subscribe', { subscription: SUBSCRIPTION });
    assert.equal((await human.json('/api/notifications/subscribe', { subscription: SUBSCRIPTION, ...once })).status, 200);
    assert.deepEqual(await human.json('/api/notifications/subscribe', { subscription: SUBSCRIPTION, ...once }), { status: 403, body: { error: 'challenge' } }, 'replayed');
    assert.equal(r.store.subscriptions().length, 1);
    assert.deepEqual(await human.json('/api/notifications/challenge', { op: 'other' }), { status: 400, body: { error: 'gesture' } });
  } finally { await r.close(); }
});

test('only a known push service is kept: an address of anyone\'s choosing is refused', async () => {
  const r = await rig();
  try {
    const human = await r.signIn();
    for (const endpoint of ['https://evil.example/collect', 'http://fcm.googleapis.com/x', 'https://127.0.0.1:8788/x', 'https://fcm.googleapis.com.evil.example/x']) {
      assert.deepEqual(await human.json('/api/notifications/challenge', { op: 'subscribe', subscription: { ...SUBSCRIPTION, endpoint } }), { status: 400, body: { error: 'subscription' } }, endpoint);
      assert.deepEqual(await human.json('/api/notifications/subscribe', { subscription: { ...SUBSCRIPTION, endpoint } }), { status: 400, body: { error: 'subscription' } }, endpoint);
    }
    assert.equal((await r.confirmed(human, 'subscribe', { subscription: { endpoint: SUBSCRIPTION.endpoint, keys: { p256dh: 'x', auth: 'y' } } })).status, 400);
    assert.equal(r.store.subscriptions().length, 0);
  } finally { await r.close(); }
  const own = await rig({ env: { CLEARED_NOTIFY_PUSH_HOSTS: 'push.example.org' } });
  try {
    const human = await own.signIn();
    assert.equal((await own.confirmed(human, 'subscribe', { subscription: { ...SUBSCRIPTION, endpoint: 'https://push.example.org/x' } })).status, 200, 'CLEARED_NOTIFY_PUSH_HOSTS adds one');
  } finally { await own.close(); }
});

test('without Web Push in [notify] adapters, or without notifications at all, the app offers nothing and keeps nothing', async () => {
  const off = await rig({ notify: { adapters: 'ntfy' } });
  try {
    const human = await off.signIn();
    assert.deepEqual(await (await off.call('/api/notifications', { headers: { cookie: human.cookie } })).json(), { available: false, reason: 'off', publicKey: null, devices: 0 });
    assert.equal((await human.post('/api/notifications/challenge', { op: 'subscribe', subscription: SUBSCRIPTION })).status, 409);
    assert.equal((await human.post('/api/notifications/subscribe', { subscription: SUBSCRIPTION })).status, 409);
  } finally { await off.close(); }
  const none = await rig({ withNotifications: false });
  try {
    const { post } = await none.signIn();
    assert.equal((await post('/api/notifications/subscribe', { subscription: SUBSCRIPTION })).status, 503);
  } finally { await none.close(); }
});

test('the app server sends nothing itself: no network call in the notification code it runs', () => {
  for (const path of ['app/lib/notifications.ts', 'app/server.ts']) {
    const code = readFileSync(join(import.meta.dirname, '..', path), 'utf8').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /fetch\(|webpushAdapter|createAdapters|\.send\(|https?\.request/, path);
  }
});

// A real second account: the agents' Unix account must not reach the notification secrets.
const agentUser = process.env.CLEARED_TEST_AGENT_USER;
test('the agents\' account cannot read the notification keys, subscriptions or credentials', { skip: agentUser ? false : 'set CLEARED_TEST_AGENT_USER (a second account reachable with sudo -n) to run it' }, () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'cleared-notify-agent-')), 'notify');
  dirs.push(dir.replace(/\/notify$/, ''));
  const store = notifyStore(dir, { create: true });
  store.vapid();
  store.subscribe({ endpoint: SUBSCRIPTION.endpoint, keys: SUBSCRIPTION.keys });
  writeFileSync(join(dir, 'credentials.json'), '{}', { mode: 0o600 });
  for (const path of [dir, join(dir, 'vapid.json'), join(dir, 'subscriptions.json'), join(dir, 'credentials.json')]) {
    assert.notEqual(spawnSync('sudo', ['-n', '-u', agentUser!, '--', 'test', '-r', path]).status, 0, `${path} must not be readable by ${agentUser}`);
    assert.notEqual(spawnSync('sudo', ['-n', '-u', agentUser!, '--', 'test', '-w', path]).status, 0, `${path} must not be writable by ${agentUser}`);
  }
});
