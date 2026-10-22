// Sensitivity per service, flagged from the plan (docs/v2/milestone-2-plan.md,
// decision 24, lane 18): a plan item carries the services its body names
// (else the workspace's first service, where its ticket runs) with their
// sensitivity, for the plan panel's chips; a fast item on a `full` service
// becomes a full one, with a note in its body, before its estimate is
// made, so its ticket has no Quick label. The services are read from the
// ledger's `services` table, which the tickets module writes at every start.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceSensitivity } from '../../../src/api/types.ts';
import { LEAD_RULES } from '../../../src/lead/prompts.ts';
import { DEFAULT_PLAN_CONFIG, PlanRunner } from '../../../src/lead/plans/runner.ts';
import { PLAN_TABLES, publicPlan } from '../../../src/lead/plans/store.ts';
import { fullLaneNote, itemServices, planExtensions } from '../../../src/lead/plans/tools.ts';
import type { HostCallContext } from '../../../src/session/contract.ts';
import { applyTables } from '../../../src/store/db.ts';
import { WORKSPACE_TABLES, recordWorkspace } from '../../../src/tickets/local-store.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../../src/workspace/config.ts';
import { QUICK_LABEL } from '../../../src/flow/engine.ts';
import { quickAuthor, setup } from '../../flow/support.ts';
import { doneTicket, recordingLead } from './support.ts';

const context: HostCallContext = { sessionId: 'lead-session-1', turn: 't' };
const criteria = '\n\nAcceptance criteria\n- [ ] a test';
const item = (title: string, body: string, lane: 'fast' | 'full' = 'fast', size = 's') => ({ title, body: `${body}${criteria}`, lane, size, after: [] });
const plan = (items: unknown[]) => ({ goal: 'goal-1', title: 'A plan', summary: 'What it does.', items }) as never;

const svc = (name: string, sensitivity: ServiceSensitivity): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity, consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null,
});

async function runner(services: readonly ServiceConfig[] | null, project = 'guestbook') {
  const t = await setup({ scripts: { author: quickAuthor } });
  applyTables(t.store.db, PLAN_TABLES);
  if (services) {
    applyTables(t.store.db, WORKSPACE_TABLES);
    const workspace: WorkspaceConfig = { id: project, name: 'Guestbook', file: null, services };
    recordWorkspace(t.store.db, workspace, '2026-10-22T08:00:00.000Z');
    // Another workspace's services in the same ledger are not this plan's.
    recordWorkspace(t.store.db, { id: 'elsewhere', name: 'Elsewhere', file: null, services: [svc('billing', 'full')] }, '2026-10-22T08:00:00.000Z');
  }
  const lead = recordingLead();
  const plans = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead, project,
    config: { ...DEFAULT_PLAN_CONFIG, maxParallel: 0 }, now: () => new Date(t.clock.now),
  });
  const tools = planExtensions(() => plans).tools!;
  return { ...t, lead, plans, tools };
}

const TWO = [svc('guestbook', 'normal'), svc('filter-api', 'full')];

test('a fast item that names a full service becomes full, with its note, and is estimated and created as full', async () => {
  const t = await runner(TWO);
  // The history: full tickets of size s take 40 minutes, fast ones 5.
  for (let i = 0; i < 3; i++) {
    await doneTicket(t.store, t.tickets, { size: 's', lane: 'full', minutes: 40, costUsd: 1 });
    await doneTicket(t.store, t.tickets, { size: 's', lane: 'fast', minutes: 5, costUsd: 0.1 });
  }
  await t.tools.propose_plan!(plan([
    item('Hold flagged entries', 'The filter-api answers a severity.'),
    item('Fix a typo', 'The guestbook\'s page says "Sign" instead of "Sing".'),
    item('Docs', 'The README explains the hold.', 'full'),
  ]), context);
  const stored = t.plans.get('plan-1')!;
  const [held, typo, docs] = stored.items;
  assert.equal(held?.lane, 'full');
  assert.equal(held?.estimate.minutes, 40, 'estimated as a full ticket');
  assert.ok(held?.body.startsWith(`The filter-api answers a severity.${criteria}`), 'the lead\'s body is kept');
  assert.ok(held?.body.endsWith(`\n\n${fullLaneNote(['filter-api'])}`), 'the note follows it');
  assert.match(fullLaneNote(['filter-api']), /full lane/);
  assert.match(fullLaneNote(['filter-api']), /filter-api/);
  assert.equal(typo?.lane, 'fast', 'a normal service keeps the fast lane');
  assert.equal(typo?.estimate.minutes, 5);
  assert.equal(docs?.lane, 'full');
  assert.ok(!docs?.body.includes('Cleared:'), 'a full item gets no note');

  await t.plans.approve('plan-1', 'u1');
  await t.plans.tick();
  const tickets = await Promise.all(t.plans.get('plan-1')!.items.map((i) => t.tickets.get(i.ticket!)));
  assert.equal(tickets[0]?.labels.includes(QUICK_LABEL), false, 'no Quick label on the item made full');
  assert.equal(tickets[1]?.labels.includes(QUICK_LABEL), true);
});

