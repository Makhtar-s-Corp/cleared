// The plan routes (docs/v2/milestone-2-plan.md, section 7.1): the plans,
// one plan, and the owner's four gestures, each guarded as milestone 1's
// routes are: the app's proof, a configured lead, a known user for a write.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MILESTONE_2_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type Plan } from '../../../src/api/types.ts';
import { PLAN_TABLES } from '../../../src/lead/plans/store.ts';
import { DEFAULT_PLAN_CONFIG, PlanRunner } from '../../../src/lead/plans/runner.ts';
import { createPlanRoutes } from '../../../src/lead/plans/routes.ts';
import { dispatch, type App } from '../../../src/modules/registry.ts';
import { handle } from '../../../src/server.ts';
import { applyTables } from '../../../src/store/db.ts';
import { setup, type Setup } from '../../flow/support.ts';
import { recordingLead } from './support.ts';

const PROOF = 'd'.repeat(64);
let t: Setup;
let plans: PlanRunner;
let lead: ReturnType<typeof recordingLead>;
let server: Server;
let base = '';
let configured = true;

const criteria = '\n\nAcceptance criteria\n- [ ] a test';
const proposal = (goal: string) => ({ goal, title: `Plan for ${goal}`, summary: 'Two tickets.', items: [
  { title: 'One', body: `One.${criteria}`, lane: 'full', size: 's', after: [] },
  { title: 'Two', body: `Two.${criteria}`, lane: 'fast', size: 'xs', after: [1] },
] });

before(async () => {
  t = await setup();
  applyTables(t.store.db, PLAN_TABLES);
  lead = recordingLead();
  // Nothing starts in these tests: the routes are what is tested.
  plans = new PlanRunner({ store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead, project: 'guestbook', config: { ...DEFAULT_PLAN_CONFIG, maxParallel: 0 }, now: () => new Date(t.clock.now) });
  const routes = createPlanRoutes({ plans: () => (configured ? plans : undefined), proof: () => PROOF });
  const app: App = { registry: t.engine.registry, tables: [], routes };
  server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const signed = { [SERVICE_PROOF_HEADER]: PROOF };
const person = { ...signed, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' };

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

test('the plan routes are the six of section 7.1', () => {
  const declared = createPlanRoutes({ plans: () => undefined, proof: () => PROOF }).map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(declared, MILESTONE_2_ROUTES.filter((r) => r.includes('/api/plans')).sort());
});

test('every route needs the proof, a configured lead, and a known user for a write', async () => {
  const { plan } = await plans.propose(proposal('goal-guard'));
  for (const [method, path] of [['GET', '/api/plans'], ['GET', `/api/plans/${plan}`], ['POST', `/api/plans/${plan}/approve`], ['POST', `/api/plans/${plan}/pause`]] as const)
    assert.equal((await call(method, path, {})).status, 401, `${method} ${path}`);
  assert.equal((await call('POST', `/api/plans/${plan}/approve`, signed)).status, 403);
  assert.equal((await call('POST', `/api/plans/${plan}/approve`, { ...signed, [SERVICE_USER_HEADER]: 'stranger' })).status, 403);
  configured = false;
  try {
    assert.equal((await call('GET', '/api/plans', signed)).status, 503);
  } finally {
    configured = true;
  }
  assert.equal(plans.get(plan)?.state, 'proposed', 'nothing was approved');
});

test('the owner reads the plans and approves one: the tickets exist, the inbox item is handled, a second approval is a 409', async () => {
  const { plan } = await plans.propose(proposal('goal-approve'));
  const list = await call('GET', '/api/plans', signed);
  assert.equal(list.status, 200);
  assert.ok((list.json as Plan[]).some((p) => p.id === plan && p.state === 'proposed'));
  const one = await call('GET', `/api/plans/${plan}`, signed);
  assert.equal((one.json as Plan).items.length, 2);
  assert.equal(((one.json as Plan).items[0] as unknown as Record<string, unknown>).putBacks, undefined, 'only the API\'s fields');
  assert.equal((await call('GET', '/api/plans/plan-404', signed)).status, 404);

  const approved = await call('POST', `/api/plans/${plan}/approve`, person);
  assert.equal(approved.status, 200);
  const body = approved.json as Plan;
  assert.equal(body.state, 'approved');
  assert.equal(body.approvedBy, 'u1');
  assert.ok(body.items.every((i) => i.ticket !== null));
  assert.equal(t.inbox.list().find((i) => i.kind === 'plan' && i.planId === plan)?.state, 'handled');
  assert.equal((await call('POST', `/api/plans/${plan}/approve`, person)).status, 409);
  assert.equal((await call('POST', `/api/plans/${plan}/reject`, person, { message: 'no' })).status, 409, 'an approved plan is not rejected');

  assert.equal(((await call('POST', `/api/plans/${plan}/pause`, person)).json as Plan).state, 'paused');
  assert.equal((await call('POST', `/api/plans/${plan}/pause`, person)).status, 409);
  assert.equal(((await call('POST', `/api/plans/${plan}/resume`, person)).json as Plan).state, 'approved');
});

test('the owner rejects a proposed plan with a message for the lead', async () => {
  const { plan } = await plans.propose(proposal('goal-reject'));
  assert.equal((await call('POST', `/api/plans/${plan}/reject`, person, { message: 42 })).status, 400);
  const rejected = await call('POST', `/api/plans/${plan}/reject`, person, { message: 'Too big: one ticket first.' });
  assert.equal(rejected.status, 200);
  assert.equal((rejected.json as Plan).state, 'rejected');
  assert.equal(lead.lines.at(-1), `The owner rejected plan ${plan}: Too big: one ticket first.`);
  assert.equal(t.inbox.list().find((i) => i.kind === 'plan' && i.planId === plan)?.state, 'handled');
  assert.equal((await call('POST', `/api/plans/${plan}/approve`, person)).status, 409);
  assert.equal((await call('POST', `/api/plans/${plan}/resume`, person)).status, 409);
});
