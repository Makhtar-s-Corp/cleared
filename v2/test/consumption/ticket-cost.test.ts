// The cost of a ticket (P211, issue #327): every session the ledger holds
// for the ticket, whatever its role; the tokens of every finished turn; the
// agents' own time, turn by turn, and the time from the ticket's first event
// to its last; the dollars only when every session that finished a turn
// reported a total, read as the session's running total, never summed.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CONSUMPTION_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { LEVERS_TABLE } from '../../src/consumption/levers.ts';
import { consumptionRoutes } from '../../src/consumption/routes.ts';
import { sessionsCost, ticketCost, type TicketCost } from '../../src/consumption/ticket-cost.ts';
import lead from '../../src/modules/lead.ts';
import { MemoryUsers, defaultRegistry, dispatch, type Registry } from '../../src/modules/registry.ts';
import { handle as health } from '../../src/server.ts';
import type { Harness, Role } from '../../src/session/contract.ts';
import type { AgUiEvent, SessionEvent } from '../../src/session/events.ts';
import { applyTables, openStore, type Store } from '../../src/store/db.ts';

const PROJECT = 'guestbook';
const T0 = Date.parse('2026-10-25T08:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

let seq = 0;
const ev = (sessionId: string, minutes: number, event: AgUiEvent, ticket = 'LOCAL-7'): SessionEvent =>
  ({ seq: ++seq, at: at(minutes), sessionId, ticket, project: PROJECT, event });
const started = (id: string, minutes: number, run: string) => ev(id, minutes, { type: 'RUN_STARTED', threadId: id, runId: run });
const finished = (id: string, minutes: number, run: string, usage: Record<string, number>, cost: number | null, stopReason: 'end_turn' | 'cancelled' = 'end_turn') =>
  ev(id, minutes, { type: 'RUN_FINISHED', threadId: id, runId: run, outcome: { type: stopReason === 'cancelled' ? 'cancelled' : 'success' }, usage: [usage], result: { stopReason, total_cost_usd: cost } } as AgUiEvent);
const failed = (id: string, minutes: number) => ev(id, minutes, { type: 'RUN_ERROR', message: 'the harness stopped' } as AgUiEvent);
const text = (id: string, minutes: number) => ev(id, minutes, { type: 'TEXT_MESSAGE_START', messageId: `m${seq}`, role: 'assistant' } as AgUiEvent);

test('the dollars of a session are its last running total, not the sum of its turns', () => {
  const author = [
    started('a', 0, 'r1'), finished('a', 10, 'r1', { inputTokens: 100, outputTokens: 20 }, 0.4),
    started('a', 12, 'r2'), finished('a', 15, 'r2', { inputTokens: 50, outputTokens: 10, cachedInputTokens: 1000, cacheWriteInputTokens: 5 }, 0.55),
  ];
  const cost = sessionsCost([author]);
  assert.equal(cost.costUsd, 0.55, 'Claude Code reports the session\'s running total: 0.40 then 0.55 is 0.55 in all');
  assert.equal(cost.tokens, 1185, 'the four counts of each finished turn');
  assert.equal(cost.turns, 2);
  assert.equal(cost.sessions, 1);
  assert.equal(cost.workMs, 13 * 60_000, 'each turn from its start to its end: 10 min and 3 min');
});

test('a turn with no total (a cancelled turn) is skipped, never read as zero, so the next total is not counted twice', () => {
  const author = [
    started('a', 0, 'r1'), finished('a', 5, 'r1', { inputTokens: 10 }, 0.3),
    started('a', 6, 'r2'), finished('a', 7, 'r2', {}, null, 'cancelled'),
    started('a', 8, 'r3'), finished('a', 9, 'r3', { inputTokens: 10 }, 0.35),
  ];
  assert.equal(sessionsCost([author]).costUsd, 0.35);
});

test('a total lower than the one before is a new process of the session (a resume): what it reports adds to what was spent', () => {
  const author = [
    started('a', 0, 'r1'), finished('a', 5, 'r1', { inputTokens: 10 }, 0.5),
    started('a', 30, 'r2'), finished('a', 32, 'r2', { inputTokens: 10 }, 0.1),
    started('a', 33, 'r3'), finished('a', 34, 'r3', { inputTokens: 10 }, 0.25),
  ];
  assert.equal(sessionsCost([author]).costUsd, 0.75, '0.50 before the resume, then 0.25 since');
});

// Issue #453: the flow journals cleared.container_recreated when it starts a
// session's second process. The real harness resumed in a new container
// goes on with the session's running total (docs/adapters.md, the run of
// 2026-10-21: 0.00536 before, 0.00560 after, a turn of about 0.0002), so the
// second process's totals are read as the first's were.
const recreated = (id: string, minutes: number) => ev(id, minutes, { type: 'CUSTOM', name: 'cleared.container_recreated', value: { attempt: 1, limit: 3, waitedMs: 5000 } });
const lost = (id: string, minutes: number) => ev(id, minutes, { type: 'RUN_ERROR', message: 'the session\'s container stopped (exit code 137)', code: 'container_lost' });

test('a session whose container was recreated counts both processes once: the running total goes on across the recreation, and a total that starts again adds', () => {
  const author = [
    started('a', 0, 'r1'), finished('a', 5, 'r1', { inputTokens: 10 }, 0.2),
    started('a', 6, 'r2'), finished('a', 8, 'r2', { inputTokens: 10 }, 0.3),
    started('a', 9, 'r3'), lost('a', 10), recreated('a', 11),
    started('a', 12, 'r4'), finished('a', 14, 'r4', { inputTokens: 10 }, 0.35),
    started('a', 15, 'r5'), finished('a', 16, 'r5', { inputTokens: 10 }, 0.45),
  ];
  const cost = sessionsCost([author]);
  assert.equal(cost.costUsd, 0.45, 'the session\'s last running total: not 0.75 (the first process twice) and not 1.30 (every turn summed)');
  assert.equal(cost.turns, 4, 'the cut turn finished nothing');
  assert.equal(cost.workMs, 11 * 60_000, 'each turn from its start to its end, the cut one up to the loss: 5, 2, 1, 2 and 1 minutes');
  const restarted = [...author.slice(0, 7), started('a', 12, 'r4'), finished('a', 14, 'r4', { inputTokens: 10 }, 0.05), started('a', 15, 'r5'), finished('a', 16, 'r5', { inputTokens: 10 }, 0.15)];
  assert.equal(sessionsCost([restarted]).costUsd, 0.45, 'a second process reporting from zero: 0.30, then its 0.15');
});

test('the dollars are unknown when one session that finished a turn never reported a total; tokens and time are still counted', () => {
  const author = [started('a', 0, 'r1'), finished('a', 10, 'r1', { inputTokens: 100 }, 0.4)];
  const codex = [started('c', 11, 'r1'), finished('c', 20, 'r1', { inputTokens: 40, outputTokens: 2 }, null)];
  const cost = sessionsCost([author, codex]);
  assert.equal(cost.costUsd, null, 'a partial sum is not the cost');
  assert.equal(cost.tokens, 142);
  assert.equal(cost.sessions, 2);
  assert.equal(cost.workMs, 19 * 60_000);
});

test('a session that finished no turn changes nothing; with no finished turn at all, the tokens and the dollars are unknown', () => {
  const starting = [started('s', 0, 'r1')];
  assert.deepEqual(sessionsCost([starting]), { sessions: 0, turns: 0, tokens: null, workMs: 0, costUsd: null });
  const author = [started('a', 0, 'r1'), finished('a', 2, 'r1', { inputTokens: 1 }, 0.01)];
  assert.equal(sessionsCost([author, starting]).costUsd, 0.01);
  assert.equal(sessionsCost([author, starting]).sessions, 1);
});

test('a turn that ends in an error counts its time; a turn still running counts none yet', () => {
  const author = [started('a', 0, 'r1'), failed('a', 4), started('a', 5, 'r2'), finished('a', 6, 'r2', { inputTokens: 1 }, 0.01), started('a', 7, 'r3')];
  assert.equal(sessionsCost([author]).workMs, 5 * 60_000);
});

// ---- a period (the week's figures, C17, issue #396) -----------------------

test('from a start: only the turns finished after it, a turn across it counting its part inside, the dollars each running total\'s increase', () => {
  const author = [
    started('a', 0, 'r1'), finished('a', 10, 'r1', { inputTokens: 100 }, 0.4),
    started('a', 20, 'r2'), finished('a', 40, 'r2', { inputTokens: 50 }, 0.7),
    started('a', 50, 'r3'), finished('a', 55, 'r3', { inputTokens: 5 }, 0.2),
  ];
  const since = Date.parse(at(30));
  assert.deepEqual(sessionsCost([author], since), { sessions: 1, turns: 2, tokens: 55, workMs: 15 * 60_000, costUsd: 0.5 },
    '0.40 before the start, then 0.30 more and a resume of 0.20; 10 of the second turn\'s 20 minutes and the third\'s 5');
  assert.deepEqual(sessionsCost([author], undefined), sessionsCost([author]), 'without a start, the whole of it, as before');
});

test('from a start: a session whose turns all ended before it is not counted, and does not make the dollars unknown', () => {
  const codex = [started('c', 0, 'r1'), finished('c', 5, 'r1', { inputTokens: 40 }, null)];
  const author = [started('a', 40, 'r1'), finished('a', 45, 'r1', { inputTokens: 10 }, 0.1)];
  assert.deepEqual(sessionsCost([codex, author], Date.parse(at(30))), { sessions: 1, turns: 1, tokens: 10, workMs: 5 * 60_000, costUsd: 0.1 });
  assert.equal(sessionsCost([codex, author]).costUsd, null);
});

// ---- the ledger ------------------------------------------------------------

function put(store: Store, id: string, role: Role, harness: Harness, ticket = 'LOCAL-7') {
  store.sessions.put({ id, project: PROJECT, ticket, role, harness, model: 'claude-opus-5-5', status: 'done', createdAt: at(0), updatedAt: at(0) });
}
const append = (store: Store, events: readonly SessionEvent[]) => {
  for (const e of events) store.events.append({ at: e.at, sessionId: e.sessionId, ticket: e.ticket, project: e.project, event: e.event });
};

test('the ledger\'s cost of a ticket counts every session it holds for the ticket: the author, its put-back run, the reviewer', () => {
  const store = openStore(':memory:');
  put(store, 'a1', 'author', 'claude-code');
  put(store, 'a2', 'author', 'claude-code');
  put(store, 'rv', 'reviewer', 'claude-code');
  put(store, 'other', 'author', 'claude-code', 'LOCAL-8');
  append(store, [
    started('a1', 0, 'r1'), text('a1', 1), finished('a1', 20, 'r1', { inputTokens: 1000, outputTokens: 100 }, 1.2),
    started('a2', 40, 'r1'), finished('a2', 50, 'r1', { inputTokens: 500, outputTokens: 50 }, 0.6),
    started('rv', 55, 'r1'), finished('rv', 62, 'r1', { inputTokens: 300, outputTokens: 30 }, 0.2),
    text('rv', 64),
  ]);
  append(store, [started('other', 0, 'r1'), finished('other', 3, 'r1', { inputTokens: 9999 }, 9, 'end_turn')].map((e) => ({ ...e, ticket: 'LOCAL-8' })));
  const cost = ticketCost(store.db, { project: PROJECT, ticket: 'LOCAL-7' });
  assert.deepEqual(cost, {
    ticket: 'LOCAL-7', sessions: 3, turns: 3, tokens: 1980,
    workMs: (20 + 10 + 7) * 60_000, elapsedMs: 64 * 60_000, costUsd: 2,
  } satisfies TicketCost);
  store.close();
});

test('the ledger\'s cost of a ticket whose session\'s container was recreated is the session\'s last running total (issue #453)', () => {
  const store = openStore(':memory:');
  put(store, 'a1', 'author', 'claude-code');
  append(store, [
    started('a1', 0, 'r1'), finished('a1', 5, 'r1', { inputTokens: 10 }, 0.3),
    started('a1', 6, 'r2'), lost('a1', 7), recreated('a1', 8),
    started('a1', 9, 'r3'), finished('a1', 10, 'r3', { inputTokens: 10 }, 0.4),
  ]);
  const cost = ticketCost(store.db, { project: PROJECT, ticket: 'LOCAL-7' });
  assert.equal(cost.costUsd, 0.4);
  assert.equal(cost.turns, 2);
});

test('the ledger\'s cost of a ticket with no session is empty, and another project\'s events are not read', () => {
  const store = openStore(':memory:');
  put(store, 'a1', 'author', 'claude-code');
  append(store, [started('a1', 0, 'r1'), finished('a1', 5, 'r1', { inputTokens: 10 }, 0.1)].map((e) => ({ ...e, project: 'filter-api' })));
  assert.deepEqual(ticketCost(store.db, { project: PROJECT, ticket: 'LOCAL-7' }), { ticket: 'LOCAL-7', sessions: 0, turns: 0, tokens: null, workMs: 0, elapsedMs: 0, costUsd: null });
  store.close();
});

test('a Codex session of the ticket (a handover) leaves the dollars unknown', () => {
  const store = openStore(':memory:');
  put(store, 'a1', 'author', 'claude-code');
  put(store, 'cx', 'author', 'codex');
  append(store, [
    started('a1', 0, 'r1'), finished('a1', 5, 'r1', { inputTokens: 10 }, 0.1),
    started('cx', 6, 'r1'), finished('cx', 9, 'r1', { inputTokens: 20 }, null),
  ]);
  const cost = ticketCost(store.db, { project: PROJECT, ticket: 'LOCAL-7' });
  assert.equal(cost.costUsd, null);
  assert.equal(cost.tokens, 30);
  store.close();
});

// ---- the route -------------------------------------------------------------

const PROOF = 'proof-of-the-app';

async function serve(options: { running?: boolean } = {}) {
  const store = openStore(':memory:');
  applyTables(store.db, [LEVERS_TABLE]);
  put(store, 'a1', 'author', 'claude-code', 'LOCAL 9/x');
  append(store, [started('a1', 0, 'r1'), finished('a1', 30, 'r1', { inputTokens: 10, outputTokens: 5 }, 0.2)].map((e) => ({ ...e, ticket: 'LOCAL 9/x' })));
  const users = new MemoryUsers();
  users.users.set('u1', { id: 'u1', name: 'owner' });
  const registry: Registry = { ...defaultRegistry(), users };
  const running = options.running !== false;
  const routes = consumptionRoutes({
    target: () => (running ? { db: store.db, project: PROJECT, config: { authorModel: 'claude-opus-5-5', reviewerModel: 'claude-sonnet-5-5' } } : undefined),
    proof: () => PROOF,
  });
  const server: Server = createServer((request, response) => dispatch({ registry, tables: [], routes }, request, response, health));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string, proof: string | null = PROOF) => {
    const headers: Record<string, string> = { [SERVICE_USER_HEADER]: 'u1' };
    if (proof !== null) headers[SERVICE_PROOF_HEADER] = proof;
    const response = await fetch(`${base}${path}`, { headers });
    return { status: response.status, body: await response.json() as unknown };
  };
}

