// The tower in a workspace of several services (decisions 18, 21, 22 and
// 30, lane 22): the workspace line with each service's state, a taken-over
// session among the live ones, the services a new ticket names, and the
// session plans that wait, so a kind the tower does not draw no longer
// breaks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { NextInboxItem, SessionSummary, Workspace } from '../../src/api/types.ts';
import { loadCatalog } from '../src/catalog.ts';
import { DRAFT_MAX as LEAD_DRAFT_MAX } from '../web/screens/lead/model.ts';
import { FIXTURE_NOW, OWNER_ID, WORKSPACE, towerFixture, towerSource, workspaceFixture } from '../fixtures/tower.ts';
import { translator } from '../web/lib/i18n.ts';
import { ApiError, type ScreenContext } from '../web/lib/screen.ts';
import { createTicket, DRAFT_MAX, liveDot, loadTower, needSentence, newTicket, serviceState, takenOverText, towerModel, type TowerData } from '../web/screens/tower/model.ts';
import { signedIn, startApp } from './support.ts';

const t = translator(loadCatalog('tower', 'en'));
const fr = translator(loadCatalog('tower', 'fr'));
const minutesBefore = (minutes: number) => new Date(FIXTURE_NOW.getTime() - minutes * 60_000).toISOString();

test('the workspace line names each service with its live sessions and its train: landing, or rolled back', async () => {
  const model = towerModel(await workspaceFixture(FIXTURE_NOW), FIXTURE_NOW, OWNER_ID);
  assert.deepEqual(model.services.map((row) => [row.name, row.live, row.landing, row.rolledBack]), [
    ['guestbook', 3, 'LOCAL-169', null],
    ['filter-api', 2, null, 'LOCAL-168'],
  ]);
  assert.deepEqual(model.services.map((row) => serviceState(row, t)), ['3 live sessions · landing LOCAL-169', '2 live sessions · rolled back LOCAL-168']);
  assert.deepEqual(model.services.map((row) => serviceState(row, fr)), ['3 sessions en cours · atterrit LOCAL-169', '2 sessions en cours · annulé LOCAL-168']);
  assert.deepEqual(model.serviceNames, ['guestbook', 'filter-api']);
});

test('a service with nothing under way says so, and one live session is singular', () => {
  assert.equal(serviceState({ name: 'guestbook', live: 0, landing: null, rolledBack: null }, t), 'quiet');
  assert.equal(serviceState({ name: 'guestbook', live: 1, landing: null, rolledBack: null }, t), '1 live session');
});

test('a one-service workspace, or none read, has no workspace line and no service to pick: milestone 1\'s tower', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const one: Workspace = { ...WORKSPACE, services: WORKSPACE.services.slice(0, 1) };
  for (const workspace of [undefined, null, one]) {
    const model = towerModel({ ...base, ...(workspace === undefined ? {} : { workspace }) }, FIXTURE_NOW, OWNER_ID);
    assert.deepEqual(model.services, []);
    assert.deepEqual(model.serviceNames, []);
    assert.ok(model.live.every((card) => card.service === null));
  }
});

test('a session taken over stays among the live ones, says by whom and since when, and is not pulsing', async () => {
  const model = towerModel(await workspaceFixture(FIXTURE_NOW), FIXTURE_NOW, OWNER_ID);
  const taken = model.live.find((card) => card.ticket === 'LOCAL-170');
  assert.ok(taken, 'the taken-over session is live');
  assert.deepEqual(taken.takenOver, { you: true, minutes: 6 });
  assert.equal(taken.service, 'filter-api');
  assert.equal(takenOverText(taken.takenOver!, t), 'Taken over by you · 6 min');
  assert.equal(takenOverText({ you: false, minutes: 6 }, t), 'Taken over by another account · 6 min');
  assert.equal(takenOverText(taken.takenOver!, fr), 'Repris en main par vous · 6 min');
  assert.equal(liveDot(taken.phase, taken.role, taken.takenOver), 'live taken');
  assert.equal(liveDot('working', 'author', null), 'live');
  // Seen by another account, it does not say "you".
  assert.deepEqual(towerModel(await workspaceFixture(FIXTURE_NOW), FIXTURE_NOW, 'someone-else').live.find((card) => card.ticket === 'LOCAL-170')?.takenOver, { you: false, minutes: 6 });
});

test('a session in the paused phase lane 20 adds is live too, taken over', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const paused = { ...base.sessions[0]!, id: 'paused-1', phase: 'paused', takenOver: { by: OWNER_ID, at: minutesBefore(3) } } as unknown as SessionSummary;
  const model = towerModel({ ...base, sessions: [...base.sessions, paused] }, FIXTURE_NOW, OWNER_ID);
  assert.deepEqual(model.live.find((card) => card.id === 'paused-1')?.takenOver, { you: true, minutes: 3 });
});

