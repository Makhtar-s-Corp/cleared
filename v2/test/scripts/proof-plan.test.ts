// The proofs' decisions about the plans already there (scripts/proof-plan.ts,
// issue 285), on plans the real runner moves over a ledger in a temporary
// folder: a plan approved with its items put back refuses a new goal and is
// taken over; a paused one lets a new goal start; a plan whose items are
// held or parked is blocked, and says which; one with an item that moves is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FlowEvent, FlowListener, PutBackReason } from '../../src/flow/events.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import { DEFAULT_PLAN_CONFIG, PlanRunner, type PlanFlow } from '../../src/lead/plans/runner.ts';
import { PLAN_TABLES } from '../../src/lead/plans/store.ts';
import { NOTIFY_TABLES } from '../../src/notify/queue.ts';
import type { SessionId } from '../../src/session/contract.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { MemoryTicketStore, type TicketId } from '../../src/tickets/contract.ts';
import { blockageLine, planBlockage, startCheck, type PlanView } from '../../scripts/proof-plan.ts';

const criteria = '\n\nAcceptance criteria\n- [ ] a test';
const item = (title: string, after: number[] = []) => ({ title, body: `${title}.${criteria}`, lane: 'full' as const, size: 's' as const, after });
const THREE = { goal: 'goal-1', title: 'Three changes', summary: 'Three changes, the third after the second.', items: [item('Entries as JSON'), item('Trimmed names'), item('Names in the feed', [2])] };
const AGENTS = { kind: 'agents', id: 'cleared-v2' } as const;

// A ledger file in a temporary folder, the real plan runner over it, and a
// flow that starts a ticket at once and puts it back when told.
async function world(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-proof-plan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openStore(join(dir, 'ledger.db'));
  t.after(() => store.db.close());
  store.db.exec(INBOX_TABLE);
  applyTables(store.db, [...PLAN_TABLES, ...NOTIFY_TABLES]);
  const clock = { now: Date.parse('2026-10-24T08:00:00.000Z') };
  const at = () => new Date(clock.now).toISOString();
  const tickets = new MemoryTicketStore({ now: at });
  const active = new Set<string>();
  const listeners: FlowListener[] = [];
  const emit = async (event: FlowEvent) => { for (const listener of listeners) await listener(event); };
  const flow: PlanFlow = {
    async start(ticket, by, origin) {
      active.add(ticket);
      await tickets.move(ticket, tickets.states.progress, AGENTS);
      await emit({ type: 'ticket_started', at: at(), project: 'guestbook', ticket, by, origin: origin ?? null, session: `s-${ticket}` as SessionId });
    },
    isActive: (ticket) => active.has(ticket),
    subscribe(listener) { listeners.push(listener); return () => {}; },
  };
  const lines: string[] = [];
  const runner = new PlanRunner({
    store, inbox: new InboxStore(store.db, () => new Date(clock.now)), tickets, flow, project: 'guestbook', config: DEFAULT_PLAN_CONFIG, now: () => new Date(clock.now),
    lead: { enqueue: () => {}, serviceLine: (text) => { lines.push(text); }, planLine: () => {}, publishPlan: () => {} },
  });
  runner.listen();
  const tick = async () => {
    clock.now += 30_000;
    await runner.tick();
    await runner.settled();
  };
  const putBack = async (ticket: string, reason: PutBackReason = 'failed') => {
    active.delete(ticket);
    await tickets.move(ticket as TicketId, tickets.states.todo, AGENTS);
    await emit({ type: 'ticket_put_back', at: at(), project: 'guestbook', ticket: ticket as TicketId, reason, note: `put back (${reason})` });
    await runner.settled();
  };
  const landed = async (ticket: string) => {
    active.delete(ticket);
    await tickets.move(ticket as TicketId, tickets.states.done, AGENTS);
    await emit({ type: 'release_landed', at: at(), project: 'guestbook', ticket: ticket as TicketId, pr: 1, health: 'healthy' });
    await runner.settled();
  };
  // The plans as GET /api/plans gives them, which is what the driver reads.
  const plans = (): PlanView[] => runner.list();
  const view = (id: string): PlanView => runner.plan(id);
  const ticketOf = (id: string, position: number) => view(id).items.find((i) => i.position === position)?.ticket as string;
  const states = (id: string) => view(id).items.map((i) => `${i.position}:${i.state}`).join(' ');
  return { runner, tick, putBack, landed, plans, view, ticketOf, states, lines };
}

