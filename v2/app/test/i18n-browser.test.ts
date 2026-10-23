// The language in a real browser (the owner's request of 2026-10-23,
// 08:40, lane i18n), on the fixtures source, the app's setting French:
//   - a browser in English gets the sign-in page and the app in English;
//   - the account menu's Français redraws the whole app in French in the
//     page (one document, no reload), and the choice survives a reload and
//     a screen change: kept in this browser and in the server's cookie;
//   - a browser in neither language gets the setting, French.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/i18n-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixtureSource } from '../fixtures/source.ts';
import { FIXTURE_NOW } from '../fixtures/tower.ts';
import { PASSWORD, startApp } from './support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
declare const document: any;
declare const window: any;
declare const performance: any;
declare const localStorage: any;

async function withBrowser(locale: string, run: (page: any, base: string) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { language: 'fr' } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale })).newPage();
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await run(page, app.base);
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

async function signIn(page: any, base: string): Promise<void> {
  await page.fill('#name', 'owner');
  await page.fill('#password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL(`${base}/`);
  await page.locator('#tower-body .tower').waitFor();
}

const lang = (page: any): Promise<string> => page.evaluate(() => document.documentElement.lang);
const nav = (page: any, screen: string): Promise<string> => page.locator(`.nav-item[data-nav="${screen}"] .nav-label`).innerText();

test('a browser in English gets English; Français in the account menu redraws the app in French in the page, and the choice stays', { skip }, async () => {
  await withBrowser('en-US', async (page, base) => {
    await page.goto(`${base}/login`);
    assert.equal(await lang(page), 'en', 'the sign-in page in the browser\'s language');
    await signIn(page, base);
    assert.equal(await lang(page), 'en');
    assert.equal(await nav(page, 'inbox'), 'Inbox');
    await page.evaluate(() => { window.sameDocument = true; });

    await page.click('#person');
    await page.locator('#language').waitFor();
    assert.equal(await page.locator('#language [data-language="en"]').getAttribute('aria-pressed'), 'true');
    const switched = Date.now();
    await page.click('#language [data-language="fr"]');
    await page.waitForFunction(() => document.documentElement.lang === 'fr');
    await page.locator('.nav-item[data-nav="inbox"] .nav-label', { hasText: 'Réception' }).waitFor();
    const took = Date.now() - switched;
    assert.equal(await page.evaluate(() => window.sameDocument), true, 'no reload');
    assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), 1);
    assert.match(await page.locator('#tower-body').innerText(), /Sessions en cours/, 'the screen redrawn in French too');
    assert.equal(await page.evaluate(() => localStorage.getItem('cleared.language')), 'fr');
    assert.ok((await page.context().cookies()).some((cookie: { name: string; value: string }) => cookie.name === 'cleared_lang' && cookie.value === 'fr'));
    assert.ok(took < 2000, `the switch took ${took} ms`);

    await page.keyboard.press('Escape');
    await page.click('.nav-item[data-nav="inbox"]');
    await page.locator('#screen .inbox').waitFor();
    assert.match(await page.locator('#screen').innerText(), /En attente/);
    await page.reload();
    await page.locator('#screen .inbox').waitFor();
    assert.equal(await lang(page), 'fr', 'the choice survives a reload');
    assert.equal(await nav(page, 'inbox'), 'Réception');

    // The cookie lost (another browser profile's sync, a cleared site): this browser's choice is told again.
    await page.context().clearCookies({ name: 'cleared_lang' });
    await page.reload();
    await page.locator('#screen .inbox').waitFor();
    assert.equal(await nav(page, 'inbox'), 'Réception');
    assert.ok((await page.context().cookies()).some((cookie: { name: string; value: string }) => cookie.name === 'cleared_lang' && cookie.value === 'fr'));
  });
});

test('a browser in neither language gets the app\'s setting, French', { skip }, async () => {
  await withBrowser('de-DE', async (page, base) => {
    await page.goto(`${base}/login`);
    assert.equal(await lang(page), 'fr');
    await signIn(page, base);
    assert.equal(await nav(page, 'inbox'), 'Réception');
  });
});
