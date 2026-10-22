// Running a recipe (docs/v2/milestone-2-plan.md, decision 29): a ticket
// recipe becomes a one-item plan, approved by the person who runs it, whose
// ticket the plan runner creates and starts over the real flow engine on
// the fake adapter; a goal recipe becomes an owner turn to the lead.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Origin } from '../../src/flow/events.ts';
import { DEFAULT_PLAN_CONFIG, PlanRunner, type PlanFlow } from '../../src/lead/plans/runner.ts';
import { PLAN_TABLES } from '../../src/lead/plans/store.ts';
import { RecipeError, parseRecipe, type RecipeFile } from '../../src/recipes/recipe.ts';
import { Recipes } from '../../src/recipes/service.ts';
import { applyTables } from '../../src/store/db.ts';
import { WORKSPACE_TABLES, recordWorkspace } from '../../src/tickets/local-store.ts';
import type { ServiceConfig } from '../../src/workspace/config.ts';
import { quickAuthor, setup } from '../flow/support.ts';
import { recordingLead } from '../lead/plans/support.ts';

const svc = (name: string, extra: Partial<ServiceConfig> = {}): ServiceConfig => ({
  name, kind: 'repository', repo: `example-org/${name}`, url: `https://example.invalid/${name}.git`, base: 'main', path: null, dir: `/srv/${name}`,
  healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, ...extra,
});

const BUMP = `---
name: bump-dependency
kind: ticket
title: Bump {{package}} to {{version}}
lane: fast
size: xs
parameters: [package, version]
---
Bump {{package}} to {{version}}.

- [ ] npm test passes
`;
const GOAL = `---
name: tidy-docs
kind: goal
parameters: [section]
---
Make the {{section}} section of the README clear.
`;
const HELD = `---
name: held-for-review
kind: ticket
size: m
services: [guestbook, filter-api]
---
An entry the filter-api flags is held for review.

- [ ] a flagged entry is held
`;

type Options = { readonly workspace?: readonly ServiceConfig[]; readonly flow?: (engine: PlanFlow) => PlanFlow };

async function recipes(files: Record<string, string>, options: Options = {}) {
  const t = await setup({ scripts: { author: quickAuthor } });
  applyTables(t.store.db, [...PLAN_TABLES, ...WORKSPACE_TABLES]);
  const workspace = options.workspace ?? [svc('guestbook')];
  recordWorkspace(t.store.db, { id: 'guestbook', name: 'Guestbook', file: null, services: workspace }, '2026-10-22T08:00:00.000Z');
  const posts: { text: string; user: string; goal: boolean }[] = [];
  const lead = Object.assign(recordingLead(), {
    async post(text: string, user: string, goal = false) { posts.push({ text, user, goal }); return { seq: 41 + posts.length }; },
  });
  const plans = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: options.flow ? options.flow(t.engine) : t.engine, lead, project: 'guestbook',
    config: DEFAULT_PLAN_CONFIG, now: () => new Date(t.clock.now),
  });
  const parsed: RecipeFile[] = Object.entries(files).map(([name, text]) => parseRecipe(text, { file: `.cleared/recipes/${name}.md`, service: 'guestbook', services: workspace.map((s) => s.name) }));
  const refreshed: string[] = [];
  const service = new Recipes({
    source: { list: async () => ({ recipes: parsed, problems: [] }), refresh: async (name) => { refreshed.push(name); } },
    plans, lead, inbox: t.inbox, workspace, clean: (text) => text.replace(/sk-ant-\w+/g, '[secret]'), now: () => new Date(t.clock.now),
  });
  return { ...t, lead, plans, posts, refreshed, recipes: service };
}

test('a ticket recipe with two parameters runs as a one-item plan, approved by who ran it, with the substituted body and the labels', async () => {
  const t = await recipes({ 'bump-dependency': BUMP });
  const run = await t.recipes.run('bump-dependency', { package: 'pg', version: '8.13.1' }, 'u1');
  assert.equal(run.accepted, true);
  assert.ok(run.plan);
  const plan = t.plans.get(run.plan)!;
  assert.equal(plan.state, 'approved');
  assert.equal(plan.approvedBy, 'u1');
  assert.equal(plan.items.length, 1);
  assert.deepEqual(t.refreshed, ['guestbook'], 'the recipe\'s service is fetched before the run');
  const ticketId = plan.items[0]!.ticket!;
  const ticket = await t.tickets.get(ticketId);
  assert.equal(ticket?.title, 'Bump pg to 8.13.1');
  assert.equal(ticket?.body, 'Bump pg to 8.13.1.\n\n- [ ] npm test passes', 'trimmed, as every plan item\'s body');
  assert.deepEqual([...(ticket?.labels ?? [])].sort(), [`plan:${run.plan}`, 'Quick', 'size:xs'].sort());
  assert.equal((await t.tickets.history(ticketId))[0]?.by.id, 'u1', 'the ticket is created by the approver');
  await t.plans.settled();
  assert.equal(t.startedSessions[0]?.input.role, 'author', 'the ticket\'s author started');
  // The plan's own inbox item never waits: running the recipe is its approval.
  assert.equal(t.inbox.items().filter((item) => item.kind === 'plan' && item.state === 'waiting').length, 0);
  // The lead is told once, by one service line naming the recipe.
  assert.equal(t.lead.lines.length, 1);
  assert.match(t.lead.lines[0]!, /bump-dependency/);
  assert.match(t.lead.lines[0]!, new RegExp(run.plan));
  assert.deepEqual(t.lead.events, []);
  await t.plans.settled();
  await t.engine.settled();
});

