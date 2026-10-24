// A batch in a real browser, in French and in English (requirement C6): the
// bar's Batch chip opens the form; one line is refused in the page, before any
// call; five lines start three tickets (the lanes) and queue two, the card
// saying why; at 90 % of the seven-day window nothing more starts, even with
// more lanes, and the card says the quota; once the figure falls the queue
// starts. The fixtures source runs the service's own batch runner on fakes.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/tower-batch-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixtureSource } from '../fixtures/source.ts';
import { FIXTURE_NOW } from '../fixtures/tower.ts';
import { PASSWORD, startApp } from './support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
declare const document: any;

const NB = ' ';
const WORDS = {
  fr: {
    chip: 'Lot', label: 'Un ticket par ligne', few: 'Ajoutez au moins 2 tickets, un par ligne.', start: 'Lancer le lot', title: 'Lots',
    five: '3 sur 5 lancés · 2 en attente', lanes: `En attente d'une voie libre${NB}: 3 sur 3 utilisées.`,
    quota: `En attente${NB}: la fenêtre de sept jours est à 90${NB}% (l'arrêt est à 85${NB}%).`, all: '5 sur 5 lancés', created: /^Lot batch-1 créé : 5 tickets\.$/,
  },
  en: {
    chip: 'Batch', label: 'One ticket per line', few: 'Add at least 2 tickets, one per line.', start: 'Start the batch', title: 'Batches',
    five: '3 of 5 started · 2 waiting', lanes: 'Waiting for a free lane: 3 of 3 in use.',
    quota: 'Waiting: the seven-day window is at 90 % (the stop is at 85 %).', all: '5 of 5 started', created: /^Batch batch-1 created: 5 tickets\.$/,
  },
} as const;

const LINES = ['Add an entries page', 'Sort entries newest first', 'Escape the names', 'Limit a name to 40 characters', 'Add a health route'];

async function withApp(language: 'fr' | 'en', run: (page: any, base: string, source: Awaited<ReturnType<typeof fixtureSource>>) => Promise<void>): Promise<void> {
  const source = await fixtureSource({ now: () => FIXTURE_NOW });
  const app = await startApp({ source, extra: { language } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  const errors: string[] = [];
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language === 'fr' ? 'fr-FR' : 'en-US' });
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await run(page, app.base, source);
    assert.deepEqual(errors, [], 'no page error');
  } finally {
    await browser.close();
    await app.close();
  }
}

for (const language of ['fr', 'en'] as const) {
  const words = WORDS[language];
  test(`A batch in ${language === 'fr' ? 'French' : 'English'}: refused when too short, three tickets start and two wait, the quota holds them, then they start`, { skip }, async () => {
    await withApp(language, async (page, base, source) => {
      await page.locator('#tower-heading').waitFor();
      assert.equal(await page.locator('[data-batch]').count(), 0, 'no batch card before any batch');
      assert.equal((await page.locator('[data-bar="batch"]').innerText()).trim(), words.chip);
      assert.equal(await page.locator('#batch-form').count(), 0, 'the form is closed');
      await page.locator('[data-bar="batch"]').click();
      await page.locator('#batch-form').waitFor();
      assert.equal(await page.locator('[data-bar="batch"]').getAttribute('aria-expanded'), 'true');
      assert.equal(await page.locator('#batch-lines').getAttribute('aria-label'), words.label);
      assert.equal((await page.locator('[data-act="batch_run"]').innerText()).trim(), words.start);

      // One line is not a batch: refused in the page, no call.
      const sent: unknown[] = [];
      await page.route(/\/api\/service\/batches$/, async (route: any) => {
        if (route.request().method() === 'POST') sent.push(route.request().postDataJSON());
        await route.continue();
      });
      await page.fill('#batch-lines', 'Only one');
      await page.locator('[data-act="batch_run"]').click();
      assert.equal((await page.locator('#batch-note').innerText()).trim(), words.few);
      assert.equal(sent.length, 0, 'no call for one line');

      // Five lines: three start (the lanes' default), two wait.
      await page.fill('#batch-lines', `${LINES.join('\n')}\n`);
      await page.locator('[data-act="batch_run"]').click();
      await page.locator('[data-batch="batch-1"]').waitFor();
      assert.deepEqual(sent, [{ project: 'guestbook', tickets: LINES.map((title) => ({ title })) }]);
      assert.match((await page.locator('#batch-note').innerText()).trim(), words.created);
      assert.equal(await page.locator('#batches-title').innerText(), words.title);
      const card = page.locator('[data-batch="batch-1"]');
      assert.equal((await card.locator('.batch-line').innerText()).trim(), words.five);
      assert.equal((await card.locator('.batch-hold').innerText()).trim(), words.lanes);
      assert.equal(await card.locator('[data-item-state="started"]').count(), 3);
      assert.equal(await card.locator('[data-item-state="queued"]').count(), 2);
      assert.deepEqual((await card.locator('.batch-item-title').allInnerTexts()).map((s: string) => s.trim()), LINES);

      // The quota stops what the lanes would allow: more lanes, 90 % of the week, nothing starts.
      source.lanes(5);
      source.quota(90);
      await page.reload();
      await page.locator('[data-batch="batch-1"] .batch-hold').waitFor();
      assert.equal((await page.locator('[data-batch="batch-1"] .batch-hold').innerText()).trim(), words.quota);
      assert.equal(await page.locator('[data-batch="batch-1"] [data-item-state="started"]').count(), 3, 'nothing more started');

      // The figure falls: the queue starts.
      source.quota(10);
      await page.reload();
      await page.locator('[data-batch="batch-1"] .batch-line').waitFor();
      assert.equal((await page.locator('[data-batch="batch-1"] .batch-line').innerText()).trim(), words.all);
      assert.equal(await page.locator('[data-batch="batch-1"] .batch-hold').count(), 0, 'nothing holds the batch any more');
      assert.equal(await page.locator('[data-batch="batch-1"] [data-item-state="started"]').count(), 5);
      assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
    });
  });
}
