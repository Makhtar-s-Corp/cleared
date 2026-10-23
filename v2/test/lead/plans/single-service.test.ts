// A workspace that went from several services to one under the same id
// (docs/v2/decisions-log.md, 2026-10-23, single-service mode): the ledger
// keeps the old services' rows (recordWorkspace deletes nothing), and the
// plans read only the services the configuration has now, so their tickets
// name a service the flow knows. The tickets an earlier plan created with
// an old service are repaired by lead/plans/repair.ts, a dry run unless
// applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLAN_CONFIG, PlanRunner, type PlanFlow } from '../../../src/lead/plans/runner.ts';
import { repairTicketServices } from '../../../src/lead/plans/repair.ts';
import { PLAN_TABLES, PlanStore } from '../../../src/lead/plans/store.ts';
import { planExtensions } from '../../../src/lead/plans/tools.ts';
import { STEPS_TABLE } from '../../../src/flow/steps.ts';
import type { FlowEvent } from '../../../src/flow/events.ts';
import type { HostCallContext } from '../../../src/session/contract.ts';
import { applyTables } from '../../../src/store/db.ts';
import { DEFAULT_STATES } from '../../../src/tickets/contract.ts';
import { LocalTicketStore, TICKET_TABLES, WORKSPACE_TABLES, recordWorkspace } from '../../../src/tickets/local-store.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../../src/workspace/config.ts';
import { quickAuthor, setup } from '../../flow/support.ts';
import { recordingLead } from './support.ts';

