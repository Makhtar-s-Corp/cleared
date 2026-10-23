// The tower's part of decisions 26 to 29 as HTML (lane 27): a live session's
// step, the contract and knowledge cards in Needs you, the schedules in the
// plans card, "Ask about the code" and "Run a recipe" in the bar, and the
// recipe's form; a tower with none of them draws as before.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { Recipe } from '../../../src/api/types.ts';
import { contractItem, knowledgeItem } from '../../fixtures/inbox.ts';
import { FIXTURE_NOW, OWNER_ID, RECIPES, schedulesFixture, ticketSteps, towerFixture, workspaceFixture } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../lib/i18n.ts';
import { Bar, RecipeForm } from '../screens/tower/Tower.tsx';
import { recipeKey, towerModel } from '../screens/tower/model.ts';
import { html, renderTowerBody, visibleText } from './render.tsx';

const en = translator(loadCatalog('tower', 'en'));
const fr = translator(loadCatalog('tower', 'fr'));
const [update] = RECIPES as [Recipe, Recipe];

test('a live session of a ticket in steps names its step and service', async () => {
  const fixture = await workspaceFixture(FIXTURE_NOW, { owner: OWNER_ID });
  const markup = renderTowerBody(towerModel({ ...fixture, steps: { 'LOCAL-163': ticketSteps(fixture.sessions) } }, FIXTURE_NOW, OWNER_ID), en);
  assert.match(markup, /<span class="svc-tag" data-step="2">step 2 of 4, filter-api<\/span>/);
  assert.equal(markup.match(/<span class="svc-tag"/g)?.length, 5, 'the others name their service as before');
  assert.doesNotMatch(markup, /\sstyle=/);
});

test('a contract and a knowledge item in Needs you, each linked to its inbox item', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const markup = renderTowerBody(towerModel({ ...base, inbox: [...base.inbox, contractItem(FIXTURE_NOW), knowledgeItem(FIXTURE_NOW)] }, FIXTURE_NOW), en);
  assert.match(markup, new RegExp(`<a class="need row" href="/inbox#${encodeURIComponent(contractItem(FIXTURE_NOW).id)}" data-row="true" data-kind="contract">`));
  assert.match(markup, /<span class="row-kind wait-line">Contract<\/span>[^]*?<span class="age">40 min<\/span>/);
  assert.match(markup, /Contract of filter-api/);
  assert.match(markup, /<span class="row-kind wait-line">Knowledge<\/span>[^]*?<span class="age">50 min<\/span>/);
  assert.ok(visibleText(markup).includes(knowledgeItem(FIXTURE_NOW).text));
});

test('the schedules sit in the plans card with their next run; none, and the card is as before', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const markup = renderTowerBody(towerModel({ ...base, schedules: schedulesFixture(FIXTURE_NOW) }, FIXTURE_NOW), en);
  assert.match(markup, /<h3 class="sub-title" id="schedules-title">Schedules<\/h3>/);
  assert.match(markup, /<li class="schedule" data-schedule="schedule-1"><span class="schedule-name">dependency-update<\/span><span class="schedule-line">Next run tomorrow at 03:00 · \$0\.50<\/span><\/li>/);
  assert.match(markup, /<li class="schedule off" data-schedule="schedule-3">/);
  const before = renderTowerBody(towerModel(base, FIXTURE_NOW), en);
  assert.doesNotMatch(before, /schedule/);
  assert.equal(renderTowerBody(towerModel({ ...base, schedules: [] }, FIXTURE_NOW), en), before);
});

test('the bar: "Ask about the code" always, "Run a recipe" once a recipe exists', () => {
  const plain = html(<Bar t={en} title="" body="" />);
  assert.match(plain, /<button[^>]*data-bar="ask"[^>]*>Ask about the code<\/button>/);
  assert.doesNotMatch(plain, /data-bar="recipe"/);
  const recipes = html(<Bar t={en} title="" body="" recipes={RECIPES} />);
  assert.match(recipes, /<button[^>]*data-bar="recipe"[^>]*aria-expanded="false"[^>]*>Run a recipe<\/button>/);
  assert.match(html(<Bar t={en} title="" body="" recipes={RECIPES} recipeOpen />), /data-bar="recipe"[^>]*aria-expanded="true"/);
  assert.match(html(<Bar t={fr} title="" body="" recipes={RECIPES} />), /Interroger le code[^]*Lancer une recette/);
});

test('the recipe form: a choice per recipe, the picked one\'s parameters, the required ones marked', () => {
  const markup = html(<RecipeForm t={en} recipes={RECIPES} picked={recipeKey(update)} values={{ version: '2' }} note="" />);
  assert.match(markup, /<form class="recipe-form" id="recipe-form"/);
  assert.match(markup, /<button[^>]*aria-pressed="true"[^>]*data-recipe="dependency-update"[^>]*>/);
  assert.match(markup, /<button[^>]*aria-pressed="false"[^>]*data-recipe="weekly-review"[^>]*>/);
  assert.match(markup, /<input[^>]*id="recipe-param-package"[^>]*required=""[^>]*data-param="package"/);
  assert.match(markup, /<input[^>]*id="recipe-param-version"[^>]*data-param="version"[^>]*value="2"/);
  assert.match(markup, /The package to update/);
  assert.match(markup, /required/);
  assert.match(markup, /<button[^>]*type="submit"[^>]*data-act="recipe_run"[^>]*>Run<\/button>/);
  assert.match(markup, /A ticket, as a one-ticket plan/);
  // Run is outlined while a required parameter is missing, in ink once it can run: one ink gesture on screen.
  assert.doesNotMatch(/<button[^>]*data-act="recipe_run"[^>]*>/.exec(markup)?.[0] ?? '', /primary/);
  assert.match(html(<RecipeForm t={en} recipes={RECIPES} picked={recipeKey(update)} values={{ package: 'pg' }} note="" />), /<button[^>]*class="chip-button primary"[^>]*data-act="recipe_run"/);
  const goal = html(<RecipeForm t={en} recipes={RECIPES} picked="guestbook/weekly-review" values={{}} note="" />);
  assert.match(goal, /A goal, sent to the lead/);
  assert.match(goal, /This recipe takes no parameter\./);
  const none = html(<RecipeForm t={en} recipes={RECIPES} picked={null} values={{}} note="" />);
  assert.doesNotMatch(none, /data-param|data-act="recipe_run"/);
  assert.doesNotMatch(markup, /\sstyle=/);
});
