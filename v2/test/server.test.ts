import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { createHealthServer, formatAddress, requestPath } from '../src/server.ts';

// Port 0: the system picks a free port, so the tests never use the default
// nor a port already in use.
const server = createHealthServer();
let base = '';

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

test('GET /health answers 200 with {"status":"ok"} as JSON, never cached', async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('HEAD /health answers 200 without a body; a query string is ignored', async () => {
  const head = await fetch(`${base}/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(`${base}/health?probe=1`)).status, 200);
});

test('another method on /health is 405 with Allow', async () => {
  const response = await fetch(`${base}/health`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.deepEqual(await response.json(), { error: 'method not allowed' });
});

test('any other path is 404', async () => {
  for (const path of ['/', '/health/', '/healthz', '/api']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not found' });
  }
});

// The status line of the answer to a request written as it is on the socket.
async function raw(request: string): Promise<string> {
  const socket = connect(Number(new URL(base).port), '127.0.0.1');
  await once(socket, 'connect');
  socket.end(request);
  let answer = '';
  socket.setEncoding('utf8');
  for await (const chunk of socket) answer += chunk;
  return answer.split('\r\n')[0] ?? '';
}

test('a request target the URL parser refuses is 400, and the server keeps answering', async () => {
  assert.equal(requestPath('//['), undefined);
  assert.equal(await raw('GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'), 'HTTP/1.1 400 Bad Request');
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('an address is written as in a URL: IPv6 in brackets', () => {
  assert.equal(formatAddress('127.0.0.1', 8791), '127.0.0.1:8791');
  assert.equal(formatAddress('::1', 8791), '[::1]:8791');
  assert.equal(formatAddress('localhost', 9100), 'localhost:9100');
});
