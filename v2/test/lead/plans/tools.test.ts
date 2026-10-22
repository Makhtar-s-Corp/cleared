// The lead's two plan tools (docs/v2/milestone-2-plan.md, section 3.2):
// propose_plan validates, estimates, stores, supersedes the proposal of the
// same goal still waiting, adds the inbox item and the thread line;
// start_ticket starts only an item of an approved plan that was put back
// or is held. Both reach the lead through the engine's extensions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LeadEngine } from '../../../src/lead/engine.ts';
import { PLAN_TABLES } from '../../../src/lead/plans/store.ts';
import { DEFAULT_PLAN_CONFIG, PlanRunner } from '../../../src/lead/plans/runner.ts';
import { planExtensions, validatePlan } from '../../../src/lead/plans/tools.ts';
import { HostToolRefused, type HostCallContext } from '../../../src/session/contract.ts';
import { examplePlanInput } from '../../../src/session/adapters/fake.ts';
import { applyTables } from '../../../src/store/db.ts';
import { quickAuthor, setup } from '../../flow/support.ts';
import { call, leadSetup, opening, say, turn, until } from '../support.ts';
import { recordingLead } from './support.ts';

const criteria = '\n\nAcceptance criteria\n- [ ] a test';
const item = (title: string, after: number[] = []) => ({ title, body: `${title}.${criteria}`, lane: 'full', size: 's', after });
// The model's input, as the SDK hands it over: checked by the host, not by the types.
const plan = (items: unknown[], goal = 'goal-1') => ({ goal, title: 'A plan', summary: 'What it does.', items }) as never;
const context: HostCallContext = { sessionId: 'lead-session-1', turn: 't' };

test('validation refuses a cycle, 13 items, an item without a criterion, a long title, an after out of range', () => {
  const refused = (input: unknown, pattern: RegExp) => assert.throws(() => validatePlan(input), (error: unknown) => error instanceof HostToolRefused && pattern.test(error.message));
  refused(plan([item('a', [2]), item('b', [3]), item('c', [1])]), /cycle/);
  refused(plan([item('a', [1])]), /itself/);
  refused(plan(Array.from({ length: 13 }, (_, i) => item(`t${i}`))), /1 to 12/);
  refused(plan([]), /1 to 12/);
  refused(plan([{ ...item('a'), body: 'No checklist here.' }]), /- \[ \]/);
  refused(plan([{ ...item('a'), body: 'Acceptance criteria\n- [x] already ticked' }]), /- \[ \]/);
  refused(plan([item('x'.repeat(121))]), /120/);
  refused(plan([item('a', [4])]), /position 4/);
  refused(plan([item('a', [1.5])]), /position/);
  refused(plan([{ ...item('a'), lane: 'slow' }]), /lane/);
  refused(plan([{ ...item('a'), size: 'xl' }]), /size/);
  refused({ ...(plan([item('a')]) as object), goal: '' }, /goal/);
  refused({ ...(plan([item('a')]) as object), title: '' }, /title/);
  const valid = validatePlan(examplePlanInput);
  assert.equal(valid.items.length, 5);
  assert.deepEqual(valid.items[2]?.after, [2]);
  assert.deepEqual(validatePlan(plan([item('a'), item('b', [1, 1])])).items[1]?.after, [1], 'a repeated position is kept once');
});

async function runner(options: { maxParallel?: number } = {}) {
  const t = await setup({ scripts: { author: quickAuthor } });
  applyTables(t.store.db, PLAN_TABLES);
  const lead = recordingLead();
  const plans = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead, project: 'guestbook',
    config: { ...DEFAULT_PLAN_CONFIG, ...options }, now: () => new Date(t.clock.now),
  });
  plans.listen();
  const tools = planExtensions(() => plans).tools!;
  return { ...t, lead, plans, tools };
}

test('propose_plan stores the plan with its estimates, adds the inbox item and the thread line; a new proposal of the goal supersedes it', async () => {
  const t = await runner();
  const first = await t.tools.propose_plan!(examplePlanInput, context);
  assert.equal(first.plan, 'plan-1');
  assert.equal(first.supersedes, null);
  assert.deepEqual(first.totals, { minutes: 102, costUsd: 3.4, weekPercent: null, samples: 0 }, 'defaults: 30 + 60 + 12 after one another, the two xs beside them');
  const stored = t.plans.get('plan-1')!;
  assert.equal(stored.state, 'proposed');
  assert.deepEqual(stored.items.map((i) => [i.position, i.state, i.estimate.minutes, i.ticket]), [[1, 'waiting', 30, null], [2, 'waiting', 60, null], [3, 'waiting', 12, null], [4, 'waiting', 5, null], [5, 'waiting', 5, null]]);
  const inbox = t.inbox.list().filter((i) => i.kind === 'plan');
  assert.deepEqual(inbox.map((i) => i.kind === 'plan' && [i.id, i.ticket, i.planId, i.title, i.summary, i.itemCount, i.totals.minutes, i.state]),
    [['plan:plan-1', 'lead', 'plan-1', examplePlanInput.title, examplePlanInput.summary, 5, 102, 'waiting']]);
  assert.deepEqual(t.lead.planLines, [{ planId: 'plan-1', text: `Plan to approve: ${examplePlanInput.title}, 5 tickets, about 1 h 42 of work.` }]);
  assert.equal(t.lead.frames.at(-1)?.id, 'plan-1');

  const second = await t.tools.propose_plan!({ ...examplePlanInput, items: examplePlanInput.items.slice(0, 2) }, context);
  assert.equal(second.supersedes, 'plan-1');
  assert.equal(t.plans.get('plan-1')!.state, 'superseded');
  assert.deepEqual(t.inbox.list().filter((i) => i.kind === 'plan').map((i) => [i.id, i.state]), [['plan:plan-2', 'waiting'], ['plan:plan-1', 'handled']]);

  // Another goal leaves it alone.
  await t.tools.propose_plan!({ ...examplePlanInput, goal: 'goal-9' }, context);
  assert.equal(t.plans.get('plan-2')!.state, 'proposed');
});

