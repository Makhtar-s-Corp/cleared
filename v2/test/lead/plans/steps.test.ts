// The steps of a plan item (docs/v2/milestone-2-plan.md, decision 26, lane
// 23): propose_plan takes `steps` per item, checked against the
// workspace's services; each step has its estimate by kind, the item's
// estimate adds them (its time is the steps' critical path), and the
// plan's totals add the items; the ticket an item becomes names the
// services of its steps, and its start carries the steps and the plan's
// limit of sessions at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LEAD_RULES } from '../../../src/lead/prompts.ts';
import { DEFAULT_ESTIMATES, stepEstimate } from '../../../src/lead/plans/estimates.ts';
import { DEFAULT_PLAN_CONFIG, PlanRunner, type PlanFlow } from '../../../src/lead/plans/runner.ts';
import { PLAN_TABLES } from '../../../src/lead/plans/store.ts';
import { planExtensions } from '../../../src/lead/plans/tools.ts';
import type { Origin } from '../../../src/flow/events.ts';
import type { HostCallContext } from '../../../src/session/contract.ts';
import { applyTables } from '../../../src/store/db.ts';
import { WORKSPACE_TABLES, recordWorkspace } from '../../../src/tickets/local-store.ts';
import type { ServiceConfig } from '../../../src/workspace/config.ts';
import { quickAuthor, setup } from '../../flow/support.ts';
import { recordingLead } from './support.ts';

const context: HostCallContext = { sessionId: 'lead-session-1', turn: 't' };
const svc = (name: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, ...extra,
});
const SERVICES = [svc('guestbook', { consumes: ['filter-api'] }), svc('filter-api', { contract: { format: 'openapi', path: 'contract/openapi.yaml' } })];

const STEPS = [
  { kind: 'contract', service: 'filter-api', after: [] },
  { kind: 'service', service: 'filter-api', after: [1] },
  { kind: 'service', service: 'guestbook', after: [1] },
  { kind: 'integration', service: 'guestbook', after: [2, 3] },
];
const item = (steps: unknown, size = 'm') => ({ title: 'Held for review', body: 'The guestbook holds what the filter-api flags.\n\n- [ ] a flagged entry is held', lane: 'full', size, after: [], steps });
const plan = (items: unknown[]) => ({ goal: 'goal-1', title: 'Held for review', summary: 'Hold flagged entries.', items }) as never;

async function runner(flow?: PlanFlow) {
  const t = await setup({ scripts: { author: quickAuthor } });
  applyTables(t.store.db, [...PLAN_TABLES, ...WORKSPACE_TABLES]);
  recordWorkspace(t.store.db, { id: 'guestbook', name: 'Guestbook', file: null, services: SERVICES }, '2026-10-22T08:00:00.000Z');
  const lead = recordingLead();
  const plans = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: flow ?? t.engine, lead, project: 'guestbook',
    config: { ...DEFAULT_PLAN_CONFIG, maxParallel: flow ? 2 : 0 }, now: () => new Date(t.clock.now),
  });
  return { ...t, lead, plans, tools: planExtensions(() => plans).tools! };
}

test('propose_plan refuses a step naming an unknown service, a contract step on a service with no contract, and two steps of one service that could run at once', async () => {
  const t = await runner();
  await assert.rejects(t.tools.propose_plan!(plan([item([{ kind: 'service', service: 'billing', after: [] }])]), context), /billing is not a service of this workspace/);
  await assert.rejects(t.tools.propose_plan!(plan([item([{ kind: 'contract', service: 'guestbook', after: [] }])]), context), /guestbook has no contract/);
  await assert.rejects(t.tools.propose_plan!(plan([item([{ kind: 'service', service: 'guestbook', after: [] }, { kind: 'integration', service: 'guestbook', after: [] }])]), context), /share a checkout/);
  await assert.rejects(t.tools.propose_plan!(plan([item([{ kind: 'deploy', service: 'guestbook', after: [] }])]), context), /contract, service or integration/);
  await assert.rejects(t.tools.propose_plan!(plan([item([{ kind: 'service', service: 'guestbook', after: [2] }, { kind: 'service', service: 'filter-api', after: [1] }])]), context), /cycle/);
  await assert.rejects(t.tools.propose_plan!(plan([item([{ kind: 'service', service: 'guestbook', after: [3] }])]), context), /position 3/);
  assert.equal(t.plans.list().length, 0);
});

