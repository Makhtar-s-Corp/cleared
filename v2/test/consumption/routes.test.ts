// The Consumption routes (O15): the app's proof first, then the flow running,
// a known user for a write; the levers refused with the reason; what a write
// leaves is what the next read says, and what the engine reads.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LEVERS_TABLE, LeverStore } from '../../src/consumption/levers.ts';
import { consumptionRoutes } from '../../src/consumption/routes.ts';
import type { WeekFigures } from '../../src/consumption/week.ts';
import type { Consumption, LeverChoices } from '../../src/consumption/usage.ts';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, CONSUMPTION_ROUTES } from '../../src/api/types.ts';
import lead from '../../src/modules/lead.ts';
import { MemoryUsers, defaultRegistry, dispatch, type Registry } from '../../src/modules/registry.ts';
import { handle as health } from '../../src/server.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { MemoryTicketStore } from '../../src/tickets/contract.ts';

const PROOF = 'proof-of-the-app';

async function serve(options: { running?: boolean } = {}) {
  const store = openStore(':memory:');
  applyTables(store.db, [LEVERS_TABLE]);
  store.sessions.put({ id: 's1', project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', status: 'running', createdAt: '2026-10-23T08:00:00.000Z', updatedAt: '2026-10-23T08:00:00.000Z' });
  store.events.append({ at: '2026-10-23T08:00:00.000Z', sessionId: 's1', ticket: 'LOCAL-1', project: 'guestbook',
    event: { type: 'RUN_FINISHED', threadId: 's1', runId: 'r1', outcome: { type: 'success' }, usage: [{ inputTokens: 10, outputTokens: 5 }], result: { stopReason: 'end_turn', total_cost_usd: 0.2 } } as never });
  const tickets = new MemoryTicketStore({ now: () => '2026-10-23T09:00:00.000Z' });
  const merged = await tickets.create({ title: 'Sign the guestbook', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  await tickets.move(merged.id, tickets.states.done, { kind: 'agents', id: 'cleared-v2' });
  const users = new MemoryUsers();
  users.users.set('u1', { id: 'u1', name: 'owner' });
  const registry: Registry = { ...defaultRegistry(), users };
  const running = options.running !== false;
  const routes = consumptionRoutes({
    target: () => (running ? { db: store.db, project: 'guestbook', config: { authorModel: 'claude-opus-5-5', reviewerModel: 'claude-sonnet-5-5' }, tickets, services: ['guestbook'] } : undefined),
    proof: () => PROOF, now: () => new Date('2026-10-23T12:00:00.000Z'),
  });
  const server: Server = createServer((request, response) => dispatch({ registry, tables: [], routes }, request, response, health));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, o: { user?: string | null; proof?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const proof = o.proof === undefined ? PROOF : o.proof;
    const user = o.user === undefined ? 'u1' : o.user;
    if (proof !== null) headers[SERVICE_PROOF_HEADER] = proof;
    if (user !== null) headers[SERVICE_USER_HEADER] = user;
    const response = await fetch(`${base}${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    return { status: response.status, body: await response.json() as unknown };
  };
  return { call, store };
}

test('the lead module declares the routes of the screen', () => {
  const declared = lead.routes.map((r) => `${r.method} ${r.path}`);
  assert.ok(CONSUMPTION_ROUTES.includes('GET /api/consumption/week'));
  for (const route of CONSUMPTION_ROUTES) assert.ok(declared.includes(route), route);
  assert.ok(lead.tables.includes(LEVERS_TABLE));
});

test('both routes answer 401 without the proof and 503 while the flow does not run; a write needs a known user', async () => {
  const t = await serve();
  const down = await serve({ running: false });
  for (const [method, path] of [['GET', '/api/consumption'], ['GET', '/api/consumption/week'], ['POST', '/api/consumption/levers']] as const) {
    assert.equal((await t.call(method, path, { proof: 'wrong', body: method === 'POST' ? {} : undefined })).status, 401);
    assert.equal((await down.call(method, path, { body: method === 'POST' ? { paused: true } : undefined })).status, 503);
  }
  assert.equal((await t.call('POST', '/api/consumption/levers', { user: 'stranger', body: { paused: true } })).status, 403);
  assert.equal((await t.call('POST', '/api/consumption/levers', { user: null, body: { paused: true } })).status, 403);
  assert.equal((await t.call('GET', '/api/consumption', { user: null })).status, 200, 'a read needs no user');
});

test('the read gives the days in the asked zone, the tokens of the harness and its cost', async () => {
  const t = await serve();
  const { status, body } = await t.call('GET', '/api/consumption?tz=Europe%2FParis');
  const read = body as Consumption;
  assert.equal(status, 200);
  assert.equal(read.timeZone, 'Europe/Paris');
  assert.equal(read.days.at(-1), '2026-10-23');
  const claude = read.harnesses.find((h) => h.harness === 'claude-code')!;
  assert.equal(claude.tokens, 15);
  assert.equal(claude.costUsd, 0.2);
  assert.equal((await t.call('GET', '/api/consumption?tz=Nowhere%2FAtAll')).status, 200);
  assert.equal(((await t.call('GET', '/api/consumption?tz=Nowhere%2FAtAll')).body as Consumption).timeZone, 'UTC');
});

test('a lever is written, answered, kept for the next read and for the readers of the engine and the scheduler', async () => {
  const t = await serve();
  const set = await t.call('POST', '/api/consumption/levers', { body: { model: 'claude-haiku-5-5', maxLanes: 1, paused: true } });
  assert.equal(set.status, 200);
  const choices = set.body as LeverChoices;
  assert.equal(choices.model.choice, 'claude-haiku-5-5');
  assert.equal(choices.model.current, 'claude-haiku-5-5');
  assert.equal(choices.maxLanes.choice, 1);
  assert.equal(choices.paused, true);
  assert.deepEqual(((await t.call('GET', '/api/consumption')).body as Consumption).levers, choices);
  assert.deepEqual(new LeverStore(t.store.db, 'guestbook').read(), { model: 'claude-haiku-5-5', maxLanes: 1, paused: true });
  const off = await t.call('POST', '/api/consumption/levers', { body: { model: null, maxLanes: null, paused: false } });
  assert.equal((off.body as LeverChoices).model.current, 'claude-opus-5-5');
});

test('a lever that is not valid is a 400 with the reason, and nothing changes', async () => {
  const t = await serve();
  const refused = await t.call('POST', '/api/consumption/levers', { body: { model: 'claude-sonnet-5-5' } });
  assert.equal(refused.status, 400);
  assert.match((refused.body as { error: string }).error, /cannot be the reviewers/);
  assert.equal((await t.call('POST', '/api/consumption/levers', { body: { maxLanes: 50 } })).status, 400);
  assert.equal((await t.call('POST', '/api/consumption/levers', { body: {} })).status, 400);
  assert.equal((await t.call('POST', '/api/consumption/levers', { body: { paused: true, maxLanes: 0 } })).status, 400);
  assert.equal(((await t.call('GET', '/api/consumption')).body as Consumption).levers.paused, false);
});

test('the week\'s figures in the asked zone: the tickets merged, the tokens, the time and the dollars, per service', async () => {
  const t = await serve();
  const { status, body } = await t.call('GET', '/api/consumption/week?tz=Europe%2FParis', { user: null });
  assert.equal(status, 200, 'a read needs no user');
  const week = body as WeekFigures;
  assert.equal(week.timeZone, 'Europe/Paris');
  assert.equal(week.days.at(-1), '2026-10-23');
  assert.deepEqual(week.merged.map((m) => [m.id, m.title, m.services]), [['LOCAL-1', 'Sign the guestbook', ['guestbook']]]);
  assert.deepEqual([week.spend.tokens, week.spend.costUsd], [15, 0.2]);
  assert.deepEqual(week.services.map((s) => [s.service, s.merged, s.tokens]), [['guestbook', 1, 15]]);
  assert.equal(((await t.call('GET', '/api/consumption/week?tz=Nowhere%2FAtAll')).body as WeekFigures).timeZone, 'UTC');
});
