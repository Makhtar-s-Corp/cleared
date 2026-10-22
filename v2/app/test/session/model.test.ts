// The session screen's model: the stored events of a session added up into
// rows, a state and a pending list, as the browser does it while it reads
// the stream. Pure, so it runs under Node.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AUTHOR_ID, ANSWER_TEXT, QUESTION_TEXT, REQUEST_ID, USER, detailOf, sessionFixture } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { applyAll, applyEvent, emptyModel, EVENT_NAMES, parseCriteria, resultSummary, stepsOf, timeline, type Row } from '../../web/screens/session/model.ts';
import { EVENT_TYPES, type AgUiEvent } from '../../../src/session/events.ts';
import { createMapper, toolRequest } from '../../../src/session/adapters/claude-code/map.ts';
import { createCleaner } from '../../../src/session/clean.ts';
import { DEFAULT_SAFE_COMMANDS, evaluate, type Policy } from '../../../src/session/policy.ts';
import type { RunnerOutput } from '../../../images/session/runner/main.ts';
import { message, modelOf, stored, tool } from './support.ts';

const time = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function fixtureModel() {
  const fixture = sessionFixture(FIXTURE_NOW);
  const model = emptyModel();
  applyAll(model, fixture.store.events.after(AUTHOR_ID));
  return { fixture, model };
}

test('the fixture session adds up to the rows of the capture, with their counts', () => {
  const { model } = fixtureModel();
  const rows = timeline(model);
  // The session plan (lane 20's fixture): proposed, then its Go, before the first edit.
  assert.deepEqual(rows.map((row) => row.kind), ['read', 'plan', 'plan', 'tool', 'tool', 'message', 'message', 'tool', 'tool']);
  const [read, proposed, given, editA, run, question, answer, editB, install] = rows as [Row, Row, Row, Row, Row, Row, Row, Row, Row];
  assert.deepEqual([proposed.kind === 'plan' && [proposed.confidence, proposed.go], given.kind === 'plan' && given.go?.by], [['high', null], USER]);
  assert.deepEqual([read.kind === 'read' && read.paths, time(read.at)], [['src/screens/Upcoming.jsx', 'test/upcoming.test.mjs', 'test/screens.test.mjs'], '09:23']);
  assert.deepEqual([editA.kind === 'tool' && editA.input, time(editA.at)], [{ kind: 'edit', path: 'src/engine/upcoming.mjs', added: 24, removed: 6 }, '09:25']);
  assert.deepEqual(run.kind === 'tool' && [run.input, resultSummary(run.output)], [{ kind: 'execute', command: 'npm run test:upcoming', description: 'Run the upcoming tests' }, { tone: 'ok', key: 'passed', n: 18 }]);
  assert.deepEqual(question.kind === 'message' && [question.role, question.text, time(question.at)], ['assistant', QUESTION_TEXT, '09:31']);
  assert.deepEqual(answer.kind === 'message' && [answer.role, answer.text, answer.by, time(answer.at)], ['user', ANSWER_TEXT, USER, '09:32']);
  assert.deepEqual(editB.kind === 'tool' && editB.input, { kind: 'edit', path: 'src/screens/Upcoming.jsx', added: 41, removed: 12 });
  assert.ok(install.kind === 'tool' && install.request?.state === 'waiting' && install.request.requestId === REQUEST_ID, 'the install waits for the human');
  assert.deepEqual(model.pending, [REQUEST_ID]);
});

test('the ticket prompt (a message from cleared) is the ticket card, not a row', () => {
  const { model } = fixtureModel();
  assert.ok(!timeline(model).some((row) => row.kind === 'message' && row.by === 'cleared'));
});

test('the state is the last snapshot with the deltas applied', () => {
  const { fixture, model } = fixtureModel();
  assert.equal(model.state?.phase, 'waiting_human');
  assert.deepEqual(model.state?.files.map((f) => [f.path, f.added, f.removed]), [['src/engine/upcoming.mjs', 24, 6], ['src/screens/Upcoming.jsx', 41, 12], ['test/upcoming.test.mjs', 38, 0]]);
  assert.deepEqual(model.state?.checks, [{ name: 'Targeted tests', state: 'passed' }, { name: 'Full suite', state: 'pending' }]);
  assert.deepEqual(model.state?.steps.map((s) => [s.name, s.finishedAt === null]), [['workspace', false], ['author', false], ['plan_gate', false], ['author', true], ['waiting_human', true]]);
  const { plan, ...served } = detailOf(fixture, AUTHOR_ID)?.state ?? {};
  assert.deepEqual(served, model.state, 'the service answers the same state');
  assert.deepEqual(plan, model.plan, 'with the session plan');
});

