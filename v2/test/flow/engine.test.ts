import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReleaseItem } from '../../src/api/types.ts';
import { PublishRefused } from '../../src/workspace/publish.ts';
import { TicketError } from '../../src/tickets/contract.ts';
import {
  REPORT_FIX, REPORT_PASS, finished, permission, quickAuthor, reviewerScript, setup, started, stepLines, text, until, type Setup,
} from './support.ts';

const human = { kind: 'human', id: 'u1' } as const;
const sessionIds = (t: Setup) => t.startedSessions.map((s) => s.id);
const events = (t: Setup) => sessionIds(t).flatMap((id) => t.store.events.after(id));
const kinds = (t: Setup) => t.inbox.list().map((i) => `${i.kind}:${i.state}`);

test('a whole ticket on the fake adapter: Todo, workspace, author with one permission and one message, review, publish, request, approval', async () => {
  const t = await setup();
  const { engine, ticket } = t;

  // Todo starts the workspace and the author session; the ticket is In Progress.
  await engine.start(ticket.id, 'u1');
  assert.equal((await t.tickets.get(ticket.id))?.status, 'In Progress');
  assert.deepEqual(t.calls, ['prepareWorkdir:author']);
  const author = t.startedSessions[0]!;
  assert.equal(author.input.role, 'author');
  assert.equal(author.input.model, 'claude-opus-5-5');
  assert.equal(author.input.workdir, `/work/${ticket.id}`);
  assert.equal(author.input.policy.role, 'author');
  assert.deepEqual(author.input.policy.scripts, ['test', 'typecheck']);
  // The project's test services start beside the session.
  assert.deepEqual(author.input.services?.map((s) => s.image), ['postgres:16']);
  assert.match(author.input.prompt, /Newest entry first/);
  assert.equal(t.store.sessions.get(author.id)?.role, 'author');

  // The permission the policy escalated waits in the inbox, and the clock of the human wait runs.
  await until(() => t.inbox.list().length === 1, 'the permission item');
  const [item] = t.inbox.list();
  assert.equal(item?.kind, 'permission');
  assert.equal(item?.state, 'waiting');
  if (item?.kind !== 'permission') throw new Error('not a permission item');
  assert.equal(item.requestId, 'request-1');
  assert.equal(item.sessionId, author.id);
  assert.equal(item.input.kind, 'execute');
  assert.equal(engine.sessionSummary(author.id)?.phase, 'waiting_human');
  assert.deepEqual(stepLines(events(t)), ['+workspace', '-workspace', '+author', '+waiting_human']);

  // The human answers from the inbox.
  await engine.answer(author.id, 'request-1', { kind: 'allow_once' }, 'u1');
  await until(() => kinds(t)[0] === 'permission:handled', 'the permission handled');
  assert.equal(engine.sessionSummary(author.id)?.phase, 'working');
  const answered = events(t).find((e) => e.event.type === 'CUSTOM' && e.event.name === 'cleared.permission_answered');
  assert.ok(answered);
  if (answered.event.type === 'CUSTOM' && answered.event.name === 'cleared.permission_answered') assert.equal(answered.event.value.by, 'u1');
  await until(() => stepLines(events(t)).includes('-waiting_human'), 'the human wait closed');

  // One message from the human, mid run; the session takes it.
  await engine.send(author.id, 'Also show the date.', 'u1');

  // The author's end starts the review, in its own session, by the other model.
  await until(() => t.startedSessions.length === 2, 'the reviewer session');
  const reviewer = t.startedSessions[1]!;
  assert.equal(reviewer.input.role, 'reviewer');
  assert.equal(reviewer.input.model, 'claude-sonnet-5-5');
  assert.equal(reviewer.input.workdir, author.input.workdir, 'the same branch');
  assert.equal(reviewer.input.policy.role, 'reviewer');
  assert.match(reviewer.input.prompt, /You review a pull request you did not write/);
  assert.match(reviewer.input.prompt, /“no blocking issues”/);

  // A pass: the project is refreshed, then published; the review is recorded for the pull request; the lock is asked.
  await until(() => kinds(t).includes('release:waiting'), 'the release item');
  assert.deepEqual(t.calls, [
    'prepareWorkdir:author', 'captureHandover:author', 'prepareWorkdir:reviewer', 'refreshProject', `publish:${ticket.id}`, `requestRelease:${ticket.id}:7`,
  ]);
  assert.equal(t.recorder.records.length, 1);
  assert.deepEqual({ ...t.recorder.records[0], at: undefined, report: undefined }, {
    ticket: ticket.id, pr: 7, session: reviewer.id, model: 'claude-sonnet-5-5', verdict: 'pass', round: 1, report: undefined, at: undefined,
  });
  assert.match(t.recorder.records[0]!.report, /Verdict: “no blocking issues”/);
  assert.equal((await t.tickets.get(ticket.id))?.status, 'Needs Approval');
  assert.deepEqual((await t.tickets.history(ticket.id)).map((h) => [h.status, h.by.kind]), [
    ['Todo', 'human'], ['In Progress', 'agents'], ['In Review', 'agents'], ['Needs Approval', 'agents'],
  ]);
  const release = t.inbox.list().find((i): i is ReleaseItem => i.kind === 'release');
  assert.ok(release);
  assert.equal(release.pr.number, 7);
  assert.deepEqual(release.heads, [{ pr: 7, head: 'abc123' }]);
  assert.equal(release.title, 'Newest entry first');
  assert.deepEqual(release.sessions.map((s) => [s.role, s.model]), [['author', 'claude-opus-5-5'], ['reviewer', 'claude-sonnet-5-5']]);
  assert.equal(release.sessions[1]?.rounds, 1);
  // The card follows the pull request's checks: a tick reads them from the forge.
  assert.equal(release.pr.checks, 'pending');
  await engine.tick();
  assert.equal(t.inbox.list().find((i): i is ReleaseItem => i.kind === 'release')?.pr.checks, 'passed');
  const verdictEvent = events(t).find((e) => e.event.type === 'CUSTOM' && e.event.name === 'cleared.review_verdict');
  assert.ok(verdictEvent);
  assert.equal(verdictEvent.sessionId, reviewer.id);

  // The steps, in order, across the two sessions.
  assert.deepEqual(stepLines(events(t)), [
    '+workspace', '-workspace', '+author', '+waiting_human', '-waiting_human', '-author', '+review', '-review', '+release', '-release', '+approval',
  ]);

  // The human approves in the app: the writer of the contract and the ticket store record it; the flow notices.
  await t.approvals.approve({ ticket: ticket.id, by: 'u1', requestedAt: release.requestedAt, heads: release.heads });
  await t.tickets.recordApproval(ticket.id, human);
  await engine.tick();
  assert.equal((await t.tickets.get(ticket.id))?.status, 'Ready to Ship');
  assert.equal(t.inbox.list().find((i) => i.kind === 'release')?.state, 'handled');
  assert.equal(stepLines(events(t)).at(-1), '-approval');
  await engine.settled();
});

