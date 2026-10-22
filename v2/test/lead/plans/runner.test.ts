// The plan runner (docs/v2/milestone-2-plan.md, section 5.3) over the real
// flow engine on the fake adapter: tickets created at the approval, started
// in position order, at most two at a time, a dependent after its
// dependency landed, a put back started once more then held, pause and
// resume, the week stop and the day budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FlowEvent } from '../../../src/flow/events.ts';
import { FlowEngine } from '../../../src/flow/engine.ts';
import { PLAN_TABLES } from '../../../src/lead/plans/store.ts';
import { DEFAULT_PLAN_CONFIG, PlanError, PlanRunner, loadPlanConfig, type PlanConfig } from '../../../src/lead/plans/runner.ts';
import { LEAD_TICKET } from '../../../src/lead/contract.ts';
import { LeadConfigError } from '../../../src/lead/config.ts';
import { NOTIFY_TABLES } from '../../../src/notify/queue.ts';
import { applyTables } from '../../../src/store/db.ts';
import type { FakeStep } from '../../../src/session/adapters/fake.ts';
import { ledgerRow, quickAuthor, releaseRow, setup, started, until, type SetupOptions } from '../../flow/support.ts';
import { recordingLead } from './support.ts';

const iso = (ms: number) => new Date(ms).toISOString();
const criteria = '\n\nAcceptance criteria\n- [ ] a test';
const item = (title: string, after: number[], lane: 'fast' | 'full' = 'full', size: 'xs' | 's' | 'm' | 'l' = 's') => ({ title, body: `${title}.${criteria}`, lane, size, after });

// The acceptance's plan: 1, 2 and 4 independent, 3 after 2, 5 after 3.
const NIGHT = {
  goal: 'goal-1', title: 'Ready for a small team', summary: 'Five small changes.',
  items: [item('Entries as JSON', []), item('Trimmed names', []), item('The time of each entry', [2]), item('A troubleshooting section', [], 'fast', 'xs'), item('The count of entries', [3])],
};

const failing: readonly FakeStep[] = [started, { emit: { type: 'RUN_ERROR', message: 'the runner died', code: 'runner' } }];

async function plans(options: SetupOptions & { readonly plan?: Partial<PlanConfig> } = {}) {
  const t = await setup({
    ...options,
    scripts: { author: quickAuthor, ...options.scripts },
    effects: {
      // One pull request per ticket: LOCAL-n is #100+n.
      async publish(input) { const number = 100 + Number(input.ticket.slice(6)); return { url: `https://example.invalid/pull/${number}`, number, head: 'abc', created: true }; },
      ...options.effects,
    },
  });
  applyTables(t.store.db, [...PLAN_TABLES, ...NOTIFY_TABLES]);
  const lead = recordingLead();
  const runner = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead, project: 'guestbook',
    config: { ...DEFAULT_PLAN_CONFIG, ...options.plan }, now: () => new Date(t.clock.now),
  });
  runner.listen();
  // Tickets live at once (In Progress or In Review), at the most.
  let live = 0;
  let most = 0;
  t.engine.subscribe((event: FlowEvent) => {
    if (event.type === 'ticket_started') most = Math.max(most, ++live);
    if (event.type === 'release_requested' || event.type === 'ticket_put_back') live--;
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) { await t.engine.settled(); await runner.settled(); }
  };
  const tick = async (ms = 30_000) => {
    t.clock.now += ms;
    await t.engine.tick();
    await settle();
    await runner.tick();
    await settle();
  };
  const status = async (id: string | null) => (id ? (await t.tickets.get(id))?.status : undefined);
  const itemsOf = (id: string) => runner.get(id)!.items;
  const states = (id: string) => itemsOf(id).map((i) => i.state);
  // The human's approval of a release, then the lock's merge and the release watch's healthy end.
  const land = async (ticket: string) => {
    const pr = 100 + Number(ticket.slice(6));
    await t.tickets.recordApproval(ticket, { kind: 'human', id: 'u1' });
    await tick(0);
    await tick(60_000);
    releaseRow(t.store, { ticket, pr, status: 'complete', mergedAt: iso(t.clock.now) });
    ledgerRow(t.store, { kind: 'release_watch_complete', ticket, pr, at: iso(t.clock.now) });
    await tick(30_000);
  };
  return { ...t, lead, runner, settle, tick, status, itemsOf, states, land, most: () => most };
}

