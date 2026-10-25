// The lead module (decision 14): its tables, its routes, and the runtime
// that builds the lead over the flow's engine on the first request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../../src/flow/runtime.ts';
import { createLeadRuntime } from '../../src/lead/engine.ts';
import { LEAD_TABLES } from '../../src/lead/store.ts';
import { PLAN_TABLES } from '../../src/lead/plans/store.ts';
import { LEVERS_TABLE } from '../../src/consumption/levers.ts';
import { QUOTA_TABLES } from '../../src/consumption/quota.ts';
import { MAP_TABLES } from '../../src/map/service.ts';
import { SCHEDULE_TABLES } from '../../src/schedules/store.ts';
import { INBOX_TABLE } from '../../src/inbox/store.ts';
import lead from '../../src/modules/lead.ts';
import { defaultRegistry } from '../../src/modules/registry.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { fakeEffects } from '../flow/support.ts';
import { leadAdapter, opening, until, type Generation } from './support.ts';

test('the lead module declares its tables and the five lead routes; it provides no slot', () => {
  // Lane 7 adds the plans' tables and routes to the module, lane 26 the schedules', the Consumption screen (O15) its levers', the quota reading (issue #270) its own, the service map (M6) its own.
  assert.deepEqual(lead.tables, [...LEAD_TABLES, ...PLAN_TABLES, ...SCHEDULE_TABLES, LEVERS_TABLE, ...QUOTA_TABLES, ...MAP_TABLES]);
  assert.deepEqual(LEAD_TABLES.map((sql) => /CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/.exec(sql)?.[1]).filter((name) => name?.startsWith('lead_')),
    ['lead_generations', 'lead_messages', 'lead_commitments', 'lead_handovers', 'lead_queue']);
  assert.deepEqual(lead.routes.map((r) => `${r.method} ${r.path}`).filter((r) => r.includes('/api/lead')).sort(),
    ['GET /api/lead', 'GET /api/lead/memory', 'GET /api/lead/messages', 'GET /api/lead/stream', 'POST /api/lead/messages']);
  assert.deepEqual(lead.provide({ store: undefined as never }), {});
});

test('the runtime builds the flow\'s engine first, then one lead over it, which starts its first generation', async () => {
  const env = {
    CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://example.invalid/guestbook.git',
    CLEARED_V2_REPO: 'example-org/cleared-example-guestbook', CLEARED_V2_STATE_DIR: '/state', CLEARED_V2_LEAD_MODEL: 'claude-haiku-5-5',
  };
  const store = openStore(':memory:');
  applyTables(store.db, [INBOX_TABLE, ...LEAD_TABLES]);
  const flow = createRuntime({ env, effects: () => fakeEffects([]) });
  flow.attach({ store });
  const generations: Generation[] = [];
  const briefings: string[] = [];
  const runtime = createLeadRuntime({
    env, flow,
    effects: () => ({
      prepareWorkdir: async () => '/state/work/lead',
      writeBriefing: async (_workdir, text) => { briefings.push(text); },
      memory: async () => [],
      searchMemory: async () => [],
    }),
  });
  runtime.attach({ store });
  const registry = { ...defaultRegistry(), sessionAdapters: { 'claude-code': leadAdapter(store.events, [opening()], generations) } };
  const engine = runtime.lead(registry);
  assert.ok(engine);
  assert.equal(runtime.lead(registry), engine, 'one lead per process');
  await until(() => engine.state().phase === 'idle', 'the first generation');
  assert.equal(generations[0]?.input.model, 'claude-haiku-5-5');
  assert.equal(generations[0]?.input.workdir, '/state/work/lead');
  assert.equal(briefings.length, 1);
  await engine.close();
  await flow.engine(registry)?.close();

  const off = createLeadRuntime({ env: { ...env, CLEARED_V2_LEAD_ENABLED: 'off' }, flow });
  off.attach({ store });
  assert.equal(off.lead(registry), undefined);
  const bare = createLeadRuntime({ env: {}, flow: createRuntime({ env: {} }) });
  bare.attach({ store });
  assert.equal(bare.lead(registry), undefined);
});
