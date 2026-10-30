// Close in a real browser, in French and in English (issue #249, P53): the
// release card offers Close, which asks for a reason (an empty one is
// refused in the page, before any call); the call carries the reason; the
// card leaves the tower and stays in the inbox's "handled" group, saying who
// closed it, when and why. The fixtures source closes for real (in memory).
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/inbox/close-browser.test.ts
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

const WORDS = {
  fr: {
    close: 'Fermer', send: 'Fermer le ticket', empty: 'Dites pourquoi le ticket est fermé.', done: /^Fermé à \d\d:\d\d\. Rien n'a été fusionné\. La carte reste dans l'historique\.$/,
    history: /^Fermé par vous à \d\d:\d\d\u00a0: «\u00a0Un ticket de répétition\u00a0»$/, reason: 'Un ticket de répétition',
  },
  en: {
    close: 'Close', send: 'Close the ticket', empty: 'Say why the ticket is closed.', done: /^Closed at \d\d:\d\d\. Nothing was merged\. The card stays in the history\.$/,
    history: /^Closed by you at \d\d:\d\d: “A rehearsal ticket”$/, reason: 'A rehearsal ticket',
  },
} as const;

async function withApp(language: 'fr' | 'en', run: (page: any, base: string, errors: string[]) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { language } });
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
    await run(page, app.base, errors);
    assert.deepEqual(errors, [], 'no page error');
  } finally {
    await browser.close();
    await app.close();
  }
}

for (const language of ['fr', 'en'] as const) {
  const words = WORDS[language];
  test(`Close in ${language === 'fr' ? 'French' : 'English'}: the reason is mandatory, the card leaves the tower and stays in the history with its reason`, { skip }, async () => {
    await withApp(language, async (page, base) => {
      const api = async (path: string) => (await (await page.request.get(`${base}/api/service${path}`)).json()) as { id: string; kind: string; state: string; ticket: string }[];
      const release = (await api('/inbox')).find((item) => item.kind === 'release' && item.state === 'waiting');
      assert.ok(release, 'the fixtures list a release card that waits');
      const needs = () => page.locator(`a.need[href*="${encodeURIComponent(release.id)}"]`).count();
      await page.locator('#tower-heading').waitFor();
      await page.locator('a.need').first().waitFor();
      assert.equal(await needs(), 1, 'on the tower before');

      const sent: unknown[] = [];
      await page.route(/\/api\/service\/tickets\/[^/]+\/close$/, async (route: any) => { sent.push(route.request().postDataJSON()); await route.continue(); });
      await page.goto(`${base}/inbox#${encodeURIComponent(release.id)}`);
      await page.locator(`#detail [data-act="close"]`).waitFor();
      assert.equal((await page.locator('#detail [data-act="close"]').innerText()).trim(), words.close);
      await page.locator('#detail [data-act="close"]').click();
      // An empty reason is refused in the page.
      await page.locator('#detail [data-act="close_send"]').click();
      assert.equal((await page.locator('#d-note').innerText()).trim(), words.empty);
      assert.equal(sent.length, 0, 'no call without a reason');
      assert.equal((await page.locator('#detail [data-act="close_send"]').innerText()).trim(), words.send);
      await page.locator('#close-message').fill(words.reason);
      await page.locator('#detail [data-act="close_send"]').click();
      await page.locator('#detail .d-done').waitFor();
      assert.match((await page.locator('#detail .d-done').innerText()).trim(), words.done);
      assert.deepEqual(sent, [{ reason: words.reason }]);
      assert.equal(await page.locator('#detail [data-act="approve"]').count(), 0, 'nothing to approve any more');

      // Off the tower.
      await page.goto(`${base}/`);
      await page.locator('#tower-heading').waitFor();
      await page.locator('a.need').first().waitFor();
      assert.equal(await needs(), 0, 'off the tower after');
      // And in the history, with who, when and why.
      await page.goto(`${base}/inbox#${encodeURIComponent(release.id)}`);
      await page.locator('#detail .d-done').waitFor();
      assert.match((await page.locator('#detail .d-done').innerText()).trim(), words.history);
      assert.equal(await page.locator(`#handled-items a.item[data-item="${release.id}"]`).count(), 1, 'in the handled group');
      assert.equal(await page.locator(`#inbox-list section:first-of-type a.item[data-item="${release.id}"]`).count(), 0, 'no longer under what waits');
      assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
    });
  });

  test(`Close on the ticket's page in ${language === 'fr' ? 'French' : 'English'}: the same reason is mandatory, and the call names the ticket`, { skip }, async () => {
    await withApp(language, async (page, base) => {
      const sessions = (await (await page.request.get(`${base}/api/service/sessions`)).json()) as { id: string; role: string; ticket: string }[];
      const author = sessions.find((s) => s.role === 'author');
      assert.ok(author, 'the fixtures list an author session');
      const sent: { url: string; body: unknown }[] = [];
      await page.route(/\/api\/service\/tickets\/[^/]+\/close$/, async (route: any) => { sent.push({ url: route.request().url(), body: route.request().postDataJSON() }); await route.continue(); });
      await page.goto(`${base}/sessions/${author.id}`);
      await page.locator('[data-session-details] > summary').first().click();
      await page.locator('#close-open').waitFor();
      assert.equal((await page.locator('#close-open').innerText()).trim(), words.close);
      await page.locator('#close-open').click();
      await page.locator('#close-send').click();
      assert.equal((await page.locator('#close-note').innerText()).trim(), words.empty);
      assert.equal(sent.length, 0, 'no call without a reason');
      await page.locator('#close-message').fill(words.reason);
      await page.locator('#close-send').click();
      await page.locator('#close-done').waitFor();
      assert.match((await page.locator('#close-done').innerText()).trim(), words.done);
      assert.equal(sent.length, 1);
      assert.match(sent[0]?.url ?? '', new RegExp(`/tickets/${author.ticket}/close$`));
      assert.deepEqual(sent[0]?.body, { reason: words.reason });
      assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
    });
  });
}
