// The inbox's part of the replanned milestone 2 (lane 21), without markup:
// the order of the new kinds, what the list says of a train and of a
// session plan, when a release can be approved, what the detail redraws on,
// what Go and Change send, and how their refusals read.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextInboxItem, ReleaseItem, TrainState } from '../../../src/api/types.ts';
import { OTHER_CHANGES as SERVICE_OTHER_CHANGES } from '../../../src/release/flags.ts';
import { MAX_CHANGE } from '../../../src/flow/plan-gate.ts';
import { BLOCKED_TICKET, PLAN_SESSION, TRAIN_TICKET, contractItem, inboxFixture, inboxSource, knowledgeItem, sessionPlanItem, trainRelease } from '../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../web/lib/screen.ts';
import { signedIn, startApp } from '../support.ts';
import {
  CHANGE_MAX, OTHER_CHANGES, approvable, approve, changeMessage, detailKey, failure, goLine, itemLine, itemTitle, known, ordered, planChange, planGo, stopLine, trainLine,
  type InboxView,
} from '../../web/screens/inbox/model.ts';

const en = translator(loadCatalog('inbox', 'en'));
const fr = translator(loadCatalog('inbox', 'fr'));

function viewOf(items: readonly NextInboxItem[], overrides: Partial<InboxView> = {}): InboxView {
  const fixture = inboxFixture(FIXTURE_NOW, { train: 'waiting', sessionPlan: 'medium' });
  return {
    items, tickets: fixture.tickets, sessions: fixture.sessions, selected: undefined, open: false,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', ...overrides,
  };
}

type Sent = { path: string; method: string | undefined; body: unknown };
function fakeApi(answers: Record<string, unknown | Error> = {}) {
  const sent: Sent[] = [];
  const api = async <T>(path: string, init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {}): Promise<T> => {
    sent.push({ path, method: init.method, body: init.body });
    const answer = answers[path];
    if (answer instanceof Error) throw answer;
    return answer as T;
  };
  return { api, sent };
}

const withTrain = (item: ReleaseItem, edit: (train: TrainState) => TrainState): ReleaseItem => ({ ...item, train: edit(item.train as TrainState) });

test('the screen\'s "Other changes" is the service\'s, and its change limit is the route\'s', () => {
  assert.equal(OTHER_CHANGES, SERVICE_OTHER_CHANGES);
  assert.equal(CHANGE_MAX, MAX_CHANGE);
});

test('a session plan waits after the permissions and before the lead\'s plan; a contract and a knowledge item come last', () => {
  const fixture = inboxFixture(FIXTURE_NOW);
  const plan = sessionPlanItem(FIXTURE_NOW);
  const items = [contractItem(FIXTURE_NOW), knowledgeItem(FIXTURE_NOW), plan, ...fixture.items];
  const { waiting } = ordered(items);
  assert.deepEqual(waiting.map((i) => i.kind), ['release', 'permission', 'session_plan', 'plan', 'question', 'contract', 'knowledge']);
});

test('an item of a kind the screen does not know is left out of the list, not drawn as an unlabelled row', () => {
  const fixture = inboxFixture(FIXTURE_NOW);
  const kept = known([...fixture.items, { kind: 'someday', id: 'x', ticket: 'LOCAL-1', project: 'p', since: FIXTURE_NOW.toISOString(), state: 'waiting' }, null, 'text']);
  assert.deepEqual(kept.map((i) => i.id), fixture.items.map((i) => i.id));
});

test('only a release with no train, or a train that waits, can be approved', () => {
  assert.equal(approvable(inboxFixture(FIXTURE_NOW).items[0] as ReleaseItem), true, 'one service');
  assert.equal(approvable(trainRelease(FIXTURE_NOW, 'waiting')), true);
  for (const state of ['blocked', 'landing', 'landed', 'rolled_back', 'halted'] as const)
    assert.equal(approvable(trainRelease(FIXTURE_NOW, state)), false, state);
  // A waiting item whose train already lands (P18: the ticket is back in the
  // validate state between two landings) offers no second approval.
  assert.equal(approvable({ ...trainRelease(FIXTURE_NOW, 'landing'), state: 'waiting' }), false);
});

test('the list says where a train is: blocked, landing, landed, rolled back as the proof reads it, halted', () => {
  const view = viewOf([]);
  const line = (state: TrainState['state']) => itemLine(trainRelease(FIXTURE_NOW, state), view, en);
  assert.equal(line('waiting'), `${TRAIN_TICKET} · 2 services · Reviewed by Sonnet, checks green`);
  assert.equal(line('blocked'), `${BLOCKED_TICKET} · Blocked: a consumer is not changed`);
  assert.equal(line('landing'), `${TRAIN_TICKET} · Landing, 1 of 2 landed`);
  assert.equal(line('landed'), `${TRAIN_TICKET} · Landed, 2 of 2`);
  assert.equal(line('rolled_back'), `${TRAIN_TICKET} · Rolled back, 2 of 2`);
  assert.equal(line('halted'), `${TRAIN_TICKET} · Halted, 1 of 2 landed`);
  assert.equal(trainLine(trainRelease(FIXTURE_NOW, 'rolled_back').train as TrainState, fr), 'Annulé, 2 sur 2');
});