test('a night of a five-item plan: two at a time, in position order, 3 after 2 is Done, the plan done when 5 lands', async () => {
  const t = await plans();
  const { plan } = await t.runner.propose(NIGHT);
  const approved = await t.runner.approve(plan, 'u1');
  assert.equal(approved.state, 'approved');
  await t.settle();

  // Evening: 1 and 2 start, 4 waits for a slot.
  await until(async () => (await t.status(t.itemsOf(plan)[1]!.ticket)) === 'Needs Approval', 'item 2 in Needs Approval');
  await t.settle();
  const firstTwo = t.startedSessions.filter((s) => s.input.role === 'author').map((s) => s.input.ticket);
  assert.deepEqual(firstTwo, [t.itemsOf(plan)[0]!.ticket, t.itemsOf(plan)[1]!.ticket], 'positions 1 and 2 first');

  // The night: ticks every 30 seconds. Needs Approval does not hold a slot, so 4 starts; 3 waits for 2 to land.
  for (let i = 0; i < 6; i++) await t.tick();
  assert.deepEqual(t.states(plan), ['needs_approval', 'needs_approval', 'waiting', 'needs_approval', 'waiting'], 'the morning');
  assert.equal(await t.status(t.itemsOf(plan)[2]!.ticket), 'Todo');
  assert.equal(await t.status(t.itemsOf(plan)[4]!.ticket), 'Todo');
  assert.ok(t.most() <= 2, `never more than 2 live tickets, saw ${t.most()}`);

  // The morning: the owner approves 2, which lands; only then does 3 start.
  await t.land(t.itemsOf(plan)[1]!.ticket!);
  assert.equal(t.itemsOf(plan)[1]!.state, 'landed');
  const two = t.flowEvents.find((e) => e.type === 'release_landed' && e.ticket === t.itemsOf(plan)[1]!.ticket)!;
  const three = t.flowEvents.find((e) => e.type === 'ticket_started' && e.ticket === t.itemsOf(plan)[2]!.ticket)!;
  assert.ok(three && Date.parse(three.at) >= Date.parse(two.at), 'item 3 started after item 2 landed');
  if (three.type === 'ticket_started') assert.deepEqual(three.origin, { plan, item: 3 });

  await t.land(t.itemsOf(plan)[0]!.ticket!);
  await t.land(t.itemsOf(plan)[3]!.ticket!);
  await until(async () => (await t.status(t.itemsOf(plan)[2]!.ticket)) === 'Needs Approval', 'item 3 in Needs Approval');
  await t.settle();
  await t.land(t.itemsOf(plan)[2]!.ticket!);
  await until(async () => (await t.status(t.itemsOf(plan)[4]!.ticket)) === 'Needs Approval', 'item 5 in Needs Approval');
  await t.settle();
  assert.equal(t.runner.get(plan)!.state, 'approved');
  await t.land(t.itemsOf(plan)[4]!.ticket!);
  assert.deepEqual(t.states(plan), ['landed', 'landed', 'landed', 'landed', 'landed']);
  assert.equal(t.runner.get(plan)!.state, 'done');
  assert.ok(t.most() <= 2);
  assert.ok(t.lead.events.some((e) => /plan-1 is done/.test(e.text)), 'the lead hears the plan is done');
  const comment = (await t.tickets.comments(t.itemsOf(plan)[0]!.ticket!)).map((c) => c.body);
  assert.ok(comment.includes(`Started by the lead for plan ${plan} (item 1), approved by u1.`));
});

