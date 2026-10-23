// The shell in a real browser (docs/v2/ui-overhaul-plan.md, 2.2.1 to 2.2.3,
// lane 35), on the fixtures source:
//   - Ctrl-K (Cmd-K on a Mac) opens the palette; a ticket's number and Enter
//     open its session, in the page: one document, no policy violation;
//   - the palette lists what waits for the person, and a gesture of the
//     screen shown runs that screen's own button or field;
//   - `?` opens the sheet of shortcuts, Esc closes it and gives the focus back;
//   - J, K and Enter walk the tower's rows and open one; G then I, G then T
//     move between screens;
//   - `[` folds the sidebar to a rail, and the choice survives a reload.
//
//   CLEARED_V2_PLAYWRIGHT=$PWD/node_modules/playwright-core node --test app/test/shell/shell-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fixturePreview } from '../../fixtures/session.ts';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { createPreviewHandler } from '../../src/preview.ts';
import { PASSWORD, startApp } from '../support.ts';
import { loadCatalog } from '../../src/catalog.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
declare const document: any;
declare const window: any;
declare const performance: any;

async function withShell(run: (page: any, base: string) => Promise<void>, language: 'en' | 'fr' = 'en'): Promise<void> {
  const preview = createServer();
  await new Promise<void>((done) => preview.listen(0, '127.0.0.1', done));
  const previewBase = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }), extra: { previewOrigin: previewBase, language } });
  preview.on('request', createPreviewHandler({ upstream: fixturePreview(), origin: previewBase, appOrigins: [app.origin] }));
  const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
  const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
  const browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
  try {
    await app.directory.add('owner', PASSWORD);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: language === 'fr' ? 'fr-FR' : 'en-US' });
    await context.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event: any) => {
        (window.violations ??= []).push(`${event.violatedDirective} ${event.blockedURI}`);
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
    await page.locator('#tower-body .tower').waitFor();
    await run(page, app.base);
    assert.deepEqual(errors, [], 'no page error');
    assert.deepEqual(await page.evaluate(() => window.violations ?? []), [], 'no policy violation: the palette and the sheet inject no style');
    assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /\u27e6/, 'no missing key drawn');
  } finally {
    await browser.close();
    await app.close();
    preview.closeAllConnections();
    await new Promise<void>((done) => preview.close(() => done()));
  }
}

const documents = (page: any): Promise<number> => page.evaluate(() => performance.getEntriesByType('navigation').length);
const marked = (page: any): Promise<boolean> => page.evaluate(() => window.sameDocument === true);

test('Ctrl-K, a ticket\'s number and Enter open its session in the page; the palette lists what waits and runs a screen\'s gesture', { skip }, async () => {
  await withShell(async (page, base) => {
    await page.evaluate(() => { window.sameDocument = true; });
    await page.keyboard.press('Control+k');
    const palette = page.locator('#palette');
    await palette.waitFor();
    assert.ok(await page.evaluate(() => document.activeElement?.matches('#palette input')), 'the field has the focus');
    assert.ok(await page.locator('#palette [data-group="waiting"] [cmdk-item]').count() > 0, 'what waits for the person');
    assert.equal(await page.locator('.app').getAttribute('inert'), '', 'the app behind it is inert');
    await page.keyboard.type('161');
    await page.keyboard.press('Enter');
    await page.waitForURL(new RegExp(`^${base}/sessions/[A-Za-z0-9_-]+$`));
    await palette.waitFor({ state: 'detached' });
    await page.locator('.session:not([aria-busy]) #status').waitFor();
    assert.match(await page.locator('#top-bar').innerText(), /LOCAL-161 · Upcoming: group entries by week/, 'the bar names the ticket');
    assert.match(await page.title(), /^Cleared · LOCAL-161 · Upcoming: group entries by week$/);
    assert.ok(await marked(page), 'the same document');
    assert.equal(await documents(page), 1);

    // On the tower, "New ticket" focuses the bar's field.
    await page.locator('#nav a[href="/"]').click();
    await page.locator('#tower-body .tower').waitFor();
    await page.keyboard.press('Control+k');
    await palette.waitFor();
    await page.keyboard.type('New ticket');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'ask-input');
    // Opened from a field and closed with Esc, the palette gives the focus back to the field (art director, item 5).
    await page.locator('#ask-input').click();
    await page.keyboard.press('Control+k');
    await palette.waitFor();
    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.id === 'ask-input');
    // A session's gesture is not offered on the tower.
    await page.keyboard.press('Escape');
    await page.locator('#screen').focus();
    await page.keyboard.press('Control+k');
    await palette.waitFor();
    assert.equal(await page.locator('#palette [data-item="gesture-takeover"]').count(), 0);
    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'detached' });
  });
});