async function approvedPlan(t: test.TestContext) {
  const w = await world(t);
  const { plan } = await w.runner.propose(THREE);
  await w.runner.approve(plan, 'u1');
  await w.tick();
  assert.equal(w.states(plan), '1:running 2:running 3:waiting', 'two running, the third after the second');
  return { ...w, id: plan };
}

test('an approved plan whose items were put back refuses a new goal, and is taken over: the runner starts the put back items again', async (t) => {
  const w = await approvedPlan(t);
  // The relaunch of 2026-10-23: the plan approved, its items put back.
  await w.putBack(w.ticketOf(w.id, 1));
  await w.putBack(w.ticketOf(w.id, 2));
  assert.equal(w.states(w.id), '1:put_back 2:put_back 3:waiting');

  const refused = startCheck(w.plans(), undefined);
  assert.equal(refused.kind, 'refuse');
  assert.match(refused.kind === 'refuse' ? refused.reason : '', new RegExp(`plan ${w.id} \\("Three changes"\\) is approved and not paused \\(items 1:put_back 2:put_back 3:waiting\\): a new run beside it would run two plans at once`));
  assert.match(refused.kind === 'refuse' ? refused.reason : '', new RegExp(`PROOF_RESUME_PLAN=${w.id}, or pause it first \\(POST /api/plans/${w.id}/pause\\)`));
  // The multi-service proof has no plan to take over: pausing is its one way out.
  const multi = startCheck(w.plans(), undefined, { resumable: false });
  assert.equal(multi.kind, 'refuse');
  assert.doesNotMatch(multi.kind === 'refuse' ? multi.reason : '', /PROOF_RESUME_PLAN/);

  const taken = startCheck(w.plans(), w.id);
  assert.equal(taken.kind, 'resume');
  assert.equal(taken.kind === 'resume' ? taken.plan.id : '', w.id);
  assert.equal(planBlockage(w.view(w.id)), null, 'a put back item moves: the runner starts it again');
  await w.tick();
  assert.equal(w.states(w.id), '1:running 2:running 3:waiting', 'taken over, the put back items run again');
  assert.equal(planBlockage(w.view(w.id)), null);
});

test('a paused plan lets a new goal start, is blocked as a whole, and is taken over by its Resume', async (t) => {
  const w = await approvedPlan(t);
  await w.putBack(w.ticketOf(w.id, 1));
  await w.runner.pause(w.id, 'u1');
  assert.deepEqual(startCheck(w.plans(), undefined), { kind: 'new' }, 'the orchestrator\'s workaround of 2026-10-23 stays open');
  const paused = planBlockage(w.view(w.id));
  assert.ok(paused);
  assert.equal(paused.reason, `plan ${w.id} is paused: the owner resumes it`);
  assert.deepEqual(paused.items.map((i) => `${i.position}:${i.state}`), ['1:put_back', '2:running', '3:waiting']);
  await w.tick();
  assert.equal(w.states(w.id), '1:put_back 2:running 3:waiting', 'paused, the runner starts nothing');

  const taken = startCheck(w.plans(), w.id);
  assert.equal(taken.kind, 'resume', 'a paused plan is taken over');
  await w.runner.resume(w.id, 'u1');
  await w.tick();
  assert.equal(w.states(w.id), '1:running 2:running 3:waiting', 'resumed, the put back item runs again');
});

