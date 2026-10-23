// The plans in the lead module (docs/v2/milestone-2-plan.md, lane 7): their
// tables and routes are the module's, and the lead's rules say how plans work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSUMPTION_ROUTES, MILESTONE_2_ROUTES, RECIPE_ROUTES } from '../../../src/api/types.ts';
import { LEAD_RULES } from '../../../src/lead/prompts.ts';
import { PLAN_TABLES } from '../../../src/lead/plans/store.ts';
import lead from '../../../src/modules/lead.ts';

test('the lead module declares the plans\' tables, the eleven routes of section 7.1, and the recipes\' and the schedules\' (lane 26)', () => {
  for (const table of PLAN_TABLES) assert.ok(lead.tables.includes(table));
  assert.deepEqual(PLAN_TABLES.map((sql) => /CREATE (?:TABLE|INDEX) IF NOT EXISTS (\w+)/.exec(sql)?.[1]), ['plans', 'plan_items', 'plan_items_ticket', 'plan_steps']);
  assert.deepEqual(lead.routes.map((r) => `${r.method} ${r.path}`).sort(), [...MILESTONE_2_ROUTES, ...RECIPE_ROUTES, ...CONSUMPTION_ROUTES].sort());
});

test('the lead\'s rules carry the plan paragraph of section 4.4', () => {
  for (const phrase of [/propose_plan/, /goal id/, /start_ticket/, /1 to 12 items/, /nothing is stacked/, /At night nothing goes live/, /fast for a small change/, /do not give your own/, /same goal/])
    assert.match(LEAD_RULES, phrase);
  assert.ok(Buffer.byteLength(LEAD_RULES) < 5 * 1024);
  assert.doesNotMatch(LEAD_RULES, /\u2014/);
});
