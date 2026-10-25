// The Consumption screen in a real browser (O15), on the fixtures source: it
// opens from the sidebar and from the G C chord without a reload, draws both
// agents with their curve and their quota, shows the dollars of the agent
// that reported them and none for the other, and its three levers act on
// the service (the fixtures answer through the service's own lever code) and
// survive a reload. With CLEARED_V2_SHOTS set to a folder it writes the
// screen's captures there.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/consumption/consumption-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const SHOTS = process.env.CLEARED_V2_SHOTS;
declare const document: any;

async function withBrowser(options: { language: 'en' | 'fr'; width?: number }, run: (page: any, base: string) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { language: options.language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 }, locale: options.language === 'fr' ? 'fr-FR' : 'en-US', timezoneId: 'Europe/Paris' });
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

const levers = (page: any) => page.evaluate(async () => ((await (await fetch('/api/service/consumption')).json()) as { levers: unknown }).levers);
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = async (page: any, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true }); };

test('the screen opens from the sidebar and from G C without a reload, and draws the agents, the quotas and the dollars of the one that reported them', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page) => {
    await page.evaluate(() => { (window as any).__kept = 'same document'; });
    await page.locator('.nav-item[data-nav="consumption"]').click();
    await page.locator('.consumption-grid').waitFor();
    assert.equal(await page.evaluate(() => location.pathname), '/consumption');
    assert.equal(await page.evaluate(() => (window as any).__kept), 'same document', 'client routing: no document load');
    assert.equal(await page.locator('h1').innerText(), 'What your agents consume');
    assert.equal(await page.locator('[data-harness]').count(), 2);
    assert.equal(await page.locator('svg[data-curve]').count(), 2);
    assert.equal(await page.locator('.quota-bar').count(), 2);
    assert.match(await page.locator('[data-headline="hit"]').innerText(), /^At the average pace of this cycle, Codex would reach 100% on /);
    assert.equal(await page.locator('[data-projection="after"]').count(), 2);
    assert.equal(await page.locator('[data-cost-row]').count(), 1, 'dollars for the agent that reported them only');
    assert.equal(await page.locator('[data-cost-row="claude-code"]').count(), 1);
    assert.match(await page.locator('.cost-source').innerText(), /not estimated here/);
    assert.match(await page.locator('.quota-reset').first().innerText(), /Resets in 3d\s12h/);
    assert.ok(await noOverflow(page), 'no horizontal scroll');
    await shot(page, 'consumption-en-desktop');

    await page.locator('.nav-item[data-nav="tower"]').click();
    await page.locator('#tower-body .tower').waitFor();
    await page.keyboard.press('g');
    await page.keyboard.press('c');
    await page.locator('.consumption-grid').waitFor();
    assert.equal(await page.evaluate(() => (window as any).__kept), 'same document');
  });
});

test('each lever acts on the service in one click, is drawn as pressed, and survives a reload', { skip }, async () => {
  await withBrowser({ language: 'en' }, async (page, base) => {
    await page.goto(`${base}/consumption`);
    await page.locator('.consumption-grid').waitFor();
    assert.deepEqual(await levers(page), { model: { current: 'claude-opus-5-5', choice: null, options: ['claude-opus-5-5', 'claude-haiku-5-5'], reviewer: 'claude-sonnet-5-5' }, maxLanes: { choice: null, options: [1, 2, 3] }, paused: false });
    assert.equal(await page.locator('[data-choice="model:claude-sonnet-5-5"]').count(), 0, 'the reviewers\' model is not offered');

    await page.locator('[data-choice="model:claude-haiku-5-5"]').click();
    await page.locator('[data-lever="model"][data-active="yes"]').waitFor();
    assert.equal(await page.locator('[data-lever="model"] .lever-state').innerText(), 'New starts use Haiku 5.5');
    await page.locator('[data-choice="lanes:1"]').click();
    await page.locator('[data-lever="lanes"][data-active="yes"]').waitFor();
    assert.equal(await page.locator('[data-lever="lanes"] .lever-state').innerText(), 'One session at a time');
    await page.locator('[data-choice="pause:pause"]').click();
    await page.locator('[data-lever="pause"][data-active="yes"]').waitFor();
    assert.equal(await page.locator('[data-lever="pause"] .lever-state').innerText(), 'Schedules are paused');
    assert.equal(await page.locator('[data-choice="pause:pause"]').innerText(), 'Resume');
    assert.deepEqual(await levers(page), { model: { current: 'claude-haiku-5-5', choice: 'claude-haiku-5-5', options: ['claude-opus-5-5', 'claude-haiku-5-5'], reviewer: 'claude-sonnet-5-5' }, maxLanes: { choice: 1, options: [1, 2, 3] }, paused: true });
    await shot(page, 'consumption-en-levers');

    await page.reload();
    await page.locator('.consumption-grid').waitFor();
    assert.equal(await page.locator('[data-lever="pause"] .lever-state').innerText(), 'Schedules are paused', 'kept by the service across a reload');
    assert.equal(await page.locator('[data-choice="lanes:1"]').getAttribute('aria-pressed'), 'true');

    await page.locator('[data-choice="pause:pause"]').click();
    await page.locator('[data-lever="pause"][data-active="no"]').waitFor();
    await page.locator('[data-choice="lanes:none"]').click();
    await page.locator('[data-lever="lanes"][data-active="no"]').waitFor();
    await page.locator('[data-choice="model:default"]').click();
    await page.locator('[data-lever="model"][data-active="no"]').waitFor();
    assert.equal((await levers(page) as { paused: boolean }).paused, false);
    assert.equal(await page.locator('.levers-note').count(), 0);
  });
});

test('in French the whole screen is French, with human dates and durations, and G C reaches it', { skip }, async () => {
  await withBrowser({ language: 'fr' }, async (page) => {
    await page.keyboard.press('g');
    await page.keyboard.press('c');
    await page.locator('.consumption-grid').waitFor();
    assert.equal(await page.locator('h1').innerText(), 'La consommation de vos agents');
    const text: string = await page.evaluate(() => document.querySelector('.consumption').innerText);
    assert.match(text, /Anticiper les limites/);
    assert.match(text, /atteindrait 100 % le (?:lun|mar|mer|jeu|ven|sam|dim)/);
    assert.match(text, /Reset dans 3\sj\s12\sh/);
    assert.match(text, /Coût équivalent API/);
    assert.match(text, /Mesuré le mer\./);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T|\b\d{7,}\b/, 'no ISO time, no raw count of milliseconds or tokens');
    assert.equal(await page.locator('.nav-item[data-nav="consumption"] .nav-label').innerText(), 'Consommation');
    await shot(page, 'consumption-fr-desktop');
  });
});

test('on a phone the screen is one column without a horizontal scroll, and the choices are touch-sized', { skip }, async () => {
  await withBrowser({ language: 'en', width: 390 }, async (page, base) => {
    await page.goto(`${base}/consumption`);
    await page.locator('.consumption-grid').waitFor();
    assert.ok(await noOverflow(page), 'no horizontal scroll at 390 px');
    const columns = await page.evaluate(() => getComputedStyle(document.querySelector('.consumption-grid')).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 1);
    const height = await page.locator('[data-choice="lanes:1"]').evaluate((el: any) => el.getBoundingClientRect().height);
    assert.ok(height >= 44, `a choice is ${height}px high`);
    await shot(page, 'consumption-en-phone');
  });
});