test('the plan\'s data carries each item\'s services with their sensitivity: the chips', async () => {
  const t = await runner([...TWO, svc('search', 'reviewer:claude-opus-5-5'), svc('payments', 'human:alice')]);
  await t.tools.propose_plan!(plan([
    item('Two services', 'The Guestbook calls the filter-api, and payments is left alone.', 'full'),
    item('Not a name', 'The filter-api-v2 and the guestbooks are other things; search-engine too.'),
    item('Nothing named', 'The page lists the newest entry first.'),
  ]), context);
  const items = publicPlan(t.plans.get('plan-1')!).items;
  assert.deepEqual(items[0]?.sensitivity, [
    { service: 'guestbook', sensitivity: 'normal' },
    { service: 'filter-api', sensitivity: 'full' },
    { service: 'payments', sensitivity: 'human:alice' },
  ], 'in the workspace\'s order, a name matched whatever its case');
  assert.deepEqual(items[1]?.sensitivity, [{ service: 'guestbook', sensitivity: 'normal' }], 'a longer word is not a service\'s name: the first service');
  assert.deepEqual(items[2]?.sensitivity, [{ service: 'guestbook', sensitivity: 'normal' }], 'no service named: the first, where its ticket runs');
  assert.equal(items[1]?.lane, 'fast');
  // What the plan panel reads: the frame the runner publishes.
  assert.deepEqual(t.lead.frames.at(-1)?.items.map((i) => i.sensitivity?.map((s) => s.sensitivity)), [['normal', 'full', 'human:alice'], ['normal'], ['normal']]);
});

test('a one-service workspace whose service is full makes every fast item full', async () => {
  const t = await runner([svc('guestbook', 'full')]);
  await t.tools.propose_plan!(plan([item('Typo', 'Fix the page title.')]), context);
  const [only] = t.plans.get('plan-1')!.items;
  assert.equal(only?.lane, 'full');
  assert.ok(only?.body.endsWith(fullLaneNote(['guestbook'])));
  assert.deepEqual(only?.sensitivity, [{ service: 'guestbook', sensitivity: 'full' }]);
});

test('a ledger with no services table (a store opened on the plans alone) gives no chip and changes no lane', async () => {
  const t = await runner(null);
  await t.tools.propose_plan!(plan([item('Typo', 'Fix the filter-api page title.')]), context);
  const [only] = t.plans.get('plan-1')!.items;
  assert.equal(only?.lane, 'fast');
  assert.equal('sensitivity' in (only ?? {}), false, 'no field at all, as before lane 18');
});

test('an input that is not a plan is left for the validation to refuse', async () => {
  const t = await runner(TWO);
  await assert.rejects(t.tools.propose_plan!({ goal: 'goal-1', title: 'A plan', summary: 'S', items: 'all of it' } as never, context), /1 to 12 items/);
  await assert.rejects(t.tools.propose_plan!(plan([{ title: 'No body', lane: 'fast', size: 's' }]), context), /body of item 1/);
});

test('itemServices: whole names only, a dash being part of a name, in the workspace\'s order', () => {
  const services = [{ name: 'guestbook', sensitivity: 'normal' as const }, { name: 'filter-api', sensitivity: 'full' as const }];
  assert.deepEqual(itemServices('Change filter-api, then GUESTBOOK.', services).map((s) => s.name), ['guestbook', 'filter-api']);
  assert.deepEqual(itemServices('Change filter-api-v2 and my-guestbook.', services).map((s) => s.name), ['guestbook'], 'none named: the first');
  assert.deepEqual(itemServices('(filter-api)', services).map((s) => s.name), ['filter-api']);
  assert.deepEqual(itemServices('anything', []), []);
});

test('the lead\'s rules say how sensitivity works', () => {
  assert.match(LEAD_RULES, /## Sensitive services/);
  assert.match(LEAD_RULES, /Name in each item's body the services it changes/);
  assert.match(LEAD_RULES, /full: never the fast lane/);
  assert.match(LEAD_RULES, /reviewer:<model>/);
  assert.match(LEAD_RULES, /human:<user>: only that user approves/);
});
