// The Browser tab's preview listener (docs/v2/milestone-2-plan.md, decision
// 20, lane 20): a page a session wrote is shown from its own loopback origin,
// never the app's. The listener holds no session, forwards nothing of the
// browser (no cookie, no anti-forgery token) to the service, which it asks
// with the app's proof only; it strips Set-Cookie, sandboxes every answer and
// answers nothing but previews. The app's page allows that origin in a frame
// (frame-src), and the app's own origin never serves a preview.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { DEFAULT_PREVIEW_PORT, PREVIEW_POLICY, PreviewConfigError, createPreviewHandler, readPreviewConfig, servicePreview } from '../src/preview.ts';
import type { DataSource } from '../src/proxy.ts';
import { signedIn, startApp, type Running } from './support.ts';

const PROOF = 'a'.repeat(64);
const KEY = 'k'.repeat(43);

type Seen = { method: string; url: string; headers: IncomingHttpHeaders };

let service: Server;
let serviceUrl = '';
const seen: Seen[] = [];
let preview: Server;
let previewBase = '';
let previewHost = '';

before(async () => {
  // The service's preview route, as lane 15 answers it, with what a page could try to set.
  service = createServer((request, response) => {
    seen.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
    if (request.url?.endsWith('/old')) {
      response.writeHead(302, { location: '/new?x=1', 'content-security-policy': 'sandbox allow-scripts allow-forms' });
      return void response.end();
    }
    if (request.url?.endsWith('/away')) {
      response.writeHead(302, { location: 'https://elsewhere.invalid/' });
      return void response.end();
    }
    const body = '<!doctype html><title>Guestbook</title><p>Entries</p>';
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8', 'set-cookie': 'planted=1; Path=/', 'content-security-policy': 'sandbox allow-scripts allow-forms',
      'access-control-allow-origin': '*', 'content-length': String(Buffer.byteLength(body)),
    });
    response.end(body);
  });
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
  serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;

  preview = createServer();
  await new Promise<void>((resolve) => preview.listen(0, '127.0.0.1', resolve));
  previewHost = `127.0.0.1:${(preview.address() as AddressInfo).port}`;
  previewBase = `http://${previewHost}`;
  preview.on('request', createPreviewHandler({ upstream: servicePreview({ url: serviceUrl, proof: PROOF }), origin: previewBase, appOrigins: ['http://127.0.0.1:18792'] }));
});

