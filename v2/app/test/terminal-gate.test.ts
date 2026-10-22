// The app's gate for the web terminal (docs/v2/milestone-2-plan.md,
// decision 32, lane 31): /api/service/sessions/:id/terminal/* is forwarded
// only on the app's loopback address, never through the public origin;
// every post needs the anti-forgery token and the loopback Origin, the
// stream the cookie and, when sent, Sec-Fetch-Site: same-origin; /api/me
// says whether the terminal is offered. A page of the preview listener
// (lane 20) posting the input route is refused, and the listener itself
// answers no write.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPreviewHandler } from '../src/preview.ts';
import type { DataSource } from '../src/proxy.ts';
import { signedIn, startApp, type Running } from './support.ts';

const PUBLIC = 'https://cleared.example.com';
const forwarded: string[] = [];
const recording: DataSource = {
  kind: 'service',
  forward(_request, response, forward) {
    forwarded.push(`${forward.method} ${forward.path}`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"accepted":true}');
  },
};

let app: Running;
let me: { cookie: string; csrf: string };
before(async () => {
  app = await startApp({ source: recording, extra: { publicOrigin: PUBLIC } });
  me = await signedIn(app);
});
after(() => app.close());

// A raw request, so that the Host and every header are the test's.
function ask(method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  const url = new URL(app.base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, method, path, headers: { host: url.host, ...headers } }, (response) => {
      let text = '';
      response.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

const terminal = (name: string) => `/api/service/sessions/s1/terminal/${name}`;
const POSTS = ['open', 'input', 'resize', 'close'];
const writeHeaders = () => ({ cookie: me.cookie, 'x-csrf-token': me.csrf, origin: app.origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' });

test('on the loopback address the terminal\'s posts and its stream are forwarded, and /api/me offers the terminal', async () => {
  forwarded.length = 0;
  for (const name of POSTS) assert.equal((await ask('POST', terminal(name), writeHeaders(), '{"data":"ls\\r"}')).status, 200, name);
  assert.equal((await ask('GET', terminal('stream'), { cookie: me.cookie, 'sec-fetch-site': 'same-origin' })).status, 200);
  assert.equal((await ask('GET', terminal('stream'), { cookie: me.cookie })).status, 200, 'a client that sends no Sec-Fetch-Site');
  assert.deepEqual(forwarded, [...POSTS.map((name) => `POST /api/sessions/s1/terminal/${name}`), 'GET /api/sessions/s1/terminal/stream', 'GET /api/sessions/s1/terminal/stream']);
  const answer = JSON.parse((await ask('GET', '/api/me', { cookie: me.cookie })).text) as { terminal: boolean };
  assert.equal(answer.terminal, true);
  const localhost = await ask('GET', '/api/me', { cookie: me.cookie, host: `localhost:${new URL(app.base).port}` });
  assert.equal((JSON.parse(localhost.text) as { terminal: boolean }).terminal, true, 'localhost is the loopback address too');
});

test('each post is refused without the anti-forgery token, with another Origin, or with the public origin\'s Origin; the stream cross-site; nothing is forwarded', async () => {
  forwarded.length = 0;
  for (const name of POSTS) {
    const { 'x-csrf-token': _token, ...noToken } = writeHeaders();
    assert.equal((await ask('POST', terminal(name), noToken, '{}')).status, 403, `${name} without the token`);
    assert.equal((await ask('POST', terminal(name), { ...writeHeaders(), origin: 'http://127.0.0.1:8794' }, '{}')).status, 403, `${name} from the preview origin`);
    assert.equal((await ask('POST', terminal(name), { ...writeHeaders(), origin: PUBLIC }, '{}')).status, 403, `${name} with the public Origin on the loopback Host`);
    assert.equal((await ask('POST', terminal(name), { ...writeHeaders(), 'sec-fetch-site': 'same-site' }, '{}')).status, 403, `${name} same-site`);
  }
  assert.equal((await ask('GET', terminal('stream'), { cookie: me.cookie, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await ask('GET', terminal('stream'), { cookie: me.cookie, origin: 'http://evil.invalid' })).status, 403);
  assert.equal((await ask('GET', terminal('stream'), {})).status, 401, 'no cookie');
  assert.deepEqual(forwarded, []);
});

test('through the public origin every terminal route is refused and /api/me says terminal: false; the editor\'s save still goes through', async () => {
  forwarded.length = 0;
  const host = new URL(PUBLIC).host;
  for (const name of POSTS) assert.equal((await ask('POST', terminal(name), { ...writeHeaders(), host, origin: PUBLIC }, '{}')).status, 403, name);
  assert.equal((await ask('GET', terminal('stream'), { cookie: me.cookie, host, 'sec-fetch-site': 'same-origin' })).status, 403);
  const answer = JSON.parse((await ask('GET', '/api/me', { cookie: me.cookie, host })).text) as { terminal: boolean };
  assert.equal(answer.terminal, false);
  assert.deepEqual(forwarded, []);
  assert.equal((await ask('PUT', '/api/service/sessions/s1/files/src/entries.ts', { ...writeHeaders(), host, origin: PUBLIC }, '{}')).status, 200, 'the save is a write like the others');
  assert.deepEqual(forwarded, ['PUT /api/sessions/s1/files/src/entries.ts']);
});

test('a page of the preview listener that posts the input route is refused, and the listener answers no write', async () => {
  forwarded.length = 0;
  // A sandboxed page has an opaque origin and cannot read the token: even
  // with the cookie, its post is refused.
  for (const origin of ['null', 'http://127.0.0.1:8794']) {
    assert.equal((await ask('POST', terminal('input'), { cookie: me.cookie, origin, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }, '{"data":"ls\\r"}')).status, 403, origin);
  }
  assert.deepEqual(forwarded, []);

  let upstream = 0;
  const preview: Server = createServer();
  await new Promise<void>((resolve) => preview.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(preview.address() as AddressInfo).port}`;
  preview.on('request', createPreviewHandler({ upstream: async () => { upstream++; throw new Error('not reached'); }, origin: base, appOrigins: [app.origin] }));
  try {
    for (const path of ['/api/service/sessions/s1/terminal/input', '/api/sessions/s1/terminal/input', `/preview/s1/${'k'.repeat(32)}/terminal/input`]) {
      const status = (await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: me.cookie, 'content-type': 'application/json' }, body: '{"data":"ls\\r"}' })).status;
      assert.ok(status === 404 || status === 405, `${path}: ${status}`);
    }
    assert.equal(upstream, 0, 'nothing reached the service');
  } finally {
    preview.closeAllConnections();
    await new Promise<void>((resolve) => preview.close(() => resolve()));
  }
});
