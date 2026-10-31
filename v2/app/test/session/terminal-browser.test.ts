// The web terminal and the editable editor in a real browser, against the
// session fixture's source (decisions 32 and 33, lane 32), on the app's
// loopback address, where the terminal is offered:
//   - Take over mounts the terminal on the session's harness (owner request
//     of 2026-10-22 17:26); a line typed to it and, after Shell, `ls` and
//     Enter reach the input route; the fixture's stand-ins answer;
//   - the editor opens a changed file, saves it with the hash it loaded,
//     shows a stale hash's conflict with Reload, and a refusal's rule and
//     reason;
//   - with both packages mounted, after a line in 256 colours and one in
//     24-bit colour, a selection in the terminal, typing in the editor, its
//     search panel and its completion list, the page counts no
//     securitypolicyviolation (lane 30's and lane v2-j2-deps-xterm's probes,
//     now in the repository; run it again on every bump of either package).
// Run only when CLEARED_V2_PLAYWRIGHT names the folder of an installed
// playwright-core (not a dependency of v2), as the other browser tests:
//
//   CLEARED_V2_PLAYWRIGHT=/path/to/node_modules/playwright-core \
//   CLEARED_V2_CHROME=/path/to/chrome node --test app/test/session/terminal-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AUTHOR_ID, fixtureFile, sessionFixture, sessionSource, type SessionSource } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { sendJson } from '../../src/proxy.ts';
import { PASSWORD, startApp } from '../support.ts';
import { openDetails } from './fold.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';
const ENGINE = 'src/engine/upcoming.mjs';

// The fixture's source, with the saves after the first answered as the
// test says: a stale hash, then a refusal by the policy.
function scripted(source: SessionSource, answers: { status: number; body: unknown }[]): SessionSource {
  let saves = 0;
  return {
    ...source,
    forward(request, response, forward) {
      if (forward.method === 'PUT' && saves++ > 0) {
        const answer = answers.shift();
        if (answer) {
          source.calls.push({ method: 'PUT', path: forward.path, user: forward.user.id, body: null });
          request.resume();
          return sendJson(response, answer.status, answer.body);
        }
      }
      source.forward(request, response, forward);
    },
  };
}

