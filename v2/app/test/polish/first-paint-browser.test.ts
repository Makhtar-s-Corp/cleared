// The first screen is drawn styled on a slow link (review of 248, F1; lane
// 38): with every screen's sheet held back 800 ms, the first time the shell
// draws a screen into #screen, that screen's sheets are on and loaded.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/polish/first-paint-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
declare const document: any;
declare const window: any;
declare const MutationObserver: any;

// When #screen first gets a child: the sheets of the screen named, each on and loaded or not.
const WATCH = `(() => {
  new MutationObserver((records, observer) => {
    const screen = document.getElementById('screen');
    if (!screen || screen.children.length === 0) return;
    observer.disconnect();
    window.firstDraw = [...document.querySelectorAll('link[rel="stylesheet"][data-screens]')]
      .filter((link) => link.dataset.screens.split(' ').includes(window.firstScreen))
      .map((link) => ({ href: link.getAttribute('href'), on: link.media === 'all', loaded: link.sheet !== null }));
  }).observe(document, { childList: true, subtree: true });
})();`;

test('on a slow link, the first screen is drawn once its sheets are on and loaded', { skip }, async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    for (const [path, screen] of [['/sessions', 'session'], ['/lead', 'lead']] as const) {
      const fresh = await context.newPage();
      await fresh.addInitScript(`window.firstScreen = ${JSON.stringify(screen)};`);
      await fresh.addInitScript(WATCH);
      // Every sheet but the shell's own arrives 800 ms late, as on a slow link.
      const entry = await page.evaluate(() => [...document.querySelectorAll('link[rel="stylesheet"]:not([data-screens])')].map((l: any) => l.getAttribute('href')));
      await fresh.route(/\/assets\/[^/]+\.css$/, async (route: any) => {
        if (!entry.some((href: string) => route.request().url().endsWith(href))) await new Promise((r) => setTimeout(r, 800));
        await route.continue();
      });
      await fresh.goto(`${app.base}${path}`);
      await fresh.waitForFunction(() => window.firstDraw !== undefined, undefined, { timeout: 10_000 });
      const drawn = await fresh.evaluate(() => window.firstDraw);
      assert.ok(drawn.length > 0, `${screen} has sheets of its own`);
      for (const sheet of drawn) assert.deepEqual({ on: sheet.on, loaded: sheet.loaded }, { on: true, loaded: true }, `${screen}: ${sheet.href}`);
      await fresh.close();
    }
  } finally {
    await browser.close();
    await app.close();
  }
});
