// The sessions kept mounted and the screens' boundary in a real browser
// (docs/v2/ui-overhaul-plan.md, 2.1.5, U4 and U10, lane 34):
//   - a session taken over, its terminal typed in and a file opened in its
//     editor; a visit to the inbox and back (a click, then the browser's
//     Back) finds the same terminal and editor (never made again: one
//     terminal open, the same nodes), the terminal's lines and the editor's
//     unsaved text, in one document;
//   - a switch moves the focus to the new screen and says its title;
//   - a message leaves the composer at once and comes back when refused;
//   - two sessions visited A, B, A, B: neither moves in the page (the
//     browser frame is not loaded again, the terminal is the same), the
//     shown one holds the only copy of its ids, and the tower's scroll is
//     given back on return;
//   - a screen that throws while it draws shows which screen failed and a
//     way to draw it again; the sidebar stays, and the other screens draw.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/foundation/stack-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AUTHOR_ID, fixturePreview, sessionFixture, sessionSource } from '../../fixtures/session.ts';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { createPreviewHandler } from '../../src/preview.ts';
import { sendJson, type DataSource } from '../../src/proxy.ts';
import { PASSWORD, startApp, type Running } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const ENGINE = 'src/engine/upcoming.mjs';

// The browser asks for the app's language (lane i18n: a page follows the browser's languages first).
async function signedInPage(app: Running, run: (page: any, errors: string[]) => Promise<void>, start = '/', locale = 'en-US'): Promise<void> {
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale });
    // A policy violation fails the test as loudly as a page error (review of 248, F7).
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        const seen = ((window as unknown as { violations?: string[] }).violations ??= []);
        seen.push(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error: Error) => errors.push(error.message));
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'owner');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    if (start !== '/') await page.goto(`${app.base}${start}`);
    await run(page, errors);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { violations?: string[] }).violations ?? []), [], 'no policy violation');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /\u27e6/, 'no missing key drawn');
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

      await page.locator('#nav a[href="/inbox"]').click();
      await page.waitForURL(`${app.base}/inbox`);
      await page.locator('#screen > [data-session-view]').first().waitFor({ state: 'hidden' });
      // What a page load did for a screen reader: the new screen's title said. A move started in the
      // sidebar keeps the focus on the item pressed (lane 35); Back moves it to the screen, as a load did.
      await page.waitForFunction(() => document.querySelector('#screen-said')?.textContent === 'Cleared · Inbox');
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.nav), 'inbox');
      assert.equal(await page.title(), 'Cleared · Inbox');
      await page.goBack();
      await page.waitForURL(new RegExp(`/sessions/${AUTHOR_ID}`));
      await page.waitForFunction(() => document.activeElement?.id === 'screen');
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

async function broken(): Promise<DataSource> {
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
  return source;
}

test('a screen that throws says so, in its language, and offers to try again; the sidebar stays and the other screens draw', { skip }, async () => {
  const fr = await startApp({ source: await broken(), extra: { language: 'fr' } });
  try {
    await signedInPage(fr, async (page) => {
      const failed = page.locator('[data-failed="session"]');
      await failed.waitFor();
      assert.match(await failed.innerText(), /Chargement impossible\u00a0: Sessions\./, 'the screen\'s name from the French catalog, not a mark');
      assert.equal(await page.locator('#boundary-retry').innerText(), 'Réessayer');
    }, '/sessions', 'fr-FR');
  } finally {
    await fr.close();
  }
  const app = await startApp({ source: await broken() });
  try {
    await signedInPage(app, async (page) => {
      const failed = page.locator('[data-failed="session"]');
      await failed.waitFor();
      assert.match(await failed.innerText(), /Could not load Sessions\./, 'the screen\'s name, translated');
      assert.equal(await page.locator('#boundary-retry').innerText(), 'Try again');
      assert.equal(await page.locator('#nav a[href="/lead"]').count(), 1, 'the sidebar stays');
      await page.locator('#boundary-retry').click();
      await failed.waitFor();
      await page.locator('#nav a[href="/lead"]').click();
      await page.locator('.lead-screen:not([aria-busy])').waitFor();
      assert.equal(await failed.count(), 0);
    }, '/sessions');
  } finally {
    await app.close();
  }
});

