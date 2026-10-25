// The ask from a session's Plan tab in a real browser (decision 28, matrix
// C11), on the session fixture's source: a question typed under the plan is
// sent to the reader's route about the session's service, or about the line
// it names, and the /ask/:id screen opens with it, in English and in French,
// with no horizontal scroll on a phone. An empty question sends nothing. No
// request leaves the app. With CLEARED_V2_SHOTS set to a folder it writes
// the card's captures there, at the four widths, light and dark.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/session/plan-ask-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { SessionSummary } from '../../../src/api/types.ts';
import { AUTHOR_ID, sessionFixture, sessionSource, type Call } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const SHOTS = process.env.CLEARED_V2_SHOTS;
declare const document: any;

type Run = { readonly page: any; readonly calls: Call[]; readonly away: string[] };

async function withPlan(options: { language: 'en' | 'fr'; width?: number; height?: number; dark?: boolean }, run: (state: Run) => Promise<void>): Promise<void> {
  const fixture = sessionFixture(FIXTURE_NOW);
  fixture.sessions[0] = { ...(fixture.sessions[0] as SessionSummary), service: 'guestbook' };
  const source = sessionSource(fixture);
  const app = await startApp({ source, extra: { language: options.language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({
      viewport: { width: options.width ?? 1440, height: options.height ?? 900 }, colorScheme: options.dark ? 'dark' : 'light',
      locale: options.language === 'fr' ? 'fr-FR' : 'en-US', timezoneId: 'Europe/Paris',
    });
    await context.addInitScript((value: string) => { try { (globalThis as any).localStorage.setItem('cleared-v2-theme', value); } catch { /* no storage */ } }, options.dark ? 'dark' : 'light');
    // Nothing leaves the app: anything else is aborted and named.
    const away: string[] = [];
    await context.route('**/*', (route: any) => {
      const url: string = route.request().url();
      if (url.startsWith(app.base)) return route.continue();
      away.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.goto(`${app.base}/sessions/${AUTHOR_ID}#plan`);
    await page.locator('#plan-ask-input').waitFor();
    await run({ page, calls: source.calls, away });
    assert.deepEqual(errors, [], 'no page error');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

const asked = (calls: readonly Call[]) => calls.filter((call) => call.method === 'POST' && call.path === '/api/asks').map((call) => call.body);
const noOverflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const shot = async (page: any, name: string) => { if (SHOTS) await page.locator('.plan-ask').screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled', caret: 'hide' }); };

test('a question asked from the Plan tab is about the session\'s service, and opens its own screen', { skip }, async () => {
  await withPlan({ language: 'en' }, async ({ page, calls, away }) => {
    assert.match(await page.locator('.plan-ask').innerText(), /Reads the base branch of guestbook/);
    await page.click('[data-act="plan_ask"]');
    assert.equal(await page.locator('.plan-ask-note').innerText(), 'Write the question first.');
    assert.deepEqual(asked(calls), [], 'an empty question is not sent');

    const question = 'Where is an entry stored before the page shows it?';
    await page.fill('#plan-ask-input', question);
    await page.click('[data-act="plan_ask"]');
    await page.waitForURL(/\/ask\/ask-[0-9a-f-]+$/);
    await page.locator('#ask-title').waitFor();
    assert.equal(await page.locator('#ask-title').innerText(), question);
    assert.equal(await page.locator('.ask-target').innerText(), 'guestbook');
    assert.equal(await page.locator('.ask-state').innerText(), 'Starting a reader on the base branch…');
    assert.deepEqual(asked(calls), [{ question, service: 'guestbook' }]);
    assert.deepEqual(away, []);
  });
});

test('in French, on a phone: a named line is the ask\'s target, and nothing scrolls sideways', { skip }, async () => {
  await withPlan({ language: 'fr', width: 390, height: 844 }, async ({ page, calls, away }) => {
    const card = await page.locator('.plan-ask').innerText();
    assert.match(card, /Interroger le code/);
    assert.match(card, /Lit la branche de base de guestbook/);
    assert.ok(await noOverflow(page), 'no horizontal scroll at 390 on the Plan tab');

    const question = 'Que fait guestbook:src/page.ts:12 ?';
    await page.fill('#plan-ask-input', question);
    await page.click('[data-act="plan_ask"]');
    await page.waitForURL(/\/ask\/ask-[0-9a-f-]+$/);
    await page.locator('#ask-title').waitFor();
    assert.equal(await page.locator('#ask-title').innerText(), question);
    assert.equal(await page.locator('.ask-target').innerText(), 'guestbook · src/page.ts, ligne 12');
    assert.deepEqual(asked(calls), [{ question, target: 'guestbook:src/page.ts:12' }]);
    assert.ok(await noOverflow(page), 'no horizontal scroll at 390 on the ask');
    assert.deepEqual(away, []);
  });
});

// Defined only when captures are asked for: the browser job of CI fails on a skipped test.
if (SHOTS) test('the card\'s captures, at each width in each theme', { skip }, async () => {
  const sizes = { 1440: [1440, 900], 1280: [1280, 800], 768: [768, 1024], 390: [390, 844] } as const;
  for (const dark of [false, true]) {
    for (const [width, [w, h]] of Object.entries(sizes)) {
      await withPlan({ language: 'en', width: w, height: h, dark }, async ({ page }) => {
        await page.fill('#plan-ask-input', 'Where is an entry stored before the page shows it?');
        await shot(page, `plan-ask-en-${width}-${dark ? 'dark' : 'light'}`);
      });
    }
  }
  for (const width of [1440, 390] as const) {
    await withPlan({ language: 'fr', width: sizes[width][0], height: sizes[width][1] }, async ({ page }) => shot(page, `plan-ask-fr-${width}-light`));
  }
});
