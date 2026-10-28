// The tower's composer in a real browser (the owner's request of 2026-10-28,
// lane j6-ui-pro): Ctrl+Enter from the description starts the ticket; a
// suggestion fills the description and gives the title its placeholder; the
// model menu sets Consumption's lever for the next authors; the other gestures
// open from one button and close on Escape. On a 390-pixel phone, every
// control is a 44 px target and nothing scrolls sideways.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/tower-composer-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { loadCatalog } from '../src/catalog.ts';
import { fixtureSource } from '../fixtures/source.ts';
import { FIXTURE_NOW } from '../fixtures/tower.ts';
import { PASSWORD, startApp } from './support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
declare const document: any;

type Viewport = { readonly width: number; readonly height: number };

async function withApp(language: 'fr' | 'en', viewport: Viewport, run: (page: any) => Promise<void>): Promise<void> {
  const source = await fixtureSource({ now: () => FIXTURE_NOW });
  const app = await startApp({ source, extra: { language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  const errors: string[] = [];
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport, locale: language === 'fr' ? 'fr-FR' : 'en-US' });
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.locator('#tower-heading').waitFor();
    await run(page);
    assert.deepEqual(errors, [], 'no page error');
  } finally {
    await browser.close();
    await app.close();
  }
}

test('Ctrl+Enter from the description starts the ticket; a suggestion fills the description; the menu opens and closes', { skip }, async () => {
  const tower = loadCatalog('tower', 'en');
  await withApp('en', { width: 1440, height: 900 }, async (page) => {
    // A suggestion: the bug template's sections, the title's placeholder, the suggestions gone.
    await page.locator('[data-suggest="bug"]').click();
    assert.equal(await page.inputValue('#ask-body'), tower.template_bug_body);
    assert.equal(await page.getAttribute('#ask-input', 'placeholder'), tower.template_bug_title);
    assert.equal(await page.locator('#ask-suggest').count(), 0);
    assert.equal(await page.locator('[data-template="bug"]').getAttribute('aria-pressed'), 'true');
    // Ctrl+Enter in the description: one ticket, with the title, the body and the type.
    const sent: any[] = [];
    await page.route(/\/api\/service\/tickets$/, async (route: any) => {
      if (route.request().method() === 'POST') sent.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.fill('#ask-input', 'The archive page breaks on mobile');
    await page.locator('#ask-body').focus();
    await page.keyboard.press('Control+Enter');
    await page.waitForFunction(() => /LOCAL-/.test(document.getElementById('ask-note')?.innerText ?? ''));
    assert.equal(sent.length, 1);
    assert.deepEqual({ title: sent[0].title, labels: sent[0].labels }, { title: 'The archive page breaks on mobile', labels: ['type:bug'] });
    assert.equal(await page.inputValue('#ask-input'), '');
    // The menu: closed, opened by its button, its gestures inside, closed by Escape with the focus back on its button.
    assert.ok(!await page.locator('#ask-more-menu').isVisible(), 'closed at first');
    await page.locator('#ask-more-button').click();
    assert.equal(await page.locator('#ask-more-button').getAttribute('aria-expanded'), 'true');
    for (const hook of ['[data-lead="goal"]', '[data-lead="lead"]', '[data-bar="ask"]']) assert.ok(await page.locator(`#ask-more-menu ${hook}`).isVisible(), hook);
    await page.keyboard.press('Escape');
    assert.ok(!await page.locator('#ask-more-menu').isVisible(), 'closed by Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'ask-more-button');
  });
});

test('the model menu sets Consumption\'s lever for the next authors, and says so', { skip }, async () => {
  await withApp('en', { width: 1440, height: 900 }, async (page) => {
    await page.locator('#ask-model').waitFor();
    const posted: any[] = [];
    await page.route(/\/api\/service\/consumption\/levers$/, async (route: any) => {
      posted.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.selectOption('#ask-model', 'claude-haiku-5-5');
    await page.waitForFunction(() => /Haiku 5\.5/.test(document.getElementById('ask-note')?.innerText ?? ''));
    assert.deepEqual(posted, [{ model: 'claude-haiku-5-5' }]);
    assert.equal(await page.inputValue('#ask-model'), 'claude-haiku-5-5');
  });
});

test('on a 390-pixel phone, in French: every control of the composer is a 44 px target, nothing scrolls sideways', { skip }, async () => {
  await withApp('fr', { width: 390, height: 844 }, async (page) => {
    await page.locator('#ask-model').waitFor();
    const small = await page.evaluate(() => [...document.querySelectorAll('#ask .ask-actions button, #ask .ask-actions select')]
      .filter((el: any) => el.offsetParent !== null)
      .map((el: any) => ({ name: el.getAttribute('aria-label') ?? el.textContent.trim(), height: el.getBoundingClientRect().height }))
      .filter((target: any) => target.height < 44));
    assert.deepEqual(small, [], 'every shown control is tall enough to tap');
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: (globalThis as any).innerWidth }));
    assert.ok(width.scroll <= width.view, `no sideways scroll (${width.scroll} > ${width.view})`);
  });
});