test('an approved plan is never superseded by a new proposal of the same goal', async () => {
  const t = await runner({ maxParallel: 0 });
  await t.tools.propose_plan!(plan([item('a')]), context);
  await t.plans.approve('plan-1', 'u1');
  const again = await t.tools.propose_plan!(plan([item('b')]), context);
  assert.equal(again.supersedes, null);
  assert.equal(t.plans.get('plan-1')!.state, 'approved');
  assert.equal(t.plans.get('plan-2')!.state, 'proposed');
});

test('the model\'s texts are cleaned before they become a plan and tickets', async () => {
  const t = await setup();
  applyTables(t.store.db, PLAN_TABLES);
  const plans = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead: recordingLead(), project: 'guestbook',
    config: { ...DEFAULT_PLAN_CONFIG, maxParallel: 0 }, now: () => new Date(t.clock.now), clean: (text) => text.replaceAll('/srv/secret', '[path]'),
  });
  await planExtensions(() => plans).tools!.propose_plan!(plan([{ ...item('Read /srv/secret'), body: `See /srv/secret.${criteria}` }]), context);
  await plans.approve('plan-1', 'u1');
  const ticket = await t.tickets.get(plans.get('plan-1')!.items[0]!.ticket!);
  assert.equal(ticket?.title, 'Read [path]');
  assert.match(ticket?.body ?? '', /^See \[path\]\./);
});

test('start_ticket starts a held item of an approved plan, and refuses any other ticket', async () => {
  const t = await runner();
  const tools = t.tools;
  const refused = async (input: unknown, pattern: RegExp) =>
    assert.rejects(tools.start_ticket!(input as never, context), (error: unknown) => error instanceof HostToolRefused && pattern.test(error.message));
  await refused({ id: 'LOCAL-1', reason: 'go' }, /not a ticket of a plan/);
  await tools.propose_plan!(plan([item('a'), item('b', [1])]), context);
  await t.plans.approve('plan-1', 'u1');
  await until(() => t.plans.get('plan-1')!.items[0]!.state === 'needs_approval', 'item 1 in Needs Approval');
  await t.engine.settled();
  const [one, two] = t.plans.get('plan-1')!.items;
  await refused({ id: one!.ticket, reason: 'go' }, /needs_approval/);
  await refused({ id: two!.ticket, reason: 'go' }, /waiting/);

  t.store.db.prepare("UPDATE plan_items SET state = 'held', put_backs = 2 WHERE position = 2").run();
  await t.plans.pause('plan-1', 'u1');
  await refused({ id: two!.ticket, reason: 'go' }, /paused/);
  await t.plans.resume('plan-1', 'u1');
  t.store.db.prepare("UPDATE plan_items SET state = 'held', put_backs = 2 WHERE position = 2").run();
  assert.deepEqual(await tools.start_ticket!({ id: two!.ticket!, reason: 'The owner fixed the database.' }, context), { started: two!.ticket });
  assert.ok(['running', 'needs_approval'].includes(t.plans.get('plan-1')!.items[1]!.state));
  const author = t.startedSessions.filter((s) => s.input.role === 'author').at(-1)!;
  assert.equal(author.input.ticket, two!.ticket);
  assert.match(author.input.prompt, /The owner fixed the database\./);
  await t.engine.settled();
});

test('through the lead: a scripted lead proposes the plan with its host tool, and the plan is stored and waits in the inbox', async () => {
  const t = await leadSetup({ lead: [[...opening(), ...turn('t1', call('c1', 'propose_plan', examplePlanInput), say('r1', 'Here is a plan.'))]], start: false });
  applyTables(t.store.db, PLAN_TABLES);
  let plans: PlanRunner | undefined;
  const lead = new LeadEngine({ ...t.deps, extensions: planExtensions(() => plans) });
  plans = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead, project: 'guestbook', config: DEFAULT_PLAN_CONFIG, now: () => new Date(t.clock.now),
  });
  await lead.start();
  await until(() => lead.state().phase === 'idle', 'the first generation');
  await lead.post('Make the guestbook readable.', 'u1', true);
  await until(() => plans!.list().length === 1, 'the plan');
  await lead.settled();
  assert.equal(plans.list()[0]?.state, 'proposed');
  assert.ok(t.inbox.list().some((i) => i.kind === 'plan' && i.planId === 'plan-1' && i.state === 'waiting'));
  assert.ok(lead.messages().some((m) => m.kind === 'plan' && m.planId === 'plan-1'));
  assert.match(lead.compactState(), /plan-1 "Make a long guestbook readable" proposed/);
  await lead.close();
});