test('a missing parameter is refused before anything is written', async () => {
  const t = await recipes({ 'bump-dependency': BUMP });
  await assert.rejects(t.recipes.run('bump-dependency', { package: 'pg' }, 'u1'), (error: unknown) => error instanceof RecipeError && error.kind === 'invalid' && /version/.test(error.message));
  assert.equal(t.plans.list().length, 0);
  assert.equal(t.lead.lines.length, 0);
  await assert.rejects(t.recipes.run('nothing', {}, 'u1'), (error: unknown) => error instanceof RecipeError && error.kind === 'not_found');
});

test('a goal recipe sends an owner turn to the lead, as a goal, by who ran it', async () => {
  const t = await recipes({ 'tidy-docs': GOAL });
  const run = await t.recipes.run('tidy-docs', { section: 'Install' }, 'u1');
  assert.deepEqual(run, { accepted: true, message: 42, goal: 'goal-42' });
  assert.deepEqual(t.posts, [{ text: 'Make the Install section of the README clear.\n', user: 'u1', goal: true }]);
  assert.equal(t.plans.list().length, 0);
});

test('a value goes through the cleaner before it becomes a ticket', async () => {
  const t = await recipes({ 'bump-dependency': BUMP });
  const run = await t.recipes.run('bump-dependency', { package: 'sk-ant-abcdef', version: '1' }, 'u1');
  const ticket = await t.tickets.get(t.plans.get(run.plan!)!.items[0]!.ticket!);
  assert.doesNotMatch(`${ticket?.title} ${ticket?.body}`, /sk-ant/);
  await t.plans.settled();
  await t.engine.settled();
});

test('a recipe naming two services runs in steps: the contract, a step per service, the integration', async () => {
  const workspace = [svc('guestbook', { consumes: ['filter-api'] }), svc('filter-api', { contract: { format: 'openapi', path: 'contract/openapi.yaml' } })];
  const starts: Origin[] = [];
  const t = await recipes({ 'held-for-review': HELD }, {
    workspace,
    flow: (engine) => ({ start: async (_ticket, _by, origin) => { if (origin) starts.push(origin); }, isActive: (id) => engine.isActive(id), subscribe: (listener) => engine.subscribe(listener) }),
  });
  const run = await t.recipes.run('held-for-review', {}, 'u1');
  const item = t.plans.get(run.plan!)!.items[0]!;
  assert.deepEqual(item.steps?.map((s) => `${s.kind}:${s.service}:${s.after.join(',')}`),
    ['contract:filter-api:', 'service:filter-api:1', 'service:guestbook:1', 'integration:guestbook:2,3']);
  assert.deepEqual((await t.tickets.get(item.ticket!))?.services?.map((s) => s.name), ['filter-api', 'guestbook']);
  assert.equal(starts[0]?.steps?.length, 4);
});

test('a fast recipe on a full service runs in the full lane, with its note, and no Quick label', async () => {
  const t = await recipes({ 'bump-dependency': BUMP }, { workspace: [svc('guestbook', { sensitivity: 'full' })] });
  const run = await t.recipes.run('bump-dependency', { package: 'pg', version: '1' }, 'u1');
  const item = t.plans.get(run.plan!)!.items[0]!;
  assert.equal(item.lane, 'full');
  const ticket = await t.tickets.get(item.ticket!);
  assert.ok(!ticket?.labels.includes('Quick'));
  assert.match(ticket?.body ?? '', /full sensitivity/);
  await t.plans.settled();
  await t.engine.settled();
});

test('the list shows each recipe as the API gives it', async () => {
  const t = await recipes({ 'bump-dependency': BUMP, 'tidy-docs': GOAL });
  const list = await t.recipes.list();
  assert.deepEqual(list.map((r) => `${r.service}:${r.name}:${r.kind}`), ['guestbook:bump-dependency:ticket', 'guestbook:tidy-docs:goal']);
  assert.equal('title' in (list[0] as object), false);
});