test('a requested change reopens the author session with the request; the second review passes', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)] } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item', 5000);
  const roles = t.startedSessions.map((s) => s.input.role);
  assert.deepEqual(roles, ['author', 'reviewer', 'reviewer'], 'the author is reopened by resume, not started again');
  assert.equal(t.recorder.records.length, 1, 'only the passing round is recorded: a request for change has no pull request');
  assert.equal(t.recorder.records[0]?.round, 2);
  const userMessages = events(t).filter((e) => e.event.type === 'TEXT_MESSAGE_CONTENT' && e.event.messageId.includes('-user-'));
  assert.equal(userMessages.length, 1);
  assert.match(userMessages[0]?.event.type === 'TEXT_MESSAGE_CONTENT' ? userMessages[0].event.delta : '', /sorts the wrong way/);
  const verdicts = events(t).flatMap((e) => (e.event.type === 'CUSTOM' && e.event.name === 'cleared.review_verdict' ? [`${e.event.value.verdict}:${e.event.value.round}`] : []));
  assert.deepEqual(verdicts, ['changes_requested:1', 'pass:2']);
  assert.deepEqual(t.calls.filter((c) => c.startsWith('publish') || c === 'refreshProject').length, 2, 'one refresh and one publish, after the passing round only');
  assert.equal((t.store.sessions.list({ ticket: t.ticket.id })).length, 3);
  const release = t.inbox.list().find((i): i is ReleaseItem => i.kind === 'release');
  assert.equal(release?.sessions.find((s) => s.role === 'reviewer')?.rounds, 2);
});

test('when the author cannot be resumed, a new author session starts with the request in its prompt', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)], reopen: 'throw' } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item', 5000);
  assert.deepEqual(t.startedSessions.map((s) => s.input.role), ['author', 'reviewer', 'author', 'reviewer']);
  assert.match(t.startedSessions[2]!.input.prompt, /sorts the wrong way/);
  assert.match(t.startedSessions[2]!.input.prompt, /Newest entry first/);
});

