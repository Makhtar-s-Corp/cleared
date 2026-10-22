// A schedule's budget (decision 29): it travels on the Origin the plan
// runner gives the flow's start, and the flow stops the ticket past it,
// in place of the service's CLEARED_V2_BUDGET_USD.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Origin } from '../../src/flow/events.ts';
import type { PlanFlow } from '../../src/lead/plans/runner.ts';
import { budgetedFlow } from '../../src/schedules/budget.ts';
import { finished, setup, started, text, until } from '../flow/support.ts';

const expensive = [started, ...text('a1', 'Expensive.'), finished(1.5)];

test('a ticket started with a budget on its origin is stopped past it, with the note naming it', async () => {
  const t = await setup({ scripts: { author: expensive } });
  await t.engine.start(t.ticket.id, 'u1', { plan: 'plan-1', item: 1, budgetUsd: 1 });
  await until(() => t.flowEvents.some((e) => e.type === 'ticket_put_back'), 'the ticket was put back');
  const back = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.equal(back?.type === 'ticket_put_back' ? back.reason : undefined, 'budget');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /budget of \$1 is spent \(\$1\.50\)/);
  await t.engine.settled();
});

test('the origin\'s budget wins over the service\'s, both ways', async () => {
  const higher = await setup({ scripts: { author: expensive }, config: { budgetUsd: 1 } });
  await higher.engine.start(higher.ticket.id, 'u1', { plan: 'plan-1', item: 1, budgetUsd: 5 });
  await until(() => higher.flowEvents.some((e) => e.type === 'release_requested' || e.type === 'ticket_put_back'), 'the ticket went on');
  assert.ok(!higher.flowEvents.some((e) => e.type === 'ticket_put_back' && e.reason === 'budget'), 'the schedule\'s $5 allows $1.50');
  await higher.engine.settled();

  const none = await setup({ scripts: { author: expensive } });
  await none.engine.start(none.ticket.id, 'u1', { plan: 'plan-1', item: 1 });
  await until(() => none.flowEvents.some((e) => e.type === 'release_requested' || e.type === 'ticket_put_back'), 'the ticket went on');
  assert.ok(!none.flowEvents.some((e) => e.type === 'ticket_put_back' && e.reason === 'budget'), 'no budget anywhere: nothing stops it');
  await none.engine.settled();
});

test('the budgeted flow adds the budget of the origin\'s plan, and only when there is one', async () => {
  const starts: (Origin | undefined)[] = [];
  const subscribed: unknown[] = [];
  const inner: PlanFlow = {
    async start(_ticket, _by, origin) { starts.push(origin); },
    isActive: (ticket) => ticket === 'LOCAL-9',
    subscribe: (listener) => { subscribed.push(listener); return () => undefined; },
  };
  const flow = budgetedFlow(inner, (plan) => (plan === 'plan-2' ? 2.5 : undefined));
  await flow.start('LOCAL-1', 'u1', { plan: 'plan-2', item: 1, note: 'again', maxParallel: 2 });
  await flow.start('LOCAL-2', 'u1', { plan: 'plan-3', item: 1 });
  await flow.start('LOCAL-3', 'u1');
  assert.deepEqual(starts, [{ plan: 'plan-2', item: 1, note: 'again', maxParallel: 2, budgetUsd: 2.5 }, { plan: 'plan-3', item: 1 }, undefined]);
  assert.equal(flow.isActive('LOCAL-9'), true);
  const listener = () => undefined;
  flow.subscribe(listener);
  assert.deepEqual(subscribed, [listener]);
});
