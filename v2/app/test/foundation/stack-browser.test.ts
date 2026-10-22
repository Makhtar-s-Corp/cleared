// The sessions kept mounted and the screens' boundary in a real browser
// (docs/v2/ui-overhaul-plan.md, 2.1.5, U4 and U10, lane 34):
//   - a session taken over, its terminal typed in and a file opened in its
//     editor; a visit to the inbox and back (a click, then the browser's
//     Back) finds the same terminal and editor (never made again: one
//     terminal open, the same nodes), the terminal's lines and the editor's
//     unsaved text, in one document;
//   - a switch moves the focus to the new screen and says its title;
//   - a message leaves the composer at once and comes back when refused;
//   - a screen that throws while it draws shows which screen failed and a
//     way to draw it again; the header stays, and the other screens draw.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/foundation/stack-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AUTHOR_ID, sessionFixture, sessionSource } from '../../fixtures/session.ts';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { sendJson, type DataSource } from '../../src/proxy.ts';
import { PASSWORD, startApp, type Running } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const ENGINE = 'src/engine/upcoming.mjs';

async function signedInPage(app: Running, run: (page: any, errors: string[]) => Promise<void>, start = '/'): Promise<void> {
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    if (start !== '/') await page.goto(`${app.base}${start}`);
    await run(page, errors);
  } finally {
    await browser.close();
  }
}

test('a message comes back when refused; a session\'s terminal and editor live through a visit to the inbox: made once, their text kept, one document', { skip }, async () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const source = sessionSource(fixture);
  const app = await startApp({ source });
  try {
    await signedInPage(app, async (page, errors) => {
      await page.locator('#timeline [data-row]').first().waitFor();

      // A message: the composer empties before the route answers, and the text comes back on a refusal.
      let answer!: () => void;
      const answered = new Promise<void>((done) => { answer = done; });
      await page.route('**/api/service/sessions/*/messages', async (route: any) => {
        await answered;
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the session stopped' }) });
      });
      await page.locator('#message').fill('Use the week of the first day.');
      await page.locator('#send').click();
      await page.waitForFunction(() => (document.querySelector('#message') as HTMLInputElement | null)?.value === '');
      answer();
      await page.waitForFunction(() => (document.querySelector('#message') as HTMLInputElement | null)?.value === 'Use the week of the first day.');
      await page.unroute('**/api/service/sessions/*/messages');

      await page.locator('#takeover').click();
      const rows = page.locator('#tab-terminal .xterm-rows');
      await rows.getByText('resumed on this session').waitFor();
      await page.locator('#tab-terminal .term-host').click();
      await page.keyboard.type('what changed?');
      await page.keyboard.press('Enter');
      await rows.getByText('stand-in for the harness').waitFor();

      await page.locator('[role="tab"][aria-controls="tab-editor"]').click();
      await page.locator(`#tab-editor [data-file="${ENGINE}"]`).click();
      await page.locator('#tab-editor [data-act="editor_edit"]').click();
      await page.locator('#tab-editor .cm-content').click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type('\n// kept across the screens');
      await page.locator('#tab-editor [data-editor-state="changed"]').waitFor();

      const opens = () => source.calls.filter((c) => c.path.endsWith('/terminal/open')).length;
      assert.equal(opens(), 1);
      await page.evaluate(() => {
        (document.querySelector('#tab-terminal .xterm') as unknown as { kept: string }).kept = 'terminal';
        (document.querySelector('#tab-editor .cm-editor') as unknown as { kept: string }).kept = 'editor';
      });

      await page.locator('header nav a[href="/inbox"]').click();
      await page.waitForURL(`${app.base}/inbox`);
      await page.locator('#screen > [data-session-view]').first().waitFor({ state: 'hidden' });
      // What a page load did for a keyboard and a screen reader: focus at the new screen, its title said.
      await page.waitForFunction(() => document.querySelector('#screen-said')?.textContent === 'Cleared · Inbox');
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'screen');
      assert.equal(await page.title(), 'Cleared · Inbox');
      await page.goBack();
      await page.waitForURL(new RegExp(`/sessions/${AUTHOR_ID}`));
      await page.locator('#tab-editor .cm-editor').waitFor();

      const kept = await page.evaluate(() => ({
        terminal: (document.querySelector('#tab-terminal .xterm') as unknown as { kept?: string } | null)?.kept,
        editor: (document.querySelector('#tab-editor .cm-editor') as unknown as { kept?: string } | null)?.kept,
        text: document.querySelector('#tab-editor .cm-content')?.textContent ?? '',
        documents: performance.getEntriesByType('navigation').length,
      }));
      assert.deepEqual({ terminal: kept.terminal, editor: kept.editor }, { terminal: 'terminal', editor: 'editor' }, 'the same terminal and editor, not made again');
      assert.match(kept.text, /kept across the screens/, 'the editor\'s unsaved text');
      assert.equal(kept.documents, 1, 'one document');
      await page.locator('[role="tab"][aria-controls="tab-terminal"]').click();
      await rows.getByText('stand-in for the harness').waitFor();
      assert.equal(opens(), 1, 'the terminal opened once');
      assert.deepEqual(errors, []);
    }, `/sessions/${AUTHOR_ID}`);
  } finally {
    await app.close();
  }
});

test('a screen that throws says so and offers to draw it again; the header stays and the other screens draw', { skip }, async () => {
  const fixtures = await fixtureSource({ now: () => FIXTURE_NOW });
  // The sessions index draws a list from /sessions: a service answering an object breaks it.
  const source: DataSource = {
    kind: fixtures.kind,
    forward(request, response, forward) {
      if (forward.method === 'GET' && forward.path === '/api/sessions') {
        request.resume();
        return sendJson(response, 200, { broken: true });
      }
      fixtures.forward(request, response, forward);
    },
  };
  const app = await startApp({ source });
  try {
    await signedInPage(app, async (page) => {
      const failed = page.locator('[data-failed="session"]');
      await failed.waitFor();
      assert.match(await failed.innerText(), /Sessions could not be drawn\./);
      assert.equal(await page.locator('#boundary-retry').innerText(), 'Draw it again');
      assert.equal(await page.locator('header nav a[href="/lead"]').count(), 1, 'the header stays');
      await page.locator('#boundary-retry').click();
      await failed.waitFor();
      await page.locator('header nav a[href="/lead"]').click();
      await page.locator('.lead-screen:not([aria-busy])').waitFor();
      assert.equal(await failed.count(), 0);
    }, '/sessions');
  } finally {
    await app.close();
  }
});