test('each stop of the train says its state and when', () => {
  const landing = trainRelease(FIXTURE_NOW, 'landing').train as TrainState;
  const [filter, guestbook] = landing.services;
  assert.match(stopLine(filter as TrainState['services'][number], landing, en), /^Landed, healthy · \d\d:\d\d$/);
  assert.match(stopLine(guestbook as TrainState['services'][number], landing, en), /^Merged, health being checked · \d\d:\d\d$/);
  const waiting = trainRelease(FIXTURE_NOW, 'waiting').train as TrainState;
  assert.equal(stopLine(waiting.services[0] as TrainState['services'][number], waiting, en), 'Waits for your approval');
  const next = withTrain(trainRelease(FIXTURE_NOW, 'landing'), (t) => ({ ...t, services: [t.services[0] as TrainState['services'][number], { ...t.services[1] as TrainState['services'][number], state: 'waiting', at: null }] })).train as TrainState;
  assert.equal(stopLine(next.services[1] as TrainState['services'][number], next, en), 'Lands next');
  const back = trainRelease(FIXTURE_NOW, 'rolled_back').train as TrainState;
  assert.match(stopLine(back.services[1] as TrainState['services'][number], back, en), /^Reverted · /);
});

test('the detail redraws when the train moves, and when a session plan gets its Go', () => {
  const landing = trainRelease(FIXTURE_NOW, 'landing');
  const landed = withTrain(landing, (t) => ({ ...t, services: t.services.map((s) => ({ ...s, state: 'healthy' as const })) }));
  const one = viewOf([landing], { selected: landing.id });
  const two = viewOf([landed], { selected: landed.id });
  assert.notEqual(detailKey(one), detailKey(two), 'a stop that turned healthy');
  const noted = withTrain(landing, (t) => ({ ...t, services: t.services.map((s, i) => (i === 1 ? { ...s, note: 'GET /health answered 500.' } : s)) }));
  assert.notEqual(detailKey(one), detailKey(viewOf([noted], { selected: noted.id })), 'a note on a stop');
  const plan = sessionPlanItem(FIXTURE_NOW);
  const gone = { ...plan, state: 'handled' as const, plan: { ...plan.plan, go: { by: 'delay' as const, at: FIXTURE_NOW.toISOString() } } };
  assert.notEqual(detailKey(viewOf([plan], { selected: plan.id })), detailKey(viewOf([gone], { selected: gone.id })));
});

test('a session plan in the list: its ticket\'s title, then its confidence and its steps', () => {
  const plan = sessionPlanItem(FIXTURE_NOW, 'high');
  const view = viewOf([plan]);
  assert.equal(itemTitle(plan, view), 'Moderation: a held entry waits for a moderator');
  assert.equal(itemLine(plan, view, en), 'LOCAL-165 · High confidence · 4 steps');
  assert.equal(itemTitle(plan, viewOf([plan], { tickets: [] })), plan.plan.steps[0], 'with no ticket read, its first step');
  assert.equal(itemLine({ ...plan, plan: { ...plan.plan, steps: ['One step'] } }, view, fr), 'LOCAL-165 · Confiance haute · 1 étape');
});

test('the contract and knowledge items are named in the list, for reading', () => {
  const view = viewOf([]);
  assert.equal(itemTitle(contractItem(FIXTURE_NOW), view), 'openapi.yaml');
  assert.equal(itemLine(contractItem(FIXTURE_NOW), view, en), 'LOCAL-170 · contract of filter-api');
  assert.equal(itemLine(knowledgeItem(FIXTURE_NOW), view, en), 'LOCAL-158 · for guestbook');
  assert.equal(itemLine({ ...knowledgeItem(FIXTURE_NOW), level: 'workspace', service: null }, view, en), 'LOCAL-158 · for the workspace');
});

test('who gave a session plan its Go, and when', () => {
  const view = viewOf([]);
  const at = '2026-10-22T07:12:00.000Z';
  const time = new Date(at);
  const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
  assert.equal(goLine({ by: 'user-demo', at }, view, en), `Go given by you at ${hhmm}.`);
  assert.equal(goLine({ by: 'user-other', at }, view, en), `Go given by user-other at ${hhmm}.`);
  assert.equal(goLine({ by: 'delay', at }, view, en), `Started by itself at ${hhmm}: the delay passed with a high confidence.`);
  assert.equal(goLine({ by: 'lead', at }, view, en), `Started by the lead at ${hhmm}, as part of the plan you approved.`);
});