test('a delta covers add, replace and remove at a path, and ignores a path that is not there', () => {
  const model = modelOf([
    { type: 'STATE_SNAPSHOT', snapshot: { status: 'a', phase: 'working', steps: [], files: [], checks: [], usage: {} } },
    { type: 'STATE_DELTA', delta: [
      { op: 'replace', path: '/status', value: 'b' },
      { op: 'add', path: '/files/-', value: { path: 'x', added: 1, removed: 0 } },
      { op: 'add', path: '/usage/inputTokens', value: 5 },
      { op: 'remove', path: '/checks' },
      { op: 'replace', path: '/nothing/here', value: 1 },
    ] },
  ]);
  assert.equal(model.state?.status, 'b');
  assert.deepEqual(model.state?.files, [{ path: 'x', added: 1, removed: 0 }]);
  assert.equal(model.state?.usage.inputTokens, 5);
  assert.equal(model.state?.checks, undefined);
});

test('replaying events from a reconnect adds nothing twice, and an older event is ignored', () => {
  const events = stored([...message('m1', 'assistant', 'one'), ...tool('t1', 'Bash', { kind: 'execute', command: 'ls' }, { kind: 'execute', output: '', cut: 0, isError: false })]);
  const model = emptyModel();
  assert.equal(applyAll(model, events), events.length);
  const rows = JSON.stringify(timeline(model));
  assert.equal(applyAll(model, events), 0, 'the whole stream again');
  assert.equal(applyEvent(model, events[2] as typeof events[number]), false, 'one old event');
  assert.equal(applyAll(model, [...events.slice(3), ...stored(message('m2', 'assistant', 'two'), events.length + 1)]), 3, 'an overlap applies only the new ones');
  assert.equal(JSON.stringify(timeline(model)).includes('"one"'), true);
  assert.equal(timeline(model).length, 3);
  assert.notEqual(JSON.stringify(timeline(model)), rows);
  assert.equal(model.lastSeq, events.length + 3);
});

test('a policy refusal with no request before it is a row of its own, and a policy allow is quiet', () => {
  const model = modelOf([
    ...tool('t1', 'Bash', { kind: 'execute', command: 'git push origin main' }, { kind: 'execute', output: 'blocked', cut: 0, isError: true }),
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'r-deny', decision: 'reject_once', by: 'policy', rule: 'push.base' } },
    { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: 'r-allow', decision: 'allow_once', by: 'policy', rule: 'edit.workdir' } },
  ]);
  const rows = timeline(model);
  assert.deepEqual(rows.map((row) => row.kind), ['tool', 'denied']);
  const denied = rows[1] as Extract<Row, { kind: 'denied' }>;
  assert.deepEqual([denied.requestId, denied.rule], ['r-deny', 'push.base']);
  assert.deepEqual(model.pending, []);
});

test('a request is waiting until its answer, then says who decided and how', () => {
  const request = (id: string, tid: string): AgUiEvent => ({
    type: 'CUSTOM', name: 'cleared.permission_request', value: { requestId: id, toolCallId: tid, tool: 'Bash', input: { kind: 'execute', command: 'touch a' }, suggestion: { decision: 'ask', rule: 'default', reason: 'no rule allows this request' } },
  });
  const answered = (id: string, decision: 'allow_once' | 'allow_always' | 'reject_once' | 'cancelled', by: string, rule?: string): AgUiEvent =>
    ({ type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: id, decision, by, ...(rule ? { rule } : {}) } });
  const model = modelOf([
    ...tool('t1', 'Bash', { kind: 'execute', command: 'touch a' }), request('r1', 't1'),
    ...tool('t2', 'Bash', { kind: 'execute', command: 'touch a' }), request('r2', 't2'), answered('r2', 'allow_once', 'u1'),
    ...tool('t3', 'Bash', { kind: 'execute', command: 'touch a' }), request('r3', 't3'), answered('r3', 'allow_always', 'u2'),
    ...tool('t4', 'Bash', { kind: 'execute', command: 'touch a' }), request('r4', 't4'), answered('r4', 'reject_once', 'u1'),
    ...tool('t5', 'Bash', { kind: 'execute', command: 'touch a' }), request('r5', 't5'), answered('r5', 'cancelled', 'policy', 'interrupt'),
    request('r6', 'unknown-tool'),
  ]);
  const states = timeline(model).map((row) => row.kind === 'tool' ? [row.request?.state, row.request?.decision, row.request?.by, row.request?.rule] : [row.kind]);
  assert.deepEqual(states, [
    ['waiting', undefined, undefined, undefined], ['answered', 'allow_once', 'u1', undefined], ['answered', 'allow_always', 'u2', undefined],
    ['answered', 'reject_once', 'u1', undefined], ['answered', 'cancelled', 'policy', 'interrupt'], ['waiting', undefined, undefined, undefined],
  ]);
  assert.deepEqual(model.pending, ['r1', 'r6'], 'a request with no tool row of its own is a row too');
});

