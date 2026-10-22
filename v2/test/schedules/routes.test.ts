// The routes of the recipes and the schedules (docs/v2/milestone-2-plan.md,
// decision 29), registered by the lead module with the plan runner: GET
// /api/recipes, POST /api/recipes/:name/run, GET and POST /api/schedules,
// DELETE /api/schedules/:id. Guarded as the lead's are: the app's proof,
// then the plans running, then for a write a user the service knows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RECIPE_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type Recipe, type Schedule } from '../../src/api/types.ts';
import { HostToolRefused } from '../../src/session/contract.ts';
import lead from '../../src/modules/lead.ts';
import { MemoryUsers, defaultRegistry, dispatch, type Registry } from '../../src/modules/registry.ts';
import { RecipeError } from '../../src/recipes/recipe.ts';
import { recipeRoutes } from '../../src/recipes/routes.ts';
import { scheduleRoutes } from '../../src/schedules/routes.ts';
import { SCHEDULE_TABLES } from '../../src/schedules/store.ts';
import { ScheduleError } from '../../src/schedules/when.ts';
import { handle as health } from '../../src/server.ts';

const PROOF = 'proof-of-the-app';
const RECIPE: Recipe = { name: 'bump', service: 'guestbook', kind: 'ticket', parameters: [{ name: 'package', required: true }], lane: 'fast', size: 'xs', services: ['guestbook'], body: 'Bump {{package}}.\n\n- [ ] x' };
const SCHEDULE: Schedule = { id: 'sch-1', recipe: 'bump', goal: null, parameters: { package: 'pg' }, at: null, every: 'day 03:00', budgetUsd: 2, weekCapPercent: 50,
  createdBy: 'u1', enabled: true, nextRunAt: '2026-10-23T03:00:00.000Z', lastRunAt: null, createdAt: '2026-10-22T10:00:00.000Z' };