test('Take over, type in the terminal, save in the editor; no policy violation with both mounted', { skip }, async () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const base = sessionSource(fixture);
  const current = fixtureFile(ENGINE, 'current');
  assert.ok(current);
  const source = scripted(base, [
    { status: 409, body: { error: 'the file changed since the editor loaded it: reload it', rule: null, reason: 'the file changed since the editor loaded it: reload it', hash: 'f'.repeat(64), confirmable: false } },
    { status: 403, body: { error: 'nothing allows this edit without asking', rule: 'default', reason: 'nothing allows this edit without asking', confirmable: false } },
  ]);
  const app = await startApp({ source });
  const errors: string[] = [];
  const away: string[] = [];
  let browser: any;
  try {
    assert.match(app.base, /^http:\/\/127\.0\.0\.1:\d+$/, 'the loopback address, where the terminal is offered');
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
    // Each time the terminal comes into the page or leaves it.
    await context.addInitScript(() => {
      const moves: string[] = [];
      (window as unknown as { moves: string[] }).moves = moves;
      let there = false;
      new MutationObserver(() => {
        const now = document.querySelector('[data-terminal-state]') !== null;
        if (now !== there) moves.push(now ? 'in' : 'out');
        there = now;
      }).observe(document, { subtree: true, childList: true });
    });
    const page = await context.newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    page.on('request', (request: { url(): string }) => { if (!request.url().startsWith(app.base)) away.push(request.url()); });
    // The list of sessions answered as the service had it when asked, 400 ms
    // later, as a slow runner's: the session's own answer lands first.
    let given = false;
    const late = new Set<unknown>();                         // the list reads asked after Give back
    await page.route((url: URL) => url.pathname === '/api/service/sessions', async (route: any) => {
      if (given) late.add(route.request());
      const answer = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({ response: answer });
    });
    const moves = () => page.evaluate(() => (window as unknown as { moves: string[] }).moves);
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'alex');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.goto(`${app.base}/sessions/${AUTHOR_ID}`);
    await openDetails(page);
    await page.locator('#timeline [data-row]').first().waitFor();
    assert.equal(await page.evaluate(() => typeof (document.querySelector('meta[property="csp-nonce"]') as HTMLMetaElement | null)?.nonce), 'string');

    // Take over: the web terminal opens on the session's harness (owner request of 2026-10-22 17:26), no command to copy.
    await page.locator('#takeover').click();
    await page.locator('[data-terminal-state="open"][data-mode="harness"]').waitFor();
    const rows = page.locator('#tab-terminal .xterm-rows');
    await rows.getByText('resumed on this session').waitFor();
    assert.equal(await page.locator('#resume-command').count(), 0, 'no command to run on the server');
    assert.doesNotMatch(await page.locator('#tab-terminal').innerText(), /docker exec|on the server/);
    await page.locator('#tab-terminal .term-host').click();
    await page.keyboard.type('what changed?');
    await page.keyboard.press('Enter');
    await rows.getByText('stand-in for the harness').waitFor();

    // Shell, the second choice: the harness leaves, a shell opens in the same container.
    await page.locator('#tab-terminal [data-act="terminal_shell"]').click();
    await page.locator('[data-terminal-state="open"][data-mode="shell"]').waitFor();
    await rows.getByText('24-bit colour').waitFor();
    await rows.getByText('256 colours').waitFor();
    await page.locator('#tab-terminal .term-host').click();
    await page.keyboard.type('ls');
    await page.keyboard.press('Enter');
    await rows.getByText('upcoming.test.mjs').waitFor();
    const typed = base.calls.filter((c) => c.path.endsWith('/terminal/input')).map((c) => (c.body as { data: string }).data).join('');
    assert.equal(typed, 'what changed?\rls\r', 'the keys as typed, Enter as a carriage return');
    assert.deepEqual(base.calls.filter((c) => c.path.endsWith('/terminal/open')).map((c) => (c.body as { mode: string }).mode), ['harness', 'shell']);
    assert.equal(base.calls.filter((c) => c.path.endsWith('/terminal/close')).length, 1, 'the harness closed before the shell opened');
    assert.deepEqual(await moves(), ['in'], 'the terminal stays from Take over on, a list read before it notwithstanding');
    // A selection across the coloured lines: xterm writes its colours as style attributes there.
    const box = await page.locator('#tab-terminal .xterm-screen').boundingBox();
    assert.ok(box);
    await page.mouse.move(box.x + 4, box.y + 4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.ok((await page.evaluate(() => getSelection()?.toString() ?? '')).length > 0 || await page.locator('#tab-terminal .xterm-selection div').count() > 0, 'something is selected');

    // The editor: a changed file, opened for editing, typed in, searched, completed.
    await page.locator('[role="tab"][aria-controls="tab-editor"]').click();
    await page.locator(`#tab-editor [data-file="${ENGINE}"]`).click();
    await page.locator('#tab-editor [data-act="editor_mode_file"], #tab-editor [aria-pressed]').first().waitFor();
    await page.locator('#tab-editor [data-act="editor_edit"]').click();
    await page.locator('#tab-editor .cm-editor').waitFor();
    await page.locator('#tab-editor .cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\n// checked by hand\nup');
    await page.keyboard.press('Control+Space');
    await page.locator('.cm-tooltip-autocomplete').waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+f');
    await page.locator('#tab-editor .cm-search').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#tab-editor [data-editor-state="changed"]').waitFor();

    // The save carries the hash it loaded; the next, a stale hash, then a refusal.
    await page.locator('#tab-editor [data-act="editor_save"]').click();
    await page.locator('#tab-editor [data-editor-state="saved"]').waitFor();
    const put = base.calls.find((c) => c.method === 'PUT');
    assert.equal(put?.path, `/api/sessions/${AUTHOR_ID}/files/${ENGINE}`);
    assert.equal((put?.body as { hash: string }).hash, current.hash, 'the loaded hash');
    assert.match((put?.body as { text: string }).text, /\/\/ checked by hand\nup/);
    await page.keyboard.type('x');
    await page.locator('#tab-editor .cm-content').click();
    await page.keyboard.type(' again');
    await page.locator('#tab-editor [data-act="editor_save"]').click();
    await page.locator('#tab-editor [data-editor-state="conflict"]').waitFor();
    assert.match(await page.locator('#tab-editor .editor-state').innerText(), /changed since you opened it/);
    await page.locator('#tab-editor [data-act="editor_reload"]').click();
    await page.locator('#tab-editor [data-editor-state="clean"]').waitFor();
    await page.locator('#tab-editor .cm-content').click();
    await page.keyboard.type('y');
    await page.locator('#tab-editor [data-act="editor_save"]').click();
    await page.locator('#tab-editor [data-editor-state="refused"]').waitFor();
    const refused = await page.locator('#tab-editor .editor-state').innerText();
    assert.match(refused, /nothing allows this edit without asking/);
    assert.match(refused, /default/);

    // Back to the terminal: still there, still counting nothing.
    await page.locator('[role="tab"][aria-controls="tab-terminal"]').click();
    await rows.getByText('upcoming.test.mjs').waitFor();
    const violations = await page.evaluate(() => (window as unknown as { violations: string[] }).violations);
    assert.deepEqual(violations, [], 'no securitypolicyviolation on the session screen');
    assert.ok(await page.locator('style[nonce]').count() > 0, 'the packages\' style elements carry the nonce');

    // Give back closes the terminal: no Open again, the timeline back.
    const opens = base.calls.filter((c) => c.path.endsWith('/terminal/open')).length;
    const after = page.waitForResponse((answer: { request(): unknown }) => late.has(answer.request()));
    given = true;
    await page.locator('#giveback').click();
    await page.locator('#takeover').waitFor();
    await page.locator('#timeline').waitFor();
    assert.equal(await page.locator('.term-host').count(), 0);
    // The list read before Give back lands after it, then the one after: the terminal does not come back.
    await after;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await moves(), ['in', 'out'], 'the terminal leaves once, at Give back');
    assert.equal(base.calls.filter((c) => c.path.endsWith('/terminal/open')).length, opens, 'no terminal opened after Give back');
  } finally {
    await browser?.close();
    await app.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(away, []);
});