test('the approval creates the tickets in Todo with the plan, size and fast lane labels and the items\' bodies; a second approval is refused', async () => {
  const t = await plans({ plan: { maxParallel: 0 } });
  const { plan } = await t.runner.propose(NIGHT);
  await t.runner.approve(plan, 'u1');
  const created = await Promise.all(t.itemsOf(plan).map(async (i) => t.tickets.get(i.ticket!)));
  assert.deepEqual(created.map((c) => c?.status), ['Todo', 'Todo', 'Todo', 'Todo', 'Todo']);
  assert.deepEqual(created.map((c) => c?.labels), [
    [`plan:${plan}`, 'size:s'], [`plan:${plan}`, 'size:s'], [`plan:${plan}`, 'size:s'], [`plan:${plan}`, 'size:xs', 'Quick'], [`plan:${plan}`, 'size:s'],
  ]);
  assert.deepEqual(created.map((c) => c?.body), NIGHT.items.map((i) => i.body));
  assert.deepEqual(created.map((c) => c?.title), NIGHT.items.map((i) => i.title));
  assert.equal(t.runner.get(plan)?.approvedBy, 'u1');
  assert.deepEqual(t.lead.lines, [`The owner approved plan ${plan} ("Ready for a small team"): its 5 tickets are created and start in order, at most 0 at a time.`]);
  const item = t.inbox.list().find((i) => i.kind === 'plan');
  assert.equal(item?.state, 'handled');
  await assert.rejects(t.runner.approve(plan, 'u1'), (error: unknown) => error instanceof PlanError && error.kind === 'conflict');
  assert.equal((await t.tickets.list({ project: 'guestbook' })).length, 6, 'no ticket created twice');
});

test('a fast item\'s author is Haiku; a full item\'s is the configured author', async () => {
  const t = await plans();
  const { plan } = await t.runner.propose({ ...NIGHT, items: [item('Docs', [], 'fast', 'xs'), item('Code', [])] });
  await t.runner.approve(plan, 'u1');
  await until(() => t.startedSessions.filter((s) => s.input.role === 'author').length === 2, 'two authors');
  const models = Object.fromEntries(t.startedSessions.filter((s) => s.input.role === 'author').map((s) => [s.input.ticket, s.input.model]));
  assert.equal(models[t.itemsOf(plan)[0]!.ticket!], 'claude-haiku-5-5');
  assert.equal(models[t.itemsOf(plan)[1]!.ticket!], 'claude-opus-5-5');
  await t.settle();
});

test('a ticket put back is started once more with the note and the base hint, then held with an event to the lead', async () => {
  const t = await plans({ scripts: { authors: [failing, failing] } });
  const { plan } = await t.runner.propose({ ...NIGHT, items: [item('Entries as JSON', [])] });
  await t.runner.approve(plan, 'u1');
  await t.settle();
  assert.equal(t.itemsOf(plan)[0]!.state, 'put_back');
  assert.match(t.itemsOf(plan)[0]!.note ?? '', /the runner died/);

  await t.tick();
  const authors = t.startedSessions.filter((s) => s.input.role === 'author');
  assert.equal(authors.length, 2, 'started once more');
  assert.match(authors[1]!.input.prompt, /the runner died/);
  assert.match(authors[1]!.input.prompt, /integrate the base branch first/);

  await t.settle();
  assert.equal(t.itemsOf(plan)[0]!.state, 'held');
  assert.equal(t.itemsOf(plan)[0]!.putBacks, 2);
  await t.tick();
  assert.equal(t.startedSessions.filter((s) => s.input.role === 'author').length, 2, 'a held item is not started by the runner');
  const held = t.lead.events.filter((e) => /held/.test(e.text));
  assert.equal(held.length, 1);
  assert.ok(held[0]!.urgent);
  assert.match(held[0]!.text, /start_ticket/);
});

test('a ticket put back by a restart of the service is started again without counting toward the hold', async () => {
  const t = await plans({ plan: { maxParallel: 0 } });
  const { plan } = await t.runner.propose({ ...NIGHT, items: [item('Entries as JSON', [])] });
  await t.runner.approve(plan, 'u1');
  const ticket = t.itemsOf(plan)[0]!.ticket!;
  t.store.db.prepare("UPDATE plan_items SET state = 'running'").run();
  // What recover() says for a ticket the last process ran.
  t.runner.onFlowEvent({ type: 'ticket_put_back', at: iso(t.clock.now), project: 'guestbook', ticket, reason: 'restart', note: 'The service restarted.' });
  assert.equal(t.itemsOf(plan)[0]!.state, 'put_back');
  assert.equal(t.itemsOf(plan)[0]!.putBacks, 0);
});

