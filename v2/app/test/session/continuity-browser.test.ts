// The session view follows the ticket in a real browser
// (docs/v2/ui-overhaul-plan.md, 2.3, U6 and U7, lane 36), on the session
// fixture's LOCAL-161, its author done, its review not started:
//   - with the author's view open on its Editor, the reviewer starts (an
//     event on the fixtures' change stream): the handover row and the
//     reviewer's rows arrive in the same view, in one document, the view
//     and the Editor's diff the same nodes, the status the reviewer's;
//   - the address is replaced by the reviewer's without a navigation, and a
//     reload of it draws the same ticket view;
//   - Take over is offered on the reviewer and opens its terminal once;
//   - the filters keep one role's rows;
//   - a view kept hidden while the person is on another screen opens no
//     stream and reads nothing.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/session/continuity-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AUTHOR_ID, REVIEWER_ID, TICKET_ID, sessionFixture, sessionSource, startReview } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { PASSWORD, startApp } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const ENGINE = 'src/engine/upcoming.mjs';

test('the reviewer\'s start continues the author\'s view: a handover row, the same view and diff, the address replaced, Take over on the reviewer; hidden, it reads nothing', { skip }, async () => {
  const fixture = sessionFixture(FIXTURE_NOW, { review: 'later' });
  const source = sessionSource(fixture);
  const app = await startApp({ source });
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        const seen = ((window as unknown as { violations?: string[] }).violations ??= []);
        seen.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const requests: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    page.on('request', (request: { url(): string }) => requests.push(new URL(request.url()).pathname + new URL(request.url()).search));
    let documents = 0;
    page.on('load', () => { documents += 1; });
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.goto(`${app.base}/sessions/${AUTHOR_ID}`);
    await page.locator('#timeline [data-row]').first().waitFor();
    assert.equal(await page.locator('#status .phrase-title').innerText(), 'Done');
    assert.equal(await page.locator('[data-filter]').count(), 0, 'one session: no filter yet');

    // The author's diff, open in the Editor.
    await page.locator('[role="tab"][aria-controls="tab-editor"]').click();
    await page.locator(`#tab-editor [data-file="${ENGINE}"]`).click();
    await page.locator('#tab-editor tr.line.add').first().waitFor();
    assert.equal(await page.locator('#tab-editor tr.line.add').count(), 24);
    await page.evaluate(() => {
      (document.querySelector('[data-session-view] .session') as unknown as { kept: string }).kept = 'view';
      (document.querySelector('#tab-editor table.code') as unknown as { kept: string }).kept = 'diff';
    });
    const loaded = documents;

    // The reviewer starts: the change stream says so.
    startReview(fixture);
    source.changed('session', REVIEWER_ID);
    source.changed('ticket', TICKET_ID);
    await page.locator('#timeline [data-row="handover"]').waitFor({ state: 'attached' });
    await page.waitForFunction(() => document.querySelector('#status .phrase-title')?.textContent === 'Reading the diff of src/engine/upcoming.mjs');
    await page.waitForURL(new RegExp(`/sessions/${REVIEWER_ID}#editor$`));
    const after = await page.evaluate(() => ({
      view: (document.querySelector('[data-session-view] .session') as unknown as { kept?: string } | null)?.kept,
      diff: (document.querySelector('#tab-editor table.code') as unknown as { kept?: string } | null)?.kept,
      added: document.querySelectorAll('#tab-editor tr.line.add').length,
      views: document.querySelectorAll('[data-session-view]').length,
      navigations: performance.getEntriesByType('navigation').length,
      handover: document.querySelector('#timeline [data-row="handover"]')?.textContent,
      rows: [...document.querySelectorAll('#timeline [data-row]')].map((row) => row.getAttribute('data-row')),
      said: [...document.querySelectorAll('[role="status"][aria-live="polite"]')].map((node) => node.textContent).join(' '),
    }));
    assert.deepEqual({ view: after.view, diff: after.diff, added: after.added, views: after.views, navigations: after.navigations },
      { view: 'view', diff: 'diff', added: 24, views: 1, navigations: 1 }, 'the same view and the same diff, in one document, one view of the ticket');
    assert.equal(documents, loaded, 'no document loaded');
    assert.match(after.handover ?? '', /^Reviewer \(Sonnet\) took over at \d\d:\d\d; the author's work is above$/);
    assert.deepEqual(after.rows.slice(after.rows.indexOf('handover')), ['handover', 'run', 'read'], 'the reviewer\'s rows below it');
    assert.match(after.said, /Reviewer \(Sonnet\) took over/, 'said once, politely');

    // Take over on the reviewer: its terminal, opened once.
    await page.locator('[role="tab"][aria-controls="tab-terminal"]').click();
    await page.locator('#status #takeover').click();
    await page.locator('#tab-terminal [data-terminal-state="open"]').waitFor();
    assert.deepEqual(source.calls.filter((c) => /takeover|terminal\/open/.test(c.path)).map((c) => c.path), [`/api/sessions/${REVIEWER_ID}/takeover`, `/api/sessions/${REVIEWER_ID}/terminal/open`]);
    await page.locator('#status #giveback').click();
    await page.locator('#status #takeover').waitFor();

    // A reload of the address lands on the same ticket view.
    await page.reload();
    await page.locator('#timeline [data-row="handover"]').waitFor();
    assert.match(page.url(), new RegExp(`/sessions/${REVIEWER_ID}`));
    // Both threads read: the author's first row, and the reviewer's rows.
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#timeline [data-row]')].map((row) => row.getAttribute('data-row'));
      const handover = rows.indexOf('handover');
      return rows[0] === 'read' && handover > 0 && rows.length - handover >= 4;   // the reviewer's run, read, and the take over's interrupted turn
    });
    const before = await page.locator('#timeline [data-row]').count();
    await page.locator('[data-filter="author"]').click();
    await page.locator('#timeline [data-row="handover"]').waitFor({ state: 'detached' });
    assert.ok(await page.locator('#timeline [data-row]').count() < before, 'the author\'s rows alone');
    await page.locator('[data-filter="all"]').click();

    // Hidden: the view opens no stream and reads nothing.
    await page.locator('header nav a[href="/inbox"]').click();
    await page.waitForURL(`${app.base}/inbox`);
    await page.locator('[data-session-view]').first().waitFor({ state: 'hidden' });
    await page.waitForTimeout(300);
    const from = requests.length;
    await page.waitForTimeout(4000);
    const read = requests.slice(from).filter((path) => path.startsWith('/api/service/sessions') || path.includes('/steps'));
    assert.deepEqual(read, [], 'a hidden view reads nothing');
    // Shown again, its live session's stream opens again.
    const back = requests.length;
    await page.goBack();
    await page.waitForURL(new RegExp(`/sessions/${REVIEWER_ID}`));
    for (let wait = 0; !requests.slice(back).some((path) => path.startsWith(`/api/service/sessions/${REVIEWER_ID}/events`)); wait++) {
      assert.ok(wait < 50, 'the reviewer\'s stream opens again once shown');
      await page.waitForTimeout(100);
    }
    assert.deepEqual(await page.evaluate(() => (window as unknown as { violations?: string[] }).violations ?? []), [], 'no policy violation');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /\u27e6/, 'no missing key drawn');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
  }
});
