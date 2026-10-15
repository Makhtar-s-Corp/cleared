import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appServer, ROUTES, WRITES } from '../app/server.mjs';
import { demoSource } from '../app/sources/demo.mjs';
import { createNotifications } from '../app/lib/notifications.mjs';
import { notifySettings } from '../lib/notify/contract.mjs';
import { notifyStore } from '../lib/notify/store.mjs';

const TOKEN = 'c'.repeat(64);
const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const pub = join(import.meta.dirname, '..', 'app', 'public');
const browserKeys = () => { const e = createECDH('prime256v1'); e.generateKeys(); return { p256dh: e.getPublicKey().toString('base64url'), auth: Buffer.from('fedcba9876543210').toString('base64url') }; };
const SUBSCRIPTION = { endpoint: 'https://fcm.googleapis.com/fcm/send/dev-1', keys: browserKeys() };

async function rig({ notify = {}, withNotifications = true } = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dir = join(mkdtempSync(join(tmpdir(), 'cleared-app-notify-')), 'notify');
  dirs.push(dir.replace(/\/notify$/, ''));
  const records = [];
  const settings = notifySettings({ sections: { notify: { vapid_subject: 'mailto:ops@example.org', ...notify } } });
  const store = notifyStore(dir, { create: true });
  const notifications = withNotifications ? createNotifications({ settings, store, origin: base, record: (e) => records.push(e) }) : null;
  const server = appServer({ source: demoSource(), token: TOKEN, ranges: ['127.0.0.0/8'], pollMs: 50, heartbeatMs: 80, notifications, origin: base, owner: 'alice' });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const call = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });
  const signIn = async () => {
    const signed = await call('/session', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'user-agent': 'Mozilla/5.0 (iPhone)' } });
    const cookie = signed.headers.get('set-cookie').split(';')[0];
    const me = await (await call('/api/me', { headers: { cookie } })).json();
    const post = (path, body = {}, over = {}) => call(path, { method: 'POST', headers: { cookie, 'x-csrf-token': me.csrf, origin: base, 'content-type': 'application/json', ...over }, body: JSON.stringify(body) });
    return { cookie, post };
  };
  return { base, dir, store, records, call, signIn, close: () => new Promise((r) => { server.close(r); }) };
}