test('a running item whose ticket is back in Todo without an event is a put back the tick finds', async () => {
  const t = await plans({ plan: { maxParallel: 0 } });
  const { plan } = await t.runner.propose({ ...NIGHT, items: [item('Entries as JSON', [])] });
  await t.runner.approve(plan, 'u1');
  t.store.db.prepare("UPDATE plan_items SET state = 'running'").run();
  await t.runner.tick();
  assert.equal(t.itemsOf(plan)[0]!.state, 'put_back');
  assert.equal(t.itemsOf(plan)[0]!.putBacks, 1);
});

test('pause stops the next start, running tickets go on; resume starts it', async () => {
  const t = await plans();
  const { plan } = await t.runner.propose({ ...NIGHT, items: [item('Entries as JSON', []), item('Trimmed names', [1])] });
  await t.runner.approve(plan, 'u1');
  await until(async () => (await t.status(t.itemsOf(plan)[0]!.ticket)) === 'Needs Approval', 'item 1 in Needs Approval');
  await t.settle();
  assert.equal((await t.runner.pause(plan, 'u1')).state, 'paused');
  await t.land(t.itemsOf(plan)[0]!.ticket!);
  assert.equal(t.itemsOf(plan)[0]!.state, 'landed', 'a paused plan still follows its tickets');
  await t.tick();
  assert.equal(await t.status(t.itemsOf(plan)[1]!.ticket), 'Todo', 'nothing starts while paused');
  assert.equal((await t.runner.resume(plan, 'u1')).state, 'approved');
  await t.settle();
  assert.notEqual(await t.status(t.itemsOf(plan)[1]!.ticket), 'Todo', 'resume starts the next item');
  await assert.rejects(t.runner.resume(plan, 'u1'), (error: unknown) => error instanceof PlanError && error.kind === 'conflict');
  assert.deepEqual(t.lead.lines.slice(1), [`The owner paused plan ${plan}: running tickets go on, nothing new starts.`, `The owner resumed plan ${plan}.`]);
  await t.settle();
});

test('a release live but not healthy holds its item and tells the lead; its dependents do not start', async () => {
  const t = await plans();
  const { plan } = await t.runner.propose({ ...NIGHT, items: [item('Entries as JSON', []), item('Trimmed names', [1])] });
  await t.runner.approve(plan, 'u1');
  await t.settle();
  const ticket = t.itemsOf(plan)[0]!.ticket!;
  t.runner.onFlowEvent({ type: 'release_unhealthy', at: iso(t.clock.now), project: 'guestbook', ticket, pr: 101, note: 'HTTP 503' });
  assert.equal(t.itemsOf(plan)[0]!.state, 'held');
  assert.ok(t.lead.events.some((e) => e.urgent && /not healthy/.test(e.text)));
  await t.tick();
  assert.equal(t.itemsOf(plan)[1]!.state, 'waiting');
});

test('the week stop: at 85 % of the seven-day window nothing new starts, the lead and the owner are told once', async () => {
  const t = await plans();
  t.store.events.append({ at: iso(t.clock.now), sessionId: 'author-old', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'seven_day', usedPercent: 86, resetsAt: null } } });
  const { plan } = await t.runner.propose({ ...NIGHT, items: [item('Entries as JSON', [])] });
  await t.runner.approve(plan, 'u1');
  await t.tick();
  await t.tick();
  assert.equal(await t.status(t.itemsOf(plan)[0]!.ticket), 'Todo');
  assert.equal(t.lead.events.filter((e) => /seven-day/.test(e.text)).length, 1);
  const health = t.store.db.prepare("SELECT json_extract(facts, '$.code') AS code FROM v2_notify_queue WHERE kind = 'health'").all() as { code: string }[];
  assert.deepEqual(health.map((h) => h.code), ['week_stop']);

  // The window resets: the runner starts again.
  t.store.events.append({ at: iso(t.clock.now + 1000), sessionId: 'author-old', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.rate_limit', value: { window: 'seven_day', usedPercent: 10, resetsAt: null } } });
  await t.tick();
  assert.notEqual(await t.status(t.itemsOf(plan)[0]!.ticket), 'Todo');
  await t.settle();
});