test('a question waits until it is answered', () => {
  const model = modelOf([
    { type: 'CUSTOM', name: 'cleared.question', value: { requestId: 'q1', questions: [{ question: 'Which format?', options: [{ label: 'ISO' }, { label: 'Local' }] }] } },
    { type: 'CUSTOM', name: 'cleared.question', value: { requestId: 'q2', questions: [{ question: 'Another?' }] } },
    { type: 'CUSTOM', name: 'cleared.answered', value: { requestId: 'q2', by: 'u1' } },
  ]);
  const rows = timeline(model) as Extract<Row, { kind: 'question' }>[];
  assert.deepEqual(rows.map((row) => [row.requestId, row.answeredBy]), [['q1', undefined], ['q2', 'u1']]);
  assert.deepEqual(model.pending, ['q1']);
});

test('an interrupt, an error and a verdict are rows; reasoning and unknown events are not', () => {
  const model = modelOf([
    { type: 'REASONING_START', messageId: 'x' }, { type: 'REASONING_END', messageId: 'x' },
    { type: 'RUN_FINISHED', threadId: 's1', runId: 'r', outcome: { type: 'cancelled' }, usage: [], result: { stopReason: 'cancelled', total_cost_usd: null } },
    { type: 'RUN_FINISHED', threadId: 's1', runId: 'r2', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: 0.1 } },
    { type: 'RUN_ERROR', message: 'the runner exited with code 1', code: 'runner_exit' },
    { type: 'CUSTOM', name: 'cleared.review_verdict', value: { session: 's2', verdict: 'changes_requested', round: 1 } },
    { type: 'CUSTOM', name: 'cleared.handover_captured', value: { path: 'HANDOVER.md' } },
  ]);
  assert.deepEqual(timeline(model).map((row) => row.kind), ['interrupted', 'error', 'verdict']);
});

test('a command result reads as the capture shows it, and never as markup', () => {
  const out = (output: string, isError = false) => resultSummary({ kind: 'execute', output, cut: 0, isError });
  assert.deepEqual(out('# tests 18\n# pass 18\n# fail 0\n'), { tone: 'ok', key: 'passed', n: 18 });
  assert.deepEqual(out('# tests 5\n# pass 3\n# fail 2\n'), { tone: 'error', key: 'failed', n: 2 });
  assert.deepEqual(out('Tests: 4 passed, 4 total'), { tone: 'ok', key: 'passed', n: 4 });
  assert.deepEqual(out('notes.txt'), { tone: 'ok', key: 'done' });
  assert.deepEqual(out('', true), { tone: 'error', key: 'error' });
  assert.equal(resultSummary(undefined), undefined);
  assert.deepEqual(resultSummary({ kind: 'edit', ok: false, error: 'not found' }), { tone: 'error', key: 'error' });
});

test('criteria are the checklist lines of the ticket body; the rest is its description', () => {
  const parsed = parseCriteria('First line.\n\nSecond.\n\n- [x] Done thing\n- [ ] Open thing\n* [X] Starred\n- not a box');
  assert.deepEqual(parsed.criteria, [{ text: 'Done thing', done: true }, { text: 'Open thing', done: false }, { text: 'Starred', done: true }]);
  assert.deepEqual(parsed.description, ['First line.', 'Second.', '- not a box']);
  assert.deepEqual(parseCriteria(''), { description: [], criteria: [] });
});

test('the page listens for exactly the event names the service sends', () => {
  assert.deepEqual([...EVENT_NAMES].sort(), [...EVENT_TYPES].sort());
});

