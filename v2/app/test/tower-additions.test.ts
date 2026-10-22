// The tower's part of decisions 26 to 29 (lane 27): a live session's step
// ("step 2 of 4, filter-api"), the contract and knowledge items among what
// needs the owner, the schedules in the plans card with their next run, "Run
// a recipe" with its parameters' form, and "Ask about the code"; a reader's
// session is the ask screen's, not a live session of the tower.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextInboxItem, Recipe, Schedule, SessionSummary, TicketStep } from '../../src/api/types.ts';
import { loadCatalog } from '../src/catalog.ts';
import { contractItem, knowledgeItem } from '../fixtures/inbox.ts';
import { FIXTURE_NOW, OWNER_ID, RECIPES, WORKSPACE, schedulesFixture, ticketSteps, towerFixture, towerSource, workspaceFixture } from '../fixtures/tower.ts';
import { translator } from '../web/lib/i18n.ts';
import { ApiError, type ScreenContext } from '../web/lib/screen.ts';
import {
  loadTower, needSentence, pickedFor, recipeBody, recipeDone, recipeProblem, runRecipe, scheduleLine, stepTag, towerModel, type TowerData,
} from '../web/screens/tower/model.ts';
import { signedIn, startApp } from './support.ts';

const t = translator(loadCatalog('tower', 'en'));
const fr = translator(loadCatalog('tower', 'fr'));
const [update, review] = RECIPES as [Recipe, Recipe];

async function workspaceData(): Promise<TowerData> {
  const fixture = await workspaceFixture(FIXTURE_NOW, { owner: OWNER_ID });
  return { ...fixture, steps: { 'LOCAL-163': ticketSteps(fixture.sessions) } };
}

test('a live session of a ticket in steps says which step and on which service', async () => {
  const model = towerModel(await workspaceData(), FIXTURE_NOW, OWNER_ID);
  const card = model.live.find((c) => c.ticket === 'LOCAL-163');
  assert.deepEqual(card?.step, { position: 2, total: 4, service: 'filter-api' });
  assert.equal(stepTag(card!.step!, t), 'step 2 of 4, filter-api');
  assert.equal(stepTag(card!.step!, fr), 'étape 2 sur 4, filter-api');
  // A ticket of one step, or whose steps were not read, says only its service.
  for (const card of model.live.filter((c) => c.ticket !== 'LOCAL-163')) assert.equal(card.step, null, card.ticket);
  const one = towerModel({ ...await workspaceData(), steps: { 'LOCAL-163': ticketSteps((await workspaceData()).sessions).slice(0, 1) } }, FIXTURE_NOW, OWNER_ID);
  assert.equal(one.live.find((c) => c.ticket === 'LOCAL-163')?.step, null);
});

test('the tower reads the steps once per ticket of its live authors, and only in a workspace of several services', async () => {
  const paths: string[] = [];
  const fixture = await workspaceFixture(FIXTURE_NOW, { owner: OWNER_ID });
  const answers = (workspace: unknown): ScreenContext['api'] => (async (path: string) => {
    paths.push(path);
    if (path === '/sessions') return [...fixture.sessions, { ...fixture.sessions[0]!, id: 'second-161' }];
    if (path === '/inbox') return fixture.inbox;
    if (path === '/tickets') return fixture.tickets;
    if (path === '/workspace') return workspace;
    if (path === '/recipes') return RECIPES;
    if (path === '/schedules') return schedulesFixture(FIXTURE_NOW);
    if (path.startsWith('/tickets/') && path.endsWith('/steps')) return path === '/tickets/LOCAL-163/steps' ? ticketSteps(fixture.sessions) : [];
    throw new ApiError(404, path);
  }) as ScreenContext['api'];
  const loaded = await loadTower(answers(WORKSPACE), { after: 0, line: null });
  const reads = paths.filter((p) => p.endsWith('/steps')).sort();
  assert.deepEqual(reads, ['/tickets/LOCAL-160/steps', '/tickets/LOCAL-161/steps', '/tickets/LOCAL-163/steps', '/tickets/LOCAL-170/steps'], 'the authors\' tickets, each once; not the reviewer\'s');
  assert.equal(towerModel(loaded.data, FIXTURE_NOW, OWNER_ID).live.find((c) => c.ticket === 'LOCAL-163')?.step?.position, 2);
  assert.deepEqual(loaded.data.recipes?.map((r) => r.name), ['dependency-update', 'weekly-review']);
  assert.equal(loaded.data.schedules?.length, 3);
  paths.length = 0;
  await loadTower(answers({ ...WORKSPACE, services: WORKSPACE.services.slice(0, 1) }), { after: 0, line: null });
  assert.deepEqual(paths.filter((p) => p.endsWith('/steps')), [], 'one service: no step to say');
});

