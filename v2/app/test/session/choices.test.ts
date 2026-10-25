// The session's question as the thread's interrupt: what waits is carried
// in AG-UI's Interrupt shape with the AskUserQuestion questions as asked; an
// answer leaves it; an interrupted turn cancels it, which the adapters say
// with a `cancelled` permission answer by the policy; and the body an
// answer posts to the session answer route.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgUiEvent, Question } from '../../../src/session/events.ts';
import { answerBody, threadOf, type QuestionRow } from '../../web/screens/session/model.ts';
import { modelOf } from './support.ts';

const MONTH: Question = {
  question: 'Should a week that spans two months appear under the first month or be split?',
  header: 'Month edges',
  options: [{ label: 'Under the first month (Recommended)', description: 'One heading per week.' }, { label: 'Split' }, { label: 'Under the month with more days' }],
};

const asked = (requestId: string): AgUiEvent => ({ type: 'CUSTOM', name: 'cleared.question', value: { requestId, questions: [MONTH] } });

test('a question that waits is the thread\'s interrupt, in AG-UI\'s shape, with the questions as the harness asked them', () => {
  const thread = threadOf(modelOf([asked('q-1')]));
  assert.deepEqual(thread.interrupts, [{ id: 'q-1', reason: 'cleared.question', message: MONTH.question, metadata: { questions: [MONTH] } }]);
  assert.deepEqual(thread.pending, ['q-1']);
});

test('an answer by a person ends the interrupt and says who answered', () => {
  const thread = threadOf(modelOf([asked('q-2'), { type: 'CUSTOM', name: 'cleared.answered', value: { requestId: 'q-2', by: 'user-1' } }]));
  assert.deepEqual(thread.interrupts, []);
  assert.deepEqual(thread.pending, []);
  const row = thread.rows.find((r) => r.kind === 'question') as QuestionRow;
  assert.equal(row.answeredBy, 'user-1');
  assert.equal(row.cancelled, undefined);
});

test('an interrupted turn cancels the question: it no longer waits, and its row says cancelled', () => {
  const thread = threadOf(modelOf([
    asked('q-3'),
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'q-3', decision: 'cancelled', by: 'policy', rule: 'interrupt' } },
    { type: 'RUN_FINISHED', threadId: 'author-1', runId: 'r', outcome: { type: 'cancelled' }, usage: [], result: { stopReason: 'cancelled', total_cost_usd: null } },
  ]));
  assert.deepEqual(thread.pending, [], 'the question does not wait any more');
  assert.deepEqual(thread.interrupts, []);
  const row = thread.rows.find((r) => r.kind === 'question') as QuestionRow;
  assert.equal(row.cancelled, true);
  assert.equal(row.answeredBy, undefined);
  assert.equal(thread.rows.filter((r) => r.kind === 'denied').length, 0, 'a cancelled question is not a refusal by the rules');
});

test('the answer route is given the answers keyed by the question\'s text, the label as written', () => {
  assert.deepEqual(answerBody({ [MONTH.question]: 'Under the first month (Recommended)' }), {
    decision: { kind: 'answer', answers: { [MONTH.question]: 'Under the first month (Recommended)' } },
  });
});
