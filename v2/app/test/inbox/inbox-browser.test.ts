// The inbox in a real browser, in French, on the fixtures source
// (docs/v2/ui-overhaul-plan.md, 2.5.1 to 2.5.5, lane 37):
//   - the reviewer's compound request shows its French question, its
//     folded command, its reason by code and its three answers without
//     scrolling, at 1440, 1280, 768 and 390 px wide;
//   - from 1280 px its row carries the three answers, below it does not;
//   - A answers "Autoriser une fois" through the answer route (stubbed in the
//     page: the fixtures source answers no request);
//   - the "Traité" group is folded with its count, and opens;
//   - Esc in the deny reason's field keeps the text and the item.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/inbox/inbox-browser.test.ts
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
declare const window: any;

const WIDTHS = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 768, height: 1024 }, { width: 390, height: 844 }] as const;
const QUESTION = 'Autoriser le relecteur à lire l\'historique et le diff du dépôt puis à lancer les tests du projet\u202f?';
const REASON = '«\u00a0git merge-base\u00a0» n\'est pas une commande que la politique autorise seule.';

async function withInbox(run: (page: any, base: string, open: (viewport: { width: number; height: number }) => Promise<string>) => Promise<void>): Promise<void> {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { language: 'fr' } });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  const errors: string[] = [];
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: WIDTHS[0], locale: 'fr-FR' });
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event: any) => { (window.violations ??= []).push(`${event.violatedDirective} ${event.blockedURI}`); });
    });
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    const inbox = await (await page.request.get(`${app.base}/api/service/inbox`)).json() as { id: string; kind: string; state: string; reasonCode?: string }[];
    const compound = inbox.find((item) => item.kind === 'permission' && item.reasonCode === 'not_allowed');
    assert.ok(compound, 'the fixtures list the reviewer\'s compound request');
    // The request's address, opened at a width, its detail drawn.
    const open = async (viewport: { width: number; height: number }) => {
      await page.setViewportSize(viewport);
      await page.goto(`${app.base}/inbox#${encodeURIComponent(compound.id)}`);
      await page.locator('#detail .d-ask').waitFor();
      return compound.id;
    };
    await run(page, app.base, open);
    assert.deepEqual(errors, [], 'no page error');
    assert.deepEqual(await page.evaluate(() => window.violations ?? []), [], 'no policy violation');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /⟦/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
  }
}

// Wholly in the window, with no scroll: the element's box against the viewport's.
const inView = (page: any, selector: string): Promise<boolean> => page.locator(selector).first().evaluate((element: any) => {
  const box = element.getBoundingClientRect();
  return window.scrollY === 0 && box.width > 0 && box.top >= 0 && box.bottom <= window.innerHeight;
});

test('the reviewer\'s request in French: its question, its folded command, its reason and its three answers without scrolling, at every width', { skip }, async () => {
  await withInbox(async (page, _base, open) => {
    for (const viewport of WIDTHS) {
      const id = await open(viewport);
      const at = `${viewport.width} px`;
      assert.equal((await page.locator('#detail .d-ask').innerText()).trim(), QUESTION, at);
      assert.ok(await inView(page, '#detail .d-ask'), `${at}: the question`);
      for (const act of ['allow_once', 'allow_always', 'reject_once']) assert.ok(await inView(page, `#detail [data-act="${act}"]`), `${at}: ${act} above the fold`);
      // The key caps beside the words from 768 px; on a phone, the words alone.
      const labels = ['Autoriser une fois', 'Toujours pour ce projet', 'Refuser'];
      assert.deepEqual(await page.locator('#detail [data-act]').allInnerTexts(), viewport.width >= 768 ? labels.map((label, n) => `${label}\n${'ATR'[n]}`) : labels, at);
      assert.ok((await page.locator('#detail .facts').first().innerText()).includes(REASON), `${at}: the reason by its code`);
      assert.equal(await page.locator('#fold').evaluate((element: any) => element.open), false, `${at}: the command folded`);
      assert.match(await page.locator('#fold summary').innerText(), /^Commande\s+git log -5 --oneline/);
      // From 1280 px another request's row carries the answers; the shown one's are in the detail beside it.
      const rowActs = (selector: string) => page.locator(`#inbox-list li:has(${selector}) [data-row-act]`).count();
      assert.equal(await rowActs(`a.item[data-item="${id}"]`), 0, `${at}: the shown request's row`);
      assert.equal(await rowActs('a.item:not(.current)[data-item^="permission"]'), viewport.width >= 1280 ? 3 : 0, `${at}: another request's row`);
      assert.equal(await page.locator('#fold .fold-more').innerText(), '+ 4 autres', `${at}: the parts the fold hides, with their unit`);
    }
    // Opened, the fold holds one part per line.
    await page.locator('#fold summary').click();
    assert.deepEqual((await page.locator('#fold .fold-line').allInnerTexts()).map((line: string) => line.trim()),
      ['git log -5 --oneline', '; git merge-base main HEAD', '; git show 3f9c2a1 --stat', '; npm test 2>&1', '| tail -8']);
  });
});

