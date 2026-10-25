// The week's figures (C17, issue #396, milestone 4 plan section 10), read
// from what the ledger already holds and written nowhere: the screen's seven
// days in the person's zone; the tickets merged in them (Done now, the last
// move to Done the service's agents', never the mirror's nor a person's);
// the tokens and the agents' time of every turn finished in them; the
// dollars only as the harness reported them, each running total's increase,
// none when one session reported nothing; each merged ticket's estimate
// against what it took, in minutes only; and the same per service, the
// lead's and the questions' turns on a row of the workspace's own.
process.env.TZ = 'UTC';

import test from 'node:test';
import assert from 'node:assert/strict';
import { consumption, lastDays } from '../../src/consumption/usage.ts';
import { weekFigures, type WeekFigures } from '../../src/consumption/week.ts';
import { PLAN_TABLES } from '../../src/lead/plans/store.ts';
import type { Harness, Role } from '../../src/session/contract.ts';
import type { AgUiEvent } from '../../src/session/events.ts';
import { applyTables, openStore, type Store } from '../../src/store/db.ts';
import { MemoryTicketStore, type Actor, type TicketId } from '../../src/tickets/contract.ts';
import { ApprovalSigner } from '../../src/approval/signer.ts';
import { MemoryUsers } from '../../src/modules/registry.ts';
import { LocalTicketStore, TICKET_TABLES } from '../../src/tickets/local-store.ts';
import { OWNER as OWNER_LOGIN, lockBox } from '../approval/harness.ts';

const PROJECT = 'guestbook';
const SERVICES = ['guestbook', 'filter-api'];
const ZONE = 'Europe/Paris';
// Sunday 25 October 2026, noon in Paris (the clocks went back at 03:00).
const NOW = new Date('2026-10-25T11:00:00.000Z');
// Monday 19 October, midnight in Paris (summer time, two hours ahead).
const SINCE = '2026-10-18T22:00:00.000Z';
const MIN = 60_000;
const at = (iso: string, minutes = 0) => new Date(Date.parse(iso) + minutes * MIN).toISOString();
const IN_WEEK = '2026-10-21T08:00:00.000Z';
const BEFORE = '2026-10-17T08:00:00.000Z';

const SERVICE: Actor = { kind: 'agents', id: 'cleared-v2' };
const MERGE: Actor = { kind: 'agents', id: 'cleared-agents' };          // a move by v1's tracker under the agents' account
const MIRROR: Actor = { kind: 'agents', id: 'cleared-mirror' };
const OWNER: Actor = { kind: 'human', id: 'u1' };

function ledger() {
  const store = openStore(':memory:');
  applyTables(store.db, PLAN_TABLES);
  let clock = BEFORE;
  const tickets = new MemoryTicketStore({ now: () => clock });
  const when = (iso: string) => { clock = iso; };
  return { store, tickets, when };
}

let run = 0;
function session(store: Store, input: { id: string; ticket: string; role?: Role; harness?: Harness; service?: string | null; project?: string }) {
  const project = input.project ?? PROJECT;
  store.sessions.put({
    id: input.id, project, ticket: input.ticket, role: input.role ?? 'author', harness: input.harness ?? 'claude-code', model: 'claude-opus-5-5',
    status: 'done', createdAt: BEFORE, updatedAt: BEFORE, ...(input.service !== undefined ? { service: input.service } : {}),
  });
  const put = (iso: string, event: AgUiEvent) => store.events.append({ at: iso, sessionId: input.id, ticket: input.ticket, project, event });
  return {
    // A turn from `from` to `to`, with its tokens and the running total the harness reported.
    turn(from: string, to: string, tokens: number, total: number | null) {
      const runId = `r${++run}`;
      put(from, { type: 'RUN_STARTED', threadId: input.id, runId });
      put(to, { type: 'RUN_FINISHED', threadId: input.id, runId, outcome: { type: 'success' }, usage: [{ inputTokens: tokens }], result: { stopReason: 'end_turn', total_cost_usd: total } } as AgUiEvent);
    },
    step(iso: string, type: 'STEP_STARTED' | 'STEP_FINISHED', stepName: 'release' | 'waiting_human') {
      put(iso, { type, stepName } as AgUiEvent);
    },
  };
}

