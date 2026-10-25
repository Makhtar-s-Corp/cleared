// Ready-made tickets in a real browser, in French and in English (P214, issue
// #330): the bar's Template chip shows Bug, Review, CI and Question; a pick
// fills the empty description with its sections and gives the title its
// placeholder; another pick replaces untouched sections and keeps written
// ones, saying so; New ticket sends the template's type label, which the
// ticket keeps. On a 390-pixel phone, in French, nothing scrolls sideways.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/tower-templates-browser.test.ts
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
declare const window: any;
declare const fetch: any;

const WORDS = {
  fr: { chip: 'Modèle', toggles: ['Bug', 'Revue', 'CI', 'Question'], bugTitle: 'Ce qui casse, en quelques mots', kept: 'Votre description est gardée, un modèle ne remplit qu\'une description vide.', created: /^LOCAL-\d+ créé/ },
  en: { chip: 'Template', toggles: ['Bug', 'Review', 'CI', 'Question'], bugTitle: 'What breaks, in a few words', kept: 'Your description is kept: a template only fills an empty one.', created: /^LOCAL-\d+ created/ },
} as const;

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

for (const language of ['fr', 'en'] as const) {
  const words = WORDS[language];
  const tower = loadCatalog('tower', language);
  test(`Ready-made tickets in ${language === 'fr' ? 'French' : 'English'}: a pick fills the description, written words stay, the ticket keeps its type`, { skip }, async () => {
    await withApp(language, { width: 1440, height: 900 }, async (page) => {
      const chip = page.locator('[data-bar="template"]');
      assert.equal((await chip.innerText()).trim(), words.chip);
      assert.equal(await page.locator('#ask-templates').count(), 0, 'closed');
      await chip.click();
      await page.locator('#ask-templates').waitFor();
      assert.equal(await chip.getAttribute('aria-expanded'), 'true');
      assert.deepEqual((await page.locator('#ask-templates [data-template]').allInnerTexts()).map((s: string) => s.trim()), words.toggles);

      // Bug: the sections in the description, the title's placeholder, the title field focused.
      await page.locator('[data-template="bug"]').click();
      assert.equal(await page.locator('[data-template="bug"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.inputValue('#ask-body'), tower.template_bug_body);
      assert.ok(await page.locator('#ask-body').isVisible(), 'the description shows');
      assert.equal(await page.getAttribute('#ask-input', 'placeholder'), words.bugTitle);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'ask-input');

      // Review over untouched sections: replaced.
      await page.locator('[data-template="review"]').click();
      assert.equal(await page.inputValue('#ask-body'), tower.template_review_body);
      assert.equal(await page.locator('[data-template="bug"]').getAttribute('aria-pressed'), 'false');

      // Written words: kept when CI is picked, and the note says so.
      const written = `${tower.template_review_body}\nhttps://example.test/pull/12`;
      await page.fill('#ask-body', written);
      await page.locator('[data-template="ci"]').click();
      assert.equal(await page.inputValue('#ask-body'), written);
      assert.equal((await page.locator('#ask-note').innerText()).trim(), words.kept);
      assert.equal(await page.locator('[data-template="ci"]').getAttribute('aria-pressed'), 'true');

      // New ticket: the type label is sent and kept; the bar is empty again.
      const sent: any[] = [];
      await page.route(/\/api\/service\/tickets$/, async (route: any) => {
        if (route.request().method() === 'POST') sent.push(route.request().postDataJSON());
        await route.continue();
      });
      await page.fill('#ask-input', 'The browser check fails on main');
      await page.locator('#ask button[type=submit]').click();
      await page.waitForFunction(() => /LOCAL-/.test(document.getElementById('ask-note')?.innerText ?? ''));
      assert.match((await page.locator('#ask-note').innerText()).trim(), words.created);
      assert.equal(sent.length, 1);
      const { title, body, labels } = sent[0];
      assert.deepEqual({ title, body, labels }, { title: 'The browser check fails on main', body: written, labels: ['type:ci'] });
      const tickets = await page.evaluate(async () => (await fetch('/api/service/tickets')).json());
      assert.deepEqual(tickets.find((x: any) => x.title === 'The browser check fails on main')?.labels, ['type:ci']);
      assert.equal(await page.inputValue('#ask-body'), '');
      assert.equal(await page.locator('#ask-templates').count(), 0, 'the row closes with the ticket made');
      assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
    });
  });
}

test('Ready-made tickets on a 390-pixel phone, in French: every template reachable, nothing scrolls sideways', { skip }, async () => {
  await withApp('fr', { width: 390, height: 844 }, async (page) => {
    await page.locator('[data-bar="template"]').click();
    await page.locator('[data-template="question"]').click();
    for (const template of ['bug', 'review', 'ci', 'question']) assert.ok(await page.locator(`[data-template="${template}"]`).isVisible(), template);
    assert.ok(await page.locator('#ask button[type=submit]').isVisible(), 'New ticket stays');
    assert.equal(await page.inputValue('#ask-body'), loadCatalog('tower', 'fr').template_question_body);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
    assert.ok(width.scroll <= width.view, `no sideways scroll (${width.scroll} > ${width.view})`);
  });
});