test('the lead module declares GET /api/tickets/:id/cost with the Consumption routes', () => {
  assert.ok(CONSUMPTION_ROUTES.includes('GET /api/tickets/:id/cost'));
  assert.ok(lead.routes.some((r) => r.method === 'GET' && r.path === '/api/tickets/:id/cost'));
});

test('GET /api/tickets/:id/cost answers the ledger\'s cost of the ticket, the id decoded; 401 without the proof, 503 while the flow does not run', async () => {
  const call = await serve();
  const { status, body } = await call(`/api/tickets/${encodeURIComponent('LOCAL 9/x')}/cost`);
  assert.equal(status, 200);
  assert.deepEqual(body, { ticket: 'LOCAL 9/x', sessions: 1, turns: 1, tokens: 15, workMs: 30 * 60_000, elapsedMs: 30 * 60_000, costUsd: 0.2 });
  assert.equal((await call('/api/tickets/LOCAL-404/cost')).status, 200, 'a ticket with no session costs nothing yet');
  assert.equal(((await call('/api/tickets/LOCAL-404/cost')).body as TicketCost).tokens, null);
  assert.equal((await call('/api/tickets/LOCAL-1/cost', null)).status, 401);
  const down = await serve({ running: false });
  assert.equal((await down('/api/tickets/LOCAL-1/cost')).status, 503);
});