after(async () => {
  for (const server of [service, preview]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('the listener\'s settings: 127.0.0.1:8794 by default, its own origin, never a reserved port nor the app\'s or the service\'s', () => {
  assert.equal(DEFAULT_PREVIEW_PORT, 8794);
  assert.deepEqual(readPreviewConfig({}, { app: 8792, service: 8791 }), { host: '127.0.0.1', port: 8794, origin: 'http://127.0.0.1:8794', loopback: true });
  assert.deepEqual(readPreviewConfig({ CLEARED_V2_PREVIEW_PORT: '18794' }, { app: 8792, service: 8791 }).origin, 'http://127.0.0.1:18794');
  const proxied = readPreviewConfig({ CLEARED_V2_PREVIEW_ORIGIN: 'https://preview.example.invalid:8444/' }, { app: 8792, service: 8791 });
  assert.deepEqual([proxied.port, proxied.origin, proxied.loopback], [8794, 'https://preview.example.invalid:8444', false]);
  for (const port of ['80', '443', '8787', '8788', '8790', '8791', '8792', '0', '70000', 'x'])
    assert.throws(() => readPreviewConfig({ CLEARED_V2_PREVIEW_PORT: port }, { app: 8792, service: 8791 }), PreviewConfigError, port);
  assert.throws(() => readPreviewConfig({ CLEARED_V2_PREVIEW_ORIGIN: 'not an address' }, { app: 8792, service: 8791 }), PreviewConfigError);
});

test('a preview is asked of the service with the app\'s proof alone, and answered sandboxed, without a cookie', async () => {
  seen.length = 0;
  const answer = await fetch(`${previewBase}/preview/s1/${KEY}/page/index.html?page=2`, {
    headers: { cookie: 'cleared_session=owner-cookie', 'x-csrf-token': 'csrf-1', origin: 'http://127.0.0.1:18792', authorization: 'Basic eDp5' },
  });
  assert.equal(answer.status, 200);
  assert.equal(await answer.text(), '<!doctype html><title>Guestbook</title><p>Entries</p>');
  assert.equal(answer.headers.get('set-cookie'), null, 'no cookie reaches the browser');
  assert.equal(answer.headers.get('access-control-allow-origin'), null);
  assert.equal(answer.headers.get('content-security-policy'), `${PREVIEW_POLICY}; frame-ancestors http://127.0.0.1:18792`);
  assert.equal(answer.headers.get('cache-control'), 'no-store');
  assert.equal(answer.headers.get('referrer-policy'), 'no-referrer');

  assert.equal(seen.length, 1);
  const asked = seen[0] as Seen;
  assert.equal(asked.method, 'GET');
  assert.equal(asked.url, `/api/sessions/s1/preview/${KEY}/page/index.html?page=2`);
  assert.equal(asked.headers[SERVICE_PROOF_HEADER], PROOF);
  for (const name of ['cookie', 'x-csrf-token', 'origin', 'authorization', SERVICE_USER_HEADER]) assert.equal(asked.headers[name], undefined, `${name} is not forwarded`);
});

test('a redirect stays under the session\'s preview address, and one that leaves the sibling is dropped', async () => {
  const moved = await fetch(`${previewBase}/preview/s1/${KEY}/old`, { redirect: 'manual' });
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), `/preview/s1/${KEY}/new?x=1`);
  const away = await fetch(`${previewBase}/preview/s1/${KEY}/away`, { redirect: 'manual' });
  assert.equal(away.headers.get('location'), null);
});

test('the listener answers nothing but previews: another path, a write, another host', async () => {
  seen.length = 0;
  for (const path of ['/', '/login', '/api/me', '/api/service/sessions', `/api/sessions/s1/preview/${KEY}/`, '/preview/s1', `/preview/s1/short/`, `/preview/s%2F1/${KEY}/`, `/preview/s1/${KEY}/%2E%2E/x`])
    assert.equal((await fetch(`${previewBase}${path}`)).status, 404, path);
  assert.equal((await fetch(`${previewBase}/preview/s1/${KEY}/`, { method: 'POST', body: 'x' })).status, 405);
  // fetch writes its own Host: a raw request names another one.
  const other = await new Promise<number>((resolve, reject) => {
    const url = new URL(previewBase);
    const asked = httpRequest({ hostname: url.hostname, port: url.port, path: `/preview/s1/${KEY}/`, headers: { host: 'evil.invalid' } }, (answer) => { answer.resume(); resolve(answer.statusCode ?? 0); });
    asked.on('error', reject);
    asked.end();
  });
  assert.equal(other, 421);
  assert.equal(seen.length, 0, 'none of them reached the service');
});

let app: Running;
const calls: string[] = [];
const recording: DataSource = {
  kind: 'service',
  forward(_request, response, forward) {
    calls.push(forward.path);
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<script src="x.js"></script>');
  },
};

test('the app allows the preview origin in a frame, names it on the page, and never serves a preview itself', async () => {
  app = await startApp({ source: recording, extra: { previewOrigin: 'http://127.0.0.1:18794' } });
  try {
    const { cookie } = await signedIn(app);
    const page = await fetch(`${app.base}/sessions/s1`, { headers: { cookie } });
    const policy = page.headers.get('content-security-policy') ?? '';
    assert.match(policy, /(^|; )frame-src http:\/\/127\.0\.0\.1:18794(;|$)/);
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.ok(!policy.includes('unsafe-inline'));
    assert.match(await page.text(), /<body [^>]*data-preview="http:\/\/127\.0\.0\.1:18794"/);

    for (const path of [`/api/service/sessions/s1/preview/${KEY}/`, `/api/service/sessions/s1/preview/${KEY}/x.js`, '/api/service/sessions/s1/preview']) {
      const answer = await fetch(`${app.base}${path}`, { headers: { cookie } });
      assert.equal(answer.status, 404, path);
    }
    assert.deepEqual(calls, [], 'the source was never asked for a preview');
    assert.equal((await fetch(`${app.base}/preview/s1/${KEY}/`, { headers: { cookie } })).status, 404, 'the listener\'s path on the app');
  } finally {
    await app.close();
  }
});

test('without a preview origin the app\'s policy is the one it had', async () => {
  app = await startApp({ source: recording });
  try {
    const { cookie } = await signedIn(app);
    const page = await fetch(`${app.base}/sessions/s1`, { headers: { cookie } });
    // As before, but for the page's own style nonce (lane 32, style-nonce.test.ts).
    assert.match(page.headers.get('content-security-policy') ?? '', /^default-src 'self'; style-src 'self' 'nonce-[A-Za-z0-9+/=]+'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/);
    assert.ok(!(await page.text()).includes('data-preview'));
  } finally {
    await app.close();
  }
});
