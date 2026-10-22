import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, MAX_BODY_BYTES } from '../src/server.ts';
import { parseWords } from '../src/words.ts';

// Port 0: the system picks a free port, so the tests never take 8795 nor a
// port already in use.
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let server: Server;
let base = '';

before(async () => {
  server = createApp(parseWords('spam\nscam\n'));
  base = await listen(server);
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

const check = (body: string, type = 'application/json'): Promise<Response> =>
  fetch(`${base}/check`, { method: 'POST', headers: { 'content-type': type }, body });

test('POST /check with clean text is ok, with no words', async () => {
  const response = await check(JSON.stringify({ text: 'Lovely guestbook, thank you!' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { ok: true, words: [] });
});

test('POST /check with listed words is not ok, and names them', async () => {
  const response = await check(JSON.stringify({ text: 'Cheap spam here, no scam, more SPAM' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: false, words: ['spam', 'scam'] });
});

test('a JSON content type with a charset is accepted', async () => {
  const response = await check(JSON.stringify({ text: 'spam' }), 'application/json; charset=utf-8');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: false, words: ['spam'] });
});

test('a body that is not JSON, or has no text string, is 400 with the reason', async () => {
  for (const body of ['not json', '[]', 'null', '{}', '{"text":3}', '{"text":null}']) {
    const response = await check(body);
    assert.equal(response.status, 400, body);
    const answer = (await response.json()) as { error?: unknown };
    assert.equal(typeof answer.error, 'string', body);
  }
});

test('a body that is not JSON by its type is 415; a body over the limit is 413', async () => {
  const form = await check('text=spam', 'application/x-www-form-urlencoded');
  assert.equal(form.status, 415);
  const big = await check(JSON.stringify({ text: 'z'.repeat(MAX_BODY_BYTES) }));
  assert.equal(big.status, 413);
  assert.equal((await fetch(`${base}/health`)).status, 200, 'the server still answers afterwards');
});

test('GET /health is 200 {"status":"ok"}, and HEAD has no body', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok' });
  const head = await fetch(`${base}/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('another method is 405 with Allow; another path is 404', async () => {
  const cases: [string, string, string][] = [
    ['/check', 'GET', 'POST'],
    ['/health', 'POST', 'GET, HEAD'],
  ];
  for (const [path, method, allow] of cases) {
    const response = await fetch(`${base}${path}`, { method });
    assert.equal(response.status, 405, `${method} ${path}`);
    assert.equal(response.headers.get('allow'), allow);
  }
  for (const path of ['/', '/check/', '/health/', '/words']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
});