test('each step has its estimate by kind; the item adds them, its time the steps\' critical path; the plan\'s totals add the items', async () => {
  const t = await runner();
  const proposed = await t.tools.propose_plan!(plan([item(STEPS, 'm'), { ...item(undefined, 's'), title: 'Second', steps: undefined }]), context);
  const stored = t.plans.plan((proposed as { plan: string }).plan);
  const steps = stored.items[0]?.steps ?? [];
  assert.deepEqual(steps.map((s) => [s.position, s.kind, s.service, s.after, s.estimate.costUsd]), [
    [1, 'contract', 'filter-api', [], DEFAULT_ESTIMATES.xs.costUsd],
    [2, 'service', 'filter-api', [1], DEFAULT_ESTIMATES.m.costUsd],
    [3, 'service', 'guestbook', [1], DEFAULT_ESTIMATES.m.costUsd],
    [4, 'integration', 'guestbook', [2, 3], DEFAULT_ESTIMATES.s.costUsd],
  ]);
  const cost = steps.reduce((sum, s) => sum + s.estimate.costUsd, 0);
  assert.equal(stored.items[0]?.estimate.costUsd, Math.round(cost * 100) / 100);
  assert.equal(stored.items[0]?.estimate.minutes, DEFAULT_ESTIMATES.xs.minutes + DEFAULT_ESTIMATES.m.minutes + DEFAULT_ESTIMATES.s.minutes, 'the two service steps run side by side');
  assert.equal(stored.items[1]?.steps, undefined);
  assert.equal(stored.totals.costUsd, Math.round(((stored.items[0]?.estimate.costUsd ?? 0) + (stored.items[1]?.estimate.costUsd ?? 0)) * 100) / 100);
});

test('the step estimates come from the history of done steps of the same kind, size and lane, with three samples or more', () => {
  const samples = [1, 2, 3].map((n) => ({ kind: 'service' as const, size: 'm' as const, lane: 'full' as const, minutes: 10 * n, costUsd: n }));
  assert.deepEqual(stepEstimate(samples, 'm', 'full', 'service'), { minutes: 20, costUsd: 2, weekPercent: null, samples: 3 });
  assert.deepEqual(stepEstimate(samples, 'm', 'full', 'integration'), { ...DEFAULT_ESTIMATES.s, weekPercent: null, samples: 0 });
});

test('the ticket of an item with steps names their services, and its start carries the steps and the plan\'s limit', async () => {
  const starts: { ticket: string; origin?: Origin }[] = [];
  const flow: PlanFlow = { async start(ticket, _by, origin) { starts.push({ ticket, ...(origin ? { origin } : {}) }); }, isActive: () => false, subscribe: () => () => undefined };
  const t = await runner(flow);
  const proposed = await t.tools.propose_plan!(plan([item(STEPS)]), context);
  await t.plans.approve((proposed as { plan: string }).plan, 'u1');
  await t.plans.settled();
  const created = await t.tickets.get(starts[0]?.ticket ?? '');
  assert.deepEqual(created?.services?.map((s) => s.name), ['filter-api', 'guestbook']);
  assert.deepEqual(starts[0]?.origin?.steps, STEPS);
  assert.equal(starts[0]?.origin?.maxParallel, 2);
});

test('the ticket of an item without steps in a workspace of several services names the services its body names', async () => {
  const starts: string[] = [];
  const flow: PlanFlow = { async start(ticket) { starts.push(ticket); }, isActive: () => false, subscribe: () => () => undefined };
  const t = await runner(flow);
  const proposed = await t.tools.propose_plan!(plan([{ ...item(undefined), steps: undefined }]), context);
  await t.plans.approve((proposed as { plan: string }).plan, 'u1');
  await t.plans.settled();
  assert.deepEqual((await t.tickets.get(starts[0] ?? ''))?.services?.map((s) => s.name), ['guestbook', 'filter-api']);
});

test('the lead\'s rules say how a ticket across services is split into steps', () => {
  assert.match(LEAD_RULES, /## Steps/);
  assert.match(LEAD_RULES, /contract step/);
  assert.match(LEAD_RULES, /integration/);
});
