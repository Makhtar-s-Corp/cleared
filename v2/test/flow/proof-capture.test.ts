// The captures of a proof receipt (issue #326, P210): the page of what the
// service's base runs (before), the page of the ticket's trial environment
// (after), and a video of about 20 seconds of the flow on the after page,
// recorded by Playwright. A fake browser stands for Playwright here; the
// last test runs a real Chromium when CLEARED_V2_PLAYWRIGHT names the folder
// of an installed playwright-core, as the app's browser tests do:
//
//   CLEARED_V2_PLAYWRIGHT=/path/to/node_modules/playwright-core \
//   CLEARED_V2_CHROME=/path/to/chrome node --test test/flow/proof-capture.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER } from '../../src/api/types.ts';
import { FLOW_MS, captureProof, playwrightBrowser, previewAddress, proofTargets, type ProofBrowser } from '../../src/flow/proof-capture.ts';

const dirOf = () => mkdtempSync(join(tmpdir(), 'cleared-v2-proof-'));

type Seen = { contexts: { options: Record<string, unknown>; closed: boolean; urls: string[] }[]; closed: boolean; wheels: number };

// A browser that writes a file where Playwright would, on a clock that the
// page's waits move.
function fakeBrowser(options: { failOn?: string } = {}) {
  let clock = 1_000_000;
  const seen: Seen = { contexts: [], closed: false, wheels: 0 };
  const browser: ProofBrowser = {
    async newContext(contextOptions) {
      const context = { options: contextOptions as Record<string, unknown>, closed: false, urls: [] as string[] };
      seen.contexts.push(context);
      return {
        async newPage() {
          return {
            async goto(url: string) {
              if (options.failOn && url.startsWith(options.failOn)) throw Object.assign(new Error('net::ERR_CONNECTION_REFUSED at http://127.0.0.1:1/?token=abc'), { name: 'Error' });
              context.urls.push(url);
              clock += 300;
            },
            async screenshot({ path }: { path: string }) { writeFileSync(path, 'png'); },
            mouse: { async wheel() { seen.wheels += 1; } },
            async waitForTimeout(ms: number) { clock += ms; },
            video() { return contextOptions.recordVideo ? { async saveAs(path: string) { assert.ok(context.closed, 'the video is saved once its page is closed'); writeFileSync(path, 'webm'); } } : null; },
          };
        },
        async close() { context.closed = true; },
      };
    },
    async close() { seen.closed = true; },
  };
  return { browser, seen, now: () => clock };
}

const BEFORE = { url: 'http://127.0.0.1:8793/' };
const AFTER = { url: 'http://127.0.0.1:8791/api/sessions/s1/preview/key/', headers: { 'x-cleared-proof': 'the-app-proof' } };