test('two sessions visited A, B, A, B: neither moves, the frame is not loaded again, the terminal is the same, the shown one holds its ids alone; the tower\'s scroll comes back', { skip }, async () => {
  const preview = createServer();
  await new Promise<void>((done) => preview.listen(0, '127.0.0.1', done));
  const previewBase = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { previewOrigin: previewBase } });
  const pages: string[] = [];
  preview.on('request', (request) => { if (request.headers['sec-fetch-dest'] === 'iframe') pages.push(request.url ?? ''); });
  preview.on('request', createPreviewHandler({ upstream: fixturePreview(), origin: previewBase, appOrigins: [app.origin] }));
  try {
    await signedInPage(app, async (page) => {
      const opens: string[] = [];
      page.on('request', (request: { url(): string }) => { if (request.url().endsWith('/terminal/open')) opens.push(request.url()); });
      const go = async (path: string) => {
        await page.evaluate((href: string) => {
          const link = document.createElement('a');
          link.href = href;
          document.body.append(link);
          link.click();
          link.remove();
        }, path);
        await page.waitForURL((url: URL) => url.pathname === path);
      };
      // Short enough for the tower (rows since lane 35) to scroll 240 px.
      await page.setViewportSize({ width: 1280, height: 400 });
      await page.locator('#tower-body .tower').waitFor();
      await page.evaluate(() => window.scrollTo(0, 240));
      await page.waitForFunction(() => window.scrollY === 240);

      const sessions = await (await page.request.get(`${app.base}/api/service/sessions`)).json() as { id: string; role: string }[];
      const [a, b] = sessions.filter((s) => s.role === 'author').map((s) => s.id);
      assert.ok(a && b, 'two authors in the fixtures');
      const view = (id: string) => `[data-session-view="${id}"]`;

      await go(`/sessions/${a}`);
      await page.locator(`${view(a)} [role="tab"][aria-controls="tab-browser"]`).click();
      await page.locator(`${view(a)} iframe`).waitFor();
      await page.waitForFunction(() => true);
      const loaded = pages.length;
      assert.ok(loaded >= 1, 'the preview drawn in its frame');
      await page.evaluate((selector: string) => { (document.querySelector(selector) as unknown as { kept: string }).kept = 'frame'; }, `${view(a)} iframe`);

      await go(`/sessions/${b}`);
      await page.locator(`${view(b)} #takeover`).click();
      await page.locator(`${view(b)} .xterm`).waitFor();
      await page.evaluate((selector: string) => { (document.querySelector(selector) as unknown as { kept: string }).kept = 'terminal'; }, `${view(b)} .xterm`);
      const order = () => page.evaluate(() => [...document.querySelectorAll('[data-session-view]')].map((el) => (el as HTMLElement).dataset.sessionView));
      const before = await order();

      await go(`/sessions/${a}`);
      await page.locator(`${view(a)} iframe`).waitFor();
      await go(`/sessions/${b}`);
      await page.locator(`${view(b)} .xterm`).waitFor();
      assert.deepEqual(await order(), before, 'no session moved in the page');
      assert.deepEqual(await page.evaluate((s: string) => (document.querySelector(s) as unknown as { kept?: string } | null)?.kept, `${view(a)} iframe`), 'frame');
      assert.deepEqual(await page.evaluate((s: string) => (document.querySelector(s) as unknown as { kept?: string } | null)?.kept, `${view(b)} .xterm`), 'terminal');
      assert.equal(pages.length, loaded, 'the frame was not loaded again');
      assert.equal(opens.length, 1, 'the terminal opened once');
      const ids = await page.evaluate(() => ({
        message: document.querySelectorAll('#message').length,
        terminal: document.querySelectorAll('#tab-terminal').length,
        owner: (document.getElementById('message')?.closest('[data-session-view]') as HTMLElement | null)?.dataset.sessionView,
      }));
      assert.deepEqual(ids, { message: 1, terminal: 1, owner: b }, 'the shown session holds its ids alone');

      await page.locator('#nav a[href="/"]').click();
      await page.locator('#tower-body .tower').waitFor();
      await page.waitForFunction(() => window.scrollY === 240, undefined, { timeout: 3000 });
    });
  } finally {
    await app.close();
    preview.closeAllConnections();
    await new Promise<void>((done) => preview.close(() => done()));
  }
});
