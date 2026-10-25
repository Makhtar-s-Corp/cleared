// The code an answer cites, in a real browser (P215, issue #331), on the
// fixtures source (fixtures/ask.ts): the /ask/:id screen links each
// citation the service checked to GitHub at the commit the reader read,
// opened in a new tab without the app's page, in English and in French,
// with no horizontal scroll on a phone. No request leaves the app: GitHub
// is answered by the test. With CLEARED_V2_SHOTS set to a folder it writes
// the screen's captures there, at the four widths, light and dark.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/ask/citations-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ASK_CITATIONS, ASK_COMMIT, ASK_ID, FOLLOW_CITATIONS } from '../../fixtures/ask.ts';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const SHOTS = process.env.CLEARED_V2_SHOTS;
declare const document: any;

type Run = { readonly page: any; readonly context: any; readonly away: string[] };

async function withBrowser(options: { language: 'en' | 'fr'; width?: number; height?: number; dark?: boolean }, run: (state: Run) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { language: options.language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({
      viewport: { width: options.width ?? 1440, height: options.height ?? 900 }, colorScheme: options.dark ? 'dark' : 'light',
      locale: options.language === 'fr' ? 'fr-FR' : 'en-US', timezoneId: 'Europe/Paris',
    });
    // The app's theme is its own choice, kept in the page's storage (scripts/capture-screens.ts).
    await context.addInitScript((value: string) => { try { (globalThis as any).localStorage.setItem('cleared-v2-theme', value); } catch { /* no storage */ } }, options.dark ? 'dark' : 'light');
    // Nothing leaves the app: GitHub gets a page of the test's, anything else is aborted and named.
    const away: string[] = [];
    await context.route('**/*', (route: any) => {
      const url: string = route.request().url();
      if (url.startsWith(app.base)) return route.continue();
      away.push(url);
      return url.startsWith('https://github.com/') ? route.fulfill({ status: 200, contentType: 'text/html', body: '<title>GitHub</title>' }) : route.abort();
    });
    const page = await context.newPage();
    await page.clock.install({ time: FIXTURE_NOW });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.goto(`${app.base}/ask/${ASK_ID}`);
    await page.locator('.answer-text a.citation').first().waitFor();
    await run({ page, context, away });
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

const links = (page: any) => page.evaluate(() => [...document.querySelectorAll('.answer-text a.citation')].map((a: any) => ({
  text: a.textContent, href: a.href, target: a.target, rel: a.rel, title: a.title,
})));
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
// The turns, where the links are.
const shot = async (page: any, name: string) => { if (SHOTS) await page.locator('.turns').screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled', caret: 'hide' }); };

test('each citation is a GitHub link to the commit the reader read, and opens in a tab of its own', { skip }, async () => {
  await withBrowser({ language: 'en' }, async ({ page, context, away }) => {
    const short = ASK_COMMIT.slice(0, 7);
    assert.deepEqual(await links(page), [...ASK_CITATIONS, ...FOLLOW_CITATIONS].map((c) => ({
      text: c.text, href: c.url, target: '_blank', rel: 'noopener noreferrer', title: `Open on GitHub at commit ${short}`,
    })));
    const [tab] = await Promise.all([context.waitForEvent('page'), page.locator('.answer-text a.citation').first().click()]);
    await tab.waitForLoadState();
    assert.equal(tab.url(), ASK_CITATIONS[0]?.url, 'the commit and the line, as the service built them');
    assert.equal(await tab.evaluate(() => (globalThis as any).opener), null, 'the tab cannot reach the app\'s page');
    assert.equal(page.url().endsWith(`/ask/${ASK_ID}`), true, 'the screen stays where it was');
    assert.deepEqual(away, [ASK_CITATIONS[0]?.url?.replace(/#.*$/, '')], 'the one request that left the app is the click\'s, its lines a fragment the browser keeps');
    assert.ok(await noOverflow(page));
  });
});

test('in French, and on a phone without a horizontal scroll', { skip }, async () => {
  await withBrowser({ language: 'fr', width: 390, height: 844 }, async ({ page, away }) => {
    const found = await links(page);
    assert.equal(found.length, ASK_CITATIONS.length + FOLLOW_CITATIONS.length);
    assert.ok(found.every((link: { title: string }) => link.title === `Ouvrir sur GitHub au commit ${ASK_COMMIT.slice(0, 7)}`));
    assert.ok(await noOverflow(page), 'no horizontal scroll at 390');
    assert.deepEqual(away, []);
  });
});

// Defined only when captures are asked for: the browser job of CI fails on a skipped test.
if (SHOTS) test('the screen\'s captures, at each width in each theme', { skip }, async () => {
  const sizes = { 1440: [1440, 900], 1280: [1280, 800], 768: [768, 1024], 390: [390, 844] } as const;
  for (const dark of [false, true]) {
    for (const [width, [w, h]] of Object.entries(sizes)) {
      await withBrowser({ language: 'en', width: w, height: h, dark }, async ({ page }) => {
        await page.locator('.answer-text a.citation').first().hover();
        await shot(page, `code-qa-links-en-${width}-${dark ? 'dark' : 'light'}`);
      });
    }
  }
  for (const width of [1440, 390] as const) {
    await withBrowser({ language: 'fr', width: sizes[width][0], height: sizes[width][1] }, async ({ page }) => shot(page, `code-qa-links-fr-${width}-light`));
  }
});
