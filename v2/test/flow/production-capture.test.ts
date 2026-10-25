// The capture of the production page after a release landed (P218, issue
// #334): Playwright opens the address the project configures ([release]
// production_url) and takes one screenshot. The page is read, never acted
// on: no click, no scroll, no form; a request that is not a GET or a HEAD of
// the page's own origin is aborted, every WebSocket closed, service workers
// blocked. A fake browser stands for Playwright here; the last test runs a
// real Chromium on a fake production page served on loopback when
// CLEARED_V2_PLAYWRIGHT names the folder of an installed playwright-core:
//
//   CLEARED_V2_PLAYWRIGHT=/path/to/node_modules/playwright-core \
//   CLEARED_V2_CHROME=/path/to/chrome node --test test/flow/production-capture.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCTION_FILE, captureProduction, playwrightBrowser, type ProofBrowser, type ProofContext } from '../../src/flow/proof-capture.ts';

const dirOf = () => mkdtempSync(join(tmpdir(), 'cleared-v2-production-'));
const URL_ = 'https://guestbook.example.invalid/entries?view=all';

type Routed = { method: string; url: string; outcome: 'continued' | 'aborted' };
type Seen = { options: Record<string, unknown>[]; urls: string[]; routed: Routed[]; sockets: boolean; closed: boolean; actions: string[] };

// A browser whose page asks, as a live page may, for its own assets, for a
// form post to its own origin and for a pixel elsewhere.
function fakeBrowser(options: { fail?: boolean } = {}) {
  const seen: Seen = { options: [], urls: [], routed: [], sockets: false, closed: false, actions: [] };
  const browser: ProofBrowser = {
    async newContext(contextOptions) {
      seen.options.push(contextOptions as Record<string, unknown>);
      let handler: Parameters<ProofContext['route']>[1] | undefined;
      const request = async (method: string, url: string) => {
        const answer: Routed = { method, url, outcome: 'aborted' };
        await handler?.({ async continue() { answer.outcome = 'continued'; }, async abort() { answer.outcome = 'aborted'; } }, { url: () => url, method: () => method, headers: () => ({}) });
        seen.routed.push(answer);
      };
      return {
        async route(_url, given) { handler = given; },
        async routeWebSocket() { seen.sockets = true; },
        async newPage() {
          return {
            async goto(url: string) {
              if (options.fail) throw new Error('net::ERR_CERT_AUTHORITY_INVALID at https://guestbook.example.invalid/?token=abc');
              seen.urls.push(url);
              await request('GET', url);
              await request('GET', 'https://guestbook.example.invalid/style.css');
              await request('POST', 'https://guestbook.example.invalid/api/entries');
              await request('GET', 'https://tracker.example.invalid/pixel.png');
            },
            async screenshot({ path }: { path: string }) { seen.actions.push('screenshot'); writeFileSync(path, 'png'); },
            mouse: { async wheel() { seen.actions.push('wheel'); } },
            async waitForTimeout() { seen.actions.push('wait'); },
            video() { return null; },
          };
        },
        async close() { /* the context */ },
      };
    },
    async close() { seen.closed = true; },
  };
  return { browser, seen };
}

test('the configured page is opened once and captured: GETs of its own origin only, no WebSocket, no service worker, no scroll', async () => {
  const dir = dirOf();
  try {
    const { browser, seen } = fakeBrowser();
    const got = await captureProduction({ browser, url: URL_, dir });
    assert.deepEqual(got, { file: PRODUCTION_FILE });
    assert.equal(PRODUCTION_FILE, 'production.png');
    assert.equal(readFileSync(join(dir, PRODUCTION_FILE), 'utf8'), 'png');
    assert.deepEqual(seen.urls, [URL_], 'the configured address, as configured');
    assert.deepEqual(seen.routed.map((r) => `${r.method} ${r.url} ${r.outcome}`), [
      `GET ${URL_} continued`,
      'GET https://guestbook.example.invalid/style.css continued',
      'POST https://guestbook.example.invalid/api/entries aborted',
      'GET https://tracker.example.invalid/pixel.png aborted',
    ]);
    assert.ok(seen.sockets, 'every WebSocket is routed to be closed');
    assert.equal(seen.options.length, 1);
    assert.equal(seen.options[0]?.serviceWorkers, 'block');
    assert.equal(seen.options[0]?.recordVideo, undefined, 'one screenshot, no video');
    assert.deepEqual(seen.actions, ['screenshot'], 'the page is read, never acted on');
    assert.ok(seen.closed, 'the browser is closed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page that does not open is `failed`, never the browser\'s words; no browser is `no_browser`', async () => {
  const dir = dirOf();
  try {
    const { browser, seen } = fakeBrowser({ fail: true });
    const got = await captureProduction({ browser, url: URL_, dir });
    assert.deepEqual(got, { missing: 'failed' });
    assert.doesNotMatch(JSON.stringify(got), /token|ERR_|example/);
    assert.ok(!existsSync(join(dir, PRODUCTION_FILE)));
    assert.ok(seen.closed);
    assert.deepEqual(await captureProduction({ browser: undefined, url: URL_, dir }), { missing: 'no_browser' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real Chromium captures a fake production page on loopback: only GETs reach it, the page\'s POST and its foreign request never do', { skip: !process.env.CLEARED_V2_PLAYWRIGHT && 'set CLEARED_V2_PLAYWRIGHT to the folder of an installed playwright-core' }, async () => {
  const dir = dirOf();
  const seen: string[] = [];
  const foreign: string[] = [];
  let page = '';
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    if (request.url === '/logo.png') { response.writeHead(204); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(page);
  });
  const other = createServer((request, response) => { foreign.push(`${request.method} ${request.url}`); response.end(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  const elsewhere = `http://127.0.0.1:${(other.address() as AddressInfo).port}/elsewhere`;
  page = `<!doctype html><title>Guestbook</title><h1>Guestbook, live</h1><img src="/logo.png" alt="">
<form method="post" action="/entries"><input name="text" value="x"></form>
<script>fetch('/entries', { method: 'POST', body: 'x' }).catch(() => {}); fetch('${elsewhere}').catch(() => {}); document.forms[0].submit();</script>`;
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const got = await captureProduction({ browser: await playwrightBrowser(), url, dir });
    assert.deepEqual(got, { file: PRODUCTION_FILE });
    assert.deepEqual(readFileSync(join(dir, PRODUCTION_FILE)).subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'a PNG');
    assert.ok(seen.includes('GET /'), 'the page was opened');
    assert.ok(seen.every((line) => line.startsWith('GET ') || line.startsWith('HEAD ')), `only reads: ${seen.join(', ')}`);
    assert.deepEqual(foreign, []);
  } finally {
    server.closeAllConnections();
    other.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => other.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
