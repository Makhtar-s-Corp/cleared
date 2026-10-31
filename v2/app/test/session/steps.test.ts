// The ticket's steps on the session screen's Plan tab (decision 26, lane
// 27): each step in order with its kind, its service, what it waits for, its
// state and its cost, this session's step marked; the service line saying
// which step this session is; nothing new for a ticket of one step.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { TicketStep } from '../../../src/api/types.ts';
import { FIXTURE_NOW, ticketSteps, towerFixture } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import { serviceLine, stepCost, stepLine, stepsView } from '../../web/screens/session/tabs.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

async function steps(): Promise<{ readonly steps: TicketStep[]; readonly session: string }> {
  const { sessions } = await towerFixture(FIXTURE_NOW);
  const session = sessions.find((s) => s.ticket === 'LOCAL-163')?.id as string;
  return { steps: ticketSteps(sessions), session };
}

test('the steps in order, this session\'s marked, with what each waits for', async () => {
  const { steps: all, session } = await steps();
  const view = stepsView([...all].reverse(), session);
  assert.ok(view);
  assert.equal(view.total, 4);
  assert.equal(view.current, 2);
  assert.deepEqual(view.rows.map((row) => [row.position, row.kind, row.service, row.state, row.current]), [
    [1, 'contract', 'filter-api', 'done', false],
    [2, 'service', 'filter-api', 'running', true],
    [3, 'service', 'guestbook', 'waiting', false],
    [4, 'integration', 'guestbook', 'waiting', false],
  ]);
  assert.deepEqual(view.rows.map((row) => stepLine(row, en)), [
    'Contract · filter-api',
    'Service · filter-api · waits for 1',
    'Service · guestbook · waits for 1',
    'Integration · guestbook · waits for 2 and 3',
  ]);
  assert.equal(stepLine(view.rows[3]!, fr), 'Intégration · guestbook · attend 2 et 3');
  for (const state of ['waiting', 'running', 'validating', 'done', 'failed']) for (const t of [en, fr]) assert.ok(t(`ticket_step_${state}`), state);
});

test('a step\'s cost once its session ran, in the reader\'s numbers', async () => {
  const view = stepsView((await steps()).steps, 'nobody');
  assert.ok(view);
  assert.equal(view.current, null, 'a session of none of the steps marks none');
  assert.deepEqual(view.rows.map((row) => stepCost(row, 'en', en)), ['$0.21', '$0.34', undefined, undefined]);
  assert.equal(stepCost(view.rows[0]!, 'fr', fr), '0,21\u00a0$');
});

test('a ticket of one step, or whose steps were not read, shows no steps and says nothing new', async () => {
  const { steps: all, session } = await steps();
  assert.equal(stepsView(all.slice(0, 1), session), null);
  assert.equal(stepsView([], session), null);
  assert.equal(stepsView(null, session), null);
  assert.equal(stepsView(undefined, session), null);
});

test('the service line says which step this session is', () => {
  assert.equal(serviceLine('filter-api', en, { current: 2, total: 4 }), 'on filter-api, step 2 of 4');
  assert.equal(serviceLine('filter-api', fr, { current: 2, total: 4 }), 'sur filter-api, étape 2 sur 4');
  assert.equal(serviceLine('filter-api', en, { current: null, total: 4 }), 'on filter-api');
  assert.equal(serviceLine('filter-api', en), 'on filter-api');
  assert.equal(serviceLine(undefined, en, { current: 2, total: 4 }), undefined);
});

test('an answer of the steps route that is not a list shows no steps, and breaks nothing', () => {
  assert.equal(stepsView({ id: 'LOCAL-163', title: 'a ticket' } as never, 'x'), null);
});
