// The session's question in its timeline, drawn by the clickable answers
// from the thread's interrupt: three options while it waits, then
// answered (by whom, with what this tab sent), cancelled by an interrupt,
// settled without the person, or left by a session that ended.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SessionSummary } from '../../../../src/api/types.ts';
import { AUTHOR_ID, MONTH_QUESTION, QUESTION_REQUEST_ID, sessionFixture } from '../../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { applyAll, emptyModel, questionStatus, threadOf, type QuestionRow, type SessionModel, type SessionView } from '../../screens/session/model.ts';
import { renderAction, renderTimeline, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });
const ME = 'user-demo';

function modelWith(): SessionModel {
  const fixture = sessionFixture(FIXTURE_NOW, { question: true });
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  return model;
}

function viewOf(model: SessionModel, overrides: Partial<SessionView> = {}): SessionView {
  const fixture = sessionFixture(FIXTURE_NOW, { question: true });
  return { summary: fixture.sessions[0] as SessionSummary, thread: threadOf(model), ticket: fixture.ticket, siblings: fixture.sessions, me: ME, language: 'en', now: FIXTURE_NOW, ...overrides };
}

const rowOf = (view: SessionView) => view.thread.rows.find((r) => r.kind === 'question') as QuestionRow;

test('the waiting question is drawn from the thread\'s interrupt: its three options as buttons, the recommendation marked, a free answer', () => {
  const view = viewOf(modelWith());
  assert.deepEqual(view.thread.interrupts.map((i) => i.id), [QUESTION_REQUEST_ID]);
  assert.deepEqual(questionStatus(rowOf(view), view, en), { kind: 'waiting', busy: false });
  const html = renderAction(view, en);
  assert.match(html, /<div class="request question waits" data-row="question" data-request-id="question-161">/);
  assert.doesNotMatch(renderTimeline(view, en), /data-answer=/, 'one place answers it: the action at the top');
  assert.deepEqual([...html.matchAll(/<button[^>]*data-answer="([^"]*)"/g)].map((m) => m[1]), MONTH_QUESTION.options?.map((o) => o.label.replace(/'/g, '&#39;')));
  assert.match(html, /<span class="choice-rec">Recommended<\/span>/);
  assert.match(html, /data-free="0"/);
  assert.doesNotMatch(html, /data-answer="(allow_once|allow_always|reject_once)"/, 'no permission button on a question');
});

test('while the answer is on its way the buttons wait; once sent from this tab it reads answered by you, with the label sent', () => {
  const model = modelWith();
  const busy = viewOf(model, { busy: new Set([QUESTION_REQUEST_ID]) });
  assert.deepEqual(questionStatus(rowOf(busy), busy, en), { kind: 'waiting', busy: true });
  const label = 'Under the first month (Recommended)';
  const sent = viewOf(model, { answers: new Map([[QUESTION_REQUEST_ID, { kind: 'sent', sent: label, chosen: [label] }]]) });
  assert.deepEqual(questionStatus(rowOf(sent), sent, en), { kind: 'answered', who: 'you', sent: label, chosen: [label] }, 'before the stream says so');
  const html = renderTimeline(sent, en);
  assert.match(html, /<div class="request question" data-row="question"/, 'amber only while it waits');
  assert.ok(visibleText(html).includes(`Answered by you: ${label}`));
  assert.doesNotMatch(html, /<button[^>]*data-answer=/);
});

test('answered elsewhere, cancelled by an interrupt, settled without the person, or left by an ended session', () => {
  const answered = modelWith();
  applyAll(answered, [{ seq: 999, at: FIXTURE_NOW.toISOString(), sessionId: AUTHOR_ID, ticket: 'LOCAL-161', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.answered', value: { requestId: QUESTION_REQUEST_ID, by: 'someone-else' } } }]);
  const other = viewOf(answered);
  assert.deepEqual(questionStatus(rowOf(other), other, en), { kind: 'answered', who: 'a teammate' });
  assert.ok(visibleText(renderTimeline(other, en)).includes('Answered by a teammate'));

  const cancelled = modelWith();
  applyAll(cancelled, [{ seq: 999, at: FIXTURE_NOW.toISOString(), sessionId: AUTHOR_ID, ticket: 'LOCAL-161', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: QUESTION_REQUEST_ID, decision: 'cancelled', by: 'policy', rule: 'interrupt' } } }]);
  const view = viewOf(cancelled);
  assert.deepEqual(questionStatus(rowOf(view), view, en), { kind: 'cancelled' });
  assert.ok(visibleText(renderTimeline(view, en)).includes('Cancelled when the turn was interrupted'));

  const settled = viewOf(modelWith(), { answers: new Map([[QUESTION_REQUEST_ID, { kind: 'settled' }]]) });
  assert.deepEqual(questionStatus(rowOf(settled), settled, en), { kind: 'settled' });
  assert.ok(visibleText(renderTimeline(settled, en)).includes('This question was settled without you.'));

  const ended = modelWith();
  applyAll(ended, [{ seq: 999, at: FIXTURE_NOW.toISOString(), sessionId: AUTHOR_ID, ticket: 'LOCAL-161', project: 'guestbook', event: { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/phase', value: 'stopped' }] } }]);
  const gone = viewOf(ended);
  assert.deepEqual(questionStatus(rowOf(gone), gone, en), { kind: 'ended' });
  const html = renderTimeline(gone, en);
  assert.doesNotMatch(html, /<button[^>]*data-answer=/, 'nothing to answer in a session that ended');
  assert.ok(visibleText(html).includes('The session ended before an answer.'));
});

test('in French the question\'s words come from the French catalog', () => {
  const text = visibleText(renderAction(viewOf(modelWith(), { language: 'fr' }), fr));
  for (const english of ['Recommended', 'Or answer in your own words', 'Send the answer']) assert.ok(!text.includes(english), english);
  assert.ok(text.includes('Recommandé'));
});
