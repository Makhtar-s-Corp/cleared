import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import lead from '../../src/modules/lead.ts';
import notify from '../../src/modules/notify.ts';
import { MODULE_NAMES, assemble, dispatch, emptyModule, matchRoute, type Module, type Route } from '../../src/modules/registry.ts';
import { handle as health } from '../../src/server.ts';
import { MemoryTicketStore } from '../../src/tickets/contract.ts';

// Lanes 6, 7 and 8 filled the users, sessions, flow, inbox, tickets and
// approval modules (their own tests); the registry tests use empty modules
// for those six. Milestone 2 adds lead and notify (decision 14), stubs
// that lanes 5, 7 and 6 fill.
const stubs = { sessions: emptyModule, users: emptyModule, tickets: emptyModule, flow: emptyModule, approval: emptyModule, inbox: emptyModule, lead: emptyModule, notify: emptyModule };
const deps = { store: undefined as never };

test('the module stubs are empty and assemble into the in-memory defaults', async () => {
  assert.deepEqual([...MODULE_NAMES], ['sessions', 'users', 'tickets', 'flow', 'approval', 'inbox', 'lead', 'notify']);
  assert.equal(MODULE_NAMES.length, 8);
  for (const [name, module] of Object.entries({ lead, notify })) {
    assert.deepEqual([module.tables, module.routes, module.provide(deps)], [[], [], {}], `the ${name} stub is empty`);
  }
  for (const [name, module] of Object.entries(stubs)) {
    assert.deepEqual([module.tables, module.routes, module.provide(deps)], [[], [], {}], name);
  }
  const app = assemble(stubs, deps);
  assert.deepEqual([app.tables, app.routes], [[], []]);
  assert.deepEqual(app.registry.sessionAdapters, {});
  assert.ok(app.registry.ticketStore instanceof MemoryTicketStore);
  assert.deepEqual(await app.registry.users.list(), []);
  await app.registry.reviewRecorder.record({ ticket: 'LOCAL-1', pr: 3, session: 's', model: 'claude-sonnet-5-5', verdict: 'pass', round: 1, report: 'ok', at: '2026-10-21T10:00:00.000Z' });
  await app.registry.approvalWriter.approve({ ticket: 'LOCAL-1', by: 'u1', requestedAt: '2026-10-21T10:00:00.000Z', heads: [{ pr: 3, head: 'abc' }] });
});

const route = (method: Route['method'], path: string, name: string): Route => ({
  method,
  path,
  handle: ({ response, params }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ name, params }));
  },
});

test('a module provides slots, tables and routes; two modules never claim the same slot or route', () => {
  const store = new MemoryTicketStore();
  const filled: Module = { tables: ['CREATE TABLE IF NOT EXISTS t (x)'], routes: [route('GET', '/api/tickets', 'list')], provide: () => ({ ticketStore: store }) };
  const app = assemble({ ...stubs, tickets: filled }, deps);
  assert.equal(app.registry.ticketStore, store);
  assert.deepEqual(app.tables, ['CREATE TABLE IF NOT EXISTS t (x)']);
  assert.equal(app.routes.length, 1);
  assert.throws(() => assemble({ ...stubs, tickets: filled, approval: { ...filled, tables: [], routes: [] } }, deps), /ticketStore is provided by both tickets and approval/);
  assert.throws(() => assemble({ ...stubs, tickets: filled, flow: { tables: [], routes: [route('GET', '/api/tickets', 'again')], provide: () => ({}) } }, deps), /GET \/api\/tickets is declared by both tickets and flow/);
});

test('routes match whole segments and name their parameters', () => {
  const routes = [route('GET', '/api/sessions/:id/events', 'events'), route('POST', '/api/sessions/:id/messages', 'send')];
  const found = matchRoute(routes, 'GET', '/api/sessions/s%201/events');
  assert.ok(found && 'params' in found);
  assert.deepEqual(found.params, { id: 's 1' });
  assert.equal(matchRoute(routes, 'GET', '/api/sessions/%E0%A4/events'), undefined, 'a segment that does not decode matches nothing');
  assert.equal(matchRoute(routes, 'GET', '/api/sessions/s1/events/x'), undefined);
  assert.equal(matchRoute(routes, 'GET', '/api/sessions//events'), undefined);
  assert.deepEqual(matchRoute(routes, 'POST', '/api/sessions/s1/events'), { allow: ['GET'] });
});

async function serve(server: Server, run: (base: string) => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try { await run(`http://127.0.0.1:${port}`); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
}

test('the dispatcher serves module routes and leaves /health and unknown paths to the health server', async () => {
  const failing: Route = { method: 'POST', path: '/api/fail', handle: () => { throw new Error('a detail that must not leak'); } };
  const app = assemble({ ...stubs, flow: { tables: [], routes: [route('GET', '/api/sessions/:id', 'one'), failing], provide: () => ({}) } }, deps);
  await serve(createServer((request, response) => dispatch(app, request, response, health)), async (base) => {
    const one = await fetch(`${base}/api/sessions/abc?after=2`);
    assert.deepEqual(await one.json(), { name: 'one', params: { id: 'abc' } });
    const wrongMethod = await fetch(`${base}/api/sessions/abc`, { method: 'DELETE' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET');
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok' });
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
    const failed = await fetch(`${base}/api/fail`, { method: 'POST' });
    assert.equal(failed.status, 500);
    assert.deepEqual(await failed.json(), { error: 'internal error' });
  });
});