test('the app is installable: manifest, service worker and icons are served without the token and carry no data', async () => {
  const r = await rig();
  try {
    const manifest = await r.call('/manifest.webmanifest');
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type'), /^application\/manifest\+json/);
    const body = await manifest.json();
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
    assert.match(worker.headers.get('content-type'), /javascript/);
    assert.equal(worker.headers.get('cache-control'), 'no-store');
    assert.equal((await r.call('/icons/other.png')).status, 401, 'only the listed files are open');
    assert.equal((await r.call('/notify.js')).status, 401, 'the page script needs the token like the others');
    const html = readFileSync(join(pub, 'index.html'), 'utf8');
    assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png">/);
    assert.ok(ROUTES.includes('GET /manifest.webmanifest') && ROUTES.includes('GET /sw.js') && ROUTES.includes('GET /api/notifications'));
    assert.ok(WRITES.includes('POST /api/notifications/subscribe') && WRITES.includes('POST /api/notifications/unsubscribe'));
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
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML/);
  const app = readFileSync(join(pub, 'app.js'), 'utf8');
  assert.match(app, /#ticket=\(\[A-Za-z0-9\._-\]\{1,40\}\)\$/, 'a notification opens one ticket identifier, nothing else from the address');
  const login = readFileSync(join(pub, 'login.js'), 'utf8');
  assert.match(login, /ticket=\[A-Za-z0-9\._-\]\{1,40\}/, 'the sign-in page does not take a ticket address for a token');
});

test('subscribing needs the human\'s session: not the access token alone, not without the anti-forgery token, not from another site', async () => {
  const r = await rig();
  try {
    const body = JSON.stringify({ subscription: SUBSCRIPTION });
    const json = { 'content-type': 'application/json' };
    assert.equal((await r.call('/api/notifications', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 401, 'the token reads the board, not the notification settings');
    assert.equal((await r.call('/api/notifications/subscribe', { method: 'POST', body, headers: { ...json, authorization: `Bearer ${TOKEN}`, origin: r.base } })).status, 401, 'an agent holding the token cannot subscribe');
    assert.equal((await r.call('/api/notifications/subscribe', { method: 'POST', body, headers: json })).status, 401);
    const { cookie, post } = await r.signIn();
    assert.equal((await post('/api/notifications/subscribe', { subscription: SUBSCRIPTION }, { 'x-csrf-token': 'wrong' })).status, 403);
    assert.equal((await post('/api/notifications/subscribe', { subscription: SUBSCRIPTION }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('/api/notifications/subscribe', { subscription: SUBSCRIPTION }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal(r.store.subscriptions().length, 0, 'nothing kept from a refused request');
    const status = await (await r.call('/api/notifications', { headers: { cookie } })).json();
    assert.equal(status.available, true);
    assert.equal(Buffer.from(status.publicKey, 'base64url').length, 65, 'the service key, made at first use');
    const done = await post('/api/notifications/subscribe', { subscription: SUBSCRIPTION });
    assert.equal(done.status, 200);
    assert.deepEqual(await done.json(), { ok: true, devices: 1 });
    assert.deepEqual(r.store.subscriptions().map((s) => [s.endpoint, s.device]), [[SUBSCRIPTION.endpoint, r.store.subscriptions()[0].device]]);
    assert.match(r.store.subscriptions()[0].device, /^iPhone · /);
    assert.equal(r.records.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(r.records[0].detail)), ['gesture', 'result', 'device']);
    assert.doesNotMatch(r.records[0].detail, /googleapis|dev-1|p256dh/, 'the ledger never gets the address or the keys');
    assert.equal((await post('/api/notifications/unsubscribe', { endpoint: SUBSCRIPTION.endpoint })).status, 200);
    assert.equal(r.store.subscriptions().length, 0);
  } finally { await r.close(); }
});

test('only a known push service is kept: an address of anyone\'s choosing is refused', async () => {
  const r = await rig();
  try {
    const { post } = await r.signIn();
    for (const endpoint of ['https://evil.example/collect', 'http://fcm.googleapis.com/x', 'https://127.0.0.1:8788/x', 'https://fcm.googleapis.com.evil.example/x']) {
      const response = await post('/api/notifications/subscribe', { subscription: { ...SUBSCRIPTION, endpoint } });
      assert.equal(response.status, 400, endpoint);
      assert.deepEqual(await response.json(), { error: 'subscription' });
    }
    assert.equal((await post('/api/notifications/subscribe', { subscription: { endpoint: SUBSCRIPTION.endpoint, keys: { p256dh: 'x', auth: 'y' } } })).status, 400);
    assert.equal(r.store.subscriptions().length, 0);
  } finally { await r.close(); }
  const own = await rig({ notify: { push_hosts: 'push.example.org' } });
  try {
    const { post } = await own.signIn();
    assert.equal((await post('/api/notifications/subscribe', { subscription: { ...SUBSCRIPTION, endpoint: 'https://push.example.org/x' } })).status, 200, '[notify] push_hosts adds one');
  } finally { await own.close(); }
});

test('without Web Push in [notify] adapters, or without notifications at all, the app offers nothing and keeps nothing', async () => {
  const off = await rig({ notify: { adapters: 'ntfy' } });
  try {
    const { cookie, post } = await off.signIn();
    assert.deepEqual(await (await off.call('/api/notifications', { headers: { cookie } })).json(), { available: false, reason: 'off', publicKey: null, devices: 0 });
    assert.equal((await post('/api/notifications/subscribe', { subscription: SUBSCRIPTION })).status, 409);
  } finally { await off.close(); }
  const none = await rig({ withNotifications: false });
  try {
    const { post } = await none.signIn();
    assert.equal((await post('/api/notifications/subscribe', { subscription: SUBSCRIPTION })).status, 503);
  } finally { await none.close(); }
});

test('the app server sends nothing itself: no network call in the notification code it runs', () => {
  for (const path of ['app/lib/notifications.mjs', 'app/server.mjs']) {
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
    assert.notEqual(spawnSync('sudo', ['-n', '-u', agentUser, '--', 'test', '-r', path]).status, 0, `${path} must not be readable by ${agentUser}`);
    assert.notEqual(spawnSync('sudo', ['-n', '-u', agentUser, '--', 'test', '-w', path]).status, 0, `${path} must not be writable by ${agentUser}`);
  }
});