test('before and after are screenshots of their pages; the video is the after page\'s flow, about 20 seconds', async () => {
  const dir = dirOf();
  try {
    const { browser, seen, now } = fakeBrowser();
    const got = await captureProof({ browser, before: BEFORE, after: AFTER, dir, now });
    assert.deepEqual(got.missing, []);
    assert.equal(got.before, 'before.png');
    assert.equal(got.after, 'after.png');
    assert.equal(got.video, 'flow.webm');
    for (const file of ['before.png', 'after.png', 'flow.webm']) assert.ok(existsSync(join(dir, file)), file);
    // The flow lasts its time, measured, not assumed.
    assert.ok((got.videoMs ?? 0) >= FLOW_MS && (got.videoMs ?? 0) < FLOW_MS + 2000, String(got.videoMs));
    assert.ok(seen.wheels >= 4, 'the flow scrolls the page');
    // One context per page: only the after one records, and only it carries the preview's header.
    const [before, after] = seen.contexts;
    assert.deepEqual(before?.urls, [BEFORE.url]);
    assert.equal(before?.options.recordVideo, undefined);
    assert.equal(before?.options.extraHTTPHeaders, undefined);
    assert.deepEqual(after?.urls, [AFTER.url]);
    assert.ok(after?.options.recordVideo);
    assert.deepEqual(after?.options.extraHTTPHeaders, AFTER.headers);
    assert.ok(seen.contexts.every((c) => c.closed) && seen.closed, 'every context and the browser are closed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('what cannot be captured is named by its code, never by the error\'s text, and the rest is still captured', async () => {
  const dir = dirOf();
  try {
    const { browser, seen, now } = fakeBrowser({ failOn: BEFORE.url });
    const got = await captureProof({ browser, before: BEFORE, after: AFTER, dir, now });
    assert.deepEqual(got.missing, [{ part: 'before', reason: 'failed' }]);
    assert.equal(got.after, 'after.png');
    assert.equal(got.video, 'flow.webm');
    assert.doesNotMatch(JSON.stringify(got), /token|ERR_|127\.0\.0\.1/);
    assert.ok(seen.closed);

    const none = await captureProof({ browser: fakeBrowser().browser, dir: dirOf(), now });
    assert.deepEqual(none.missing, [{ part: 'before', reason: 'no_before' }, { part: 'after', reason: 'no_after' }, { part: 'video', reason: 'no_after' }]);
    const noBrowser = await captureProof({ browser: undefined, before: BEFORE, after: AFTER, dir: dirOf(), now });
    assert.deepEqual(noBrowser.missing.map((m) => `${m.part}:${m.reason}`), ['before:no_browser', 'after:no_browser', 'video:no_browser']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a browser that cannot open a context loses the captures, never the caller', async () => {
  const browser: ProofBrowser = { async newContext() { throw new Error('Target closed'); }, async close() { throw new Error('already closed'); } };
  const got = await captureProof({ browser, before: BEFORE, after: AFTER, dir: dirOf() });
  assert.deepEqual(got.missing.map((m) => `${m.part}:${m.reason}`), ['before:failed', 'after:failed', 'video:failed']);
});

test('no playwright-core to load: no browser, said as such', async () => {
  assert.equal(await playwrightBrowser({ CLEARED_V2_PLAYWRIGHT: join(tmpdir(), 'no-such-playwright') }), undefined);
});

test('the targets: before is the page at the origin of the service\'s health address, after the session\'s preview through the service with the app\'s proof', () => {
  const after = previewAddress({ host: '127.0.0.1', port: 8791 }, { session: 's1', key: 'k-1', alias: 'guestbook', port: 8793 }, 'the-app-proof');
  assert.deepEqual(after, { url: 'http://127.0.0.1:8791/api/sessions/s1/preview/k-1/', headers: { [SERVICE_PROOF_HEADER]: 'the-app-proof' } });
  // A service listening on every address is reached on loopback.
  assert.equal(previewAddress({ host: '0.0.0.0', port: 8791 }, { session: 's1', key: 'k', alias: 'g', port: 1 }, 'p').url, 'http://127.0.0.1:8791/api/sessions/s1/preview/k/');
  assert.deepEqual(proofTargets({ healthUrl: 'http://127.0.0.1:8793/health' }, after), { before: { url: 'http://127.0.0.1:8793/' }, after });
  assert.deepEqual(proofTargets({ healthUrl: null }, undefined), {});
  // An address with credentials, or not http, is not opened.
  assert.deepEqual(proofTargets({ healthUrl: 'http://user:pass@127.0.0.1:8793/health' }, undefined), {});
  assert.deepEqual(proofTargets({ healthUrl: 'file:///etc/passwd' }, undefined), {});
});

const PLAYWRIGHT = process.env.CLEARED_V2_PLAYWRIGHT;

function page(title: string, colour: string): Promise<{ server: Server; url: string; headers: string[] }> {
  const headers: string[] = [];
  const server = createServer((request, response) => {
    headers.push(String(request.headers['x-cleared-proof'] ?? ''));
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>${title}</title><body style="background:${colour};height:3000px"><h1>${title}</h1></body>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({ server, url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/`, headers });
  }));
}

test('a real Chromium: two PNG pages and a WebM video of the flow', { skip: PLAYWRIGHT ? false : 'CLEARED_V2_PLAYWRIGHT is not set', timeout: 120_000 }, async () => {
  const before = await page('Oldest first', '#fff');
  const after = await page('Newest first', '#eee');
  const dir = dirOf();
  try {
    const browser = await playwrightBrowser(process.env);
    assert.ok(browser, 'playwright-core loads from CLEARED_V2_PLAYWRIGHT');
    const got = await captureProof({ browser, before: { url: before.url }, after: { url: after.url, headers: { 'x-cleared-proof': 'p' } }, dir, flowMs: 3000 });
    assert.deepEqual(got.missing, []);
    const png = (file: string) => readFileSync(join(dir, file)).subarray(0, 8).toString('hex');
    assert.equal(png('before.png'), '89504e470d0a1a0a');
    assert.equal(png('after.png'), '89504e470d0a1a0a');
    // WebM starts with EBML's magic number.
    assert.equal(readFileSync(join(dir, 'flow.webm')).subarray(0, 4).toString('hex'), '1a45dfa3');
    assert.ok(statSync(join(dir, 'flow.webm')).size > 1000);
    assert.ok((got.videoMs ?? 0) >= 3000);
    assert.ok(after.headers.includes('p') && !before.headers.includes('p'), 'the preview\'s header goes to the after page only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    before.server.close();
    after.server.close();
  }
});