test('a session plan that waits is a need with its confidence; a kind the tower does not draw is left out instead of breaking it', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const items: NextInboxItem[] = [
    ...base.inbox,
    { kind: 'session_plan', id: 'session-plan-1', ticket: 'LOCAL-161', project: 'guestbook', since: minutesBefore(5), state: 'waiting', sessionId: 's', service: 'guestbook',
      plan: { steps: ['Group the entries by week'], files: ['src/page.ts'], confidence: 'medium', reason: 'Two ways to group by week.', proposedAt: minutesBefore(5), go: null } },
    { kind: 'knowledge', id: 'knowledge-1', ticket: 'LOCAL-161', project: 'guestbook', since: minutesBefore(4), state: 'waiting', text: 'Dates are UTC.', level: 'workspace', service: null, sourceSession: 's', outcome: null } as unknown as NextInboxItem,
  ];
  const data: TowerData = { ...base, inbox: items as TowerData['inbox'] };
  const model = towerModel(data, FIXTURE_NOW, OWNER_ID);
  const plan = model.needs.find((card) => card.kind === 'session_plan');
  assert.ok(plan);
  assert.equal(plan.title, 'Upcoming: group entries by week');
  assert.equal(plan.href, '/inbox#session-plan-1');
  assert.equal(needSentence(plan, t), 'Two ways to group by week. Medium confidence: the author waits for your Go.');
  assert.ok(!model.needs.some((card) => (card.kind as string) === 'knowledge'));
  assert.equal(model.needs.length, 4);
});

test('a new ticket names the services picked, and none when none is picked', () => {
  assert.deepEqual(newTicket(' A ', '', 'guestbook', ['guestbook', 'filter-api']), { title: 'A', project: 'guestbook', services: ['guestbook', 'filter-api'] });
  assert.deepEqual(newTicket('A', ' b ', 'guestbook', []), { title: 'A', project: 'guestbook', body: 'b' });
  assert.deepEqual(newTicket('A', '', 'guestbook'), { title: 'A', project: 'guestbook' });
});

test('creating a ticket with two services posts both to the tickets route', async () => {
  const calls: { path: string; init: unknown }[] = [];
  const api = (async (path: string, init?: unknown) => {
    calls.push({ path, init });
    return { id: 'LOCAL-181', status: 'Todo' };
  }) as ScreenContext['api'];
  const ticket = await createTicket(api, { title: 'Flagged entries are held', body: '', project: 'guestbook', services: ['guestbook', 'filter-api'] });
  assert.equal(ticket.id, 'LOCAL-181');
  assert.deepEqual(calls, [{ path: '/tickets', init: { method: 'POST', body: { title: 'Flagged entries are held', project: 'guestbook', services: ['guestbook', 'filter-api'] } } }]);
});

test('the tower reads the workspace apart: a service without the route shows milestone 1\'s tower', async () => {
  const base = await towerFixture(FIXTURE_NOW);
  const answers: Record<string, unknown> = { '/sessions': base.sessions, '/inbox': base.inbox, '/tickets': base.tickets, '/workspace': WORKSPACE };
  const read = (missing: readonly string[]) => (async (path: string) => {
    if (missing.includes(path) || !(path in answers)) throw new ApiError(404, 'not found');
    return answers[path];
  }) as ScreenContext['api'];
  assert.deepEqual((await loadTower(read([]), { after: 0, line: null })).data.workspace, WORKSPACE);
  assert.equal((await loadTower(read(['/workspace']), { after: 0, line: null })).data.workspace, null);
});

test('through the app, the workspace and a ticket naming two services reach the stand-in', async () => {
  const source = towerSource(() => FIXTURE_NOW);
  const app = await startApp({ source });
  try {
    const { cookie, csrf } = await signedIn(app);
    const workspace = await (await fetch(`${app.base}/api/service/workspace`, { headers: { cookie } })).json() as Workspace;
    assert.deepEqual(workspace.services.map((s) => s.name), ['guestbook', 'filter-api']);
    const created = await fetch(`${app.base}/api/service/tickets`, {
      method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': csrf, 'content-type': 'application/json' },
      body: JSON.stringify(newTicket('Flagged entries are held', '', 'guestbook', ['guestbook', 'filter-api'])),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(source.calls.map((call) => call.body), [{ title: 'Flagged entries are held', project: 'guestbook', services: ['guestbook', 'filter-api'] }]);
  } finally {
    await app.close();
  }
});

test('the bar\'s draft limit is the one the lead\'s screen reads (issue 173, item 5)', () => {
  assert.equal(DRAFT_MAX, LEAD_DRAFT_MAX);
});