test('a service without recipes or schedules still shows the tower, with no recipe to run', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const api = (async (path: string) => {
    if (path === '/sessions') return base.sessions;
    if (path === '/inbox') return base.inbox;
    if (path === '/tickets') return base.tickets;
    throw new ApiError(404, path);
  }) as ScreenContext['api'];
  const { data } = await loadTower(api, { after: 0, line: null });
  const model = towerModel(data, FIXTURE_NOW);
  assert.equal(model.recipes.length, 0);
  assert.deepEqual(model.schedules, []);
});

test('a contract and a knowledge item need the owner, with what each waits for, linked to the inbox', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const inbox: NextInboxItem[] = [...base.inbox, contractItem(FIXTURE_NOW), knowledgeItem(FIXTURE_NOW), { ...knowledgeItem(FIXTURE_NOW), id: 'k-2', level: 'workspace', service: null }];
  const model = towerModel({ ...base, inbox }, FIXTURE_NOW);
  const contract = model.needs.find((card) => card.kind === 'contract');
  assert.ok(contract);
  assert.equal(contract.href, `/inbox#${encodeURIComponent(contractItem(FIXTURE_NOW).id)}`);
  assert.equal(contract.title, 'Contract of filter-api');
  assert.equal(needSentence(contract, t), 'openapi.yaml changes; the steps after it wait for your validation.');
  const knowledge = model.needs.filter((card) => card.kind === 'knowledge');
  assert.deepEqual(knowledge.map((card) => card.title), [knowledgeItem(FIXTURE_NOW).text, knowledgeItem(FIXTURE_NOW).text]);
  assert.deepEqual(knowledge.map((card) => needSentence(card, t)), ['Proposed for guestbook: approve it to keep it.', 'Proposed for the whole workspace: approve it to keep it.']);
  assert.equal(needSentence(knowledge[0]!, fr), 'Proposé pour guestbook : approuvez-le pour le garder.');
  assert.equal(t('need_contract', { age: '3 min' }), 'Contract · 3 min');
  assert.equal(t('need_knowledge', { age: '3 min' }), 'Knowledge · 3 min');
  // A handled one needs nobody.
  assert.equal(towerModel({ ...base, inbox: [{ ...contractItem(FIXTURE_NOW), state: 'handled' }] }, FIXTURE_NOW).needs.length, 0);
});

test('a reader\'s session is not a live session of the tower: the ask screen shows it', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const reader: SessionSummary = { ...base.sessions[0]!, id: 'reader-1', role: 'reader', ticket: 'ask-1', phase: 'working', status: 'Reading src/page.ts' };
  const model = towerModel({ ...base, sessions: [...base.sessions, reader] }, FIXTURE_NOW);
  assert.ok(!model.live.some((card) => card.id === 'reader-1'));
  assert.equal(model.live.length, base.sessions.length);
});

test('the schedules show in the plans card, the next run first, with its budget; one switched off says so, last', () => {
  const rows = towerModel({ ...TOWER_EMPTY, schedules: schedulesFixture(FIXTURE_NOW) }, FIXTURE_NOW).schedules;
  assert.deepEqual(rows.map((row) => row.name), ['dependency-update', 'weekly-review', 'Read the error log of the night and open a ticket for each new error']);
  assert.deepEqual(rows.map((row) => scheduleLine(row, FIXTURE_NOW, 'en', t)), ['Next run tomorrow at 03:00 · $0.50', 'Next run on Mon at 08:00 · $1.00', 'Off']);
  assert.deepEqual(rows.map((row) => scheduleLine(row, FIXTURE_NOW, 'fr', fr)), ['Prochain passage demain à 03:00 · 0,50 $', 'Prochain passage lun. à 08:00 · 1,00 $', 'Désactivé']);
  const today: Schedule = { ...schedulesFixture(FIXTURE_NOW)[0]!, nextRunAt: new Date(2026, 9, 21, 22, 15).toISOString() };
  assert.equal(scheduleLine(towerModel({ ...TOWER_EMPTY, schedules: [today] }, FIXTURE_NOW).schedules[0]!, FIXTURE_NOW, 'en', t), 'Next run at 22:15 · $0.50');
  const none: Schedule = { ...today, nextRunAt: null };
  assert.equal(scheduleLine(towerModel({ ...TOWER_EMPTY, schedules: [none] }, FIXTURE_NOW).schedules[0]!, FIXTURE_NOW, 'en', t), 'No next run · $0.50');
});

