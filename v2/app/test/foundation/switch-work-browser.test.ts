// What a switch costs the page beyond drawing the next screen (lane
// j3-tab-perf, P223), in a real browser on the fixtures source, over the
// budget's lap through two sessions (switch-budget.ts, LAP_TWO): once each
// screen was drawn,
//   - no switch builds an Intl number formatter (each is built once for its
//     language and options, lib/i18n.ts);
//   - none reads the notification permission, a call into the browser
//     (the sidebar's bell reads what the browser can do once per answer of
//     the service, shell/NotifyButton.tsx);
//   - the Lead, whose stream says its state and plans again each time the
//     screen opens it, asks no new read of the inbox (screens/lead/model.ts,
//     inboxNews);
//   - the shell gives the window its scroll back once the next screen's
//     sheets are on, so the layout that scroll forces is the frame's one
//     (shell/App.tsx).
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/foundation/switch-work-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';
import { LAP_TWO, PROBE, switchRun } from '../switch-budget.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
declare const window: any;

// Installed before the page's scripts: counters on the formatters, the
// permission and the window's scroll, read once the lap is counted.
const WATCH = `(() => {
  if (window.top !== window) return;
  const seen = { numbers: 0, relative: 0, permission: 0, scrolls: [] };
  window.__work = seen;
  for (const [name, key] of [['NumberFormat', 'numbers'], ['RelativeTimeFormat', 'relative']]) {
    const Real = Intl[name];
    Intl[name] = new Proxy(Real, {
      construct(target, args) { seen[key] += 1; return Reflect.construct(target, args); },
      apply(target, self, args) { seen[key] += 1; return Reflect.apply(target, self, args); },
    });
  }
  const permission = Object.getOwnPropertyDescriptor(Notification, 'permission');
  if (permission && permission.get) {
    Object.defineProperty(Notification, 'permission', { configurable: true, get() { seen.permission += 1; return permission.get.call(this); } });
  }
  const scrollTo = window.scrollTo;
  window.scrollTo = function (...args) {
    const path = location.pathname;
    const screen = path === '/' ? 'tower' : path.startsWith('/sessions') ? 'session' : path.split('/')[1];
    const on = [...document.querySelectorAll('link[rel="stylesheet"][data-screens]')]
      .filter((link) => link.media === 'all').flatMap((link) => link.dataset.screens.split(' '));
    seen.scrolls.push({ path, sheets: on.includes(screen) });
    return scrollTo.apply(this, args);
  };
})();`;

test('once each screen was drawn, a switch builds no formatter, reads no permission, asks the Lead\'s inbox nothing, and scrolls on its own sheets', { skip }, async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  const errors: string[] = [];
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });
    await context.addInitScript(PROBE);
    await context.addInitScript(WATCH);
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.locator('#tower-body .tower').waitFor();
    // The bell is drawn once the service has said what it offers.
    await page.waitForFunction(() => window.__work.permission > 0, undefined, { timeout: 10_000 }).catch(() => {});
    const inbox: string[] = [];
    let counting = false;
    page.on('request', (request: { url(): string }) => {
      const url = new URL(request.url());
      if (counting && url.pathname === '/api/service/inbox') inbox.push(url.pathname);
    });
    const run = await switchRun(page, LAP_TWO.length * 2, async () => {
      // Each screen was drawn once: from here on, the lap is counted.
      await page.evaluate(() => { Object.assign(window.__work, { numbers: 0, relative: 0, permission: 0, scrolls: [] }); });
      counting = true;
    }, LAP_TWO);
    counting = false;
    const work = await page.evaluate(() => window.__work);
    assert.equal(run.times.length, LAP_TWO.length * 2);
    assert.deepEqual({ numbers: work.numbers, relative: work.relative }, { numbers: 0, relative: 0 }, 'no formatter built');
    assert.equal(work.permission, 0, 'the notification permission is not read again');
    assert.deepEqual(inbox, [], 'the Lead\'s visits ask no new read of the inbox');
    assert.ok(work.scrolls.length >= LAP_TWO.length * 2, `the scroll is given back at each switch: ${work.scrolls.length}`);
    assert.deepEqual(work.scrolls.filter((s: { sheets: boolean }) => !s.sheets), [], 'each scroll is given back once the screen\'s sheets are on');
    await context.close();
  } finally {
    await browser.close();
    await app.close();
  }
  assert.deepEqual(errors, []);
});