function planItem(store: Store, ticket: string, minutes: number, project = PROJECT, plan = `plan-${ticket}`) {
  store.db.prepare(`INSERT INTO plans (id, project, goal, title, summary, state, max_parallel, totals, proposed_at)
    VALUES (?, ?, 'a goal', 'a plan', 'a summary', 'running', 1, '{}', ?)`).run(plan, project, BEFORE);
  store.db.prepare(`INSERT INTO plan_items (plan_id, position, title, body, lane, size, after, estimate, ticket, state, updated_at)
    VALUES (?, 1, 'an item', '', 'full', 'm', '[]', ?, ?, 'landed', ?)`).run(plan, JSON.stringify({ minutes, costUsd: 0.8, weekPercent: null, samples: 0 }), ticket, BEFORE);
}

async function merged(t: ReturnType<typeof ledger>, title: string, iso: string, by: Actor = SERVICE, services?: string[]): Promise<TicketId> {
  t.when(at(iso, -60));
  const ticket = await t.tickets.create({ title, project: PROJECT, ...(services ? { services } : {}) }, OWNER);
  t.when(iso);
  await t.tickets.move(ticket.id, t.tickets.states.done, by);
  return ticket.id;
}

const read = (t: ReturnType<typeof ledger>, zone = ZONE): Promise<WeekFigures> =>
  weekFigures(t.store.db, t.tickets, { project: PROJECT, services: SERVICES, now: NOW, timeZone: zone });

test('the week is the screen\'s seven days in the person\'s zone, from the first one\'s midnight to now', async () => {
  const week = await read(ledger());
  assert.deepEqual(week.days, lastDays(NOW, ZONE));
  assert.equal(week.days[0], '2026-10-19');
  assert.equal(week.since, SINCE, 'midnight in Paris on 19 October, summer time');
  assert.equal(week.at, NOW.toISOString());
  assert.equal(week.timeZone, ZONE);
  assert.equal((await read(ledger(), 'Not/AZone')).timeZone, 'UTC', 'an unknown zone reads as UTC');
  assert.equal((await read(ledger(), 'Not/AZone')).since, '2026-10-19T00:00:00.000Z');
});

test('a ticket is merged when it is Done now and its last move to Done, in the week, was the service\'s agents\'', async () => {
  const t = ledger();
  const flow = await merged(t, 'Sign the guestbook', IN_WEEK, SERVICE, ['guestbook']);
  const guarded = await merged(t, 'Filter the words', at(IN_WEEK, 60), MERGE, ['filter-api']);
  await merged(t, 'Closed on the tracker', IN_WEEK, MIRROR);
  await merged(t, 'Moved by hand', IN_WEEK, OWNER);
  await merged(t, 'Merged last week', BEFORE, SERVICE);
  const back = await merged(t, 'Rolled back', IN_WEEK, SERVICE);
  t.when(at(IN_WEEK, 30));
  await t.tickets.move(back, t.tickets.states.todo, SERVICE);
  // Merged once, sent back, merged again in the week: its last move counts.
  const twice = await merged(t, 'Merged twice', BEFORE, SERVICE);
  t.when(at(IN_WEEK, 10));
  await t.tickets.move(twice, t.tickets.states.todo, SERVICE);
  t.when(at(IN_WEEK, 120));
  await t.tickets.move(twice, t.tickets.states.done, SERVICE);
  t.when(BEFORE);
  const elsewhere = await t.tickets.create({ title: 'Another workspace', project: 'other' }, OWNER);
  t.when(IN_WEEK);
  await t.tickets.move(elsewhere.id, t.tickets.states.done, SERVICE);

  const week = await read(t);
  assert.deepEqual(week.merged.map((m) => m.id), [twice, guarded, flow], 'the newest first');
  const first = week.merged.find((m) => m.id === flow);
  assert.deepEqual(first, { id: flow, title: 'Sign the guestbook', services: ['guestbook'], mergedAt: IN_WEEK, estimateMinutes: null, actualMinutes: null });
  assert.deepEqual(week.merged.find((m) => m.id === twice)?.services, ['guestbook'], 'a ticket that names no service is on the workspace\'s first');
});

