// Open in an editor in a real browser, against the session fixture's source
// (docs/v2/complement-devin.md item 19, matrix C19, P120 to P125): the
// button in the thread's header opens two links, VS Code and Cursor, whose
// addresses are the service's answer as given; nothing is opened or run by
// the page (the links are followed by the person's own browser), a session
// the service gives no link for shows no button, and the page counts no
// securitypolicyviolation. Run only when CLEARED_V2_PLAYWRIGHT names the
// folder of an installed playwright-core (not a dependency of v2), as the
// other browser tests:
//
//   CLEARED_V2_PLAYWRIGHT=/path/to/node_modules/playwright-core \
//   CLEARED_V2_CHROME=/path/to/chrome node --test app/test/session/editor-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AUTHOR_ID, sessionFixture, sessionSource } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { sendJson } from '../../src/proxy.ts';
import { PASSWORD, startApp } from '../support.ts';
import { openDetails } from './fold.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';

test('Open in an editor: the button, the two links as the service gave them, no editor run and no violation', { skip }, async () => {
  const source = sessionSource(sessionFixture(FIXTURE_NOW));
  const app = await startApp({ source });
  const errors: string[] = [];
  const away: string[] = [];
  let browser: any;
  try {
    await app.directory.add('alex', PASSWORD);
    const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
    const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
    browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
    await context.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { violations: string[] }).violations = seen;
      document.addEventListener('securitypolicyviolation', (event) => seen.push(`${event.violatedDirective} ${event.blockedURI} ${event.sample}`));
    });
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    page.on('request', (request: { url(): string }) => { if (!request.url().startsWith(app.base)) away.push(request.url()); });
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'alex');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.goto(`${app.base}/sessions/${AUTHOR_ID}`);
    await openDetails(page);
    await page.locator('#timeline [data-row]').first().waitFor();

    const button = page.locator('#open-editor');
    await button.waitFor();
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('[data-editor]').count(), 0, 'no link before the button is pressed');
    await button.click();
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    const links = await page.locator('#open-editor-links a').evaluateAll((anchors: HTMLAnchorElement[]) => anchors.map((a) => [a.dataset.editor, a.getAttribute('href'), a.target]));
    assert.equal(links.length, 2);
    assert.deepEqual(links.map((l: string[]) => l[0]), ['vscode', 'cursor']);
    assert.match(links[0][1], /^vscode:\/\/file\/.+/);
    assert.match(links[1][1], /^cursor:\/\/file\/.+/);
    assert.deepEqual(links.map((l: string[]) => l[2]), ['', ''], 'no new tab');
    assert.deepEqual(await page.locator('#open-editor-links a').allInnerTexts(), ['VS Code', 'Cursor']);
    // The page runs nothing: no POST was made by pressing the button, and no terminal or file was touched.
    assert.deepEqual(source.calls.filter((c) => c.method !== 'GET').map((c) => c.path), [], 'no write');
    // Pressing it again closes it.
    await button.click();
    assert.equal(await page.locator('#open-editor-links').count(), 0);
    assert.deepEqual(await page.evaluate(() => (window as unknown as { violations: string[] }).violations), [], 'no securitypolicyviolation');
    assert.deepEqual(errors, []);
    assert.deepEqual(away, [], 'nothing fetched from another site');

    // In French.
    const fr = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'fr-FR' });
    const french = await fr.newPage();
    await french.goto(`${app.base}/login`);
    await french.fill('#name', 'alex');
    await french.fill('#password', PASSWORD);
    await french.click('button[type=submit]');
    await french.waitForURL(`${app.base}/`);
    await french.goto(`${app.base}/sessions/${AUTHOR_ID}`);
    await openDetails(french);
    await french.locator('#open-editor').waitFor();
    assert.match(await french.locator('#open-editor').innerText(), /Ouvrir dans un éditeur/);

    // The service gives no link (the checkout is gone, 409): no button.
    const gone = await startApp({
      source: { ...source, forward(request, response, forward) { return forward.path.endsWith('/editor') ? sendJson(response, 409, { error: 'the session\'s checkout is gone' }) : source.forward(request, response, forward); } },
    });
    try {
      await gone.directory.add('alex', PASSWORD);
      const other = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
      const none = await other.newPage();
      await none.goto(`${gone.base}/login`);
      await none.fill('#name', 'alex');
      await none.fill('#password', PASSWORD);
      await none.click('button[type=submit]');
      await none.waitForURL(`${gone.base}/`);
      await none.goto(`${gone.base}/sessions/${AUTHOR_ID}`);
      await openDetails(none);
      await none.locator('#timeline [data-row]').first().waitFor();
      await none.locator('#takeover').waitFor();
      assert.equal(await none.locator('#open-editor').count(), 0);
    } finally {
      await gone.close();
    }
  } finally {
    await browser?.close();
    await app.close();
  }
});