test('A answers "Autoriser une fois" through the answer route; R from the reason\'s field types an R, and Esc there keeps the text', { skip }, async () => {
  await withInbox(async (page, _base, open) => {
    const sent: { url: string; body: unknown }[] = [];
    await page.route(/\/api\/service\/sessions\/[^/]+\/requests\/[^/]+\/answer$/, async (route: any) => {
      sent.push({ url: route.request().url(), body: route.request().postDataJSON() });
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"accepted":true}' });
    });
    await open(WIDTHS[0]);
    await page.locator('#deny-reason').fill('Pas maintenant');
    await page.locator('#deny-reason').press('r');
    await page.locator('#deny-reason').press('Escape');
    assert.equal(await page.locator('#deny-reason').inputValue(), 'Pas maintenantr', 'a key typed in the field is the field\'s');
    assert.match(await page.evaluate(() => document.location.hash), /request-review-1/, 'Esc in the field leaves the item open');
    assert.equal(sent.length, 0);
    await page.locator('#deny-reason').fill('');
    await page.evaluate(() => document.getElementById('screen')?.focus());
    await page.keyboard.press('a');
    await page.locator('#detail .d-done').waitFor();
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.url ?? '', /\/requests\/request-review-1\/answer$/);
    assert.deepEqual(sent[0]?.body, { decision: { kind: 'allow_once' } });
    assert.equal((await page.locator('#detail .d-done').innerText()).trim(), 'Autorisé une fois. La session continue.');
    // G then T is the shell's chord, to the tower: it answers nothing.
    const items = await (await page.request.get(`${_base}/api/service/inbox`)).json() as { id: string; kind: string; state: string; reasonCode?: string }[];
    const other = items.find((item) => item.kind === 'permission' && item.state === 'waiting' && !item.reasonCode);
    await page.goto(`${_base}/inbox#${encodeURIComponent(other?.id ?? '')}`);
    await page.locator('#detail [data-act="allow_always"]').waitFor();
    await page.evaluate(() => document.getElementById('screen')?.focus());
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await page.waitForURL(`${_base}/`);
    assert.equal(sent.length, 1, 'no answer sent by the chord');
  });
});

test('the "Traité" group is folded under what waits, with its count, and opens on a click', { skip }, async () => {
  await withInbox(async (page, base) => {
    await page.goto(`${base}/inbox`);
    const toggle = page.locator('#handled-toggle');
    await toggle.waitFor();
    assert.equal((await toggle.innerText()).trim(), 'Traité · 2');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#handled-items').count(), 0);
    const waiting = await page.locator('#inbox-list section:first-of-type a.item').count();
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await page.locator('#handled-items a.item .item-title').allInnerTexts(), ['Lancer les tests du projet', 'Lancer le script db:migrate']);
    const box = (selector: string) => page.locator(selector).first().evaluate((element: any) => element.getBoundingClientRect().top);
    assert.ok(await box('#handled-items') > await box(`#inbox-list section:first-of-type li:nth-child(${waiting})`), 'below what waits');
    // The top bar names the screen; the list has no heading of its own drawn, the screen's one is read out (P224).
    assert.deepEqual(await page.locator('#screen h1').evaluateAll((all: any[]) => all.map((h) => [h.textContent, h.getBoundingClientRect().height <= 1])), [['Réception', true]]);
  });
});

