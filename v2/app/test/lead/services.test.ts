// The plan panel's services and their sensitivity (decisions 18 and 24,
// lane 22): which chips an item shows, what each says, and that their keys
// are the lead's catalog's without being the panel's shared list, which the
// inbox's catalog (lane 21's) must hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Plan, PlanItem } from '../../../src/api/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { servicePlan } from '../../fixtures/lead.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { translator } from '../../web/lib/i18n.ts';
import { chipText, ITEM_KEYS, PLAN_PANEL_KEYS, PLAN_SERVICE_KEYS, planStateLine, serviceChips, itemStateText } from '../../web/plan-panel/model.ts';

const t = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('lead', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('lead', 'fr') });
const plan = servicePlan(FIXTURE_NOW);
const only = (sensitivity: PlanItem['sensitivity'], items: readonly PlanItem[] = plan.items): Plan => ({ ...plan, items: items.map((item) => ({ ...item, ...(sensitivity ? { sensitivity } : {}) })) });

test('an item of a plan across two services names each service, its sensitivity when it is not normal', () => {
  const chips = plan.items.map((item) => serviceChips(item, plan).map((chip) => chipText(chip, t)));
  assert.deepEqual(chips, [
    ['filter-api · full review'],
    ['guestbook', 'filter-api · full review'],
    ['guestbook'],
    ['guestbook', 'filter-api · full review'],
  ]);
});

test('a plan on one service of normal sensitivity shows no chip: a one-service workspace reads as before', () => {
  const one = only([{ service: 'guestbook', sensitivity: 'normal' }]);
  assert.deepEqual(one.items.map((item) => serviceChips(item, one)), one.items.map(() => []));
  const none: Plan = { ...plan, items: plan.items.map(({ sensitivity: _, ...item }) => item) };
  assert.deepEqual(none.items.map((item) => serviceChips(item, none)), none.items.map(() => []));
});

test('a sensitive service is named even when the plan names only it', () => {
  for (const [sensitivity, en, french] of [
    ['full', 'guestbook · full review', 'guestbook · revue complète'],
    ['reviewer:claude-opus-5-5', 'guestbook · reviewed by Opus', 'guestbook · revu par Opus'],
    ['human:ops', 'guestbook · approved by ops', 'guestbook · approuvé par ops'],
  ] as const) {
    const one = only([{ service: 'guestbook', sensitivity }]);
    const [chip] = serviceChips(one.items[0] as PlanItem, one);
    assert.ok(chip, sensitivity);
    assert.equal(chipText(chip, t), en);
    assert.equal(chipText(chip, fr), french);
  }
});

test('a sensitivity this screen does not know is shown as it is written, never an unknown key', () => {
  const odd = only([{ service: 'guestbook', sensitivity: 'audit:weekly' as never }]);
  const [chip] = serviceChips(odd.items[0] as PlanItem, odd);
  assert.ok(chip);
  assert.equal(chipText(chip, t), 'guestbook · audit:weekly');
});

test('a plan or an item state the panel does not know reads as written instead of blanking the panel (issue 177, item 2)', () => {
  const odd = { ...plan, state: 'archived' } as unknown as Plan;
  assert.equal(planStateLine(odd, t), 'archived');
  assert.equal(itemStateText('parked' as PlanItem['state'], t), 'parked');
  assert.equal(itemStateText('landed', t), t(ITEM_KEYS.landed));
});

test('the chips\' keys are the lead\'s catalog\'s, in English and French, and are not the shared list the inbox must hold', () => {
  for (const language of ['en', 'fr'] as const) {
    const catalog = loadCatalog('lead', language);
    for (const key of PLAN_SERVICE_KEYS) assert.ok(Object.hasOwn(catalog, key), `lead.${language}.json lacks ${key}`);
  }
  for (const key of PLAN_SERVICE_KEYS) {
    assert.ok(!(PLAN_PANEL_KEYS as readonly string[]).includes(key), key);
    assert.doesNotMatch(key, /^plan_/, `${key} would join the shared list's check`);
  }
  const code = readFileSync(new URL('../../web/plan-panel/model.ts', import.meta.url), 'utf8');
  for (const key of PLAN_SERVICE_KEYS) assert.ok(code.includes(`'${key}'`), `${key} is listed but never used`);
});
