import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { approvalRoutes } from '../../src/approval/route.ts';
import { defaultRegistry, dispatch, type App } from '../../src/modules/registry.ts';
import { PROOF, head, service } from './support.ts';

async function serve(s: Awaited<ReturnType<typeof service>>, run: (call: (path: string, init?: { user?: string | null; proof?: string | null; body?: unknown; raw?: string; method?: string }) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>) {
  const app: App = { registry: { ...defaultRegistry(), users: s.users, ticketStore: s.store, approvalWriter: s.writer }, tables: [], routes: approvalRoutes };
  const server: Server = createServer((request, response) => dispatch(app, request, response, (_req, res) => { res.writeHead(404); res.end(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, init: { user?: string | null; proof?: string | null; body?: unknown; raw?: string; method?: string } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (init.proof !== null) headers[SERVICE_PROOF_HEADER] = init.proof ?? PROOF;
    if (init.user !== null) headers[SERVICE_USER_HEADER] = init.user ?? 'u-owner';
    const response = await fetch(`${base}${path}`, { method: init.method ?? 'POST', headers, ...((init.method ?? 'POST') === 'GET' ? {} : { body: init.raw ?? JSON.stringify(init.body ?? {}) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
  };
  try { await run(call); } finally { await new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); }
}

test('POST /api/tickets/:id/approve is refused before anything is signed without the app\'s proof, a user id, a known user or the owner', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  const body = { requestedAt: asked.requestedAt, heads: asked.heads };
  await serve(s, async (call) => {
    const path = `/api/tickets/${ticket.id}/approve`;
    // What a session container can at most send: no proof, a user id it made up.
    assert.deepEqual(await call(path, { proof: null, body }), { status: 401, body: { error: 'unauthorized' } });
    assert.equal((await call(path, { proof: 'b'.repeat(64), body })).status, 401);
    assert.equal((await call(path, { proof: PROOF.slice(1), body })).status, 401);
    assert.equal((await call(path, { proof: '', body })).status, 401);
    assert.deepEqual(await call(path, { user: null, body }), { status: 400, body: { error: 'a user id is required' } });
    assert.equal((await call(path, { user: 'nobody', body })).status, 403);
    assert.equal((await call(path, { user: 'u-guest', body })).status, 403, 'only the owner approves');
    assert.equal(s.timers.pending.size, 0);
    assert.equal((await s.store.history(ticket.id)).length, 2, 'nothing was signed');
    assert.deepEqual(s.events(), []);
  });
});

test('the body is checked: JSON, a request time, one to eight pull requests with 40 hex heads', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  await serve(s, async (call) => {
    const path = `/api/tickets/${ticket.id}/approve`;
    assert.equal((await call(path, { raw: '{' })).status, 400);
    assert.equal((await call(path, { raw: '[]' })).status, 400);
    assert.equal((await call(path, { body: { heads: asked.heads } })).status, 400);
    assert.equal((await call(path, { body: { requestedAt: 5, heads: asked.heads } })).status, 400);
    assert.equal((await call(path, { body: { requestedAt: asked.requestedAt, heads: [{ pr: 7, head: 'abc' }] } })).status, 400);
    assert.equal((await call(path, { body: { requestedAt: asked.requestedAt, heads: [{ pr: -1, head: head('a') }] } })).status, 400);
    assert.equal((await call(path, { body: { requestedAt: asked.requestedAt, heads: Array.from({ length: 9 }, (_, i) => ({ pr: i + 1, head: head('a') })) } })).status, 400);
    assert.equal((await call(path, { raw: JSON.stringify({ requestedAt: asked.requestedAt, heads: asked.heads, pad: 'x'.repeat(70_000) }) })).status, 413);
    assert.equal(s.timers.pending.size, 0);
  });
});

test('an accepted approval answers 202 with who and when it will be written; a second one is a conflict', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  const body = { requestedAt: asked.requestedAt, heads: asked.heads };
  await serve(s, async (call) => {
    const path = `/api/tickets/${ticket.id}/approve`;
    const first = await call(path, { body });
    assert.equal(first.status, 202);
    assert.equal(first.body.accepted, true);
    assert.equal(first.body.by, 'u-owner');
    assert.equal(first.body.dueAt, '2026-10-21T10:01:00.000Z');
    assert.equal((await call(path, { body })).status, 409);
    assert.equal((await s.store.get(ticket.id))?.status, 'Needs Approval');
    const undone = await call(`${path}/undo`, {});
    assert.deepEqual(undone, { status: 200, body: { undone: true } });
    assert.equal((await call(`${path}/undo`, {})).status, 409, 'nothing left to undo');
    assert.equal((await call(path, { body })).status, 202, 'it can be asked again');
    await s.timers.fire();
    assert.equal((await s.store.get(ticket.id))?.status, 'Ready to Ship');
    assert.equal((await call(`${path}/undo`, {})).status, 409);
  });
});

test('refusals map to statuses: a stale request or heads 409, a card elsewhere 409, an unknown ticket 404, no key 503', async () => {
  const s = await service();
  const ticket = await s.waiting();
  const asked = s.ask([{ pr: 7, head: head('a') }]);
  await serve(s, async (call) => {
    const path = `/api/tickets/${ticket.id}/approve`;
    assert.equal((await call(path, { body: { requestedAt: asked.requestedAt, heads: [{ pr: 7, head: head('b') }] } })).status, 409);
    assert.equal((await call(path, { body: { requestedAt: '2026-10-21T08:00:00.000Z', heads: asked.heads } })).status, 409);
    assert.equal((await call('/api/tickets/LOCAL-9/approve', { body: { requestedAt: asked.requestedAt, heads: asked.heads } })).status, 404);
    assert.equal((await call('/api/tickets/..%2Fx/approve', { body: { requestedAt: asked.requestedAt, heads: asked.heads } })).status, 404);
    assert.equal((await call(path, { method: 'GET' })).status, 405);
    assert.equal((await call(`${path}/undo`, { user: 'u-guest' })).status, 403);
    assert.equal((await call(`${path}/undo`, { proof: null })).status, 401);
  });
  const unsigned = await service({ withKey: false });
  const waiting = await unsigned.waiting();
  const record = unsigned.ask([{ pr: 7, head: head('a') }]);
  await serve(unsigned, async (call) => {
    const answer = await call(`/api/tickets/${waiting.id}/approve`, { body: { requestedAt: record.requestedAt, heads: record.heads } });
    assert.equal(answer.status, 503);
    assert.match(String(answer.body.error), /set up/);
  });
});

test('the default registry (no approval set up) answers 503, not a fake acceptance', async () => {
  const s = await service();
  const app: App = { registry: defaultRegistry(), tables: [], routes: approvalRoutes };
  const server = createServer((request, response) => dispatch(app, request, response, (_req, res) => { res.writeHead(404); res.end(); }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/tickets/LOCAL-1/approve`, { method: 'POST', headers: { [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'u-owner' }, body: '{}' });
    assert.equal(response.status, 503);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); server.closeAllConnections(); }
  void s;
});