test('a plan whose items are held and parked is blocked, says which and why, and stays so at the next tick', async (t) => {
  const w = await approvedPlan(t);
  // Item 1 put back three times, by its third attempt (issue 290): held.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await w.putBack(w.ticketOf(w.id, 1));
    if (attempt < 3) await w.tick();
  }
  // Item 2's question waited past its delay and the lead's: parked.
  await w.putBack(w.ticketOf(w.id, 2), 'parked');
  assert.equal(w.states(w.id), '1:held 2:parked 3:waiting');
  assert.ok(w.lines.some((line) => /held/.test(line)) && w.lines.some((line) => /parked/.test(line)), 'both said in the lead\'s thread');

  const blocked = planBlockage(w.view(w.id));
  assert.ok(blocked);
  assert.equal(blocked.reason, `plan ${w.id} has nothing running and nothing to approve: 1 (${w.ticketOf(w.id, 1)}) held; 2 (${w.ticketOf(w.id, 2)}) parked`);
  assert.deepEqual(blocked.items.map((i) => `${i.position} ${i.why}`), [
    '1 held: the lead starts it again with start_ticket, or asks the owner',
    '2 parked on a question nobody answered: the lead starts it again with the answer',
    '3 waits for 2 (parked)',
  ]);
  assert.match(blockageLine(blocked), /item 3 \S+ waits for 2 \(parked\)\)$/);
  await w.tick();
  assert.equal(planBlockage(w.view(w.id))?.signature, blocked.signature, 'the runner starts neither: the same blockage, its time runs on');
  assert.deepEqual(startCheck(w.plans(), w.id).kind, 'resume', 'a blocked plan can still be taken over');

  // The lead starts the parked item again with the answer: the plan moves.
  await w.runner.startTicket(w.ticketOf(w.id, 2) as TicketId, 'The answer: keep the old names.');
  await w.runner.settled();
  assert.equal(planBlockage(w.view(w.id)), null, 'an item runs: not blocked');
  // It lands; item 3 starts; it lands too: only the held item is left, alone.
  await w.landed(w.ticketOf(w.id, 2));
  await w.tick();
  assert.equal(w.states(w.id), '1:held 2:landed 3:running');
  await w.landed(w.ticketOf(w.id, 3));
  const last = planBlockage(w.view(w.id));
  assert.equal(last?.reason, `plan ${w.id} has nothing running and nothing to approve: 1 (${w.ticketOf(w.id, 1)}) held`);
  assert.notEqual(last?.signature, blocked.signature, 'another blockage, counted from its own start');
});

test('the start check refuses a plan it cannot take over, and two plans at once', async (t) => {
  const w = await approvedPlan(t);
  const missing = startCheck(w.plans(), 'plan-99');
  assert.equal(missing.kind, 'refuse');
  assert.match(missing.kind === 'refuse' ? missing.reason : '', new RegExp(`there is no plan plan-99 on this workspace \\(${w.id} approved\\)`));

  // A second plan, proposed: neither taken over nor allowed beside the first.
  const { plan: second } = await w.runner.propose({ ...THREE, goal: 'goal-2', title: 'Three more' });
  const proposed = startCheck(w.plans(), second);
  assert.equal(proposed.kind === 'refuse' ? proposed.reason : '', `plan ${second} is proposed: only an approved or paused plan is taken over`);
  await w.runner.pause(w.id, 'u1');
  await w.runner.approve(second, 'u1');
  await w.runner.settled();
  const both = startCheck(w.plans(), w.id);
  assert.equal(both.kind === 'refuse' ? both.reason : '', `plan ${second} is approved too: taking over ${w.id} would run two plans at once; pause ${second} first (POST /api/plans/${second}/pause)`);
  assert.equal(startCheck(w.plans(), second).kind, 'resume', 'the approved one, with the other paused');
});

test('a plan done, or with every item landed or cancelled, is not blocked; a ready item that does not start is', () => {
  const plan = (state: PlanView['state'], ...items: [string, number[]?][]): PlanView => ({
    id: 'plan-1', title: 'A plan', state, items: items.map(([s, after], n) => ({ position: n + 1, state: s as PlanView['items'][number]['state'], ticket: `LOCAL-${n + 1}`, after: after ?? [] })),
  });
  assert.equal(planBlockage(plan('done', ['landed'], ['cancelled'])), null);
  assert.equal(planBlockage(plan('approved', ['landed'], ['cancelled'])), null);
  assert.equal(planBlockage(plan('approved', ['landed'], ['needs_approval'])), null, 'a card waits for its approval: the morning gives it');
  const ready = planBlockage(plan('approved', ['landed'], ['ready'], ['waiting', [1, 4]], ['cancelled']));
  assert.equal(ready?.reason, 'plan plan-1 has nothing running and nothing to approve: 2 (LOCAL-2) ready but not started');
  assert.deepEqual(ready?.items.map((i) => i.why), ['ready but not started: the week stop or the day budget may hold the plans', 'waits for 4 (cancelled)']);
});
