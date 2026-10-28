// The Services screen's nightly pass panel in a real browser (issue #455),
// on the fixtures source: one box per service of the map, the first on with
// its last pass, the second off; Space on a box turns its pass on or off
// and the line says so; axe finds nothing, in English and in French, in
// the app's one light theme (P265); on a phone the page does not scroll
// sideways. With CLEARED_V2_CAPTURES set to a folder it writes the panel's
// captures there.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/services/dreaming-browser.test.ts
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

let axe: string | undefined;
const axeSource = (): string => (axe ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8'));
// The shell's search and account buttons hold their label in their name and
// more text beside it, which axe's label-in-name rule reads as a mismatch:
// app/test/a11y-browser.test.ts says why and leaves them out of that rule.
// The rest of the page, the panel included, is checked whole.
const NAMED_BY_LABEL = [['#palette-open'], ['#person']];

async function axeClean(page: any, what: string): Promise<void> {
  if (!await page.evaluate(() => typeof window.axe === 'object')) await page.evaluate(axeSource());
  const found = await page.evaluate(async ({ tags, named }: { tags: string[]; named: string[][] }) => {
    const all = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: tags }, rules: { 'label-content-name-mismatch': { enabled: false } } });
    const label = await window.axe.run({ include: [document], exclude: named }, { resultTypes: ['violations'], runOnly: { type: 'rule', values: ['label-content-name-mismatch'] } });
    const result = { violations: [...all.violations, ...label.violations] };
    return result.violations.map((v: { id: string; nodes: { target: string[] }[] }) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, { tags: TAGS, named: NAMED_BY_LABEL });
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
    await page.locator('[data-dreaming] [data-dreaming-service]').first().waitFor();
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
  await page.locator('[data-dreaming]').scrollIntoViewIfNeeded();
  await page.locator('[data-dreaming]').screenshot({ path: join(CAPTURES, `${name}.png`) });
};

const boxes = (page: any): Promise<boolean[]> => page.locator('[data-dreaming] input[type="checkbox"]').evaluateAll((inputs: any[]) => inputs.map((input) => input.checked));

test('one box per service, the second off; Space turns a pass off and on, and the line says so', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page) => {
    await axeClean(page, 'listed');
    const on = await boxes(page);
    assert.equal(on[0], true);
    assert.equal(on[1], false);
    assert.match(await page.locator('[data-dreaming-service]').first().innerText(), /Last pass on .*: 2 proposals\./);
    await shot(page, 'dreaming-en-1440-light');
    await page.locator('#dreaming-0').focus();
    await page.keyboard.press('Space');
    await page.locator('#dreaming-0:not(:checked)').waitFor();
    assert.match(await page.locator('[data-dreaming-service]').first().innerText(), /Off: no pass for this service\./);
    await page.keyboard.press('Space');
    await page.locator('#dreaming-0:checked').waitFor();
    await axeClean(page, 'changed');
  });
});

test('in French, every word of the panel is French', { skip }, async () => {
  await withBrowser({ language: 'fr' }, async (page) => {
    const text: string = await page.locator('[data-dreaming]').innerText();
    assert.match(text, /Apprendre des sessions passées/);
    assert.match(text, /Désactivée/);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, 'no ISO time');
    await axeClean(page, 'fr');
    await shot(page, 'dreaming-fr-1440-light');
  });
});

for (const width of [768, 390] as const) {
  test(`at ${width} px the panel does not make the page scroll sideways`, { skip }, async () => {
    await withBrowser({ language: 'en', width }, async (page) => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `no horizontal scroll at ${width} px`);
      await axeClean(page, `${width}`);
      await shot(page, `dreaming-en-${width}-light`);
    });
  });
}