test('a recipe\'s form refuses a missing parameter before anything is posted, and sends the others trimmed', async () => {
  assert.equal(recipeProblem(update, {}), 'package');
  assert.equal(recipeProblem(update, { package: '   ', version: '2' }), 'package');
  assert.equal(recipeProblem(update, { package: 'pg' }), undefined, 'the version is optional');
  assert.equal(recipeProblem(review, {}), undefined);
  assert.deepEqual(recipeBody(update, { package: ' pg ', version: '  ' }), { parameters: { package: 'pg' } });
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api = (async (path: string, init: { method?: string; body?: unknown } = {}) => { calls.push({ path, ...init }); return { accepted: true, plan: 'plan-9' }; }) as ScreenContext['api'];
  await assert.rejects(runRecipe(api, update, { version: '2' }), /recipe_missing/);
  assert.deepEqual(calls, [], 'nothing posted');
  assert.deepEqual(await runRecipe(api, update, { package: 'pg' }), { accepted: true, plan: 'plan-9' });
  await runRecipe(api, { ...review, name: 'a b/c' }, {});
  assert.deepEqual(calls, [
    { path: '/recipes/dependency-update/run', method: 'POST', body: { parameters: { package: 'pg' } } },
    { path: '/recipes/a%20b%2Fc/run', method: 'POST', body: { parameters: {} } },
  ]);
});

test('what a run says, and where it leads: the plan of a ticket recipe, the lead for a goal', () => {
  assert.deepEqual(recipeDone({ accepted: true, plan: 'plan-9' }, update, t), { text: 'dependency-update runs as a one-ticket plan.', href: '/plans/plan-9' });
  assert.deepEqual(recipeDone({ accepted: true, message: 4 }, review, t), { text: 'weekly-review was sent to the lead as a goal.', href: '/lead' });
  assert.deepEqual(recipeDone({ accepted: true }, update, t), { text: 'dependency-update runs as a one-ticket plan.', href: null });
});

test('a service picked and then hidden by clearing the title is not posted with the next title (issue 210, item 1)', () => {
  assert.deepEqual(pickedFor('', ['filter-api']), []);
  assert.deepEqual(pickedFor('   ', ['filter-api']), []);
  assert.deepEqual(pickedFor('A title', ['filter-api']), ['filter-api']);
});

test('through the app, the tower\'s stand-in answers the recipes, the schedules and a ticket\'s steps', async () => {
  const source = towerSource(() => FIXTURE_NOW);
  const app = await startApp({ source });
  try {
    const { cookie, csrf } = await signedIn(app);
    const get = async <T,>(path: string) => await (await fetch(`${app.base}/api/service${path}`, { headers: { cookie } })).json() as T;
    assert.deepEqual((await get<Recipe[]>('/recipes')).map((r) => r.name), ['dependency-update', 'weekly-review']);
    assert.equal((await get<Schedule[]>('/schedules')).length, 3);
    assert.deepEqual((await get<TicketStep[]>('/tickets/LOCAL-163/steps')).map((s) => [s.position, s.kind, s.service, s.state]), [
      [1, 'contract', 'filter-api', 'done'], [2, 'service', 'filter-api', 'running'], [3, 'service', 'guestbook', 'waiting'], [4, 'integration', 'guestbook', 'waiting'],
    ]);
    const run = await fetch(`${app.base}/api/service/recipes/dependency-update/run`, {
      method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ parameters: {} }),
    });
    assert.equal(run.status, 400, 'the stand-in refuses a missing parameter as lane 26 does');
    assert.deepEqual(source.calls.at(-1), { method: 'POST', path: '/api/recipes/dependency-update/run', body: { parameters: {} } });
  } finally {
    await app.close();
  }
});

const TOWER_EMPTY: TowerData = { sessions: [], inbox: [], tickets: [], lead: null, leadLine: null, plans: [], weekLeft: null };
