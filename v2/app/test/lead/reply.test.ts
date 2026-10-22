// The screen's gestures: the reply field answers the lead's pending question,
// sends a goal, or sends a message, always through POST /api/lead/messages
// (the session answer route answers 409 for the lead's session, issue 168
// item 3); an option of the question sends its label; Approve, Pause and
// Resume call the plan routes and the panel shows the plan they answer.
// Run against the app with lane 8's stand-in for the service's lead and
// plan routes, so the writes carry the signed-in user as in production.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LeadMessage, Plan } from '../../../src/api/types.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { leadFixture, leadSource, otherPlans, waitingForAnswer } from '../../fixtures/lead.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../public/i18n.ts';
import { ApiError, type ScreenContext } from '../../public/screen.ts';
import { composerMode, gestureFailure, planGesture, replyFor, sendReply } from '../../public/screens/lead.ts';
import { renderPlanPanel } from '../../public/plan-panel.ts';
import { signedIn, startApp, type Running } from '../support.ts';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('lead', 'en') });

// What app.ts gives a screen as `api`, over fetch with the cookie.
function apiOf(app: Running, cookie: string, csrf: string): ScreenContext['api'] {
  return async (path, init = {}) => {
    const write = init.method === 'POST';
    const response = await fetch(`${app.base}/api/service${path}`, {
      method: init.method ?? 'GET',
      headers: { cookie, accept: 'application/json', ...(write ? { 'x-csrf-token': csrf, 'content-type': 'application/json', origin: app.origin } : {}) },
      ...(write ? { body: JSON.stringify(init.body ?? null) } : {}),
    });
    if (!response.ok) throw new ApiError(response.status, `${path}: ${response.status}`);
    return await response.json() as never;
  };
}

test('the reply answers the pending question, unless it is sent as a goal; otherwise it is a message', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const { state } = waitingForAnswer(fixture);
  assert.deepEqual(replyFor('  Pages of 20.  ', state, false), { kind: 'answer', body: { text: 'Pages of 20.' } });
  assert.deepEqual(replyFor('Make the guestbook ready for a small team', state, true), { kind: 'goal', body: { text: 'Make the guestbook ready for a small team', goal: true } });
  assert.deepEqual(replyFor('What landed last night?', fixture.state, false), { kind: 'message', body: { text: 'What landed last night?' } });
  assert.equal(replyFor('   ', fixture.state, false), undefined);
  assert.equal(replyFor('x'.repeat(20_001), fixture.state, false), undefined, 'the service refuses more than 20 000 characters');
  assert.equal(composerMode(state, false), 'answer');
  assert.equal(composerMode(state, true), 'goal');
  assert.equal(composerMode(fixture.state, false), 'message');
  assert.equal(composerMode({ ...fixture.state, phase: 'down' }, false), 'message', 'a message to a lead that is down waits for its next generation');
});

test('against the service routes: an answer settles the question, a goal leaves it waiting, and each write carries the signed-in user', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const waiting = waitingForAnswer(fixture);
  const source = leadSource({ ...fixture, ...waiting }, { now: () => FIXTURE_NOW });
  const app = await startApp({ source });
  try {
    const { cookie, csrf, id } = await signedIn(app);
    const api = apiOf(app, cookie, csrf);

    const goal = replyFor('Make the guestbook ready for a small team', source.state(), true);
    assert.ok(goal);
    const sentGoal = await sendReply(api, goal);
    assert.equal(sentGoal.by, 'owner');
    assert.ok(source.state().pendingQuestion, 'a goal does not answer the question that waits');

    const answer = replyFor('Pages of 20 (Recommended)', source.state(), false);
    assert.ok(answer);
    const sent: LeadMessage = await sendReply(api, answer);
    assert.equal(sent.text, 'Pages of 20 (Recommended)');
    assert.equal(source.state().pendingQuestion, null);
    assert.equal(source.messages().find((m) => m.kind === 'question')?.question?.state, 'handled');
    assert.deepEqual(source.calls.map((c) => [c.path, c.user, c.body]), [
      ['/api/lead/messages', id, { text: 'Make the guestbook ready for a small team', goal: true }],
      ['/api/lead/messages', id, { text: 'Pages of 20 (Recommended)' }],
    ]);
    assert.ok(!source.calls.some((c) => c.path.includes('/requests/')), 'never the session answer route');
  } finally {
    await app.close();
  }
});

test('Approve calls the plan route at once, and the panel turns to Running; a second Approve is a conflict the screen explains', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const source = leadSource(fixture, { now: () => FIXTURE_NOW });
  const app = await startApp({ source });
  try {
    const { cookie, csrf, id } = await signedIn(app);
    const api = apiOf(app, cookie, csrf);
    const plan = fixture.plans[0] as Plan;
    assert.match(renderPlanPanel(plan, en), /Plan to approve/);

    const approved = await planGesture(api, plan, 'approve');
    assert.deepEqual(source.calls.map((c) => [c.method, c.path, c.user]), [['POST', '/api/plans/plan-1/approve', id]]);
    assert.equal(approved.state, 'approved');
    const html = renderPlanPanel(approved, en);
    assert.match(html, /<p class="plan-eyebrow">Running · 0 of 5 landed<\/p>/);
    assert.match(html, /data-plan-action="pause">Pause<\/button>/);
    assert.doesNotMatch(html, /awaiting/);

    const again = await planGesture(api, plan, 'approve').then(() => undefined, (error: unknown) => error);
    assert.ok(again instanceof ApiError && again.status === 409);
    assert.equal(gestureFailure(again, 'approve'), 'lead_plan_conflict');
    assert.equal(en(gestureFailure(again, 'approve')), 'The plan changed in the meantime. Here it is as it is now.');
    assert.equal(en(gestureFailure(new ApiError(502, 'x'), 'approve')), 'The plan could not be approved. Try again.');
    assert.equal(en(gestureFailure(new TypeError('offline'), 'pause')), 'The plan could not be paused. Try again.');
  } finally {
    await app.close();
  }
});

test('Pause stops a running plan and Resume starts it again, through their routes', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const { running } = otherPlans(FIXTURE_NOW);
  const source = leadSource({ ...fixture, plans: [running] }, { now: () => FIXTURE_NOW });
  const app = await startApp({ source });
  try {
    const { cookie, csrf } = await signedIn(app);
    const api = apiOf(app, cookie, csrf);
    const paused = await planGesture(api, running, 'pause');
    assert.equal(paused.state, 'paused');
    assert.match(renderPlanPanel(paused, en), /data-plan-action="resume">Resume<\/button>/);
    const resumed = await planGesture(api, paused, 'resume');
    assert.equal(resumed.state, 'approved');
    assert.deepEqual(source.calls.map((c) => c.path), ['/api/plans/plan-2/pause', '/api/plans/plan-2/resume']);
  } finally {
    await app.close();
  }
});
