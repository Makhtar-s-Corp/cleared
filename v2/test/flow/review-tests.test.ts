// The reviewer runs the service's tests (issue #268): the declared test
// command is read from the service's agents.conf, the reviewer's prompt names
// it, and its run, read from the session's events in the ledger, goes into
// the verdict row, the ticket's thread, the author's request and the
// release's announcement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowConfigError, parseConf, projectSettings } from '../../src/flow/config.ts';
import { reviewPrompt } from '../../src/flow/prompts.ts';
import { testComment, testRunOf } from '../../src/flow/review-tests.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { toolArgs, toolResult, type CustomValue, type SessionEvent } from '../../src/session/events.ts';
import { REPORT_FIX, REPORT_PASS, finished, quickAuthor, setup, started, text, until, type Setup } from './support.ts';

const CONF = '[merge]\nverdict = no blocking issues\n[session]\n';
const ticket = { id: 'LOCAL-1', title: 'Newest entry first', body: 'The guestbook lists entries newest first.' };

test('[session] test_command is one simple command; not declared, npm test when package.json has a test script', () => {
  assert.deepEqual(projectSettings(parseConf(`${CONF}test_command = node --test test/\n`), ['test']).testCommand, ['node', '--test', 'test/']);
  assert.deepEqual(projectSettings(parseConf(`${CONF}test_command = npm run 'test:unit'\n`), []).testCommand, ['npm', 'run', 'test:unit']);
  assert.deepEqual(projectSettings(parseConf(CONF), ['test', 'lint']).testCommand, ['npm', 'test']);
  assert.equal(projectSettings(parseConf(CONF), ['lint']).testCommand, undefined);
  for (const bad of ['npm test && rm -rf src', 'npm test > out.txt', 'npm test $FLAGS', 'npm test | tail'])
    assert.throws(() => projectSettings(parseConf(`${CONF}test_command = ${bad}\n`), ['test']), FlowConfigError, bad);
});

test('the review prompt names the declared command and asks for a Tests line; none declared, it says so', () => {
  const declared = reviewPrompt({ ticket, base: 'main', verdict: 'no blocking issues', testCommand: ['npm', 'test'] });
  assert.match(declared, /Run the service's tests with exactly `npm test`, alone/);
  assert.match(declared, /Tests: what `npm test` showed/);
  assert.doesNotMatch(declared, /You may run the project's tests/);
  const none = reviewPrompt({ ticket, base: 'main', verdict: 'no blocking issues' });
  assert.match(none, /declares no test command/);
  assert.doesNotMatch(none, /^Tests:/m);
});

// One Bash call of a session and its result, as the cleaner stores them.
const call = (id: string, command: string, output: string, isError: boolean): FakeStep[] => [
  { emit: { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'Bash' } },
  { emit: toolArgs(id, { kind: 'execute', command }) },
  { emit: { type: 'TOOL_CALL_END', toolCallId: id } },
  { emit: toolResult(`${id}-result`, id, { kind: 'execute', output, cut: 0, isError }) },
];
const events = (steps: readonly FakeStep[]): SessionEvent[] => steps.flatMap((step, seq) => ('emit' in step && step.emit
  ? [{ seq: seq + 1, at: '2026-10-24T10:00:00.000Z', sessionId: 's1' as SessionEvent['sessionId'], ticket: 'LOCAL-1', project: 'guestbook', event: step.emit }]
  : []));

test('the run is read from the session\'s events: the last call of the declared command, alone or not, with its result', () => {
  const npm = ['npm', 'test'];
  assert.deepEqual(testRunOf(events(call('c1', 'npm test', 'ok 1\nok 2\n# pass 2', false)), npm), { command: 'npm test', outcome: 'passed', tail: 'ok 1\nok 2\n# pass 2' });
  assert.equal(testRunOf(events(call('c1', 'npm test', 'not ok 1\n# fail 1', true)), npm)?.outcome, 'failed');
  // In a pipe, the status is tail's.
  assert.equal(testRunOf(events(call('c1', 'npm test 2>&1 | tail -5', '# pass 2', false)), npm)?.outcome, 'unclear');
  // Another command, or the report only saying so, is not a run.
  assert.deepEqual(testRunOf([...events(call('c1', 'npm run lint', 'ok', false)), ...events(text('r1', 'Tests: npm test passed.'))], npm), { command: 'npm test', outcome: 'not_run' });
  // The last run counts: a failure fixed and run again is a pass.
  assert.equal(testRunOf(events([...call('c1', 'npm test', 'not ok', true), ...call('c2', 'npm test', 'ok', false)]), npm)?.outcome, 'passed');
  // A long output keeps its last lines.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(testRunOf(events(call('c1', 'npm test', long, false)), npm)?.tail?.split('\n').length, 15);
  // No declared command: nothing to say.
  assert.equal(testRunOf(events(call('c1', 'npm test', 'ok', false)), undefined), undefined);
  assert.match(testComment({ command: 'npm test', outcome: 'not_run' }, 2), /^Review round 2\. Tests: the reviewer did not run `npm test`\.$/);
});

// The engine with a service that declares `npm test`.
const settings = async () => ({ verdict: 'no blocking issues', safeCommands: [], hosts: [], services: [], scripts: ['test'], testCommand: ['npm', 'test'] });
const reviewer = (report: string, run: readonly FakeStep[]): readonly FakeStep[] => [started, ...run, ...text('r1', report), finished(0.1)];
type Verdict = CustomValue['cleared.review_verdict'];
const verdicts = (t: Setup): Verdict[] => t.startedSessions.filter((s) => s.input.role === 'reviewer').flatMap((s) => t.store.events.after(s.id))
  .flatMap((e) => (e.event.type === 'CUSTOM' && e.event.name === 'cleared.review_verdict' ? [e.event.value] : []));

test('a pass carries the tests that passed: the verdict row, the ticket\'s thread, the announcement', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewer(REPORT_PASS, call('t1', 'npm test', 'ok 1 - newest first\n# pass 1\n# fail 0', false))] }, effects: { settings } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);

  const [verdict] = verdicts(t);
  assert.deepEqual(verdict?.tests, { command: 'npm test', outcome: 'passed', tail: 'ok 1 - newest first\n# pass 1\n# fail 0' });
  const thread = (await t.tickets.comments(t.ticket.id)).map((c) => c.body).join('\n---\n');
  assert.match(thread, /Review round 1\. Tests: `npm test` passed in the reviewer's session\./);
  assert.match(thread, /# fail 0/);
  assert.match(t.recorder.records[0]?.report ?? '', /Tests: `npm test` passed/);
  const release = t.inbox.list().find((i) => i.kind === 'release');
  assert.ok(release, 'the release waits');
  // The prompt the reviewer got names the command.
  const prompt = t.startedSessions.find((s) => s.input.role === 'reviewer')?.input.prompt ?? '';
  assert.match(prompt, /exactly `npm test`/);
});

