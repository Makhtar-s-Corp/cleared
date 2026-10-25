// The clickable answers through the app: the session, lead and inbox pages
// load the component's rules with their own, and what a click makes reaches
// the right route of the fixture sources: the session answer route with the
// answers keyed by the question's text, the lead's messages route with the
// label as its text, never the session answer route for the lead.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { LeadMessage } from '../../src/api/types.ts';
import type { Question } from '../../src/session/events.ts';
import { AUTHOR_ID, MONTH_QUESTION, QUESTION_REQUEST_ID, sessionFixture, sessionSource } from '../fixtures/session.ts';
import { FIXTURE_NOW } from '../fixtures/tower.ts';
import { leadFixture, leadSource, waitingForAnswer } from '../fixtures/lead.ts';
import { choiceReply } from '../web/screens/lead/model.ts';
import { answerBody } from '../web/screens/session/model.ts';
import { pageFiles, signedIn, startApp, type Running } from './support.ts';

const PAGES: Question = {
  question: 'On desktop, do you want the entries in pages of 20, or one long list as on the phone?',
  header: 'Desktop list',
  options: [{ label: 'Pages of 20 (Recommended)' }, { label: 'One long list' }, { label: 'Pages of 50' }],
};

function poster(app: Running, signed: { cookie: string; csrf: string }) {
  return (path: string, body: unknown) => fetch(`${app.base}/api/service${path}`, {
    method: 'POST',
    headers: { cookie: signed.cookie, accept: 'application/json', 'x-csrf-token': signed.csrf, 'content-type': 'application/json', origin: app.origin },
    body: JSON.stringify(body),
  });
}

test('the session, lead and inbox pages load the clickable answers\' rules', async () => {
  const fixture = sessionFixture(FIXTURE_NOW, { question: true });
  const app = await startApp({ source: sessionSource(fixture, { now: () => FIXTURE_NOW }) });
  try {
    const { cookie } = await signedIn(app);
    for (const path of [`/sessions/${AUTHOR_ID}`, '/lead', '/inbox']) {
      const files = await pageFiles(app, path, cookie);
      assert.match(files.css, /\.choice-rec\b/, `${path}: the component's sheet`);
      assert.match(files.css, /\.choice\[aria-pressed=(?:"true"|true)\]/, path);
    }
  } finally {
    await app.close();
  }
});

test('a click on the session\'s question posts its label as written to the session answer route, once', async () => {
  const fixture = sessionFixture(FIXTURE_NOW, { question: true });
  const source = sessionSource(fixture, { now: () => FIXTURE_NOW });
  const app = await startApp({ source });
  try {
    const signed = await signedIn(app);
    const post = poster(app, signed);
    const label = MONTH_QUESTION.options?.[0]?.label as string;
    const path = `/sessions/${AUTHOR_ID}/requests/${QUESTION_REQUEST_ID}/answer`;
    assert.equal((await post(path, answerBody({ [MONTH_QUESTION.question]: label }))).status, 202);
    assert.deepEqual(source.calls.map((c) => [c.method, c.path, c.user, c.body]), [
      ['POST', `/api/${path.slice(1)}`, signed.id, { decision: { kind: 'answer', answers: { [MONTH_QUESTION.question]: 'Under the first month (Recommended)' } } }],
    ]);
    const last = fixture.store.events.after(AUTHOR_ID).map((e) => e.event).filter((e) => e.type === 'CUSTOM').at(-1);
    assert.deepEqual(last, { type: 'CUSTOM', name: 'cleared.answered', value: { requestId: QUESTION_REQUEST_ID, by: signed.id } });
    assert.equal((await post(path, answerBody({ [MONTH_QUESTION.question]: label }))).status, 404, 'a question no longer waiting: settled');
  } finally {
    await app.close();
  }
});

test('a click on the lead\'s question sends its label through POST /api/lead/messages, never the session answer route', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const waiting = waitingForAnswer(fixture);
  const messages = waiting.messages.map((m): LeadMessage => (m.question ? { ...m, question: { ...m.question, questions: [PAGES] } } : m));
  const source = leadSource({ ...fixture, state: waiting.state, messages }, { now: () => FIXTURE_NOW });
  const app = await startApp({ source });
  try {
    const signed = await signedIn(app);
    const reply = choiceReply([PAGES], { [PAGES.question]: 'Pages of 50' });
    const response = await poster(app, signed)('/lead/messages', reply.body);
    assert.equal(response.status, 200);
    assert.equal((await response.json() as LeadMessage).text, 'Pages of 50');
    assert.deepEqual(source.calls.map((c) => [c.method, c.path, c.user, c.body]), [['POST', '/api/lead/messages', signed.id, { text: 'Pages of 50' }]]);
    assert.equal(source.state().pendingQuestion, null, 'the pending question is answered');
  } finally {
    await app.close();
  }
});
