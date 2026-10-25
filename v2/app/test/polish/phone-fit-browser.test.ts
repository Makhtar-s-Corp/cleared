// The polish pass on a phone (lane j3-ui-polish, matrix P221), in a real
// browser on the fixtures source, at 375 and 390 pixels, in English and in
// French: the harness pick's wins table keeps each header on one line and
// fits its panel, and
// the title's placeholder of a picked template is not cut by New ticket.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/polish/phone-fit-browser.test.ts
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
declare const getComputedStyle: any;

const WIDTHS = [375, 390] as const;
// The page's own fonts, loaded: a width measured in the fallback font says nothing.
const fontsReady = (page: any) => page.evaluate(() => document.fonts.ready.then(() => undefined));

async function onPhone(language: 'en' | 'fr', width: number, run: (page: any, base: string) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, locale: language === 'fr' ? 'fr-FR' : 'en-US', timezoneId: 'Europe/Paris' });
    const page = await context.newPage();
    await page.clock.install({ time: FIXTURE_NOW });
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await run(page, app.base);
    assert.deepEqual(errors, [], 'no page error');
  } finally {
    await browser.close();
    await app.close();
  }
}

for (const language of ['en', 'fr'] as const) {
  for (const width of WIDTHS) {
    test(`${language} at ${width}: the wins table keeps each header on one line and fits its panel`, { skip }, async () => {
      await onPhone(language, width, async (page, base) => {
        await page.goto(`${base}/consumption`);
        await page.locator('[data-wins="shown"]').waitFor();
        await fontsReady(page);
        const wrapped = await page.locator('.wins-table th').evaluateAll((cells: any[]) => cells.flatMap((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          const lines = new Set([...range.getClientRects()].map((rect: any) => Math.round(rect.top)));
          return lines.size > 1 ? [cell.innerText] : [];
        }));
        assert.deepEqual(wrapped, [], 'no header on two lines');
        // Nor is the table wider than its panel: no column hidden behind a scroll (the art director's pass).
        // The table's own width at its narrowest (min-content), not the 100 % it stretches to.
        const box = await page.locator('.wins-scroll').evaluate((scroll: any) => {
          const table = scroll.querySelector('table');
          table.style.width = 'min-content';
          const needs = Math.ceil(table.getBoundingClientRect().width);
          table.style.width = '';
          return { needs, room: scroll.clientWidth };
        });
        assert.ok(box.needs <= box.room, `the table needs ${box.needs} px, its panel has ${box.room}`);
      });
    });

    test(`${language} at ${width}: a picked template's placeholder is said whole in the title's field`, { skip }, async () => {
      await onPhone(language, width, async (page) => {
        await page.locator('[data-bar="template"]').click();
        await fontsReady(page);
        for (const id of ['bug', 'review', 'ci', 'question']) {
          await page.locator(`[data-template="${id}"]`).click();
          const fit = await page.locator('#ask-input').evaluate((input: any) => {
            const style = getComputedStyle(input);
            const canvas = document.createElement('canvas').getContext('2d');
            canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            return { text: input.placeholder, needs: canvas.measureText(input.placeholder).width, room };
          });
          assert.ok(fit.needs <= fit.room, `"${fit.text}" needs ${Math.ceil(fit.needs)} px, the field has ${Math.floor(fit.room)}`);
        }
      });
    });
  }
}