test('after the last allowed round a request for change puts the ticket back with the report as a note', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_FIX)] }, config: { maxReviewRounds: 2 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo', 'the ticket back in Todo', 5000);
  const comments = await t.tickets.comments(t.ticket.id);
  assert.match(comments.at(-1)?.body ?? '', /2 review rounds/);
  assert.match(comments.at(-1)?.body ?? '', /sorts the wrong way/);
  assert.equal(comments.at(-1)?.by.kind, 'agents');
  assert.equal(t.recorder.records.length, 0);
  assert.ok(!t.calls.includes(`publish:${t.ticket.id}`));
  assert.deepEqual(kinds(t), []);
});

test('a reviewer is never asked for, and never has captured, a HANDOVER.md (issue 139)', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.waitingFor(t.startedSessions[0]!.id) === 1);
  await t.engine.answer(t.startedSessions[0]!.id, 'request-1', { kind: 'allow_once' }, 'u1');
  await until(() => t.startedSessions.length === 1 && t.engine.sessionSummary(t.startedSessions[0]!.id)?.phase === 'working');
  await t.engine.send(t.startedSessions[0]!.id, 'go on', 'u1');
  await until(() => kinds(t).includes('release:waiting'));
  assert.deepEqual(t.calls.filter((c) => c.startsWith('captureHandover')), ['captureHandover:author']);
  const prompt = t.startedSessions[1]!.input.prompt;
  assert.match(prompt, /do not write HANDOVER\.md/i);
  assert.match(prompt, /if you are asked for HANDOVER\.md/i);
});

test('the review takes the last report that holds a Verdict line, so an answer to the end-of-session notice does not hide it', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [[started, ...text('r1', REPORT_PASS), ...text('r2', 'My report is my handover; I cannot write files.'), finished(0.1)]] } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'));
  assert.equal(t.recorder.records[0]?.verdict, 'pass');
});

test('a review that gives no verdict stops the ticket with a note, and publishes nothing', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [[started, ...text('r1', 'Looks fine to me.'), finished(0.1)]] } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /no verdict/);
  assert.ok(!t.calls.some((c) => c.startsWith('publish')));
});

test('the project is refreshed right before the publish (issue 141), and a refused publish puts the ticket back with the reason', async () => {
  const t = await setup({
    scripts: { author: quickAuthor },
    effects: { async publish() { throw new PublishRefused('guard', 'the guard refuses it'); } },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo');
  const at = t.calls.indexOf('refreshProject');
  assert.ok(at > 0, 'refreshProject ran');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /guard refuses it/);
  assert.equal(t.recorder.records.length, 0);
  assert.ok(!t.calls.some((c) => c.startsWith('requestRelease')));
});

test('the refresh comes immediately before publish in a flow that publishes', async () => {
  const t = await setup({ scripts: { author: quickAuthor } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'));
  const calls = t.calls;
  assert.equal(calls[calls.indexOf(`publish:${t.ticket.id}`) - 1], 'refreshProject');
});

test('an idle session is stopped at 15 minutes: 14:59 still runs, 15:00 stops and puts the ticket back with a note', async () => {
  const t = await setup({ scripts: { author: [started, ...text('a1', 'Thinking.'), { awaitMessage: true }] } });
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await until(() => t.store.events.after(id).some((e) => e.event.type === 'RUN_STARTED'));
  await t.engine.settled();
  t.clock.now += 14 * 60_000 + 59_000;
  await t.engine.tick();
  assert.equal(t.store.sessions.get(id)?.status, 'working');
  t.clock.now += 1000;
  await t.engine.tick();
  assert.equal(t.store.sessions.get(id)?.status, 'stopped');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /15 minutes/);
  const last = t.store.events.after(id).at(-1)?.event;
  assert.equal(last?.type, 'RUN_ERROR');
  if (last?.type === 'RUN_ERROR') assert.equal(last.code, 'idle');
  await assert.rejects(t.engine.send(id, 'hello?', 'u1'), /stopped|not running/i);
});

test('time spent waiting for the human is not idle time: a pending permission is not stopped at 15 minutes', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(id) === 1);
  t.clock.now += 3 * 3600_000;
  await t.engine.tick();
  assert.equal(t.store.sessions.get(id)?.status, 'waiting_human');
  // Answered: the idle clock starts from the answer, not from the old event.
  await t.engine.answer(id, 'request-1', { kind: 'allow_once' }, 'u1');
  await t.engine.tick();
  assert.equal(t.store.sessions.get(id)?.status, 'working');
});

