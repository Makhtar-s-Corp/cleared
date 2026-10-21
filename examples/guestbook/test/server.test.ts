import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createApp, MAX_BODY_BYTES } from '../src/server.ts';
import { createStore } from '../src/store.ts';
import { testDatabase, type TestDatabase } from './helpers/db.ts';

// Port 0: the system picks a free port, so the tests never take 8793 nor a
// port already in use.
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

let db: TestDatabase;
let server: Server;
let base = '';

before(async () => {
  db = await testDatabase();
  server = createApp(db.store);
  base = await listen(server);
});

after(async () => {
  await close(server);
  await db.drop();
});

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  redirect: 'manual',
});

test('GET / is the page, as HTML, never cached', async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /<form method="post" action="\/entries">/);
});

test('POST /entries stores the entry and sends the visitor back to the page', async () => {
  const response = await fetch(`${base}/entries`, form({ name: '  Grace  ', message: 'Hello <there>' }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/');
  const stored = (await db.store.list()).at(-1);
  assert.equal(stored?.name, 'Grace');
  assert.equal(stored?.message, 'Hello <there>');
  const page = await (await fetch(`${base}/`)).text();
  assert.ok(page.includes('Hello &lt;there&gt;'));
});

test('an empty or too long field is 400 with the page and its error, and nothing is stored', async () => {
  const before = (await db.store.list()).length;
  const invalid: Record<string, string>[] = [
    { name: '', message: 'm' },
    { name: 'n', message: '   ' },
    { message: 'no name field' },
    { name: 'x'.repeat(81), message: 'm' },
    { name: 'n', message: 'y'.repeat(501) },
  ];
  for (const fields of invalid) {
    const response = await fetch(`${base}/entries`, form(fields));
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.match(await response.text(), /role="alert"/);
  }
  assert.equal((await db.store.list()).length, before);
});

// Writes a POST with a body of `size` bytes in 64 KiB chunks, waiting for
// the socket to drain as an uploading client does, then returns everything
// the server answered and how long the whole exchange took.
async function rawPost(size: number): Promise<{ answer: string; ms: number }> {
  const started = Date.now();
  const socket = connect(Number(new URL(base).port), '127.0.0.1');
  await once(socket, 'connect');
  socket.on('error', () => {}); // a write after the answer may fail: the answer is what counts
  let answer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => { answer += chunk; });
  const ended = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  // Exactly `size` bytes of body, as Content-Length says: a form field, then filler.
  const field = 'name=n&message=';
  socket.write(`POST /entries HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: ${size}\r\n\r\n${field}`);
  const chunk = 'z'.repeat(64 * 1024);
  for (let sent = field.length; sent < size && !socket.destroyed; sent += chunk.length) {
    if (!socket.write(chunk.slice(0, size - sent))) await Promise.race([once(socket, 'drain'), ended]);
  }
  socket.end();
  await ended;
  return { answer, ms: Date.now() - started };
}

// The server reads the rest of the body before it answers: a server that
// stops reading leaves an uploading client stalled until a timeout closes
// the connection, and one that closes early can reset it before the answer.
test('a body over the limit is answered 413, every time, and the upload never stalls', async () => {
  for (let round = 0; round < 5; round++) {
    const big = await fetch(`${base}/entries`, form({ name: 'n', message: 'z'.repeat(4 * 1024 * 1024) }));
    assert.equal(big.status, 413, `fetch, round ${round}`);
    assert.match(await big.text(), /larger than 16384 bytes/);
  }
  for (let round = 0; round < 5; round++) {
    const { answer, ms } = await rawPost(4 * 1024 * 1024);
    assert.match(answer, /^HTTP\/1\.1 413 Payload Too Large\r\n/, `raw socket, round ${round}: ${JSON.stringify(answer.slice(0, 80))}`);
    assert.match(answer, /larger than 16384 bytes/);
    assert.ok(ms < 2000, `raw socket, round ${round}: the exchange took ${ms} ms`);
  }
  // The server still answers afterwards.
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('a body that is not a form is 415; a body over the limit is 413', async () => {
  const json = await fetch(`${base}/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(json.status, 415);
  const big = await fetch(`${base}/entries`, form({ name: 'n', message: 'z'.repeat(MAX_BODY_BYTES) }));
  assert.equal(big.status, 413);
});

test('GET /health is 200 while the database answers', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok' });
  const head = await fetch(`${base}/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('GET /health is 503 when the database does not answer, without hanging', async () => {
  const down = createStore('postgres://postgres@127.0.0.1:1/postgres', { timeoutMs: 1000 });
  const sick = createApp(down);
  const sickBase = await listen(sick);
  try {
    const started = Date.now();
    const response = await fetch(`${sickBase}/health`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'unavailable' });
    assert.ok(Date.now() - started < 3000, 'the probe must not hang');
    const page = await fetch(`${sickBase}/`);
    assert.equal(page.status, 500);
  } finally {
    await close(sick);
    await down.close();
  }
});

test('another method is 405 with Allow; another path is 404', async () => {
  const cases: [string, string, string][] = [
    ['/', 'POST', 'GET, HEAD'],
    ['/health', 'POST', 'GET, HEAD'],
    ['/entries', 'GET', 'POST'],
  ];
  for (const [path, method, allow] of cases) {
    const response = await fetch(`${base}${path}`, { method, redirect: 'manual' });
    assert.equal(response.status, 405, `${method} ${path}`);
    assert.equal(response.headers.get('allow'), allow);
  }
  for (const path of ['/index.html', '/health/', '/entries/1', '/api']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});