test('on the public origin the terminal is not offered: why, and no command', { skip }, async () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const source = sessionSource(fixture);
  const app = await startApp({ source, extra: { publicOrigin: 'https://cleared.example.invalid' } });
  let browser: any;
  try {
    await app.directory.add('alex', PASSWORD);
    const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
    const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
    browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' })).newPage();
    // The page asks /api/me, which says terminal: false for a request that came through the public origin.
    await page.route('**/api/me', async (route: any) => {
      const answer = await route.fetch();
      const me = await answer.json();
      await route.fulfill({ response: answer, json: { ...me, terminal: false } });
    });
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'alex');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.goto(`${app.base}/sessions/${AUTHOR_ID}`);
    await openDetails(page);
    await page.locator('#takeover').click();
    await page.locator('#tab-terminal .takeover').waitFor();
    const notice = await page.locator('#tab-terminal .takeover').innerText();
    assert.match(notice, /this machine/);
    assert.doesNotMatch(notice, /docker exec|on the server/, 'no command to run on the server');
    assert.equal(await page.locator('#resume-command').count(), 0);
    assert.equal(await page.locator('.term-host').count(), 0, 'no web terminal');
    assert.equal(source.calls.filter((c) => c.path.includes('/terminal/')).length, 0);
  } finally {
    await browser?.close();
    await app.close();
  }
});
