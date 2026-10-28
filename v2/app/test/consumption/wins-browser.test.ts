// The harness pick's wins on the Consumption screen in a real browser (P213,
// issue #329), on the fixtures source, whose ledger holds three picks that
// ended (fixtures/consumption.ts), read by the service's own consumption():
// a row per ticket type and agent, in English and in French, and no
// horizontal scroll on a phone. With CLEARED_V2_SHOTS set to a folder it
// writes the panel's captures there, at 1440, 1280, 768 and 390 pixels, light.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/consumption/wins-browser.test.ts
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
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { language: options.language } });
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
    await page.locator('[data-wins="shown"]').waitFor();
    await run(page);
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

// The table's rows as their cells say them, the spaces plain.
const rows = async (page: any) => ((await page.locator('.wins-table tbody tr').allInnerTexts()) as string[]).map((row) => row.split('\t').map((cell) => cell.replace(/\s+/g, ' ').trim()));
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
// A width, measured once the shell has drawn its sidebar for it: before, the
// style is the new width's and the sidebar's mode the old one's.
const resize = async (page: any, width: number, height: number) => {
  await page.setViewportSize({ width, height });
  await page.locator(`.app[data-sidebar="${sidebarMode(null, width)}"]`).waitFor();
};
const shot = async (page: any, name: string) => { if (SHOTS) await page.locator('[data-wins]').screenshot({ path: join(SHOTS, `${name}.png`) }); };

test('the wins of the harness pick, a row per ticket type and agent, as the ledger holds them, at every width and in both themes', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page) => {
    assert.equal(await page.locator('#wins-title').innerText(), 'Which agent wins');
    assert.deepEqual(await rows(page), [
      ['Bug', 'Claude Code', '2', '2', '1'], ['Bug', 'Codex', '2', '1', '1'],
      ['Other', 'Claude Code', '1', '1', '1'], ['Other', 'Cursor', '1', '0', '0'],
    ]);
    for (const width of [1440, 1280, 768, 390]) {
      await resize(page, width, 900);
      assert.ok(await noOverflow(page), `no horizontal scroll at ${width}`);
      for (const theme of ['light']) {
        await page.evaluate((value: string) => { document.documentElement.dataset.theme = value; }, theme);
        await shot(page, `wins-en-${width}-${theme}`);
      }
    }
  });
});

test('in French the panel is French, and holds on a phone', { skip }, async () => {
  await withBrowser({ language: 'fr' }, async (page) => {
    assert.equal(await page.locator('#wins-title').innerText(), "Quel agent l'emporte");
    assert.deepEqual((await page.locator('.wins-table thead th').allInnerTexts()).map((h: string) => h.trim()), ['Type', 'Agent', 'Lancées', 'Réussies', 'Gardées']);
    assert.equal((await rows(page))[2]?.[0], 'Autre');
    await resize(page, 390, 844);
    assert.ok(await noOverflow(page), 'no horizontal scroll on a phone');
    await shot(page, 'wins-fr-390-light');
    await resize(page, 1440, 900);
    await shot(page, 'wins-fr-1440-light');
  });
});