test('Go posts the session\'s Go route with no body; Change posts the message, trimmed', async () => {
  const plan = sessionPlanItem(FIXTURE_NOW);
  const { api, sent } = fakeApi({ [`/sessions/${PLAN_SESSION}/plan/go`]: { accepted: true }, [`/sessions/${PLAN_SESSION}/plan/change`]: { accepted: true } });
  assert.deepEqual(await planGo(api, plan, FIXTURE_NOW), { kind: 'plan_go', at: FIXTURE_NOW.toISOString() });
  assert.deepEqual(await planChange(api, plan, '  Keep the public list as it is.  ', FIXTURE_NOW), { kind: 'plan_changed', at: FIXTURE_NOW.toISOString() });
  assert.deepEqual(sent, [
    { path: `/sessions/${PLAN_SESSION}/plan/go`, method: 'POST', body: null },
    { path: `/sessions/${PLAN_SESSION}/plan/change`, method: 'POST', body: { message: 'Keep the public list as it is.' } },
  ]);
});

test('a Change is refused before sending when it says nothing or is too long', () => {
  assert.deepEqual(changeMessage('   '), { error: 'plan_change_empty' });
  assert.deepEqual(changeMessage('x'.repeat(CHANGE_MAX + 1)), { error: 'plan_change_long' });
  assert.deepEqual(changeMessage(` ${'x'.repeat(CHANGE_MAX)} `), { message: 'x'.repeat(CHANGE_MAX) });
});

test('how a refusal of Go or Change reads', () => {
  const err = (status: number) => new ApiError(status, `${status}`);
  assert.deepEqual(failure(err(409), 'plan_go'), { key: 'plan_settled', settled: true }, 'no plan waits any more: it started, or the session ended');
  assert.deepEqual(failure(err(404), 'plan_go'), { key: 'plan_settled', settled: true });
  assert.deepEqual(failure(err(403), 'plan_go'), { key: 'plan_user', settled: false });
  assert.deepEqual(failure(err(503), 'plan_go'), { key: 'plan_flow_off', settled: false });
  assert.deepEqual(failure(err(500), 'plan_go'), { key: 'plan_go_failed', settled: false });
  assert.deepEqual(failure(err(400), 'plan_change'), { key: 'plan_change_invalid', settled: false });
  assert.deepEqual(failure(err(409), 'plan_change'), { key: 'plan_settled', settled: true });
  assert.deepEqual(failure(new Error('offline'), 'plan_change'), { key: 'plan_change_failed', settled: false });
});

test('every key the new parts name is in both catalogs, and no French text holds an em dash', () => {
  const en = loadCatalog('inbox', 'en');
  const fr = loadCatalog('inbox', 'fr');
  for (const key of Object.keys(en)) assert.ok(Object.hasOwn(fr, key), `inbox.fr.json lacks ${key}`);
  for (const [key, value] of Object.entries({ ...en, ...fr })) assert.ok(!value.includes('\u2014'), `${key} holds an em dash`);
});

// Through the app: lane 6's forwarding, with the signed-in user, to the
// fixture's stand-in of lane 17's routes and lane 16's approval.
test('through the app, Go reaches the session\'s route as the signed-in user, and a blocked train\'s approval is refused', async () => {
  const fixture = inboxFixture(FIXTURE_NOW, { sessionPlan: 'medium' });
  const source = inboxSource({ ...fixture, items: [...fixture.items, trainRelease(FIXTURE_NOW, 'blocked')] });
  const app = await startApp({ source });
  try {
    const { cookie, csrf, id } = await signedIn(app);
    const api: ScreenContext['api'] = async <T>(path: string, init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {}): Promise<T> => {
      const write = init.method === 'POST';
      const headers: Record<string, string> = { cookie, accept: 'application/json', origin: app.origin, 'sec-fetch-site': 'same-origin' };
      if (write) Object.assign(headers, { 'x-csrf-token': csrf, 'content-type': 'application/json' });
      const response = await fetch(`${app.base}/api/service${path}`, { method: init.method ?? 'GET', headers, body: write ? JSON.stringify(init.body ?? null) : null });
      if (!response.ok) throw new ApiError(response.status, `${path}: ${response.status}`);
      return await response.json() as T;
    };
    const items = known(await api<unknown[]>('/inbox'));
    const plan = items.find((i) => i.kind === 'session_plan');
    assert.ok(plan && plan.kind === 'session_plan');
    await planGo(api, plan, FIXTURE_NOW);
    assert.deepEqual(source.calls.at(-1), { method: 'POST', path: `/api/sessions/${PLAN_SESSION}/plan/go`, user: id, body: null });
    const after = known(await api<unknown[]>('/inbox')).find((i) => i.id === plan.id);
    assert.equal(after?.state, 'handled');
    await assert.rejects(planGo(api, plan, FIXTURE_NOW), (error: unknown) => failure(error, 'plan_go').key === 'plan_settled', 'a second Go finds no plan waiting');
    const blocked = items.find((i): i is ReleaseItem => i.kind === 'release' && i.ticket === BLOCKED_TICKET) as ReleaseItem;
    await assert.rejects(approve(api, blocked, FIXTURE_NOW), (error: unknown) => error instanceof ApiError && error.status === 409);
  } finally {
    await app.close();
  }
});
