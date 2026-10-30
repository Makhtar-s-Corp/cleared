import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { ProofError } from '../../src/modules/users.ts';
import { serviceSource } from '../src/proxy.ts';
import { signedIn, startApp } from './support.ts';

const PROOF = 'f'.repeat(64);

type Seen = { method: string; url: string; headers: IncomingHttpHeaders; body: string };

// A stand-in for the service: it records what reaches it and answers with
// `reply`, which may keep the response open.
async function fakeService(reply: (response: ServerResponse, seen: Seen) => void = (response) => { response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak=1' }); response.end('[]'); }) {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body };
      seen.push(entry);
      reply(response, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('a forwarded request carries the user id and the proof, and nothing of the cookie or the anti-forgery token', async () => {
  const service = await fakeService();
  const app = await startApp({ source: serviceSource({ url: service.url, proof: PROOF }) });
  try {
    const { cookie, csrf, id } = await signedIn(app);
    const read = await fetch(`${app.base}/api/service/sessions?after=3`, {
      headers: { cookie, authorization: 'Bearer something', [SERVICE_USER_HEADER]: 'someone-else', [SERVICE_PROOF_HEADER]: 'forged', 'last-event-id': '7' },
    });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), []);
    assert.equal(read.headers.get('set-cookie'), null, 'the service cannot set a cookie on the app');
    const write = await fetch(`${app.base}/api/service/tickets`, {
      method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'The guestbook shows the newest entry first', project: 'guestbook' }),
    });
    assert.equal(write.status, 200);
    const [get, post] = service.seen;
    assert.equal(get?.method, 'GET');
    assert.equal(get?.url, '/api/sessions?after=3');
    assert.equal(post?.method, 'POST');
    assert.equal(post?.url, '/api/tickets');
    assert.equal(post?.body, JSON.stringify({ title: 'The guestbook shows the newest entry first', project: 'guestbook' }));
    for (const seen of [get, post]) {
      assert.equal(seen?.headers[SERVICE_USER_HEADER], id);
      assert.equal(seen?.headers[SERVICE_PROOF_HEADER], PROOF);
      assert.equal(seen?.headers.cookie, undefined);
      assert.equal(seen?.headers.authorization, undefined);
      assert.equal(seen?.headers['x-csrf-token'], undefined);
      assert.equal(seen?.headers.origin, undefined);
      assert.ok(!JSON.stringify(seen?.headers).includes(cookie.split('=')[1] ?? 'missing'), 'no header carries the session id');
      assert.ok(!JSON.stringify(seen?.headers).includes(csrf), 'no header carries the anti-forgery token');
    }
    assert.equal(get?.headers['last-event-id'], '7', 'a reconnecting stream keeps its place');
  } finally {
    await app.close();
    await service.close();
  }
});

test('a request without a session is refused and never reaches the service', async () => {
  const service = await fakeService();
  const app = await startApp({ source: serviceSource({ url: service.url, proof: PROOF }) });
  try {
    const response = await fetch(`${app.base}/api/service/inbox`);
    assert.equal(response.status, 401);
    assert.equal((await fetch(`${app.base}/api/service/inbox`, { headers: { cookie: 'cleared_v2_session=' + 'A'.repeat(43) } })).status, 401);
    assert.deepEqual(service.seen, []);
  } finally {
    await app.close();
    await service.close();
  }
});

test('an event stream is passed on as it comes, not when it ends', async () => {
  let hold: ServerResponse | undefined;
  const service = await fakeService((response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    response.write('id: 1\nevent: RUN_STARTED\ndata: {}\n\n');
    hold = response;
  });
  const app = await startApp({ source: serviceSource({ url: service.url, proof: PROOF }) });
  try {
    const { cookie } = await signedIn(app);
    const response = await fetch(`${app.base}/api/service/sessions/s1/events`, { headers: { cookie } });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'id: 1\nevent: RUN_STARTED\ndata: {}\n\n');
    hold?.end();
    await reader.cancel();
  } finally {
    await app.close();
    await service.close();
  }
});

test('a service that does not answer is a 502, and a path outside the API is not forwarded', async () => {
  const app = await startApp({ source: serviceSource({ url: 'http://127.0.0.1:9', proof: PROOF }) });
  try {
    const { cookie } = await signedIn(app);
    const response = await fetch(`${app.base}/api/service/sessions`, { headers: { cookie } });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'the service did not answer' });
    assert.equal((await fetch(`${app.base}/api/service/%2e%2e/health`, { headers: { cookie } })).status, 404);
  } finally {
    await app.close();
  }
});

// Issue #429: the app reads its proof when a request needs it. Until the
// file holds a whole proof the service is not asked; once the service
// refuses the proof, the next request reads the file again.
test('a proof not ready yet is said, never sent, and a refused proof is read again', async () => {
  const service = await fakeService((response, seen) => {
    const ok = seen.headers[SERVICE_PROOF_HEADER] === PROOF;
    response.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    response.end(ok ? '[]' : '{"error":"unauthorized"}');
  });
  let current: string | undefined;
  let forgotten = 0;
  const proof = Object.assign(() => {
    if (current === undefined) throw new ProofError('the app\'s proof at /state/v2-app-proof is not 64 hex characters');
    return current;
  }, { forget: () => { forgotten += 1; current = PROOF; } });
  const app = await startApp({ source: serviceSource({ url: service.url, proof }) });
  try {
    const { cookie } = await signedIn(app);
    const early = await fetch(`${app.base}/api/service/sessions`, { headers: { cookie } });
    assert.equal(early.status, 503);
    assert.deepEqual(await early.json(), { error: 'service_starting' });
    assert.equal(service.seen.length, 0, 'the service is not asked without a proof');
    current = 'e'.repeat(64);
    const refused = await fetch(`${app.base}/api/service/sessions`, { headers: { cookie } });
    assert.equal(refused.status, 401);
    assert.equal(forgotten, 1, 'a refusal makes the app read its proof again');
    const read = await fetch(`${app.base}/api/service/sessions`, { headers: { cookie } });
    assert.equal(read.status, 200);
  } finally {
    await app.close();
    await service.close();
  }
});

// Issue #491: a proof that cannot serve is not a service that does not answer.
test('a refused proof is said with its reason, and the service is not asked', async () => {
  const service = await fakeService((response) => { response.writeHead(200); response.end('[]'); });
  const proof = Object.assign(() => { throw new ProofError('the app\'s proof at /state/v2-app-proof is not 64 hex characters', 'malformed'); }, { forget: () => undefined });
  const app = await startApp({ source: serviceSource({ url: service.url, proof }) });
  const logged = console.error;
  console.error = () => undefined;
  try {
    const { cookie } = await signedIn(app);
    const answer = await fetch(`${app.base}/api/service/sessions`, { headers: { cookie } });
    assert.equal(answer.status, 503);
    assert.deepEqual(await answer.json(), { error: 'proof_refused', reason: 'malformed' }, 'the reason, never the path');
    assert.equal(service.seen.length, 0);
  } finally {
    console.error = logged;
    await app.close();
    await service.close();
  }
});