test('a session over the ticket budget is stopped, its ticket put back with a note, and nothing restarts it', async () => {
  const t = await setup({ scripts: { author: [started, ...text('a1', 'Expensive.'), finished(6.5)] }, config: { budgetUsd: 5 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo');
  const id = t.startedSessions[0]!.id;
  assert.equal(t.store.sessions.get(id)?.status, 'stopped');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /budget of \$5/);
  const last = t.store.events.after(id).at(-1)?.event;
  assert.equal(last?.type, 'RUN_ERROR');
  if (last?.type === 'RUN_ERROR') assert.equal(last.code, 'budget');
  await t.engine.tick();
  await t.engine.settled();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(t.startedSessions.length, 1, 'the service moving the ticket to Todo does not start the flow again');
  assert.ok(!t.calls.includes('captureHandover:reviewer'));
});

test('the budget adds up the cost of every session of the ticket', async () => {
  const t = await setup({ scripts: { author: [started, ...text('a1', 'Done.'), finished(3)], reviewers: [reviewerScript(REPORT_PASS, 3)] }, config: { budgetUsd: 5 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo');
  assert.equal(t.startedSessions.length, 2);
  assert.equal(t.recorder.records.length, 0, 'an over-budget review is not recorded or published');
  assert.ok(!t.calls.some((c) => c.startsWith('publish')));
});

test('a run error ends the session and puts the ticket back with the message', async () => {
  const t = await setup({ scripts: { author: [started, { emit: { type: 'RUN_ERROR', message: 'the runner died', code: 'runner' } }] } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo');
  assert.equal(t.store.sessions.get(t.startedSessions[0]!.id)?.status, 'failed');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /the runner died/);
});

test('interrupt ends the turn; the session waits for the human and is not done', async () => {
  const t = await setup({ scripts: { author: [started, ...text('a1', 'Working.'), { awaitMessage: true }, ...text('a2', 'Again.'), { awaitMessage: true }] } });
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await t.engine.interrupt(id);
  await until(() => t.store.events.after(id).some((e) => e.event.type === 'RUN_FINISHED'));
  await t.engine.settled();
  assert.equal(t.startedSessions.length, 1, 'a cancelled turn is not the author finishing');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'In Progress');
});

test('a question waits in the inbox and an answer from the human closes it', async () => {
  const t = await setup({ scripts: { author: [started, { emit: { type: 'CUSTOM', name: 'cleared.question', value: { requestId: 'q1', questions: [{ question: 'Which date format?' }] } } }, { awaitMessage: true }, finished(0.1)] } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().length === 1);
  assert.equal(t.inbox.list()[0]?.kind, 'question');
  // The fake adapter has no request of its own for a question: the answer is refused cleanly, the item stays.
  await assert.rejects(t.engine.answer(t.startedSessions[0]!.id, 'q1', { kind: 'answer', answers: { 'Which date format?': 'ISO' } }, 'u1'));
  assert.equal(t.inbox.list()[0]?.state, 'waiting');
});

test('"Always in this project" saves the rule for the project, by the human who chose it', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(id) === 1);
  await t.engine.answer(id, 'request-1', { kind: 'allow_always', scope: 'project' }, 'u1');
  assert.deepEqual(t.store.policyRules.learned('guestbook'), [{ tool: 'Bash', pattern: 'touch test/fixtures/entries.json' }]);
});

test('an answer for a request that is not waiting is refused, and the unknown session too', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(id) === 1);
  await assert.rejects(t.engine.answer(id, 'nope', { kind: 'allow_once' }, 'u1'), /no request/i);
  await assert.rejects(t.engine.answer('missing', 'request-1', { kind: 'allow_once' }, 'u1'), /unknown session/i);
});

test('start refuses a ticket of another project, a missing ticket, and a ticket that already runs', async () => {
  const t = await setup();
  const other = await t.tickets.create({ title: 'x', project: 'elsewhere' }, human);
  await assert.rejects(t.engine.start(other.id, 'u1'), /project/);
  await assert.rejects(t.engine.start('LOCAL-99', 'u1'), /unknown ticket/);
  await t.engine.start(t.ticket.id, 'u1');
  await assert.rejects(t.engine.start(t.ticket.id, 'u1'), /already/);
});

test('a ticket in the go state cannot be started: the move to go is the human approval only', async () => {
  const t = await setup();
  await assert.rejects(t.tickets.move(t.ticket.id, 'Ready to Ship', human), TicketError);
});

test('the engine without an adapter for the harness fails the start and leaves the ticket in Todo', async () => {
  const t = await setup({ adapterless: true });
  await assert.rejects(t.engine.start(t.ticket.id, 'u1'), /no adapter/i);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
});

test('session summary and detail follow the events: phase, status, steps, files', async () => {
  const t = await setup({ scripts: { author: [started, { emit: { type: 'TOOL_CALL_START', toolCallId: 'e1', toolCallName: 'Edit' } }, { emit: { type: 'TOOL_CALL_ARGS', toolCallId: 'e1', delta: JSON.stringify({ kind: 'edit', path: 'src/entries.ts', added: 3, removed: 1 }) } }, permission, { awaitMessage: true }] } });
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(id) === 1);
  const detail = t.engine.sessionDetail(id);
  assert.equal(detail?.phase, 'waiting_human');
  assert.equal(detail?.status, 'Paused, waiting for you');
  assert.equal(detail?.ticket, t.ticket.id);
  assert.deepEqual(detail?.state.files, [{ path: 'src/entries.ts', added: 3, removed: 1 }]);
  assert.ok((detail?.lastSeq ?? 0) >= 4);
  assert.equal(t.engine.sessions().length, 1);
  assert.equal(t.engine.sessionDetail('missing'), undefined);
});

test('a ticket put back and started again gets its review rounds afresh', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_FIX), reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)] }, config: { maxReviewRounds: 2 } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === 'Todo' && !t.engine.isActive(t.ticket.id), 'the first flow out of rounds', 5000);
  assert.equal(t.recorder.records.length, 0);
  // A person starts it again: the first review of this flow asks for changes, which is round 1, so the author is reopened.
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item of the second flow', 5000);
  assert.equal(t.recorder.records.length, 1);
  assert.equal(t.recorder.records[0]?.round, 2, 'a request for change, then a pass: rounds 1 and 2 of this flow');
  const release = t.inbox.list().find((i): i is ReleaseItem => i.kind === 'release');
  assert.equal(release?.sessions.find((s) => s.role === 'reviewer')?.rounds, 2);
});