test('without a week measure, the day budget stops new starts once today\'s sessions cost more', async () => {
  const t = await plans({ plan: { dayBudgetUsd: 1.5, maxParallel: 1 } });
  const finished = (cost: number) => ({ type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: cost } }) as const;
  t.store.events.append({ at: iso(t.clock.now - 3 * 86_400_000), sessionId: 'old', ticket: 'LOCAL-1', project: 'guestbook', event: finished(5) });
  t.store.events.append({ at: iso(t.clock.now), sessionId: 'today', ticket: 'LOCAL-1', project: 'guestbook', event: finished(0.6) });
  const { plan } = await t.runner.propose({ ...NIGHT, items: [item('Entries as JSON', []), item('Trimmed names', [])] });
  await t.runner.approve(plan, 'u1');
  await until(async () => (await t.status(t.itemsOf(plan)[0]!.ticket)) === 'Needs Approval', 'item 1 in Needs Approval');
  await t.settle();
  // $0.60 earlier today, $0.40 for the first ticket's author and reviewer: under $1.50.
  assert.equal(await t.status(t.itemsOf(plan)[0]!.ticket), 'Needs Approval', 'under the budget: the first starts');
  t.store.events.append({ at: iso(t.clock.now), sessionId: 'today', ticket: 'LOCAL-1', project: 'guestbook', event: finished(0.6) });
  await t.tick();
  assert.equal(await t.status(t.itemsOf(plan)[1]!.ticket), 'Todo', 'over it: nothing new');
  assert.equal(t.lead.events.filter((e) => /budget/.test(e.text)).length, 1);
});

test('the settings: the week stop and the day budget, and a wrong one is an error', () => {
  assert.deepEqual(loadPlanConfig({}), DEFAULT_PLAN_CONFIG);
  assert.deepEqual(DEFAULT_PLAN_CONFIG, { maxParallel: 2, weekStopPercent: 85, dayBudgetUsd: undefined });
  assert.deepEqual(loadPlanConfig({ CLEARED_V2_WEEK_STOP_PERCENT: '70', CLEARED_V2_DAY_BUDGET_USD: '12.5' }), { maxParallel: 2, weekStopPercent: 70, dayBudgetUsd: 12.5 });
  assert.throws(() => loadPlanConfig({ CLEARED_V2_WEEK_STOP_PERCENT: '120' }), LeadConfigError);
  assert.throws(() => loadPlanConfig({ CLEARED_V2_DAY_BUDGET_USD: 'lots' }), LeadConfigError);
  assert.throws(() => loadPlanConfig({ CLEARED_V2_DAY_BUDGET_USD: '0' }), LeadConfigError);
});

test('a new flow engine over a store with a proposed plan and the lead\'s question waiting leaves both, and handles a dead session\'s permission', async () => {
  const t = await plans();
  await t.runner.propose(NIGHT);
  t.inbox.addQuestion({ ticket: LEAD_TICKET, project: 'guestbook', sessionId: 'lead-session-1', requestId: 'q1', questions: [{ question: 'Pages of 20?', header: 'Pages', options: [{ label: 'Yes' }, { label: 'No' }] }] });
  t.inbox.addQuestion({ ticket: 'LOCAL-1', project: 'guestbook', sessionId: 'author-dead', requestId: 'q2', questions: [{ question: 'Which order?', header: 'Order', options: [{ label: 'Newest' }, { label: 'Oldest' }] }] });
  t.inbox.addPermission({ ticket: 'LOCAL-1', project: 'guestbook', sessionId: 'author-dead', requestId: 'p1', tool: 'Bash', input: { kind: 'execute', command: 'npm install left-pad' }, suggestion: { decision: 'ask', rule: 'install.package', reason: 'a package' } });
  t.inbox.addPermission({ ticket: LEAD_TICKET, project: 'guestbook', sessionId: 'lead-session-1', requestId: 'p2', tool: 'Read', input: { kind: 'read', path: '/etc/hosts' }, suggestion: { decision: 'ask', rule: 'default', reason: 'outside' } });

  new FlowEngine(t.deps);
  const state = Object.fromEntries(t.inbox.list().map((i) => [i.id, i.state]));
  assert.equal(state[`plan:plan-1`], 'waiting', 'the proposed plan waits');
  assert.equal(state['question:lead-session-1:q1'], 'waiting', 'the lead\'s question waits for the next generation');
  assert.equal(state['question:author-dead:q2'], 'handled');
  assert.equal(state['permission:author-dead:p1'], 'handled');
  assert.equal(state['permission:lead-session-1:p2'], 'handled', 'a permission of a dead lead generation cannot be answered either');
});