const context: HostCallContext = { sessionId: 'lead-session-1', turn: 't' };
const PROJECT = 'cleared-example-guestbook';
const svc = (name: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
  name, kind: 'repository', repo: `owner/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, ...extra,
});
// The multi-service runs' workspace, then the single-service one, both under the project's id.
const MULTI: WorkspaceConfig = { id: PROJECT, name: 'Guestbook and filter API', file: null, services: [svc('guestbook', { consumes: ['filter-api'] }), svc('filter-api')] };
const SINGLE: WorkspaceConfig = { id: PROJECT, name: PROJECT, file: null, services: [svc(PROJECT)] };

const criteria = '\n\n- [ ] the test passes';
const item = (title: string, body: string, after: number[] = []) => ({ title, body: `${body}${criteria}`, lane: 'full', size: 's', after });
// Five items as the 48 h proof's plan had them: bodies that name the guestbook.
const FIVE = [
  item('Heading', 'The guestbook\'s page has a heading.'),
  item('Empty state', 'The guestbook says when it has no entry.'),
  item('Count', 'The guestbook shows how many entries it has.'),
  item('Order', 'The guestbook lists entries newest first.'),
  item('Footer', 'The guestbook\'s page has a footer.'),
];
const plan = (items: unknown[]) => ({ goal: 'goal-1', title: 'The guestbook\'s page', summary: 'Five small changes.', items }) as never;

async function settle(t: { engine: { settled(): Promise<void> } }, plans: PlanRunner): Promise<void> {
  for (let i = 0; i < 5; i++) { await t.engine.settled(); await plans.settled(); }
}

test('LOCAL-33..37: in single-service mode, a ledger holding the multi-service rows plans on the configured service, and the tickets start', async () => {
  const t = await setup({ scripts: { author: quickAuthor }, config: { project: PROJECT, workspace: SINGLE, steps: true } });
  applyTables(t.store.db, [...PLAN_TABLES, ...WORKSPACE_TABLES]);
  recordWorkspace(t.store.db, MULTI, '2026-10-22T08:00:00.000Z');
  recordWorkspace(t.store.db, SINGLE, '2026-10-23T08:00:00.000Z');
  const events: FlowEvent[] = [];
  t.engine.subscribe((event) => { events.push(event); });
  const plans = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead: recordingLead(), project: PROJECT,
    services: SINGLE.services.map((service) => service.name), config: { ...DEFAULT_PLAN_CONFIG, maxParallel: 5 }, now: () => new Date(t.clock.now),
  });
  plans.listen();

  await planExtensions(() => plans).tools!.propose_plan!(plan(FIVE), context);
  await plans.approve('plan-1', 'u1');
  await settle(t, plans);

  const tickets = plans.get('plan-1')!.items.map((i) => i.ticket!);
  assert.equal(tickets.length, 5);
  assert.deepEqual(events.filter((e) => e.type === 'ticket_put_back').map((e) => `${e.ticket}: ${e.note}`), [], 'no ticket is put back');
  for (const id of tickets) {
    const ticket = await t.tickets.get(id);
    assert.ok((ticket?.services ?? []).every((s) => s.name === PROJECT), `${id} names only ${PROJECT}`);
  }
  assert.deepEqual(new Set(events.filter((e) => e.type === 'ticket_started').map((e) => e.ticket)), new Set(tickets), 'every ticket starts');
  assert.ok(plans.get('plan-1')!.items.every((i) => i.state === 'running' || i.state === 'needs_approval'));
  assert.deepEqual(plans.get('plan-1')!.items.map((i) => i.sensitivity?.map((s) => s.service)), FIVE.map(() => [PROJECT]));
  assert.deepEqual(plans.store.services().map((service) => service.name), [PROJECT], 'the old services are not the plans\'');
  assert.equal((t.store.db.prepare('SELECT COUNT(*) AS n FROM services WHERE workspace = ?').get(PROJECT) as { n: number }).n, 3, 'no ledger row is deleted');
  await plans.close();
});

test('multi-service mode is unchanged: the tickets name the services their bodies name, and the first when none, while an old service is never planned', async () => {
  const t = await setup({ config: { project: PROJECT, workspace: MULTI } });
  applyTables(t.store.db, [...PLAN_TABLES, ...WORKSPACE_TABLES]);
  // The other way round: a single-service run's row before the multi-service runs.
  recordWorkspace(t.store.db, SINGLE, '2026-10-21T08:00:00.000Z');
  recordWorkspace(t.store.db, MULTI, '2026-10-22T08:00:00.000Z');
  const starts: string[] = [];
  const flow: PlanFlow = { async start(ticket) { starts.push(ticket); }, isActive: () => false, subscribe: () => () => undefined };
  const plans = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow, lead: recordingLead(), project: PROJECT,
    services: MULTI.services.map((service) => service.name), config: { ...DEFAULT_PLAN_CONFIG, maxParallel: 3 }, now: () => new Date(t.clock.now),
  });
  assert.deepEqual(plans.store.services().map((service) => service.name), ['guestbook', 'filter-api']);
  const tools = planExtensions(() => plans).tools!;
  await assert.rejects(tools.propose_plan!(plan([{ ...item('Old', 'The page.'), steps: [{ kind: 'service', service: PROJECT, after: [] }] }]), context),
    new RegExp(`${PROJECT} is not a service of this workspace \\(guestbook, filter-api\\)`));
  await tools.propose_plan!(plan([
    item('Both', 'The guestbook holds what the filter-api flags.'),
    item('Filter', 'The filter-api answers a severity.'),
    item('Docs', 'The README explains the hold.'),
  ]), context);
  await plans.approve('plan-1', 'u1');
  await plans.settled();
  const named = await Promise.all(plans.get('plan-1')!.items.map(async (i) => (await t.tickets.get(i.ticket!))?.services?.map((s) => s.name)));
  assert.deepEqual(named, [['guestbook', 'filter-api'], ['filter-api'], ['guestbook']]);
  assert.equal(starts.length, 3);
});

test('without the configured names, the store reads every recorded service of the workspace, as before', async () => {
  const t = await setup();
  applyTables(t.store.db, [...PLAN_TABLES, ...WORKSPACE_TABLES]);
  recordWorkspace(t.store.db, MULTI, '2026-10-22T08:00:00.000Z');
  recordWorkspace(t.store.db, SINGLE, '2026-10-23T08:00:00.000Z');
  assert.deepEqual(new PlanStore(t.store.db, PROJECT).services().map((s) => s.name), ['guestbook', 'filter-api', PROJECT]);
  assert.deepEqual(new PlanStore(t.store.db, PROJECT, undefined, [PROJECT, 'gone']).services().map((s) => s.name), [PROJECT], 'a configured service with no row yet is not invented');
});

// The tickets as the 48 h proof's plan created them before the fix: in
// Todo, each naming guestbook (a body about the guestbook names it, or
// none, and then the first recorded service, guestbook too), their items
// held after two failed starts, or put back once, or not started yet.
// LOCAL-1..32 are earlier tickets.
async function blocked() {
  const t = await setup({ scripts: { author: quickAuthor }, config: { project: PROJECT, workspace: SINGLE, steps: true } });
  applyTables(t.store.db, [...TICKET_TABLES, ...WORKSPACE_TABLES, ...PLAN_TABLES, STEPS_TABLE]);
  recordWorkspace(t.store.db, MULTI, '2026-10-22T08:00:00.000Z');
  recordWorkspace(t.store.db, SINGLE, '2026-10-23T08:00:00.000Z');
  const tickets = new LocalTicketStore(t.store.db, { stateDir: '/nonexistent', now: () => new Date(t.clock.now).toISOString() });
  const agents = { kind: 'agents', id: 'cleared-v2' } as const;
  for (let n = 1; n <= 32; n++) await tickets.create({ title: `Earlier ${n}`, project: PROJECT }, agents);
  const store = new PlanStore(t.store.db, PROJECT, () => new Date(t.clock.now));
  const estimate = { minutes: 10, costUsd: 1, weekPercent: null, samples: 0 };
  const { plan: stored } = store.propose({
    goal: 'goal-1', title: 'The guestbook\'s page', summary: 'Five small changes.', maxParallel: 5, totals: estimate,
    items: FIVE.map((i) => ({ ...i, lane: 'full' as const, size: 's' as const, estimate })),
  });
  store.move(stored.id, ['proposed'], 'approved', 'u1');
  const services: string[][] = [['guestbook'], ['guestbook'], ['guestbook'], ['guestbook'], ['guestbook']];
  for (const [index, i] of FIVE.entries()) {
    const created = await tickets.create({ title: i.title, body: i.body, labels: ['plan:plan-1', 'size:s'], project: PROJECT, services: services[index] }, agents);
    store.setTicket(stored.id, index + 1, created.id);
  }
  const states = ['held', 'held', 'put_back', 'waiting', 'waiting'] as const;
  states.forEach((state, index) => store.setItem(stored.id, index + 1, { state, putBack: state !== 'waiting', note: 'The flow could not start: FlowError' }));
  return { ...t, tickets, planStore: store };
}

const dump = (db: import('node:sqlite').DatabaseSync) =>
  ['ticket_services', 'tracker_tickets', 'tracker_comments', 'plan_items', 'services'].map((name) => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all());

test('the repair is a dry run unless applied, and then names the workspace\'s only service on LOCAL-33..37 and puts their held items back', async () => {
  const t = await blocked();
  const input = { workspace: { id: PROJECT, services: [PROJECT] }, todo: DEFAULT_STATES.todo, at: '2026-10-23T18:00:00.000Z' };
  const before = dump(t.store.db);
  const dry = repairTicketServices(t.store.db, { ...input, apply: false });
  assert.deepEqual(dump(t.store.db), before, 'a dry run changes nothing');
  assert.deepEqual(dry.map((r) => [r.ticket, r.from, r.to, r.item?.to ?? null]), [
    ['LOCAL-33', ['guestbook'], [PROJECT], 'put_back'],
    ['LOCAL-34', ['guestbook'], [PROJECT], 'put_back'],
    ['LOCAL-35', ['guestbook'], [PROJECT], 'put_back'],
    ['LOCAL-36', ['guestbook'], [PROJECT], null],
    ['LOCAL-37', ['guestbook'], [PROJECT], null],
  ]);

  assert.deepEqual(repairTicketServices(t.store.db, { ...input, apply: true }), dry);
  for (const id of ['LOCAL-33', 'LOCAL-34', 'LOCAL-35', 'LOCAL-36', 'LOCAL-37'])
    assert.deepEqual((await t.tickets.get(id))?.services?.map((s) => s.name), [PROJECT], id);
  assert.equal((await t.tickets.comments('LOCAL-34'))[0]?.body, `Cleared: this ticket named guestbook, not a service of workspace ${PROJECT}; it now names ${PROJECT}.`);
  assert.equal((t.store.db.prepare('SELECT COUNT(*) AS n FROM ticket_services').get() as { n: number }).n, 5, 'renamed, none deleted');
  const items = t.planStore.get('plan-1')!.items;
  assert.deepEqual(items.map((i) => [i.state, i.putBacks]), [['put_back', 1], ['put_back', 1], ['put_back', 1], ['waiting', 0], ['waiting', 0]], 'the count of put backs is kept');
  assert.equal((t.store.db.prepare('SELECT COUNT(*) AS n FROM services WHERE workspace = ?').get(PROJECT) as { n: number }).n, 3, 'the services rows are kept');
  assert.deepEqual(repairTicketServices(t.store.db, { ...input, apply: false }), [], 'a second run finds nothing');

  // The service's next start: the runner, on the configured services, starts all five.
  t.registry.ticketStore = t.tickets as never;
  const events: FlowEvent[] = [];
  t.engine.subscribe((event) => { events.push(event); });
  const plans = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead: recordingLead(), project: PROJECT,
    services: [PROJECT], config: { ...DEFAULT_PLAN_CONFIG, maxParallel: 5 }, now: () => new Date(t.clock.now),
  });
  plans.listen();
  await plans.tick();
  await settle(t, plans);
  assert.deepEqual(events.filter((e) => e.type === 'ticket_put_back').map((e) => e.ticket), []);
  assert.deepEqual(events.filter((e) => e.type === 'ticket_started').map((e) => e.ticket).sort(), ['LOCAL-33', 'LOCAL-34', 'LOCAL-35', 'LOCAL-36', 'LOCAL-37']);
  await plans.close();
});

test('the repair leaves alone a ticket whose part ran, whose item has steps on an old service, that names two services, or of a workspace of several, and deletes nothing', async () => {
  const t = await blocked();
  t.store.db.prepare("UPDATE ticket_services SET branch = 'cleared/LOCAL-33' WHERE ticket = 'LOCAL-33'").run();
  t.store.db.prepare("INSERT INTO ticket_services (ticket, service, branch, pr, state) VALUES ('LOCAL-34', 'filter-api', NULL, NULL, 'todo')").run();
  t.store.db.prepare("INSERT INTO plan_steps (plan_id, item, position, kind, service, after, estimate) VALUES ('plan-1', 3, 1, 'service', 'guestbook', '[]', '{}')").run();
  const left = (await Promise.all(['LOCAL-33', 'LOCAL-34', 'LOCAL-35'].map((id) => t.tickets.get(id)))).map((ticket) => ticket?.services);
  const single = repairTicketServices(t.store.db, { workspace: { id: PROJECT, services: [PROJECT] }, todo: DEFAULT_STATES.todo, apply: true, at: '2026-10-23T18:00:00.000Z' });
  assert.deepEqual(single.filter((r) => r.to === null).map((r) => [r.ticket, r.reason]), [
    ['LOCAL-33', 'its part on guestbook has a branch or a pull request: repair it by hand'],
    ['LOCAL-34', 'it names guestbook, filter-api: a rename cannot make that one service, and the repair deletes no part: set it aside, or cancel the item and propose it again'],
    ['LOCAL-35', 'item 3 of plan-1 has steps on guestbook: cancel the item and propose it again'],
  ]);
  assert.deepEqual((await Promise.all(['LOCAL-33', 'LOCAL-34', 'LOCAL-35'].map((id) => t.tickets.get(id)))).map((ticket) => ticket?.services), left, 'left as they were');
  assert.deepEqual(t.planStore.get('plan-1')!.items.slice(0, 3).map((i) => i.state), ['held', 'held', 'put_back']);
  assert.equal((t.store.db.prepare('SELECT COUNT(*) AS n FROM ticket_services').get() as { n: number }).n, 6, 'no part is deleted');

  // A workspace of several: a ticket naming an old service is left to a person, applied or not.
  const t2 = await blocked();
  const before = dump(t2.store.db);
  const several = repairTicketServices(t2.store.db, { workspace: { id: PROJECT, services: ['guestbook-v2', 'filter-api'] }, todo: DEFAULT_STATES.todo, apply: true, at: '2026-10-23T18:00:00.000Z' });
  assert.deepEqual(several.map((r) => [r.ticket, r.to]), [['LOCAL-33', null], ['LOCAL-34', null], ['LOCAL-35', null], ['LOCAL-36', null], ['LOCAL-37', null]]);
  assert.equal(several[0]?.reason, `${PROJECT} has several services (guestbook-v2, filter-api): name the ticket's by hand`);
  assert.deepEqual(dump(t2.store.db), before);
});