async function serve(options: { running?: boolean } = {}) {
  const runs: [string, Record<string, string>, string][] = [];
  const created: [unknown, string][] = [];
  const recipes = {
    list: async () => [RECIPE],
    run: async (name: string, parameters: Record<string, string>, by: string) => {
      if (name === 'gone') throw new RecipeError('not_found', 'no recipe gone');
      if (name === 'refused') throw new HostToolRefused('Item 1\'s body needs at least one "- [ ]" acceptance criterion.');
      if (!parameters.package) throw new RecipeError('invalid', 'the recipe bump needs the parameter package');
      runs.push([name, parameters, by]);
      return { accepted: true as const, plan: 'plan-1' };
    },
  };
  const schedules = {
    list: () => [SCHEDULE],
    create: async (body: unknown, by: string) => {
      if ((body as { budgetUsd?: unknown }).budgetUsd === 0) throw new ScheduleError('the budget is an amount in dollars above 0 and at most 1000');
      created.push([body, by]);
      return SCHEDULE;
    },
    remove: (id: string) => id === 'sch-1',
  };
  const users = new MemoryUsers();
  users.users.set('u1', { id: 'u1', name: 'owner' });
  const registry: Registry = { ...defaultRegistry(), users };
  const running = options.running !== false;
  const routes = [
    ...recipeRoutes({ recipes: () => (running ? recipes : undefined), proof: () => PROOF }),
    ...scheduleRoutes({ schedules: () => (running ? schedules : undefined), proof: () => PROOF }),
  ];
  const server: Server = createServer((request, response) => dispatch({ registry, tables: [], routes }, request, response, health));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, options: { user?: string | null; proof?: string | null; body?: unknown } = {}) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const proof = options.proof === undefined ? PROOF : options.proof;
    const user = options.user === undefined ? 'u1' : options.user;
    if (proof !== null) headers[SERVICE_PROOF_HEADER] = proof;
    if (user !== null) headers[SERVICE_USER_HEADER] = user;
    const response = await fetch(`${base}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    return { status: response.status, body: await response.json() as unknown };
  };
  return { call, runs, created };
}

test('every route answers 401 without the app\'s proof, and 503 while the plans do not run', async () => {
  const t = await serve();
  const down = await serve({ running: false });
  for (const [method, path] of [['GET', '/api/recipes'], ['POST', '/api/recipes/bump/run'], ['GET', '/api/schedules'], ['POST', '/api/schedules'], ['DELETE', '/api/schedules/sch-1']] as const) {
    assert.equal((await t.call(method, path, { proof: 'wrong', body: method === 'POST' ? {} : undefined })).status, 401, `${method} ${path}`);
    assert.equal((await down.call(method, path, { body: method === 'POST' ? {} : undefined })).status, 503, `${method} ${path}`);
  }
});

test('the recipes are listed; a run needs a known user and its parameters, and answers the plan', async () => {
  const t = await serve();
  assert.deepEqual(await t.call('GET', '/api/recipes', { user: null }), { status: 200, body: [RECIPE] });
  assert.equal((await t.call('POST', '/api/recipes/bump/run', { user: 'stranger', body: { parameters: { package: 'pg' } } })).status, 403);
  assert.equal((await t.call('POST', '/api/recipes/bump/run', { user: null, body: { parameters: { package: 'pg' } } })).status, 403);
  assert.equal((await t.call('POST', '/api/recipes/bump/run', { body: { parameters: { package: 7 } } })).status, 400);
  assert.equal((await t.call('POST', '/api/recipes/bump/run', { body: { parameters: ['pg'] } })).status, 400);
  assert.deepEqual(await t.call('POST', '/api/recipes/bump/run', { body: { parameters: {} } }), { status: 400, body: { error: 'the recipe bump needs the parameter package' } });
  assert.equal((await t.call('POST', '/api/recipes/gone/run', { body: { parameters: {} } })).status, 404);
  assert.equal((await t.call('POST', '/api/recipes/refused/run', { body: { parameters: {} } })).status, 400);
  assert.deepEqual(await t.call('POST', '/api/recipes/bump/run', { body: { parameters: { package: 'pg' } } }), { status: 200, body: { accepted: true, plan: 'plan-1' } });
  // No parameters given is none given: the recipe's own check refuses it.
  assert.equal((await t.call('POST', '/api/recipes/bump/run', { body: {} })).status, 400);
  assert.deepEqual(t.runs, [['bump', { package: 'pg' }, 'u1']]);
});

test('the schedules are listed, created by the signed-in user, refused with the reason, and removed', async () => {
  const t = await serve();
  assert.deepEqual(await t.call('GET', '/api/schedules', { user: null }), { status: 200, body: [SCHEDULE] });
  const body = { recipe: 'bump', parameters: { package: 'pg' }, every: 'day 03:00', budgetUsd: 2, weekCapPercent: 50 };
  assert.equal((await t.call('POST', '/api/schedules', { user: 'stranger', body })).status, 403);
  assert.deepEqual(await t.call('POST', '/api/schedules', { body }), { status: 200, body: SCHEDULE });
  assert.deepEqual(t.created, [[body, 'u1']]);
  assert.deepEqual(await t.call('POST', '/api/schedules', { body: { ...body, budgetUsd: 0 } }), { status: 400, body: { error: 'the budget is an amount in dollars above 0 and at most 1000' } });
  assert.equal((await t.call('DELETE', '/api/schedules/sch-1', { user: 'stranger' })).status, 403);
  assert.deepEqual(await t.call('DELETE', '/api/schedules/sch-1'), { status: 200, body: { deleted: true } });
  assert.equal((await t.call('DELETE', '/api/schedules/sch-9')).status, 404);
});

test('the lead module registers the routes and the tables of the recipes and the schedules', () => {
  const declared = lead.routes.map((r) => `${r.method} ${r.path}`);
  for (const route of RECIPE_ROUTES) assert.ok(declared.includes(route), route);
  for (const table of SCHEDULE_TABLES) assert.ok(lead.tables.includes(table));
  assert.deepEqual(SCHEDULE_TABLES.map((sql) => /CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/.exec(sql)?.[1]), ['schedules', 'schedule_runs', 'schedule_runs_plan']);
});
