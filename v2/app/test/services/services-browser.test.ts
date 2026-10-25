// The service map in a real browser (milestone 4, section 11), on the
// fixtures source, which serves the example workspace's map read by the
// service's own code: it opens from the tower's line of services and from
// the G M chord without a reload; a service picked by the keyboard shows
// its impact; Refresh asks the service again; on a phone the page does not
// scroll sideways. With CLEARED_V2_SHOTS set to a folder it writes the
// screen's captures there.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/services/services-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW, towerSource } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const SHOTS = process.env.CLEARED_V2_SHOTS;
declare const document: any;

async function withBrowser(options: { language: 'en' | 'fr'; width?: number; theme?: 'light' | 'dark' }, run: (page: any, base: string) => Promise<void>): Promise<void> {
  // The tower's source draws the workspace of two services, whose line has the map's link; the rest is the fixtures'.
  const app = await startApp({ source: towerSource(() => FIXTURE_NOW, await fixtureSource({ now: () => FIXTURE_NOW })), extra: { language: options.language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({
      viewport: { width: options.width ?? 1440, height: 900 }, locale: options.language === 'fr' ? 'fr-FR' : 'en-US', timezoneId: 'Europe/Paris',
    });
    // The app's theme is the person's choice, kept by the page, not the system's (as the accessibility pass sets it).
    await context.addInitScript(`try { localStorage.setItem('cleared-v2-theme', '${options.theme ?? 'light'}'); } catch {}`);
    const page = await context.newPage();
    await page.clock.install({ time: FIXTURE_NOW });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.locator('#tower-body .tower').waitFor();
    await run(page, app.base);
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = async (page: any, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

test('the map opens from the tower and from G M without a reload, and draws the example workspace', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page) => {
    await page.evaluate(() => { (window as any).__kept = 'same document'; });
    await page.locator('#services-open').click();
    await page.locator('.services-grid').waitFor();
    assert.equal(await page.evaluate(() => location.pathname), '/services');
    assert.equal(await page.evaluate(() => (window as any).__kept), 'same document', 'client routing: no document load');
    assert.equal(await page.locator('h1').innerText(), 'Service map');
    assert.equal(await page.locator('svg.map-svg[role="img"]').count(), 1);
    assert.equal(await page.locator('.map-box[data-box="service"]').count(), 2);
    assert.equal(await page.locator('[data-link]').count(), 2);
    assert.match(await page.locator('[data-link="call:guestbook:filter-api"]').innerText(), /guestbook calls filter-api: POST \/check/);
    assert.ok(await noOverflow(page), 'no horizontal scroll');
    await shot(page, 'services-en-1440-light');

    await page.locator('.nav-item[data-nav="tower"]').click();
    await page.locator('#tower-body .tower').waitFor();
    await page.keyboard.press('g');
    await page.keyboard.press('m');
    await page.locator('.services-grid').waitFor();
    assert.equal(await page.evaluate(() => (window as any).__kept), 'same document');
  });
});

test('a service picked by the keyboard shows its impact; Refresh asks the service again', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page, base) => {
    await page.goto(`${base}/services`);
    await page.locator('.services-grid').waitFor();
    await page.locator('[data-service="filter-api"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('.services-impact [data-impact]').first().waitFor();
    assert.equal(await page.locator('[data-service="filter-api"]').getAttribute('aria-pressed'), 'true');
    const impact: string = await page.locator('.services-impact').innerText();
    assert.match(impact, /If filter-api changes/);
    assert.match(impact, /guestbook calls it: POST \/check/);
    assert.match(impact, /Landing order: filter-api, then guestbook/);
    await shot(page, 'services-en-impact');
    await page.locator('#services-refresh').click();
    await page.locator('#services-refresh:not([disabled])').waitFor();
    assert.equal(await page.locator('.services-note').count(), 0, 'no refusal');
  });
});

test('in French, dark, every word is French', { skip }, async () => {
  await withBrowser({ language: 'fr', theme: 'dark' }, async (page, base) => {
    await page.goto(`${base}/services`);
    await page.locator('.services-grid').waitFor();
    const text: string = await page.evaluate(() => document.querySelector('.services').innerText);
    assert.match(text, /Carte des services/);
    assert.match(text, /guestbook appelle filter-api\s:\sPOST \/check/);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, 'no ISO time');
    await shot(page, 'services-fr-1440-dark');
  });
});

for (const [width, theme] of [[1280, 'light'], [768, 'light'], [390, 'light'], [1280, 'dark'], [768, 'dark'], [390, 'dark']] as const) {
  test(`at ${width} px, ${theme}, the page does not scroll sideways, and the list of links is there`, { skip }, async () => {
    await withBrowser({ language: 'en', width, theme }, async (page, base) => {
      await page.goto(`${base}/services`);
      await page.locator('.services-grid').waitFor();
      assert.ok(await noOverflow(page), `no horizontal scroll at ${width} px`);
      assert.equal(await page.locator('[data-link]').count(), 2);
      if (width === 390) {
        const height = await page.locator('[data-service="guestbook"]').evaluate((el: any) => el.getBoundingClientRect().height);
        assert.ok(height >= 44, `a service button is ${height}px high`);
      }
      await shot(page, `services-en-${width}-${theme}`);
    });
  });
}