test('the release waits for approval without holding the ticket: a person can send it back, and the next tick settles the old item only', async () => {
  const t = await setup({ scripts: { authors: [quickAuthor, [started, ...text('a1', 'Again.'), { awaitMessage: true }]], reviewers: [reviewerScript(REPORT_PASS), reviewerScript(REPORT_PASS)] } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item');
  assert.equal(t.engine.isActive(t.ticket.id), false, 'the flow is over once the lock is asked');
  const firstReviewer = t.startedSessions[1]!.id;

  // "Send back": the human moves it to Todo, which starts a new flow.
  await t.tickets.move(t.ticket.id, 'Todo', human);
  await t.engine.start(t.ticket.id, 'u1');
  assert.equal(t.engine.isActive(t.ticket.id), true);
  await t.engine.tick();
  assert.equal(t.inbox.list().find((i) => i.kind === 'release')?.state, 'handled', 'the old release item is settled');
  assert.equal(t.engine.isActive(t.ticket.id), true, 'and the new flow keeps its marker');
  assert.equal(stepLines(t.store.events.after(firstReviewer)).at(-1), '-approval', 'the approval step closes on the session it started on');
  assert.deepEqual(stepLines(t.store.events.after(t.startedSessions[2]!.id)).includes('-approval'), false);
});

test('the release item carries the time the ticket store holds for the move to Needs Approval, whoever made the move', async () => {
  // A lock that does not move the card: the flow does, and the item has that time.
  const slow = await setup({ scripts: { author: quickAuthor }, effects: { async requestRelease() { slowClock.now += 5000; } } });
  const slowClock = slow.clock;
  await slow.engine.start(slow.ticket.id, 'u1');
  await until(() => kinds(slow).includes('release:waiting'));
  const moves = (await slow.tickets.history(slow.ticket.id)).filter((h) => h.status === 'Needs Approval');
  assert.equal(moves.length, 1);
  const item = slow.inbox.list().find((i): i is ReleaseItem => i.kind === 'release');
  assert.equal(item?.requestedAt, moves[0]?.at);
  assert.equal(item?.requestedAt, '2026-10-21T10:00:05.000Z');
  assert.equal(slow.recorder.records[0]?.at, '2026-10-21T10:00:00.000Z', 'the review is stamped when it passed');

  // A lock that moves the card itself, as ask-validation.sh does: no second move.
  let own: Setup | undefined;
  own = await setup({ scripts: { author: quickAuthor }, effects: { async requestRelease({ ticket }) { own!.clock.now += 7000; await own!.tickets.move(ticket, 'Needs Approval', { kind: 'agents', id: 'lock' }); own!.clock.now += 3000; } } });
  await own.engine.start(own.ticket.id, 'u1');
  await until(() => kinds(own!).includes('release:waiting'));
  const lockMoves = (await own.tickets.history(own.ticket.id)).filter((h) => h.status === 'Needs Approval');
  assert.equal(lockMoves.length, 1, 'the flow does not move a card the lock moved');
  assert.equal(own.inbox.list().find((i): i is ReleaseItem => i.kind === 'release')?.requestedAt, '2026-10-21T10:00:07.000Z');
});

test('a new engine closes the requests the last process left waiting, and keeps the releases', async () => {
  const t = await setup();
  t.inbox.addPermission({ ticket: 'LOCAL-1', project: 'guestbook', sessionId: 'old', requestId: 'r', tool: 'Bash', input: { kind: 'execute', command: 'x' }, suggestion: { decision: 'ask', rule: 'default', reason: 'x' } });
  t.inbox.addQuestion({ ticket: 'LOCAL-1', project: 'guestbook', sessionId: 'old', requestId: 'q', questions: [{ question: 'Which?' }] });
  t.inbox.addRelease({ ticket: 'LOCAL-1', project: 'guestbook', title: 't', announcement: 'a', requestedAt: 'x', pr: { number: 1, url: 'u', checks: 'pending' }, heads: [], captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [] });
  new (t.engine.constructor as new (deps: unknown) => unknown)(t.deps);
  assert.deepEqual(t.inbox.list().map((i) => `${i.kind}:${i.state}`).sort(), ['permission:handled', 'question:handled', 'release:waiting']);
});

test('a decision of the wrong kind for the item is refused: an answer to a permission, allow to a question', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(id) === 1);
  await assert.rejects(t.engine.answer(id, 'request-1', { kind: 'answer', answers: { a: 'b' } }, 'u1'), /allow or reject/);
  assert.equal(t.inbox.list()[0]?.state, 'waiting');
  const q = await setup({ scripts: { author: [started, { emit: { type: 'CUSTOM', name: 'cleared.question', value: { requestId: 'q1', questions: [{ question: 'Which?' }] } } }, { awaitMessage: true }] } });
  await q.engine.start(q.ticket.id, 'u1');
  await until(() => q.inbox.list().length === 1);
  await assert.rejects(q.engine.answer(q.startedSessions[0]!.id, 'q1', { kind: 'allow_once' }, 'u1'), /answered with an answer/);
});

