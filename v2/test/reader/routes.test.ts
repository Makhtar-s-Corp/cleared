// The routes of a question to the code (decision 28, lane 25): POST
// /api/asks, GET /api/asks/:id and POST /api/asks/:id/follow, guarded as
// the service's other routes are: the app's proof, a running reader, and a
// user the service knows for a write.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ASK_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type Ask } from '../../src/api/types.ts';
import { dispatch, defaultRegistry, MemoryUsers, type App } from '../../src/modules/registry.ts';
import sessions from '../../src/modules/sessions.ts';
import { ASK_TABLES } from '../../src/reader/store.ts';
import { readerRoutes } from '../../src/reader/routes.ts';
import { handle } from '../../src/server.ts';
import { readerSetup, turn, until } from './support.ts';

const PROOF = 'd'.repeat(64);
// The second turn starts and never ends: the follow-up's turn runs.
const t = readerSetup({ script: [...turn('t1', 'Line 12 renders the entries.', 0.05), { emit: { type: 'RUN_STARTED', threadId: 'reader', runId: 't2' } }, { awaitMessage: true }] });
let running = true;
let server: Server;
let base = '';

before(async () => {
  const registry = defaultRegistry();
  (registry.users as MemoryUsers).users.set('u1', { id: 'u1', name: 'owner' });
  const app: App = { registry, tables: [], routes: readerRoutes({ reader: () => (running ? t.reader : undefined), proof: () => PROOF }) };
  server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  t.reader.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const signed = { [SERVICE_PROOF_HEADER]: PROOF };
const person = { ...signed, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' };

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

test('the reader serves the three routes lane 17 wrote ahead for it', () => {
  const declared = readerRoutes({ reader: () => undefined, proof: () => PROOF }).map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(declared, [...ASK_ROUTES].sort());
});

test('the sessions module registers them, and the asks table', () => {
  const registered = sessions.routes.map((r) => `${r.method} ${r.path}`);
  assert.ok(ASK_ROUTES.every((route) => registered.includes(route)), registered.join(', '));
  assert.deepEqual(sessions.tables, ASK_TABLES);
});

test('every route needs the proof, a running reader, and a known user for a write', async () => {
  for (const [method, path] of [['POST', '/api/asks'], ['GET', '/api/asks/ask-x'], ['POST', '/api/asks/ask-x/follow']] as const)
    assert.equal((await call(method, path, {}, method === 'POST' ? { question: 'q' } : undefined)).status, 401, `${method} ${path}`);
  assert.equal((await call('POST', '/api/asks', { ...signed, 'content-type': 'application/json' }, { question: 'q' })).status, 403, 'no user');
  assert.equal((await call('POST', '/api/asks', { ...person, [SERVICE_USER_HEADER]: 'nobody' }, { question: 'q' })).status, 403, 'an unknown user');
  running = false;
  try {
    assert.equal((await call('GET', '/api/asks/ask-x', signed)).status, 503);
  } finally {
    running = true;
  }
});

test('an ask, its answer, and a follow-up through the routes', async () => {
  const created = await call('POST', '/api/asks', person, { question: 'What does line 12 do?', target: 'guestbook:src/page.ts:12' });
  assert.equal(created.status, 200);
  const ask = created.json as Ask;
  assert.equal(ask.state, 'starting');
  assert.equal(ask.by, 'u1');
  await until(() => t.reader.get(ask.id)?.state === 'answered', 'the answer');
  const read = await call('GET', `/api/asks/${ask.id}`, signed);
  assert.equal(read.status, 200);
  assert.equal((read.json as Ask).turns[0]?.answer, 'Line 12 renders the entries.');
  assert.equal((read.json as Ask).costUsd, 0.05);
  const followed = await call('POST', `/api/asks/${ask.id}/follow`, person, { question: 'And line 13?' });
  assert.equal(followed.status, 200);
  assert.equal((followed.json as Ask).turns.length, 2);
  assert.equal((await call('POST', `/api/asks/${ask.id}/follow`, person, { question: 'And 14?' })).status, 409, 'a turn runs');
});

test('a bad body, an unknown ask, and a refused question answer with their status', async () => {
  assert.equal((await call('POST', '/api/asks', person, 'not json')).status, 400);
  assert.equal((await call('POST', '/api/asks', person, [])).status, 400);
  assert.equal((await call('POST', '/api/asks', person, { question: 3 })).status, 400);
  assert.equal((await call('POST', '/api/asks', person, { question: 'q', service: 7 })).status, 400);
  assert.equal((await call('POST', '/api/asks', person, { question: 'q', target: 7 })).status, 400);
  assert.equal((await call('POST', '/api/asks', person, { question: 'q', service: 'billing' })).status, 400);
  assert.equal((await call('POST', '/api/asks', person, { question: 'q', target: 'guestbook:src/page.ts:99' })).status, 400);
  assert.equal((await call('GET', '/api/asks/ask-none', signed)).status, 404);
  assert.equal((await call('POST', '/api/asks/ask-none/follow', person, { question: 'q' })).status, 404);
  assert.equal((await call('POST', '/api/asks/ask-none/follow', person, { question: '' })).status, 400);
});