test('a session recorded with the real CLI, through the real mapper, reads as rows', () => {
  const lines = readFileSync(new URL('../../../test/session/claude-code/fixtures/two-turns.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as RunnerOutput);
  const policy: Policy = {
    role: 'author', base: 'main', workdir: '/workspace', scripts: ['test'], credentialFile: '/run/cleared/claude.token',
    safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [],
  };
  const mapper = createMapper({ sessionId: 's1' });
  const cleaner = createCleaner();
  const raw: AgUiEvent[] = [...mapper.start('claude-haiku-5-5')];
  lines.forEach((line, index) => {
    if (index === 0) raw.push(...mapper.userMessage('00000000-0000-4000-8000-000000000001', 'Read notes.txt, then edit it, then run ls and touch made.txt.', 'user-1'));
    if (index === 17) raw.push(...mapper.userMessage('00000000-0000-4000-8000-000000000020', 'Which word replaced old?', 'user-1'));
    if (line.type === 'permission_request') {
      const verdict = evaluate(toolRequest(line), policy);
      raw.push(...mapper.permissionRequest(line, verdict));
      raw.push(...mapper.answered(line.requestId, verdict.decision === 'allow' ? { decision: { kind: 'allow_once' }, by: 'policy', rule: verdict.rule } : verdict.decision === 'deny' ? { decision: { kind: 'reject_once', message: verdict.message }, by: 'policy', rule: verdict.rule } : { decision: { kind: 'allow_once' }, by: 'user-1' }));
    } else raw.push(...mapper.line(line));
  });
  const model = modelOf(raw.flatMap((event) => cleaner.clean(event)));
  const rows = timeline(model);
  const kinds = rows.map((row) => row.kind === 'tool' ? `${row.input?.kind}${row.request ? `:${row.request.decision}:${row.request.by}` : ''}` : row.kind === 'message' ? `${row.role}:${row.text}` : row.kind);
  assert.deepEqual(kinds.filter((k) => !k.startsWith('user:')), ['read', 'edit', 'execute', 'execute:allow_once:user-1', 'assistant:DONE', 'assistant:new']);
  assert.equal(rows.filter((row) => row.kind === 'message' && row.role === 'user').length, 2);
  assert.deepEqual(model.pending, []);
  assert.equal(model.state?.phase, 'stopped', 'the recording ends with the runner\'s exit');
  assert.deepEqual(model.state?.files, [{ path: 'notes.txt', added: 1, removed: 1 }]);
  assert.ok(!rows.some((row) => row.kind === 'denied'), 'the policy allows are quiet');
});

test('a step that happens more than once counts the sum of its spans, whatever order the snapshot and the step events came in', () => {
  const at = (seq: number) => new Date(2026, 9, 21, 9, 0, seq).toISOString();
  const step = (type: 'STEP_STARTED' | 'STEP_FINISHED', stepName: string) => ({ type, stepName }) as AgUiEvent;
  const snapshot = (steps: [string, number, number | null][]) => ({ type: 'STATE_SNAPSHOT', snapshot: { status: 'Working', phase: 'working', files: [], checks: [], usage: {}, steps: steps.map(([name, from, to]) => ({ name, startedAt: at(from), finishedAt: to === null ? null : at(to) })) } }) as AgUiEvent;
  const model = modelOf([
    step('STEP_STARTED', 'author'), step('STEP_STARTED', 'waiting_human'), step('STEP_FINISHED', 'waiting_human'), step('STEP_FINISHED', 'author'),
    snapshot([['author', 1, 4], ['waiting_human', 2, 3]]),
    // The author reopened after a review: a second round, with its own wait.
    step('STEP_STARTED', 'author'), step('STEP_STARTED', 'waiting_human'), step('STEP_FINISHED', 'waiting_human'),
    // A snapshot taken before the round ended still has it open.
    snapshot([['author', 1, 4], ['waiting_human', 2, 3], ['author', 6, null], ['waiting_human', 7, 8]]),
    step('STEP_FINISHED', 'author'),
    step('STEP_STARTED', 'review'),
  ]);
  const totals = stepsOf(model, Date.parse(at(21)));
  assert.deepEqual(totals.map((s) => [s.name, s.ms / 1000, s.count, s.open]), [
    ['author', 3 + 4, 2, false],
    ['waiting_human', 1 + 1, 2, false],
    ['review', 10, 1, true],
  ]);
});
