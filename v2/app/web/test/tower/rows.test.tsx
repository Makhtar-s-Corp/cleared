// The tower as rows (docs/v2/ui-overhaul-plan.md, 2.2.4 and 2.2.7, lane 35):
// what needs the person and the live sessions are rows J and K walk, each
// with a kind, a title and one line; amber says it waits once, on the kind;
// what waits for the person comes first; an empty part says so in one
// sentence with the one thing to do; a recipe is its service's and its name's.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Recipe } from '../../../../src/api/types.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { FIXTURE_NOW, RECIPES, towerFixture } from '../../../fixtures/tower.ts';
import { translator } from '../../lib/i18n.ts';
import { liveOrder, recipeKey, towerModel, type NeedCard } from '../../screens/tower/model.ts';
import { RecipeForm } from '../../screens/tower/Tower.tsx';
import { html, renderTowerBody, visibleText } from '../render.tsx';

const en = translator(loadCatalog('tower', 'en'));

test('what needs the person and the live sessions are rows, each a link J and K walk', async () => {
  const markup = renderTowerBody(towerModel(await towerFixture(FIXTURE_NOW), FIXTURE_NOW), en);
  const rows = markup.match(/<a class="(?:need|open) row" [^>]*data-row="true"/g) ?? [];
  assert.equal(rows.length, 3 + 4, 'three waiting items and four live sessions');
  assert.match(markup, /<ul class="rows needs">/);
  assert.match(markup, /<ul class="rows sessions">/);
  // The proof scripts find a live session by its ticket and click its link.
  assert.match(markup, /<li class="session-card" data-phase="waiting_human"><a class="open row" href="\/sessions\/[^"]+" data-row="true">[^]*?<span class="id">LOCAL-161<\/span>/);
});

test('one amber signal per waiting row: its kind, no ring, no stripe, no dot', async () => {
  const markup = renderTowerBody(towerModel(await towerFixture(FIXTURE_NOW), FIXTURE_NOW), en);
  const needs = markup.slice(markup.indexOf('<ul class="rows needs">'), markup.indexOf('</ul>', markup.indexOf('<ul class="rows needs">')));
  assert.equal(needs.match(/class="row-kind wait-line"/g)?.length, 3);
  assert.doesNotMatch(needs, /dot awaiting|live waiting|need-head/);
});

test('what waits for the person first, then what works, then what reviews', async () => {
  const model = towerModel(await towerFixture(FIXTURE_NOW), FIXTURE_NOW);
  const order = liveOrder([...model.live].reverse()).map((card) => card.phase);
  assert.deepEqual(order, ['waiting_human', 'working', 'working', 'reviewing']);
});

test('an empty part says so in one sentence, with one action where there is one thing to do', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const markup = renderTowerBody(towerModel({ ...data, inbox: [], sessions: [], plans: [], tickets: [] }, FIXTURE_NOW), en);
  assert.match(markup, /<p class="quiet-line" id="needs-empty">Nothing waits for you\.<\/p>/);
  assert.match(markup, /<div class="empty-state" id="live-empty"><svg[^]*?<\/svg><p class="empty-text">No session is running\.<\/p><button type="button" class="chip-button">New ticket<\/button><\/div>/);
  assert.match(markup, /<div class="empty-state" id="plans-empty"><svg[^]*?<\/svg><p class="empty-text">No plan in progress\.<\/p><button type="button" class="chip-button">New goal<\/button><\/div>/);
  assert.ok(visibleText(markup).includes('Nothing landed yet today.'));
  for (const language of ['en', 'fr'] as const) {
    const catalog = loadCatalog('tower', language);
    for (const key of ['needs_empty', 'live_empty', 'plans_empty']) assert.equal(catalog[key]!.split(/[.?]\s/).length, 1, `${language} ${key}: one sentence`);
  }
});

test('every kind a waiting row can have is named in both languages', () => {
  const kinds: readonly NeedCard['kind'][] = ['release', 'permission', 'question', 'plan', 'session_plan', 'contract', 'knowledge'];
  for (const language of ['en', 'fr'] as const) {
    const catalog = loadCatalog('tower', language);
    for (const kind of kinds) assert.ok(catalog[`kind_${kind}`], `${language}: kind_${kind}`);
  }
});

test('two services\' recipes of one name: picking one presses that one only and shows its parameters (issue 227, item 1)', () => {
  const [update] = RECIPES as [Recipe, Recipe];
  const twin: Recipe = { ...update, service: 'filter-api', parameters: [{ name: 'module', description: 'The module to update', required: true }] };
  const markup = html(<RecipeForm t={en} recipes={[update, twin]} picked={recipeKey(twin)} values={{}} note="" />);
  assert.equal(markup.match(/aria-pressed="true"/g)?.length, 1);
  assert.match(markup, /aria-pressed="true"[^>]*data-recipe="dependency-update" data-service="filter-api"/);
  assert.match(markup, /id="recipe-param-module"/);
  assert.doesNotMatch(markup, /id="recipe-param-package"/);
});
