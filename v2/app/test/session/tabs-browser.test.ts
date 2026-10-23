// The session screen's tabs in a real browser, against the fixture source
// (decisions 20 and 30, lane 20): the four tabs switch and the Go of a
// waiting session plan calls its route; and the Browser tab's isolation: a
// page planted in the preview, whose script posts the approve route and
// reads the session JSON, runs with an opaque origin, gets no cookie and a
// refused answer; the preview listener answers nothing but previews, and
// the app's origin never serves a preview. Run only when
// CLEARED_V2_PLAYWRIGHT names the folder of an installed playwright-core
// (not a dependency of v2), as the other browser tests:
//
//   CLEARED_V2_PLAYWRIGHT=/path/to/node_modules/playwright-core \
//   CLEARED_V2_CHROME=/path/to/chrome node --test app/test/session/tabs-browser.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { AUTHOR_ID, PREVIEW_KEY, TICKET_ID, fixturePreview, sessionFixture, sessionSource } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { createPreviewHandler, type PreviewUpstream } from '../../src/preview.ts';
import type { DataSource } from '../../src/proxy.ts';
import { PASSWORD, signedIn, startApp, type Running } from '../support.ts';

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;
const skip = PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set';

type Seen = { readonly errors: string[]; readonly away: string[] };
type Hit = { readonly method: string; readonly url: string; readonly headers: IncomingHttpHeaders };

// The app and its preview listener on free loopback ports; alex signs in
// through the page, then opens `path`. Every page error, every request that
// leaves the app's and the preview's origins, and every request each server
// received are kept.
async function browse(
  source: DataSource,
  path: string,
  run: (page: any, ctx: { app: Running; previewBase: string; appHits: Hit[]; previewHits: Hit[] }) => Promise<void>,
  upstream?: (appOrigin: string) => PreviewUpstream,
): Promise<Seen> {
  const preview = createServer();
  await new Promise<void>((resolve) => preview.listen(0, '127.0.0.1', resolve));
  const previewBase = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
  const app = await startApp({ source, extra: { previewOrigin: previewBase } });
  preview.on('request', createPreviewHandler({ upstream: (upstream ?? (() => fixturePreview()))(app.origin), origin: previewBase, appOrigins: [app.origin] }));
  const appHits: Hit[] = [];
  const previewHits: Hit[] = [];
  app.server.prependListener('request', (request) => appHits.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers }));
  preview.prependListener('request', (request) => previewHits.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers }));
  const errors: string[] = [];
  const away: string[] = [];
  let browser: any;
  try {
    await app.directory.add('alex', PASSWORD);
    const require = createRequire(join(PLAYWRIGHT as string, 'package.json'));
    const { chromium } = require('playwright-core') as { chromium: { launch(options: Record<string, unknown>): Promise<any> } };
    browser = await chromium.launch({ headless: true, ...(process.env.CLEARED_V2_CHROME ? { executablePath: process.env.CLEARED_V2_CHROME } : {}) });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' })).newPage();
    page.on('pageerror', (error: Error) => errors.push(error.message));
    page.on('request', (request: { url(): string }) => { if (!request.url().startsWith(app.base) && !request.url().startsWith(previewBase)) away.push(request.url()); });
    await page.goto(`${app.base}/login`);
    await page.fill('#name', 'alex');
    await page.fill('#password', PASSWORD);
    await page.click('button[type=submit]');
    await page.waitForURL(`${app.base}/`);
    await page.goto(`${app.base}${path}`);
    await run(page, { app, previewBase, appHits, previewHits });
  } finally {
    await browser?.close();
    await app.close();
    preview.closeAllConnections();
    await new Promise<void>((resolve) => preview.close(() => resolve()));
  }
  return { errors, away };
}

test('the four tabs switch, and the Go of a waiting plan calls its route', { skip }, async () => {
  const fixture = sessionFixture(FIXTURE_NOW, { plan: 'waiting' });
  const source = sessionSource(fixture);
  const seen = await browse(source, `/sessions/${AUTHOR_ID}`, async (page) => {
    await page.locator('#timeline [data-row]').first().waitFor();
    const selected = async () => page.locator('[role="tab"][aria-selected="true"]').getAttribute('aria-controls');
    assert.equal(await selected(), 'tab-terminal');
    await page.locator('[role="tab"][aria-controls="tab-plan"]').click();
    assert.equal(await selected(), 'tab-plan');
    assert.ok(await page.locator('#tab-plan').isVisible());
    assert.ok(!(await page.locator('#tab-terminal').isVisible()));
    assert.match(page.url(), /#plan$/);
    await page.locator('#tab-plan [data-act="plan_go"]').click();
    await page.locator('#tab-plan [data-act="plan_go"]').waitFor({ state: 'detached' });
    assert.match(await page.locator('#tab-plan').innerText(), /Go given by you at/);

    // Nothing is changed before the Go: the Editor says so.
    await page.locator('[role="tab"][aria-controls="tab-editor"]').click();
    await page.locator('#tab-editor .editor-files').waitFor();
    assert.match(await page.locator('#tab-editor').innerText(), /No file changed yet/);
    await page.keyboard.press('ArrowRight');
    assert.equal(await selected(), 'tab-browser');
    await page.locator('#tab-browser iframe').waitFor();
    assert.equal(await page.locator('#tab-browser iframe').getAttribute('sandbox'), 'allow-scripts allow-forms');
    await page.keyboard.press('ArrowRight');
    assert.equal(await selected(), 'tab-plan');
    await page.locator('[role="tab"][aria-controls="tab-terminal"]').click();
    assert.ok(await page.locator('#timeline').isVisible());
  });
  assert.deepEqual(source.calls.filter((c) => c.path.includes('/plan/')).map((c) => [c.method, c.path]), [['POST', `/api/sessions/${AUTHOR_ID}/plan/go`]]);
  assert.deepEqual(seen, { errors: [], away: [] });
});

test('the Editor shows a file\'s changes against the base; Take over attaches the harness, and Give back calls its route', { skip }, async () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const source = sessionSource(fixture);
  const seen = await browse(source, `/sessions/${AUTHOR_ID}#editor`, async (page) => {
    await page.locator('#tab-editor tr.line.add').first().waitFor();
    assert.equal(await page.locator('#tab-editor [data-file][aria-current="true"]').getAttribute('data-file'), 'src/engine/upcoming.mjs');
    assert.equal(await page.locator('#tab-editor tr.line.add').count(), 24);
    assert.equal(await page.locator('#tab-editor tr.line.del').count(), 6);
    await page.locator('#tab-editor [data-file="test/upcoming.test.mjs"]').click();
    await page.locator('#tab-editor .tag').waitFor();
    assert.equal(await page.locator('#tab-editor tr.line.add').count(), 38, 'a new file is all added');

    // Take over attaches the terminal to the session's harness, with no command to run on the server (owner request of 2026-10-22 17:26).
    await page.locator('#takeover').click();
    await page.locator('#tab-terminal [data-terminal-state="open"][data-mode="harness"]').waitFor();
    assert.equal(await page.locator('#resume-command').count(), 0);
    assert.ok(await page.locator('#message').isDisabled(), 'no message to a paused session');
    await page.locator('#giveback').click();
    await page.locator('#takeover').waitFor();
  });
  assert.deepEqual(source.calls.filter((c) => /takeover|giveback/.test(c.path)).map((c) => c.path), [`/api/sessions/${AUTHOR_ID}/takeover`, `/api/sessions/${AUTHOR_ID}/giveback`]);
  assert.deepEqual(seen, { errors: [], away: [] });
});

