// A plan item's steps across services in the plan panel (decision 26: "the
// plan shows the steps' order and dependencies", lane 27): each step's kind,
// service, what it waits for and its estimate, in order; nothing for an item
// of one step or none. The panel's keys are in both catalogs that draw it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stepsPlan } from '../../fixtures/lead.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { PLAN_PANEL_KEYS, planSteps, stepText } from '../../web/plan-panel/model.ts';

const en = translator(loadCatalog('lead', 'en'));
const fr = translator(loadCatalog('lead', 'fr'));

test('an item\'s steps in order, each with its kind, its service, what it waits for and its estimate', () => {
  const plan = stepsPlan(FIXTURE_NOW);
  const item = plan.items.find((i) => i.position === 2)!;
  const steps = planSteps({ ...item, steps: [...(item.steps ?? [])].reverse() });
  assert.deepEqual(steps.map((s) => s.position), [1, 2, 3, 4]);
  assert.deepEqual(steps.map((s) => stepText(s, en, 'en')), [
    'Contract · filter-api · 10 min · $0.15',
    'Service · filter-api · after 1 · 15 min · $0.25',
    'Service · guestbook · after 1 · 20 min · $0.30',
    'Integration · guestbook · after 2 and 3 · 10 min · $0.20',
  ]);
  assert.equal(stepText(steps[3]!, fr, 'fr'), 'Intégration · guestbook · après 2 et 3 · 10 min · 0,20 $');
  // The other items have no steps, or one.
  for (const other of plan.items.filter((i) => i.position !== 2)) assert.deepEqual(planSteps(other), []);
  assert.deepEqual(planSteps({ ...item, steps: item.steps!.slice(0, 1) }), []);
});

test('the panel\'s keys, the steps\' among them, are in the lead\'s catalog and the inbox\'s, in both languages', () => {
  for (const key of ['plan_steps_label', 'plan_step_contract', 'plan_step_service', 'plan_step_integration', 'plan_step_after']) assert.ok((PLAN_PANEL_KEYS as readonly string[]).includes(key), key);
  for (const screen of ['lead', 'inbox'] as const) for (const language of ['en', 'fr'] as const) {
    const catalog = loadCatalog(screen, language);
    for (const key of PLAN_PANEL_KEYS) assert.ok(Object.hasOwn(catalog, key), `${screen}.${language}: ${key}`);
  }
});