test('on the real store: the flow\'s Done and the guarded merge\'s (v1\'s tracker under the service account, read as other) are merges; the mirror\'s and the owner\'s signed move are not', async () => {
  const box = lockBox();
  const store = openStore(':memory:');
  applyTables(store.db, TICKET_TABLES);
  const users = new MemoryUsers();
  users.users.set('user-uuid-1', { id: 'user-uuid-1', name: OWNER_LOGIN });
  let clock = at(IN_WEEK, -60);
  const tickets = new LocalTicketStore(store.db, { stateDir: box.state, ownerId: OWNER_LOGIN, users, signer: ApprovalSigner.load(box.keyFile), publicKey: box.keys.publicKey, now: () => clock });
  const made = async (title: string) => (await tickets.create({ title, project: PROJECT }, SERVICE)).id;
  const flow = await made('Moved by the flow');
  const guarded = await made('Merged by merge-pr');
  const mirrored = await made('Closed on the tracker');
  const byHand = await made('Moved by the owner');
  clock = IN_WEEK;
  await tickets.move(flow, tickets.states.done, SERVICE);
  await tickets.move(mirrored, tickets.states.done, MIRROR);
  await tickets.move(byHand, tickets.states.done, { kind: 'human', id: 'user-uuid-1' });
  // merge-pr.ts moves the card through v1's local tracker, run by the service account: neither the agents' nor the owner's, so `shared`.
  store.db.prepare("UPDATE tracker_tickets SET status = 'Done' WHERE id = ?").run(Number(guarded.slice('LOCAL-'.length)));
  store.db.prepare("INSERT INTO tracker_history (ticket, status, actor_kind, actor_id, at) VALUES (?, 'Done', 'shared', 'cleared', ?)").run(Number(guarded.slice('LOCAL-'.length)), at(IN_WEEK, 5));
  const history = await tickets.histories([guarded, byHand]);
  assert.equal(history.get(guarded)?.at(-1)?.by.kind, 'other', 'the store reads the service account\'s row as other');
  assert.equal(history.get(byHand)?.at(-1)?.by.kind, 'human', 'the owner\'s move is signed');

  const week = await weekFigures(store.db, tickets, { project: PROJECT, services: SERVICES, now: NOW, timeZone: ZONE });
  assert.deepEqual(week.merged.map((m) => m.id), [guarded, flow]);
});

test('the tokens and the agents\' time: every turn finished in the week, whatever its role; a turn across the week\'s start counts its part inside', async () => {
  const t = ledger();
  const author = session(t.store, { id: 'a', ticket: 'LOCAL-1' });
  author.turn(at(BEFORE), at(BEFORE, 10), 1_000, 0.1);                   // before the week: not counted
  author.turn(at(SINCE, -20), at(SINCE, 15), 200, 0.3);                  // across its start: 15 of its 35 minutes
  author.turn(IN_WEEK, at(IN_WEEK, 30), 300, 0.5);
  const lead = session(t.store, { id: 'l', ticket: 'lead', role: 'lead' });
  lead.turn(IN_WEEK, at(IN_WEEK, 5), 40, 0.05);
  const reader = session(t.store, { id: 'q', ticket: 'ask-1', role: 'reader' });
  reader.turn(IN_WEEK, at(IN_WEEK, 2), 7, 0.01);
  session(t.store, { id: 'x', ticket: 'LOCAL-9', project: 'other' }).turn(IN_WEEK, at(IN_WEEK, 60), 9_999, 9);

  const week = await read(t);
  assert.equal(week.spend.tokens, 547);
  assert.equal(week.spend.turns, 4);
  assert.equal(week.spend.sessions, 3);
  assert.equal(week.spend.workMs, (15 + 30 + 5 + 2) * MIN);
  const screen = consumption(t.store.db, { project: PROJECT, now: NOW, timeZone: ZONE, levers: { model: null, maxLanes: null, paused: false }, config: { authorModel: 'claude-opus-5-5', reviewerModel: 'claude-sonnet-5-5' } });
  assert.equal(week.spend.tokens, screen.harnesses.reduce((sum, h) => sum + h.tokens, 0), 'the same tokens as the screen\'s agents');
});

