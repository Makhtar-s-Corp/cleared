// The batch's routes over HTTP (requirement C6): POST /api/batches,
// GET /api/batches and GET /api/batches/:id, with the checks of the
// service's API: the app's proof, then the flow, then for a write a user the
// service knows; a batch refused whole with a 400 before any ticket exists.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BATCH_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type Batch } from '../../src/api/types.ts';
import type { Levers } from '../../src/consumption/levers.ts';
import { BatchRunner, batchRoutes } from '../../src/flow/batch.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { finished, setup, started, text, until, type Setup } from './support.ts';

const PROOF = 'c'.repeat(64);
const working = (id: string): FakeStep[] => [started, ...text(id, 'Still at it.'), { awaitMessage: true }, finished(0.1)];

let t: Setup;
let runner: BatchRunner;
let server: Server;
let base = '';

before(async () => {
  t = await setup({ scripts: { authors: [working('a1'), working('a2'), working('a3'), working('a4')] } });
  const levers = { read: (): Levers => ({ model: null, maxLanes: 2, paused: false }) };
  runner = new BatchRunner({ db: t.store.db, tickets: t.tickets, flow: t.engine, project: 'guestbook', levers, weekStopPercent: 85, now: () => new Date(t.clock.now) });
  runner.listen();
  const routes = batchRoutes({ runner: () => runner, proof: () => PROOF });
  const app: App = { registry: t.engine.registry, tables: [], routes };
  server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await runner.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const signed = { [SERVICE_PROOF_HEADER]: PROOF };
const person = { ...signed, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' };

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : undefined };
}

test('the service declares the three routes of the batches, and the type lists them', () => {
  const declared = batchRoutes({ runner: () => runner, proof: () => PROOF }).map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(declared, [...BATCH_ROUTES].sort());
  assert.deepEqual([...BATCH_ROUTES].sort(), ['GET /api/batches', 'GET /api/batches/:id', 'POST /api/batches']);
});

test('every route needs the app\'s proof, and a write a known user', async () => {
  for (const [method, path] of [['GET', '/api/batches'], ['GET', '/api/batches/batch-1'], ['POST', '/api/batches']] as const)
    assert.equal((await call(method, path, {}, method === 'POST' ? {} : undefined)).status, 401, `${method} ${path}`);
  assert.equal((await call('POST', '/api/batches', { ...signed, 'content-type': 'application/json' }, { project: 'guestbook', tickets: [{ title: 'A' }, { title: 'B' }] })).status, 403);
  assert.equal((await call('POST', '/api/batches', { ...person, [SERVICE_USER_HEADER]: 'nobody' }, { project: 'guestbook', tickets: [{ title: 'A' }, { title: 'B' }] })).status, 403);
  assert.deepEqual((await call('GET', '/api/batches', signed)).json, [], 'nothing was created by the refused calls');
});

test('a body that is not a batch is a 400, before any ticket exists', async () => {
  const before = (await t.tickets.list({ project: 'guestbook' })).length;
  const bodies: unknown[] = [
    {}, { project: 'guestbook' }, { project: 'guestbook', tickets: 'one' }, { project: 'guestbook', tickets: [{ title: 'Alone' }] },
    { project: 'other', tickets: [{ title: 'A' }, { title: 'B' }] },
    { tickets: [{ title: 'A' }, { title: 'B' }] },
    { project: 'guestbook', tickets: [{ title: 'A' }, { title: '' }] },
    { project: 'guestbook', tickets: [{ title: 'A' }, { title: 'B', variants: 2 }] },
    { project: 'guestbook', variants: 2, tickets: [{ title: 'A' }, { title: 'B' }] },
    { project: 'guestbook', tickets: [{ title: 'A' }, { title: 'B', labels: 'x' }] },
  ];
  for (const body of bodies) assert.equal((await call('POST', '/api/batches', person, body)).status, 400, JSON.stringify(body));
  assert.equal((await t.tickets.list({ project: 'guestbook' })).length, before);
});

test('a batch is created, followed, and listed', async () => {
  const made = await call('POST', '/api/batches', person, { project: 'guestbook', tickets: [{ title: 'One', body: 'First.' }, { title: 'Two' }, { title: 'Three' }] });
  assert.equal(made.status, 200);
  const batch = made.json as Batch;
  assert.deepEqual(batch.items.map((i) => i.title), ['One', 'Two', 'Three']);
  assert.deepEqual(batch.items.map((i) => i.state), ['started', 'started', 'queued']);
  assert.equal(batch.by, 'u1');
  assert.equal(batch.lanes, 2);
  assert.equal(batch.running, 2);
  assert.deepEqual(batch.hold, { reason: 'lanes', running: 2, lanes: 2 });
  await t.engine.settled();
  await until(() => t.startedSessions.length === 2, 'the two sessions');

  const one = await call('GET', `/api/batches/${batch.id}`, signed);
  assert.equal(one.status, 200);
  assert.deepEqual((one.json as Batch).items.map((i) => i.status), ['In Progress', 'In Progress', 'Todo']);
  assert.equal((await call('GET', '/api/batches/batch-99', signed)).status, 404);
  const list = await call('GET', '/api/batches', signed);
  assert.deepEqual((list.json as Batch[]).map((b) => b.id), [batch.id]);
});
