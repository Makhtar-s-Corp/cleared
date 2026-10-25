// The notifications button in a real browser, on http://127.0.0.1: the
// page registers /sw.js and subscribes, the app stores the subscription,
// and turning it off forgets it. Run only when CLEARED_V2_PLAYWRIGHT names
// the folder of an installed playwright-core (not a dependency of v2), for
// example:
//
//   CLEARED_V2_PLAYWRIGHT=/path/to/node_modules/playwright-core \
//   CLEARED_V2_CHROME=/path/to/chrome node --test app/test/notify/browser.test.ts
//
// Headless Chromium and Chrome refuse a push registration ("Registration
// failed - permission denied", checked on 2026-10-22), so the page's
// PushManager is replaced by an init script that hands out a subscription
// to https://push.example.invalid/..., with real-shaped keys, a host the app
// accepts only because CLEARED_NOTIFY_PUSH_HOSTS names it. Everything else
// is the browser's own: the service worker, the permission, the button.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notificationsFrom } from '../../src/notifications.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

test('a headless browser registers the worker, subscribes through the button, and turns it off', { skip: PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'cleared-v2-notify-browser-'));
  roots.push(root);
  const dir = join(root, 'notify');
  writeFileSync(join(root, 'agents.conf'), `[notify]\nsecrets_dir = ${dir}\nvapid_subject = mailto:ops@example.invalid\n`);
  const app = await startApp({ extra: { notifications: notificationsFrom({ CLEARED_CONF: join(root, 'agents.conf'), CLEARED_NOTIFY_PUSH_HOSTS: 'push.example.invalid' }) } });
  await app.directory.add('alex', PASSWORD);
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: Buffer.from('fedcba9876543210').toString('base64url') };

  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
    await context.grantPermissions(['notifications'], { origin: app.origin });
    await context.addInitScript((shape: { p256dh: string; auth: string }) => {
      let current: unknown = null;
      const made = (endpoint: string) => ({ endpoint, toJSON: () => ({ endpoint, expirationTime: null, keys: shape }), unsubscribe: async () => { current = null; return true; } });
      PushManager.prototype.subscribe = async function (options?: PushSubscriptionOptionsInit) {
        const key = options?.applicationServerKey;
        if (!(key instanceof Uint8Array) || key.length !== 65 || key[0] !== 4) throw new Error('not the service key');
        current = made(`https://push.example.invalid/send/${crypto.randomUUID()}`);
        return current as PushSubscription;
      };
      PushManager.prototype.getSubscription = async function () { return current as PushSubscription | null; };
    }, keys);
    const page = await context.newPage();
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'alex');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);

    await page.waitForSelector('#notify:not([hidden])');
    await page.click('#notify-summary');
    assert.equal(await page.textContent('.notify-state'), 'Off for this device.');
    await page.click('#notify-toggle[data-action=on]');
    await page.waitForSelector('#notify.on');
    assert.equal(await page.getAttribute('#notify-summary', 'aria-label'), 'Notifications: on for this device');
    assert.match(await page.textContent('#notify-menu') ?? '', /1 device is told when something waits for you\./);
    const worker = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/'))?.active?.scriptURL ?? null);
    assert.equal(worker, `${app.base}/sw.js`);
    const stored = JSON.parse(readFileSync(join(dir, 'subscriptions.json'), 'utf8')) as { endpoint: string; keys: unknown; device: string }[];
    assert.equal(stored.length, 1);
    assert.match(stored[0]?.endpoint ?? '', /^https:\/\/push\.example\.invalid\/send\//);
    assert.deepEqual(stored[0]?.keys, keys);
    assert.equal(stored[0]?.device, 'alex · Linux');

    await page.click('#notify-toggle[data-action=off]');
    await page.waitForSelector('#notify:not(.on)');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'subscriptions.json'), 'utf8')), []);
    assert.ok(existsSync(join(dir, 'vapid.json')));
  } finally {
    await browser.close();
    await app.close();
  }
});