test('the dollars: each running total\'s increase over the week, a resume adding what it reports; none when one session reported nothing', async () => {
  const t = ledger();
  const author = session(t.store, { id: 'a', ticket: 'LOCAL-1' });
  author.turn(at(BEFORE), at(BEFORE, 10), 10, 0.4);                      // 0.40 spent before the week
  author.turn(IN_WEEK, at(IN_WEEK, 10), 10, 0.9);                        // 0.50 of it in the week
  author.turn(at(IN_WEEK, 60), at(IN_WEEK, 70), 10, 0.2);                // a resume: 0.20 more
  const reviewer = session(t.store, { id: 'r', ticket: 'LOCAL-1', role: 'reviewer' });
  reviewer.turn(IN_WEEK, at(IN_WEEK, 5), 10, 0.15);
  assert.equal((await read(t)).spend.costUsd, 0.85);

  session(t.store, { id: 'c', ticket: 'LOCAL-2', harness: 'codex', service: 'filter-api' }).turn(IN_WEEK, at(IN_WEEK, 3), 10, null);
  const week = await read(t);
  assert.equal(week.spend.costUsd, null, 'Codex reports no dollars: a partial sum is not the week\'s cost');
  assert.equal(week.spend.tokens, 40, 'tokens and time are still counted');
  const rows = Object.fromEntries(week.services.map((s) => [s.service ?? 'workspace', s.costUsd]));
  assert.equal(rows.guestbook, 0.85, 'a service whose sessions all reported keeps its dollars');
  assert.equal(rows['filter-api'], null);
});

test('estimates against what it took: each merged ticket a plan estimated, in minutes measured as the estimates measure', async () => {
  const t = ledger();
  const planned = await merged(t, 'Planned', IN_WEEK, SERVICE, ['guestbook']);
  planItem(t.store, planned, 30);
  const author = session(t.store, { id: 'a', ticket: planned });
  author.turn(at(IN_WEEK, -120), at(IN_WEEK, -100), 10, 0.1);
  author.step(at(IN_WEEK, -95), 'STEP_STARTED', 'waiting_human');
  author.step(at(IN_WEEK, -85), 'STEP_FINISHED', 'waiting_human');      // the owner took 10 minutes
  author.turn(at(IN_WEEK, -85), at(IN_WEEK, -75), 10, 0.2);
  author.step(at(IN_WEEK, -70), 'STEP_FINISHED', 'release');             // 50 minutes, less 10 of waiting
  const unplanned = await merged(t, 'From the chat', at(IN_WEEK, 5), SERVICE);
  session(t.store, { id: 'b', ticket: unplanned }).turn(at(IN_WEEK, -10), at(IN_WEEK, -5), 10, 0.1);
  // A plan of another workspace that names the same ticket id is not this one's.
  planItem(t.store, unplanned, 5, 'other');

  const week = await read(t);
  assert.deepEqual(week.merged.find((m) => m.id === planned), { id: planned, title: 'Planned', services: ['guestbook'], mergedAt: IN_WEEK, estimateMinutes: 30, actualMinutes: 40 });
  assert.equal(week.merged.find((m) => m.id === unplanned)?.estimateMinutes, null);
  assert.deepEqual(week.estimates, { tickets: 1, estimatedMinutes: 30, actualMinutes: 40 });
  assert.equal(JSON.stringify(week).includes('0.8'), false, 'an estimate\'s dollars are never said');
});

