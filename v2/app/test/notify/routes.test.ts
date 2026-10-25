// The app's notification routes (milestone 2 plan, section 6): the status,
// subscribe and unsubscribe, with the password session, the anti-forgery
// token and the app's origin, no passkey. The subscriptions go to
// lib/notify/store.mjs's private directory, which the service's dispatcher
// reads; the app sends nothing itself.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceName, notificationsFrom, secureOrigin } from '../../src/notifications.ts';
import { signedIn, startApp, type Running } from '../support.ts';

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

// A [notify] section in a project's agents.conf, and the service's
// environment, as the app reads them.
function setting(notify: Record<string, string> = {}, env: Record<string, string> = {}): { env: NodeJS.ProcessEnv; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'cleared-v2-notify-'));
  roots.push(root);
  const dir = join(root, 'notify');
  const lines = Object.entries({ secrets_dir: dir, vapid_subject: 'mailto:ops@example.invalid', ...notify }).map(([key, value]) => `${key} = ${value}`);
  writeFileSync(join(root, 'agents.conf'), `[notify]\n${lines.join('\n')}\n`);
  return { env: { CLEARED_CONF: join(root, 'agents.conf'), ...env }, dir };
}

const browserKeys = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.from('fedcba9876543210').toString('base64url') };
};
const device = (n: number, host = 'fcm.googleapis.com') => ({ endpoint: `https://${host}/fcm/send/device-${n}`, keys: browserKeys() });

