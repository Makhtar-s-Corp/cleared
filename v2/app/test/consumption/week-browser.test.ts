// The week's figures on the Consumption screen in a real browser (C17, issue
// #396), on the fixtures source with its week (fixtures/consumption.ts,
// `week`), read by the service's own weekFigures() through its route: the
// tickets merged, the tokens and the agents' time, no dollar figure since
// Codex reports none, the estimates against what they took, a row per
// service; in English and in French, and no horizontal scroll at any width.
// With CLEARED_V2_SHOTS set to a folder it writes the panel's captures there,
// at 1440, 1280, 768 and 390 pixels, light and dark.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/consumption/week-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixtureSource } from '../../fixtures/source.ts';
import { sidebarMode } from '../../web/shell/model.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const SHOTS = process.env.CLEARED_V2_SHOTS;
declare const document: any;
declare const window: any;

async function withBrowser(options: { language: 'en' | 'fr' }, run: (page: any) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW, week: true }), extra: { language: options.language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: options.language === 'fr' ? 'fr-FR' : 'en-US', timezoneId: 'Europe/Paris' });
    // The page's answer to a width's media queries held 500 ms, as a slow
    // runner's is: the style moves at once, the shell's sidebar mode after.
    await context.addInitScript(() => {
      const proto = (window as any).MediaQueryList.prototype;
      const add = proto.addEventListener;
      const remove = proto.removeEventListener;
      const late = new WeakMap<object, (event: unknown) => void>();
      const lateOf = (listener: (event: unknown) => void) => {
        if (!late.has(listener)) late.set(listener, (event: unknown) => setTimeout(() => listener(event), 500));
        return late.get(listener);
      };
      proto.addEventListener = function (this: unknown, type: string, listener: (event: unknown) => void, ...rest: unknown[]) {
        return add.call(this, type, type === 'change' ? lateOf(listener) : listener, ...rest);
      };
      proto.removeEventListener = function (this: unknown, type: string, listener: (event: unknown) => void, ...rest: unknown[]) {
        return remove.call(this, type, type === 'change' ? lateOf(listener) : listener, ...rest);
      };
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
    await page.goto(`${app.base}/consumption`);
    await page.locator('[data-week="shown"]').waitFor();
    await run(page);
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

// The table's rows as their cells say them, the spaces plain.
const rows = async (page: any) => ((await page.locator('.week-table tbody tr').allInnerTexts()) as string[]).map((row) => row.split('\t').map((cell) => cell.replace(/\s+/g, ' ').trim()));
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
// A width, measured once the shell has drawn its sidebar for it.
const resize = async (page: any, width: number, height: number) => {
  await page.setViewportSize({ width, height });
  await page.locator(`.app[data-sidebar="${sidebarMode(null, width)}"]`).waitFor();
};
const shot = async (page: any, name: string) => { if (SHOTS) await page.locator('[data-week]').screenshot({ path: join(SHOTS, `${name}.png`) }); };
const plain = (text: string) => text.replace(/\s+/g, ' ').trim();

test('the week\'s figures as the ledger holds them: what merged, what it took, per service, at every width and in both themes', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page) => {
    assert.equal(await page.locator('#week-title').innerText(), 'This week');
    const facts = plain(await page.locator('.week-facts').innerText());
    assert.match(facts, /3 tickets merged/);
    assert.match(facts, /tokens used/);
    assert.match(facts, /of agent work/);
    assert.match(plain(await page.locator('[data-week-dollars]').innerText()), /^No dollar figure: an agent reported none this week/);
    assert.deepEqual((await page.locator('[data-week-ticket]').evaluateAll((items: any[]) => items.map((item) => item.dataset.weekTicket))), ['LOCAL-2', 'LOCAL-3', 'LOCAL-4']);
    assert.match(plain(await page.locator('[data-week-ticket="LOCAL-2"]').innerText()), /estimated 30 min, took 42 min/);
    assert.deepEqual((await rows(page)).map((row) => [row[0], row[1], row.at(-1)]), [
      ['guestbook', '2', 'not reported'], ['filter-api', '2', '$1.80'], ['Workspace (lead, questions)', '0', '$0.35'],
    ]);
    for (const width of [1440, 1280, 768, 390]) {
      await resize(page, width, 900);
      assert.ok(await noOverflow(page), `no horizontal scroll at ${width}`);
      for (const theme of ['light', 'dark']) {
        await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
        await shot(page, `week-en-${width}-${theme}`);
      }
    }
  });
});

test('in French the panel is French, and holds on a phone', { skip }, async () => {
  await withBrowser({ language: 'fr' }, async (page) => {
    assert.equal(await page.locator('#week-title').innerText(), 'Cette semaine');
    assert.match(plain(await page.locator('.week-facts').innerText()), /3 tickets fusionnés/);
    assert.deepEqual((await page.locator('.week-table thead th').allInnerTexts()).map((h: string) => h.trim()), ['Service', 'Fusionnés', 'Jetons', 'Temps des agents', 'Dollars']);
    assert.match(plain(await page.locator('[data-week-ticket="LOCAL-2"]').innerText()), /estimé à 30 min, réalisé en 42 min/);
    await resize(page, 390, 844);
    assert.ok(await noOverflow(page), 'no horizontal scroll on a phone');
    await shot(page, 'week-fr-390-light');
    await resize(page, 1440, 900);
    await shot(page, 'week-fr-1440-light');
  });
});
