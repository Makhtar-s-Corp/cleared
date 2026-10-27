// The Services screen's Test secrets panel in a real browser
// (docs/v2/milestone-5-plan.md, section 12, C16), on the fixtures source,
// whose test values are names and dates only: the panel lists the example
// workspace's services under the map; a value added by the keyboard is
// listed by name, its field emptied; Remove takes it away; a refusal is said
// in words; axe finds nothing, in English and in French, light and dark; on
// a phone the page does not scroll sideways. With CLEARED_V2_CAPTURES set to
// a folder it writes the panel's captures there.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/services/test-values-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW, towerSource } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const CAPTURES = process.env.CLEARED_V2_CAPTURES;
declare const document: any;
declare const window: any;

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const VALUE = ['sandbox', 'fake', 'value', 'panel'].join('-');

let axe: string | undefined;
const axeSource = (): string => (axe ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));
async function axeClean(page: any, what: string): Promise<void> {
  if (!await page.evaluate(() => typeof window.axe === 'object')) await page.evaluate(axeSource());
  const found = await page.evaluate(async (tags: string[]) => {
    const result = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: tags } });
    return result.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, TAGS);
  assert.deepEqual(found, [], `${what}: axe`);
}

async function withBrowser(options: { language: 'en' | 'fr'; width?: number; theme?: 'light' | 'dark' }, run: (page: any) => Promise<void>): Promise<void> {
  const app = await startApp({ source: towerSource(() => FIXTURE_NOW, await fixtureSource({ now: () => FIXTURE_NOW })), extra: { language: options.language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, locale: options.language === 'fr' ? 'fr-FR' : 'en-US', timezoneId: 'Europe/Paris' });
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
    await page.goto(`${app.base}/services`);
    await page.locator('[data-test-values] [data-service="guestbook"]').waitFor();
    await run(page);
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

const shot = async (page: any, name: string) => {
  if (!CAPTURES) return;
  mkdirSync(CAPTURES, { recursive: true });
  await page.locator('.services-test-values').screenshot({ path: join(CAPTURES, `${name}.png`) });
};

test('the panel lists the services under the map; a value added is listed by name, then removed', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page) => {
    await axeClean(page, 'listed');
    assert.equal(await page.locator('[data-test-values] [data-service]').count(), 2);
    await page.selectOption('#services-test-value-service', 'filter-api');
    await page.fill('#services-test-value-name', 'FILTER_TEST_KEY');
    await page.fill('#services-test-value-value', 'short');
    await page.keyboard.press('Enter');
    await page.locator('[data-test-values] [role="alert"]').waitFor();
    assert.match(await page.locator('[data-test-values] [role="alert"]').innerText(), /8 characters/);
    await page.fill('#services-test-value-value', VALUE);
    await page.keyboard.press('Enter');
    await page.locator('[data-service="filter-api"] [data-test-value="FILTER_TEST_KEY"]').waitFor();
    assert.equal(await page.inputValue('#services-test-value-value'), '');
    assert.ok(!(await page.content()).includes(VALUE), 'the page never holds the value');
    await axeClean(page, 'saved');
    await shot(page, 'test-values-en-1440-light');
    await page.locator('[data-service="filter-api"] [data-act="test_value_remove"]').click();
    await page.locator('[data-service="filter-api"] [data-test-value="FILTER_TEST_KEY"]').waitFor({ state: 'detached' });
  });
});

test('in French, dark, every word of the panel is French', { skip }, async () => {
  await withBrowser({ language: 'fr', theme: 'dark' }, async (page) => {
    const text: string = await page.locator('.services-test-values').innerText();
    assert.match(text, /Secrets de test/);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, 'no ISO time');
    await axeClean(page, 'fr dark');
    await shot(page, 'test-values-fr-1440-dark');
  });
});

for (const [width, theme] of [[1280, 'light'], [768, 'light'], [390, 'light'], [1280, 'dark'], [768, 'dark'], [390, 'dark'], [1440, 'dark']] as const) {
  test(`at ${width} px, ${theme}, the panel does not make the page scroll sideways`, { skip }, async () => {
    await withBrowser({ language: 'en', width, theme }, async (page) => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `no horizontal scroll at ${width} px`);
      await axeClean(page, `${width} ${theme}`);
      await shot(page, `test-values-en-${width}-${theme}`);
    });
  });
}