test('a request for change carries the failing run to the author, and a review that ran nothing says so', async () => {
  const t = await setup({
    scripts: { author: quickAuthor, reviewers: [reviewer(REPORT_FIX, call('t1', 'npm test', 'not ok 1 - newest first\n# fail 1', true)), reviewer(REPORT_PASS, [])] },
    config: { maxReviewRounds: 3 }, effects: { settings },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);

  assert.deepEqual(verdicts(t).map((v) => `${v.verdict}:${v.tests?.outcome}`), ['changes_requested:failed', 'pass:not_run']);
  const author = t.startedSessions.find((s) => s.input.role === 'author')!.id;
  const request = t.store.events.after(author).flatMap((e) => (e.event.type === 'CUSTOM' && e.event.name === 'cleared.review_channel' && e.event.value.from === 'reviewer' ? [e.event.value.text] : []));
  assert.match(request[0] ?? '', /Tests: `npm test` failed in the reviewer's session\./);
  const thread = (await t.tickets.comments(t.ticket.id)).map((c) => c.body);
  assert.ok(thread.some((body) => /^Review round 1\. Tests: `npm test` failed/.test(body) && /# fail 1/.test(body)), thread.join('\n---\n'));
  assert.ok(thread.some((body) => body === 'Review round 2. Tests: the reviewer did not run `npm test`.'), thread.join('\n---\n'));
});

test('the run in the thread goes through the service\'s cleaner', async () => {
  const t = await setup({
    scripts: { author: quickAuthor, reviewers: [reviewer(REPORT_PASS, call('t1', 'npm test', 'token=SECRET-1\n# pass 1', false))] },
    effects: { settings }, clean: (s) => s.replaceAll('SECRET-1', '[redacted]'),
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release item', 5000);
  assert.equal(verdicts(t)[0]?.tests?.tail, 'token=[redacted]\n# pass 1');
  assert.doesNotMatch((await t.tickets.comments(t.ticket.id)).map((c) => c.body).join('\n'), /SECRET-1/);
});
