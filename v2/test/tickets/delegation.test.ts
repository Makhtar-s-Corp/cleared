// A delegated ticket in the lead's plans (C3, P244): a one-item plan bound
// to the ticket the mirror made, proposed in the Inbox for the owner, the
// lead told who handed it over and where; the owner's approval starts that
// ticket and makes no second one. Over the real flow engine on the fake
// adapter and the real plan runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_TABLES } from '../../src/lead/plans/store.ts';
import { DEFAULT_PLAN_CONFIG, PlanRunner } from '../../src/lead/plans/runner.ts';
import { NOTIFY_TABLES } from '../../src/notify/queue.ts';
import { applyTables } from '../../src/store/db.ts';
import { delegateTo } from '../../src/tickets/delegation.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { quickAuthor, setup, until } from '../flow/support.ts';
import { recordingLead } from '../lead/plans/support.ts';

const AGENTS = { kind: 'agents' as const, id: 'cleared-v2' };

async function plans(options: { lead?: boolean } = {}) {
  const t = await setup({ scripts: { author: quickAuthor } });
  applyTables(t.store.db, [...PLAN_TABLES, ...NOTIFY_TABLES]);
  const lead = recordingLead();
  const runner = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead, project: 'guestbook',
    config: DEFAULT_PLAN_CONFIG, now: () => new Date(t.clock.now), clean: (text) => text.replaceAll('hunter2', '[secret]'),
  });
  runner.listen();
  const delegate = delegateTo({ plans: () => (options.lead === false ? undefined : runner), lead: () => lead, tickets: t.tickets, flow: () => t.engine });
  const settle = async () => {
    for (let i = 0; i < 5; i++) { await t.engine.settled(); await runner.settled(); }
  };
  const from = (ticket: Ticket) => ({ ticket, tracker: 'GitHub', key: 'org/guestbook#7', url: 'https://github.com/org/guestbook/issues/7', who: 'jane' });
  return { ...t, lead, runner, delegate, settle, from };
}

test('a delegated ticket in Todo becomes a one-item plan bound to it, waiting in the Inbox; the lead is told who handed it over and where', async () => {
  const t = await plans();
  const outcome = await t.delegate(t.from(t.ticket));
  assert.ok(outcome && 'plan' in outcome, 'a plan');
  const plan = t.runner.get(outcome.plan);
  assert.equal(plan?.state, 'proposed');
  assert.equal(plan?.goal, `delegation-${t.ticket.id}`);
  assert.equal(plan?.items.length, 1);
  assert.deepEqual([plan?.items[0]?.ticket, plan?.items[0]?.title, plan?.items[0]?.lane, plan?.items[0]?.size], [t.ticket.id, t.ticket.title, 'full', 's']);
  assert.ok(t.inbox.list().some((item) => item.kind === 'plan' && item.planId === outcome.plan), 'the plan waits in the Inbox');
  assert.equal(t.startedSessions.length, 0, 'nothing starts before the owner\'s approval');
  assert.equal(t.lead.lines.length, 1);
  const line = t.lead.lines[0] as string;
  for (const part of ['jane', 'GitHub', 'org/guestbook#7', t.ticket.id, outcome.plan, `"${t.ticket.title}"`]) assert.ok(line.includes(part), `the line names ${part}: ${line}`);
  assert.ok(!line.includes(t.ticket.body), 'the issue\'s text is read with the ticket tool, not put in the line');
});

test('the owner\'s approval starts that ticket, with the owner as the one who approved; no second ticket is made', async () => {
  const t = await plans();
  const outcome = await t.delegate(t.from(t.ticket));
  assert.ok(outcome && 'plan' in outcome);
  const before = (await t.tickets.list()).length;
  await t.runner.approve(outcome.plan, 'u1');
  await t.settle();
  await until(() => t.startedSessions.some((s) => s.input.role === 'author'), 'the author started');
  const author = t.startedSessions.find((s) => s.input.role === 'author');
  assert.equal(author?.input.ticket, t.ticket.id);
  assert.equal((await t.tickets.list()).length, before, 'no second ticket');
  const started = t.flowEvents.find((e) => e.type === 'ticket_started' && e.ticket === t.ticket.id);
  assert.ok(started && started.type === 'ticket_started' && started.by === 'u1', 'started for the owner who approved');
  assert.equal(t.runner.get(outcome.plan)?.items[0]?.ticket, t.ticket.id);
});

test('the item takes its size and lane from the ticket\'s labels, and its title and the lead\'s line are cleaned', async () => {
  const t = await plans();
  const ticket = await t.tickets.create({ title: 'Rotate hunter2 away', body: 'No criteria here.', labels: ['size:m', 'Quick'], project: 'guestbook' }, AGENTS);
  const outcome = await t.delegate(t.from(ticket));
  assert.ok(outcome && 'plan' in outcome);
  const item = t.runner.get(outcome.plan)?.items[0];
  assert.deepEqual([item?.size, item?.lane, item?.title], ['m', 'fast', 'Rotate [secret] away']);
  assert.ok(!(t.lead.lines[0] as string).includes('hunter2'));
});

test('a ticket already in hand gets no plan: not in Todo, run by the flow, or an item of a plan that runs', async () => {
  const t = await plans();
  const moved = await t.tickets.create({ title: 'Already moving', project: 'guestbook' }, AGENTS);
  await t.tickets.move(moved.id, 'In Review', AGENTS);
  assert.deepEqual(await t.delegate(t.from((await t.tickets.get(moved.id)) as Ticket)), { inState: 'In Review' });

  const first = await t.delegate(t.from(t.ticket));
  assert.ok(first && 'plan' in first);
  await t.runner.approve(first.plan, 'u1');
  await t.settle();
  await until(async () => (await t.tickets.get(t.ticket.id))?.status !== 'Todo' || t.engine.isActive(t.ticket.id), 'the ticket is in hand');
  const again = await t.delegate(t.from((await t.tickets.get(t.ticket.id)) as Ticket));
  assert.ok(again && !('plan' in again), `no second plan: ${JSON.stringify(again)}`);
  assert.equal(t.runner.store.list().filter((p) => p.goal === `delegation-${t.ticket.id}`).length, 1);
});

test('a second delegation while its plan waits replaces that plan', async () => {
  const t = await plans();
  const first = await t.delegate(t.from(t.ticket));
  const second = await t.delegate(t.from(t.ticket));
  assert.ok(first && 'plan' in first && second && 'plan' in second);
  assert.notEqual(second.plan, first.plan);
  assert.equal(t.runner.get(first.plan)?.state, 'superseded');
  assert.equal(t.runner.get(second.plan)?.state, 'proposed');
});

test('with no lead running, nothing is decided: the mirror asks again later', async () => {
  const t = await plans({ lead: false });
  assert.equal(await t.delegate(t.from(t.ticket)), undefined);
  assert.deepEqual(t.lead.lines, []);
});