test('a row\'s answer shows its item, says what it did there, and puts the focus on its detail', { skip }, async () => {
  await withInbox(async (page, base) => {
    const sent: string[] = [];
    await page.route(/\/api\/service\/sessions\/[^/]+\/requests\/[^/]+\/answer$/, async (route: any) => {
      sent.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"accepted":true}' });
    });
    await page.goto(`${base}/inbox`);
    const row = page.locator('#inbox-list li:has(a.item[data-item*="request-review-1"])');
    await row.locator('[data-row-act="reject_once"]').click();
    await page.locator('#detail .d-done').waitFor();
    assert.match(await page.evaluate(() => document.location.hash), /request-review-1/, 'the answered item is the one shown');
    assert.equal((await page.locator('#detail .d-done').innerText()).trim(), 'Refusé. Le motif est transmis à la session.');
    await page.waitForFunction(() => document.activeElement?.id === 'detail', undefined, { timeout: 2000 });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'detail', 'and it stays there once the cache has moved the item');
    assert.equal((await page.locator('#inbox-live').innerText()).trim(), 'Refusé. Le motif est transmis à la session.');
    assert.equal(sent.length, 1);
    assert.match(sent[0] ?? '', /\/requests\/request-review-1\/answer$/);
  });
});

test('an answer the service finds settled says so once, and the item leaves what waits; the fixtures source answers a request for real', { skip }, async () => {
  await withInbox(async (page, _base, open) => {
    // The fixtures source keeps the answer: the request is handled, and a second answer is a 409.
    await open(WIDTHS[0]);
    await page.evaluate(() => document.getElementById('screen')?.focus());
    await page.keyboard.press('t');
    await page.locator('#detail .d-done').waitFor();
    assert.equal((await page.locator('#detail .d-done').innerText()).trim(), 'Autorisé pour ce projet. La session continue.');
    await page.locator('#handled-toggle[aria-expanded="true"]').waitFor({ timeout: 5000 });
    assert.equal(await page.locator('#handled-items a.item[data-item*="request-review-1"]').count(), 1, 'in "Traité", opened since it is the item shown');
    assert.equal(await page.locator('#inbox-list section:first-of-type a.item[data-item*="request-review-1"]').count(), 0, 'no longer under what waits');
    // A request settled elsewhere: one line, no note repeating it.
    await page.route(/\/requests\/[^/]+\/answer$/, (route: any) => route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"answered"}' }));
    const items = await (await page.request.get(`${_base}/api/service/inbox`)).json() as { id: string; kind: string; state: string; reasonCode?: string }[];
    const other = items.find((item) => item.kind === 'permission' && item.state === 'waiting');
    await page.goto(`${_base}/inbox#${encodeURIComponent(other?.id ?? '')}`);
    await page.locator('#detail [data-act="reject_once"]').click();
    await page.locator('#detail .d-done').waitFor();
    assert.equal((await page.locator('#detail .d-done').innerText()).trim(), 'Réglé depuis la session.');
    assert.equal((await page.locator('#d-note').innerText()).trim(), '', 'said once');
  });
});

test('A on a walked row that is not the one shown shows it first; A again answers it', { skip }, async () => {
  await withInbox(async (page, base) => {
    const sent: string[] = [];
    await page.route(/\/requests\/[^/]+\/answer$/, async (route: any) => {
      sent.push(route.request().url());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"accepted":true}' });
    });
    await page.goto(`${base}/inbox`);
    const row = page.locator('#inbox-list a.item[data-item*="request-review-1"]');
    await row.focus();
    await page.keyboard.press('a');
    await page.waitForFunction(() => document.location.hash.includes('request-review-1'));
    assert.equal(sent.length, 0, 'the first A shows the row');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-item') ?? ''), await row.getAttribute('data-item'), 'the focus stays on the row');
    await page.keyboard.press('a');
    await page.locator('#detail .d-done').waitFor();
    assert.equal(sent.length, 1, 'the second answers it');
    assert.match(sent[0] ?? '', /request-review-1\/answer$/);
  });
});