type Browser = { cookie: string; csrf: string };
async function post(app: Running, browser: Partial<Browser>, path: string, body: unknown, over: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: app.origin, 'sec-fetch-site': 'same-origin', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15' };
  if (browser.cookie) headers.cookie = browser.cookie;
  if (browser.csrf) headers['x-csrf-token'] = browser.csrf;
  const response = await fetch(`${app.base}${path}`, { method: 'POST', headers: { ...headers, ...over }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}
async function status(app: Running, cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${app.base}/api/notifications`, { headers: { cookie } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
const stored = (dir: string) => JSON.parse(readFileSync(join(dir, 'subscriptions.json'), 'utf8')) as { endpoint: string; device: string }[];

test('the status says notifications can be used, with the public key and the number of devices; the keys are made on first use, in a 0700 directory', async () => {
  const { env, dir } = setting();
  const app = await startApp({ extra: { notifications: notificationsFrom(env) } });
  try {
    assert.equal(existsSync(dir), false, 'nothing is made before the first call');
    const signed = await signedIn(app);
    const answer = await status(app, signed.cookie);
    assert.equal(answer.status, 200);
    assert.equal(answer.body.available, true);
    assert.equal(answer.body.reason, null);
    assert.match(String(answer.body.publicKey), /^[A-Za-z0-9_-]{87}$/);
    assert.equal(answer.body.devices, 0);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'vapid.json')).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(answer.body).includes('privateKey'), false, 'the private key never leaves the store');
  } finally {
    await app.close();
  }
});

test('a subscription without the session, without the anti-forgery token, with another token or from another origin is refused, and nothing is stored', async () => {
  const { env, dir } = setting();
  const app = await startApp({ extra: { notifications: notificationsFrom(env) } });
  try {
    const signed = await signedIn(app);
    const body = { subscription: device(1) };
    assert.equal((await post(app, {}, '/api/notifications/subscribe', body)).status, 401, 'no session');
    assert.equal((await post(app, { cookie: signed.cookie }, '/api/notifications/subscribe', body)).status, 403, 'no token');
    assert.equal((await post(app, { cookie: signed.cookie, csrf: 'f'.repeat(64) }, '/api/notifications/subscribe', body)).status, 403, 'another token');
    assert.equal((await post(app, signed, '/api/notifications/subscribe', body, { origin: 'http://elsewhere.example.invalid' })).status, 403, 'another origin');
    assert.equal((await post(app, signed, '/api/notifications/subscribe', body, { 'sec-fetch-site': 'cross-site' })).status, 403, 'a cross-site request');
    assert.equal((await post(app, signed, '/api/notifications/unsubscribe', { endpoint: body.subscription.endpoint }, { origin: 'http://elsewhere.example.invalid' })).status, 403, 'unsubscribe too');
    assert.equal(existsSync(join(dir, 'subscriptions.json')), false);
    const read = await fetch(`${app.base}/api/notifications`);
    assert.equal(read.status, 401, 'the status needs the session too');
  } finally {
    await app.close();
  }
});

test('a subscription to a host that is not a known push service is refused, unless CLEARED_NOTIFY_PUSH_HOSTS names it', async () => {
  const strict = setting();
  const app = await startApp({ extra: { notifications: notificationsFrom(strict.env) } });
  try {
    const signed = await signedIn(app);
    for (const subscription of [
      device(1, 'push.example.invalid'),
      { ...device(2), endpoint: 'http://fcm.googleapis.com/fcm/send/x' },
      { ...device(3), endpoint: 'https://fcm.googleapis.com:8443/fcm/send/x' },
      { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'short', auth: 'short' } },
      'not an object',
    ]) {
      const answer = await post(app, signed, '/api/notifications/subscribe', { subscription });
      assert.equal(answer.status, 400, JSON.stringify(subscription));
      assert.equal(answer.body.error, 'subscription');
    }
    assert.equal((await post(app, signed, '/api/notifications/subscribe', '{not json')).status, 400);
    assert.equal(existsSync(join(strict.dir, 'subscriptions.json')), false);
  } finally {
    await app.close();
  }
  const own = setting({}, { CLEARED_NOTIFY_PUSH_HOSTS: 'push.example.invalid' });
  const second = await startApp({ extra: { notifications: notificationsFrom(own.env) } });
  try {
    const signed = await signedIn(second);
    const answer = await post(second, signed, '/api/notifications/subscribe', { subscription: device(1, 'push.example.invalid') });
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body, { ok: true, devices: 1 });
    assert.deepEqual(stored(own.dir).map((s) => s.endpoint), ['https://push.example.invalid/fcm/send/device-1']);
  } finally {
    await second.close();
  }
});

test('the eleventh device pushes out the oldest; the same browser subscribing again counts once; unsubscribe forgets one', async () => {
  const { env, dir } = setting();
  const app = await startApp({ extra: { notifications: notificationsFrom(env) } });
  try {
    const signed = await signedIn(app);
    const devices = Array.from({ length: 11 }, (_, n) => device(n + 1));
    for (const [n, subscription] of devices.entries()) {
      const answer = await post(app, signed, '/api/notifications/subscribe', { subscription });
      assert.equal(answer.status, 200);
      assert.equal(answer.body.devices, Math.min(n + 1, 10));
    }
    assert.deepEqual(stored(dir).map((s) => s.endpoint), devices.slice(1).map((s) => s.endpoint), 'the first one went');
    assert.equal(stored(dir)[0]?.device, 'alex · Mac', 'the device is named by its user and platform only');
    assert.equal((await post(app, signed, '/api/notifications/subscribe', { subscription: devices[5] })).body.devices, 10);
    const gone = await post(app, signed, '/api/notifications/unsubscribe', { endpoint: devices[5]?.endpoint });
    assert.deepEqual(gone.body, { ok: true, removed: true, devices: 9 });
    const again = await post(app, signed, '/api/notifications/unsubscribe', { endpoint: devices[5]?.endpoint });
    assert.deepEqual(again.body, { ok: true, removed: false, devices: 9 });
    assert.equal((await post(app, signed, '/api/notifications/unsubscribe', { endpoint: 42 })).status, 400);
    assert.equal((await status(app, signed.cookie)).body.devices, 9);
  } finally {
    await app.close();
  }
});

test('a store directory looser than 0700 is refused, never repaired: the status says why and nothing is written', async () => {
  const { env, dir } = setting();
  const app = await startApp({ extra: { notifications: notificationsFrom(env) } });
  try {
    const signed = await signedIn(app);
    assert.equal((await status(app, signed.cookie)).body.available, true);
    chmodSync(dir, 0o755);
    const answer = await status(app, signed.cookie);
    assert.deepEqual(answer.body, { available: false, reason: 'store', publicKey: null, devices: 0 });
    const refused = await post(app, signed, '/api/notifications/subscribe', { subscription: device(1) });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error, 'store');
    assert.equal(statSync(dir).mode & 0o777, 0o755, 'left as it is');
    assert.equal(existsSync(join(dir, 'subscriptions.json')), false);
  } finally {
    await app.close();
  }
});

// A request that arrives through a proxy on this machine names the proxy's
// host, which the app accepts only when CLEARED_V2_APP_ORIGIN says so.
function through(app: Running, host: string, cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: new URL(app.base).port, path: '/api/notifications', headers: { host, cookie } }, (response) => {
      let text = '';
      response.setEncoding('utf8').on('data', (chunk: string) => { text += chunk; }).on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }));
    }).on('error', reject).end();
  });
}

test('the status answers insecure on a plain http address other than this machine, and is available on loopback and https', async () => {
  const plain = setting();
  const app = await startApp({ extra: { notifications: notificationsFrom(plain.env), publicOrigin: 'http://box.example.invalid:8443' } });
  try {
    const signed = await signedIn(app);
    assert.deepEqual((await through(app, 'box.example.invalid:8443', signed.cookie)).body, { available: false, reason: 'insecure', publicKey: null, devices: 0 });
    assert.equal((await status(app, signed.cookie)).body.available, true, 'the same app read on 127.0.0.1');
    const subscribe = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({ subscription: device(1) });
      request({ host: '127.0.0.1', port: new URL(app.base).port, path: '/api/notifications/subscribe', method: 'POST', headers: {
        host: 'box.example.invalid:8443', origin: 'http://box.example.invalid:8443', cookie: signed.cookie, 'x-csrf-token': signed.csrf, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)),
      } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); }).on('error', reject).end(body);
    });
    assert.equal(subscribe, 409, 'nothing is subscribed from an insecure address');
  } finally {
    await app.close();
  }
  const secure = setting();
  const proxied = await startApp({ extra: { notifications: notificationsFrom(secure.env), publicOrigin: 'https://box.example.invalid:8443' } });
  try {
    const signed = await signedIn(proxied);
    assert.equal((await through(proxied, 'box.example.invalid:8443', signed.cookie)).body.available, true);
  } finally {
    await proxied.close();
  }
  for (const [origin, secureEnough] of [
    ['http://127.0.0.1:8792', true], ['http://localhost:8792', true], ['http://[::1]:8792', true], ['https://box.example.invalid:8443', true],
    ['http://box.example.invalid:8443', false], ['http://10.0.0.2:8792', false], ['null', false], ['not an address', false],
  ] as const) assert.equal(secureOrigin(origin), secureEnough, origin);
});

test('the status says why when the service cannot send Web Push: another adapter, no subject, a broken setting', async () => {
  const cases: [Record<string, string>, Record<string, string>, string][] = [
    [{ adapters: 'ntfy' }, {}, 'off'],
    [{ adapters: 'none' }, {}, 'off'],
    [{ vapid_subject: '' }, {}, 'no_subject'],
    [{ adapters: 'carrier-pigeon' }, {}, 'config'],
  ];
  for (const [notify, extra, reason] of cases) {
    const { env, dir } = setting(notify, extra);
    const app = await startApp({ extra: { notifications: notificationsFrom(env) } });
    try {
      const signed = await signedIn(app);
      assert.deepEqual((await status(app, signed.cookie)).body, { available: false, reason, publicKey: null, devices: 0 }, JSON.stringify(notify));
      const refused = await post(app, signed, '/api/notifications/subscribe', { subscription: device(1) });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error, reason);
      assert.equal(existsSync(dir), false, 'nothing made when nothing can be sent');
    } finally {
      await app.close();
    }
  }
  // The subject may come from the app's https address instead.
  const linked = setting({ vapid_subject: '' }, { CLEARED_NOTIFY_LINK_BASE: 'https://box.example.invalid:8443' });
  const app = await startApp({ extra: { notifications: notificationsFrom(linked.env) } });
  try {
    assert.equal((await status(app, (await signedIn(app)).cookie)).body.available, true);
  } finally {
    await app.close();
  }
});

test('a device is named by its platform, never by its full user agent', () => {
  assert.equal(deviceName('alex', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'), 'alex · iPhone');
  assert.equal(deviceName('alex', 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)'), 'alex · iPad');
  assert.equal(deviceName('alex', 'Mozilla/5.0 (Linux; Android 15; Pixel 9)'), 'alex · Android');
  assert.equal(deviceName('alex', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'alex · Windows');
  assert.equal(deviceName('alex', 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/140.0'), 'alex · Linux');
  assert.equal(deviceName('alex', undefined), 'alex · browser');
  assert.ok(deviceName('a'.repeat(60), 'x').length <= 40);
});