test('per service: a session\'s own service, else its ticket\'s one service, else the first; the lead, the questions and a ticket on several services on the workspace\'s row; the rows add up to the week', async () => {
  const t = ledger();
  const both = await merged(t, 'On both', IN_WEEK, SERVICE, ['guestbook', 'filter-api']);
  const api = await merged(t, 'On the filter', IN_WEEK, SERVICE, ['filter-api']);
  const none = await merged(t, 'On none', IN_WEEK, SERVICE);
  session(t.store, { id: 'step', ticket: both, service: 'filter-api' }).turn(IN_WEEK, at(IN_WEEK, 10), 100, 0.1);
  session(t.store, { id: 'rev', ticket: both, role: 'reviewer' }).turn(IN_WEEK, at(IN_WEEK, 4), 20, 0.02);
  session(t.store, { id: 'api', ticket: api }).turn(IN_WEEK, at(IN_WEEK, 6), 30, 0.03);
  session(t.store, { id: 'gb', ticket: none }).turn(IN_WEEK, at(IN_WEEK, 8), 40, 0.04);
  session(t.store, { id: 'l', ticket: 'lead', role: 'lead' }).turn(IN_WEEK, at(IN_WEEK, 1), 5, 0.005);
  session(t.store, { id: 'gone', ticket: 'LOCAL-99', service: 'old-service' }).turn(IN_WEEK, at(IN_WEEK, 2), 3, 0.003);

  const week = await read(t);
  const rows = week.services.map((s) => [s.service, s.merged, s.tokens, s.workMs / MIN, s.costUsd]);
  assert.deepEqual(rows, [
    ['guestbook', 2, 40, 8, 0.04],
    ['filter-api', 2, 130, 16, 0.13],
    ['old-service', 0, 3, 2, 0.003],
    [null, 0, 25, 5, 0.025],
  ], 'the configured services in order, one no longer configured, then the workspace\'s own row');
  assert.equal(week.merged.length, 3, 'a ticket on two services counts once in the week');
  const sum = (key: 'tokens' | 'workMs' | 'turns') => week.services.reduce((n, s) => n + (s[key] ?? 0), 0);
  assert.equal(sum('tokens'), week.spend.tokens);
  assert.equal(sum('workMs'), week.spend.workMs);
  assert.equal(sum('turns'), week.spend.turns);
});

test('a quiet week: nothing merged, no turn, each configured service on its row with nothing, no workspace row', async () => {
  const week = await read(ledger());
  assert.deepEqual(week.merged, []);
  assert.deepEqual(week.spend, { sessions: 0, turns: 0, tokens: null, workMs: 0, costUsd: null });
  assert.deepEqual(week.estimates, { tickets: 0, estimatedMinutes: 0, actualMinutes: 0 });
  assert.deepEqual(week.services.map((s) => [s.service, s.merged, s.tokens, s.costUsd]), [['guestbook', 0, null, null], ['filter-api', 0, null, null]]);
});

test('a ledger without the plans\' tables reads no estimate, and nothing is written', async () => {
  const store = openStore(':memory:');
  const tickets = new MemoryTicketStore({ now: () => IN_WEEK });
  const made = await tickets.create({ title: 'Alone', project: PROJECT }, OWNER);
  await tickets.move(made.id, tickets.states.done, SERVICE);
  const tables = () => (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const before = tables();
  const week = await weekFigures(store.db, tickets, { project: PROJECT, services: SERVICES, now: NOW, timeZone: ZONE });
  assert.equal(week.merged[0]?.estimateMinutes, null);
  assert.deepEqual(tables(), before, 'no table made');
});