// A page a session could write: it tries to approve the ticket and to read
// the session through the app, and says what it got.
const probe = (appOrigin: string) => `<!doctype html><meta charset="utf-8"><title>probe</title><pre id="out">running</pre>
<script>
(async () => {
  const out = { origin: self.origin };
  try { out.cookie = document.cookie; } catch (error) { out.cookie = 'refused: ' + error.name; }
  const ask = (path, init) => fetch(${JSON.stringify(appOrigin)} + path, { credentials: 'include', ...init }).then((r) => r.status, (e) => 'refused: ' + e.name);
  out.approve = await ask('/api/service/tickets/${TICKET_ID}/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  out.read = await ask('/api/service/sessions/${AUTHOR_ID}', {});
  out.form = typeof HTMLFormElement;
  document.getElementById('out').textContent = JSON.stringify(out);
})();
</script>`;

test('a page planted in the preview has an opaque origin, no cookie and a refused answer; nothing serves a preview but the listener', { skip }, async () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const source = sessionSource(fixture);
  const withProbe = (appOrigin: string): PreviewUpstream => {
    const planted = fixturePreview();
    return async (path, method) => path.endsWith('/probe')
      ? { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'planted=1; Path=/' }, body: Buffer.from(probe(appOrigin)) }
      : planted(path, method);
  };
  const seen = await browse(source, `/sessions/${AUTHOR_ID}#browser`, async (page, { app, previewBase, appHits, previewHits }) => {
    const frame = page.frameLocator('#tab-browser iframe');
    await frame.locator('body').waitFor();
    const element = await page.locator('#tab-browser iframe').elementHandle();
    const inner = await element.contentFrame();
    await inner.goto(`${previewBase}/preview/${AUTHOR_ID}/${PREVIEW_KEY}/probe`);
    await inner.waitForFunction(() => document.getElementById('out')?.textContent !== 'running');
    const result = JSON.parse(await inner.locator('#out').innerText()) as Record<string, unknown>;
    assert.equal(result.origin, 'null', 'an opaque origin');
    assert.match(String(result.cookie), /^refused|^$/, 'no cookie is readable');
    assert.notEqual(result.approve, 200);
    assert.notEqual(result.read, 200);

    // What reached the app from the page: never the owner's cookie, never an approval.
    // The page's requests are the ones from an opaque origin (Origin: null); the screen's own carry the app's.
    const fromProbe = appHits.filter((hit) => hit.headers.origin === 'null');
    assert.ok(fromProbe.length > 0, 'the planted page reached the app');
    for (const hit of fromProbe) assert.equal(hit.headers.cookie, undefined, `${hit.method} ${hit.url} carried a cookie`);
    assert.ok(!source.calls.some((call) => call.path.endsWith('/approve')), 'nothing was approved');
    // The browser sends the app's cookie to the listener (cookies ignore ports): it forwards it to no one.
    assert.ok(previewHits.length > 0);
    const cookies = await page.context().cookies(previewBase);
    assert.ok(!cookies.some((cookie: { name: string }) => cookie.name === 'planted'), 'the planted cookie was stripped');

    const { cookie } = await signedIn(app, 'alex');
    for (const path of ['/', '/login', '/api/me', '/api/service/sessions', `/sessions/${AUTHOR_ID}`])
      assert.equal((await fetch(`${previewBase}${path}`, { headers: { cookie } })).status, 404, `the listener answers ${path}`);
    assert.equal((await fetch(`${app.base}/api/service/sessions/${AUTHOR_ID}/preview/${PREVIEW_KEY}/`, { headers: { cookie } })).status, 404, 'the app serves no preview');
    assert.equal((await fetch(`${app.base}/preview/${AUTHOR_ID}/${PREVIEW_KEY}/`, { headers: { cookie } })).status, 404);
  }, withProbe);
  assert.deepEqual(seen.errors, []);
  assert.deepEqual(seen.away, []);
});