test('a reopen whose message cannot be sent stops the resumed session and falls back to a new author', async () => {
  const stops: string[] = [];
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)], reopen: 'send_fails', stops } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => kinds(t).includes('release:waiting'), 'the release item', 5000);
  const authorId = t.startedSessions[0]!.id;
  assert.deepEqual(stops, [authorId]);
  assert.equal(t.startedSessions.filter((s) => s.input.role === 'author').length, 2);
});

test('reject_always is not a decision the API takes, and a store error on create is a 409, not a crash', async () => {
  const { createApiRoutes } = await import('../../src/api/routes.ts');
  const t = await setup();
  t.tickets.create = async () => { throw new TicketError('the store refuses this ticket'); };
  const routes = createApiRoutes({ engine: () => t.engine, proof: () => 'p'.repeat(64) });
  const call = async (path: string, body: unknown) => {
    const { createServer } = await import('node:http');
    const { dispatch } = await import('../../src/modules/registry.ts');
    const { handle } = await import('../../src/server.ts');
    const server = createServer((req, res) => dispatch({ registry: t.engine.registry, tables: [], routes }, req, res, handle));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, { method: 'POST', headers: { 'x-cleared-proof': 'p'.repeat(64), 'x-cleared-user': 'u1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return res.status;
    } finally { server.closeAllConnections(); server.close(); }
  };
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(id) === 1);
  assert.equal(await call(`/api/sessions/${id}/requests/request-1/answer`, { decision: { kind: 'reject_always', message: 'no' } }), 400);
  assert.equal(await call('/api/tickets', { title: 'x', project: 'guestbook' }), 409);
});