test('? opens the sheet, Esc closes it and gives the focus back; G then I and G then T move', { skip }, async () => {
  await withShell(async (page, base) => {
    await page.locator('#screen').focus();
    await page.keyboard.press('Shift+Slash');
    const sheet = page.locator('#shortcuts');
    await sheet.waitFor();
    for (const id of ['palette', 'sheet', 'sidebar', 'go_tower', 'go_inbox', 'next', 'previous', 'open', 'back', 'send']) {
      assert.equal(await sheet.locator(`[data-shortcut="${id}"]`).count(), 1, id);
    }
    assert.equal(await sheet.locator('[data-shortcut="tab_1"]').count(), 0, 'a session\'s keys are listed on a session only');
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'screen', 'the focus is back where it was');
    await page.evaluate(() => { window.sameDocument = true; });
    await page.keyboard.press('g');
    await page.keyboard.press('i');
    await page.waitForURL(`${base}/inbox`);
    await page.keyboard.press('g');
    await page.keyboard.press('t');
    await page.waitForURL(`${base}/`);
    assert.ok(await marked(page), 'the same document');
  });
});

test('J, K and Enter walk the tower\'s rows and open one, in the page', { skip }, async () => {
  await withShell(async (page, base) => {
    await page.evaluate(() => { window.sameDocument = true; });
    await page.locator('#screen').focus();
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute('href') ?? '');
    const rows: string[] = await page.locator('#screen [data-row]').evaluateAll((all: any[]) => all.map((a) => a.getAttribute('href')));
    assert.ok(rows.length >= 5, 'the tower has rows');
    await page.keyboard.press('j');
    assert.equal(await focused(), rows[0]);
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    assert.equal(await focused(), rows[2]);
    await page.keyboard.press('k');
    assert.equal(await focused(), rows[1]);
    // The pointer used since: Enter opens nothing the person walked away from (review of 252, item 2).
    await page.locator('#top-bar .here').click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    assert.equal(page.url(), `${base}/`, 'Enter opens nothing once the pointer was used');
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    assert.equal(await focused(), rows[1]);
    await page.keyboard.press('Enter');
    await page.waitForURL(`${base}${rows[1]}`);
    assert.ok(await marked(page), 'opened in the page');
  });
});

test('[ folds the sidebar to a rail, the choice survives a reload, and [ opens it again', { skip }, async () => {
  await withShell(async (page) => {
    const mode = () => page.locator('.app').getAttribute('data-sidebar');
    assert.equal(await mode(), 'open');
    await page.locator('#screen').focus();
    await page.keyboard.press('BracketLeft');
    assert.equal(await mode(), 'rail');
    // In the rail the screens keep their names for a screen reader.
    assert.equal(await page.locator('#nav a[href="/inbox"]').getAttribute('data-tip'), 'Inbox · G I', 'its tooltip: the name and the chord');
    assert.match(await page.locator('#nav a[href="/inbox"]').evaluate((a: any) => a.textContent), /Inbox/);
    await page.reload();
    await page.locator('#tower-body .tower').waitFor();
    assert.equal(await mode(), 'rail', 'kept across a reload');
    await page.locator('#sidebar-toggle').click();
    assert.equal(await mode(), 'open');
  });
});

// The English sentences the French catalogs of the shell, the tower and the lead do not share.
function englishOf(text: string): string | undefined {
  const all = (language: 'en' | 'fr') => Object.assign({}, ...(['shell', 'tower', 'lead'] as const).map((s) => loadCatalog(s, language))) as Record<string, string>;
  const en = all('en');
  const fr = all('fr');
  for (const [key, value] of Object.entries(en)) {
    // A template with under two letters of its own ("{n}s") says nothing of a language.
    if (fr[key] === value || (value.replace(/\{[a-z_]+\}/g, '').match(/\p{L}/gu) ?? []).length < 2) continue;
    const literal = value.split(/\{[a-z_]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?');
    if (new RegExp(`^${literal}$`).test(text)) return key;
  }
  return undefined;
}

test('in French, the default: the sidebar, the top bar, the palette and the sheet draw no English', { skip }, async () => {
  await withShell(async (page) => {
    assert.equal(await page.locator('html').getAttribute('lang'), 'fr');
    const lines = async (selector: string): Promise<string[]> => (await page.locator(selector).innerText()).split('\n').map((line: string) => line.trim()).filter(Boolean);
    const texts = [...await lines('#sidebar'), ...await lines('#top-bar')];
    await page.locator('#screen').focus();
    await page.keyboard.press('Control+k');
    texts.push(...await lines('#palette'));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Slash');
    texts.push(...await lines('#shortcuts'));
    assert.ok(texts.includes('Tour') && texts.includes('Réception') && texts.includes('Rechercher'), 'the screens and the search, in French');
    for (const text of texts) {
      const key = englishOf(text);
      assert.equal(key, undefined, `"${text}" is the English of ${key}`);
    }
  }, 'fr');
});
