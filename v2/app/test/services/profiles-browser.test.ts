// The Services screen's Agent profile panel in a real browser (issue
// #452), on the fixtures source, whose profile and environment are the
// service's own store in memory: both histories under the test secrets;
// Restore on an old version, by the keyboard, makes a new current version
// that says where it came from, and the old one stays listed; axe finds
// nothing, in English and in French, light and dark; on a phone the page
// does not scroll sideways. With CLEARED_V2_CAPTURES set to a folder it
// writes the panel's captures there.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/services/profiles-browser.test.ts
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
    await page.locator('[data-profiles] [data-profile-version]').first().waitFor();
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
  await page.locator('[data-profiles]').screenshot({ path: join(CAPTURES, `${name}.png`) });
};

const versions = (page: any, object: 'agent' | 'environment'): Promise<string[]> =>
  page.locator(`[data-profiles-object="${object}"] [data-profile-version]`).evaluateAll((rows: any[]) => rows.map((row) => row.getAttribute('data-profile-version')));

test('the panel lists both histories; Restore on an old version makes a new current one, the old one kept', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page) => {
    await axeClean(page, 'listed');
    assert.deepEqual(await versions(page, 'agent'), ['2', '1']);
    assert.deepEqual(await versions(page, 'environment'), ['1']);
    assert.equal(await page.locator('[data-profiles-object="environment"] [data-restore]').count(), 0, 'the current version has no Restore');
    await shot(page, 'profiles-en-1440-light');
    await page.locator('[data-restore="agent:1"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('[data-profiles-object="agent"] [data-profile-version="3"][data-current="yes"]').waitFor();
    assert.deepEqual(await versions(page, 'agent'), ['3', '2', '1']);
    assert.match(await page.locator('[data-profile-version="3"]').innerText(), /Restored from version 1/);
    assert.match(await page.locator('[data-profiles] [role="status"]').innerText(), /Version 3/);
    assert.equal(await page.locator('[data-restore="agent:2"]').count(), 1, 'version 2 can still be restored');
    await axeClean(page, 'restored');
  });
});

test('in French, dark, every word of the panel is French', { skip }, async () => {
  await withBrowser({ language: 'fr', theme: 'dark' }, async (page) => {
    const text: string = await page.locator('[data-profiles]').innerText();
    assert.match(text, /Profil d.agent/);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, 'no ISO time');
    await axeClean(page, 'fr dark');
    await shot(page, 'profiles-fr-1440-dark');
  });
});

for (const [width, theme] of [[1280, 'light'], [768, 'light'], [390, 'light'], [1280, 'dark'], [768, 'dark'], [390, 'dark'], [1440, 'dark']] as const) {
  test(`at ${width} px, ${theme}, the panel does not make the page scroll sideways`, { skip }, async () => {
    await withBrowser({ language: 'en', width, theme }, async (page) => {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `no horizontal scroll at ${width} px`);
      await axeClean(page, `${width} ${theme}`);
      await shot(page, `profiles-en-${width}-${theme}`);
    });
  });
}
