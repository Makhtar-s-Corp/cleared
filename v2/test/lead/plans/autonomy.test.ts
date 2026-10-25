// A plan that no longer freezes (issue #290, lane j3-autonomy), over the
// real flow engine on the fake adapter and a simulated clock: a ticket put
// back twice gets one automatic third attempt, told what the reviewer asked
// last and the output of its last failing test run; a third put back holds
// it and says so in the lead's thread; a ticket parked on an unanswered
// question frees its slot. Either way the rest of the plan goes on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_TABLES } from '../../../src/lead/plans/store.ts';
import { DEFAULT_PLAN_CONFIG, PlanRunner, type PlanConfig } from '../../../src/lead/plans/runner.ts';
import { isTestCommand, retryContext } from '../../../src/lead/plans/retry.ts';
import { NOTIFY_TABLES } from '../../../src/notify/queue.ts';
import type { FakeStep } from '../../../src/session/adapters/fake.ts';
import { toolArgs, toolResult } from '../../../src/session/events.ts';
import { applyTables } from '../../../src/store/db.ts';
import { REPORT_FIX, quickAuthor, reviewerScript, setup, started, until, type SetupOptions } from '../../flow/support.ts';
import { recordingLead } from './support.ts';

const criteria = '\n\nAcceptance criteria\n- [ ] a test';
const item = (title: string, after: number[] = []) => ({ title, body: `${title}.${criteria}`, lane: 'full' as const, size: 's' as const, after });
const TWO = { goal: 'goal-1', title: 'Two changes', summary: 'Two independent changes.', items: [item('Entries as JSON'), item('Trimmed names')] };
const FAILURE = 'FAIL test/entries.test.ts\n  entries as JSON\n    expected 2 entries, got 3';

// An author that runs the tests, sees them fail, and dies.
const failingTests = (n: number): readonly FakeStep[] => [
  started,
  { emit: { type: 'TOOL_CALL_START', toolCallId: `test-${n}`, toolCallName: 'Bash' } },
  { emit: toolArgs(`test-${n}`, { kind: 'execute', command: 'npm test' }) },
  { emit: { type: 'TOOL_CALL_END', toolCallId: `test-${n}` } },
  { emit: toolResult(`test-${n}-result`, `test-${n}`, { kind: 'execute', output: FAILURE, cut: 0, isError: true }) },
  { emit: { type: 'RUN_ERROR', message: 'the runner died', code: 'runner' } },
];
const dies: readonly FakeStep[] = [started, { emit: { type: 'RUN_ERROR', message: 'the runner died', code: 'runner' } }];

async function plans(options: SetupOptions & { readonly plan?: Partial<PlanConfig> } = {}) {
  const t = await setup({ ...options, scripts: { author: quickAuthor, ...options.scripts } });
  applyTables(t.store.db, [...PLAN_TABLES, ...NOTIFY_TABLES]);
  const lead = recordingLead();
  const runner = new PlanRunner({
    store: t.store, inbox: t.inbox, tickets: t.tickets, flow: t.engine, lead, project: 'guestbook',
    config: { ...DEFAULT_PLAN_CONFIG, ...options.plan }, now: () => new Date(t.clock.now),
  });
  runner.listen();
  const settle = async () => {
    for (let i = 0; i < 5; i++) { await t.engine.settled(); await runner.settled(); }
  };
  const tick = async (ms = 30_000) => {
    t.clock.now += ms;
    await t.engine.tick();
    await settle();
    await runner.tick();
    await settle();
  };
  const itemsOf = (id: string) => runner.get(id)!.items;
  const authors = () => t.startedSessions.filter((s) => s.input.role === 'author');
  return { ...t, lead, runner, settle, tick, itemsOf, authors };
}

test('put back twice, a ticket gets a third attempt told the reviewer\'s last report and its failing tests; put back again, it is held, said in the lead\'s thread, and the next item starts', async () => {
  // Attempt 1: two review rounds ask for changes. Attempt 2: the tests fail and the session dies. Attempt 3: the same.
  const t = await plans({
    plan: { maxParallel: 1 },
    scripts: { authors: [quickAuthor, failingTests(2), failingTests(3)], reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_FIX)] },
  });
  const { plan } = await t.runner.propose(TWO);
  await t.runner.approve(plan, 'u1');
  // The two rounds reopen the author in the background.
  await until(() => t.itemsOf(plan)[0]!.state === 'put_back', 'the first put back');
  await t.settle();
  const first = t.itemsOf(plan)[0]!;
  assert.equal(first.state, 'put_back');
  assert.equal(first.putBacks, 1);
  assert.match(first.note ?? '', /after 2 review rounds/);

  await t.tick();
  assert.equal(t.authors().length, 2, 'started once more');
  await until(() => t.itemsOf(plan)[0]!.putBacks === 2, 'the second put back');
  assert.equal(t.itemsOf(plan)[0]!.state, 'put_back', 'a second put back is not the hold any more');
  assert.equal(t.itemsOf(plan)[0]!.putBacks, 2);
  assert.equal(t.itemsOf(plan)[1]!.state, 'ready', 'the item put back keeps its slot over the next one');

  await t.tick();
  assert.equal(t.authors().length, 3, 'the third attempt starts by itself');
  const third = t.authors()[2]!;
  assert.equal(third.input.ticket, first.ticket);
  assert.match(third.input.prompt, /third and last automatic attempt/);
  assert.match(third.input.prompt, /the runner died/, 'the last note');
  assert.match(third.input.prompt, /src\/entries\.ts:3 sorts the wrong way/, 'what the reviewer asked last');
  assert.match(third.input.prompt, /`npm test`/, 'the failing command');
  assert.match(third.input.prompt, /expected 2 entries, got 3/, 'its output');
  assert.match(third.input.prompt, /integrate the base branch first/);

  await until(() => t.itemsOf(plan)[0]!.state === 'held', 'the hold');
  await t.settle();
  assert.equal(t.itemsOf(plan)[0]!.putBacks, 3);
  const said = t.lead.lines.filter((line) => line.includes(first.ticket!));
  assert.equal(said.length, 1, 'the escalation is a line of the lead\'s thread');
  assert.match(said[0]!, /third time/);
  assert.match(said[0]!, /start_ticket/);
  assert.match(said[0]!, /rest of the plan goes on/);

  await t.tick();
  assert.equal(t.authors().length, 4, 'the next item starts in the freed slot');
  assert.equal(t.authors()[3]!.input.ticket, t.itemsOf(plan)[1]!.ticket);
  assert.equal(t.authors().filter((s) => s.input.ticket === first.ticket).length, 3, 'a held item is not started again by the runner');
  assert.equal(t.lead.lines.filter((line) => line.includes(first.ticket!)).length, 1, 'said once');
});

test('the third attempt of a ticket with no review and no test run says only its note', async () => {
  const t = await plans({ scripts: { authors: [dies, dies, dies] } });
  const { plan } = await t.runner.propose({ ...TWO, items: [item('Entries as JSON')] });
  await t.runner.approve(plan, 'u1');
  await t.settle();
  await t.tick();
  await t.tick();
  const third = t.authors()[2]!;
  assert.match(third.input.prompt, /third and last automatic attempt/);
  assert.doesNotMatch(third.input.prompt, /reviewer asked/);
  assert.doesNotMatch(third.input.prompt, /failing test run/);
  await t.settle();
  assert.equal(t.itemsOf(plan)[0]!.state, 'held');
});

test('the retry context: the reviewer\'s last report and the last failing test run of the ticket, cut and cleaned', async () => {
  const t = await setup();
  const at = (minutes: number) => new Date(t.clock.now + minutes * 60_000).toISOString();
  const ticket = t.ticket.id;
  const put = (id: string, role: 'author' | 'reviewer', minutes: number) =>
    t.store.sessions.put({ id, project: 'guestbook', ticket, role, harness: 'claude-code', model: 'claude-opus-5-5', status: 'done', createdAt: at(minutes), updatedAt: at(minutes) });
  const write = (sessionId: string, minutes: number, event: Parameters<typeof t.store.events.append>[0]['event']) => t.store.events.append({ at: at(minutes), sessionId, ticket, project: 'guestbook', event });
  put('author-1', 'author', 0);
  write('author-1', 1, { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'Bash' });
  write('author-1', 1, toolArgs('a', { kind: 'execute', command: 'npm run typecheck' }));
  write('author-1', 1, toolResult('a-r', 'a', { kind: 'execute', output: `old failure token-1234\n${'x'.repeat(9000)}\nthe end`, cut: 0, isError: true }));
  write('author-1', 2, toolArgs('b', { kind: 'execute', command: 'ls' }));
  write('author-1', 2, toolResult('b-r', 'b', { kind: 'execute', output: 'nothing here', cut: 0, isError: true }));
  write('author-1', 2, toolArgs('d', { kind: 'execute', command: 'cat test/missing.txt' }));
  write('author-1', 2, toolResult('d-r', 'd', { kind: 'execute', output: 'cat: test/missing.txt: No such file', cut: 0, isError: true }));
  write('author-1', 3, toolArgs('c', { kind: 'execute', command: 'npm test' }));
  write('author-1', 3, toolResult('c-r', 'c', { kind: 'execute', output: 'all green', cut: 0, isError: false }));
  put('reviewer-1', 'reviewer', 4);
  for (const event of [
    { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: REPORT_FIX },
    { type: 'TEXT_MESSAGE_END', messageId: 'm' },
  ] as const) write('reviewer-1', 5, event);

  const context = retryContext(t.store, ticket, (text) => text.replaceAll('token-1234', '[secret]'));
  assert.equal(context.review, REPORT_FIX);
  assert.equal(context.tests?.command, 'npm run typecheck', 'a failing test command, not a failing ls nor a passing run');
  assert.ok(context.tests!.output.length <= 4000, 'cut');
  assert.match(context.tests!.output, /the end$/, 'its end kept, where a test runner says what failed');
  assert.doesNotMatch(context.tests!.output, /token-1234/, 'cleaned');
  assert.deepEqual(retryContext(t.store, 'LOCAL-999', (text) => text), { review: undefined, tests: undefined });
});

test('a test command is a test runner, not a line that holds the word test (issue 299)', () => {
  for (const yes of ['npm test', 'npm run typecheck', 'npm run test:unit -- --watch=false', 'pnpm lint', 'npx vitest run', 'cd v2 && npm test', 'CI=1 npm test', 'node --test test/a.test.ts', 'pytest -x', 'python3 -m pytest', 'make test', 'cargo test', 'go test ./...'])
    assert.ok(isTestCommand(yes), yes);
  for (const no of ['cat test/x', 'ls tests', 'grep -r check src', 'git checkout test', 'echo lint', 'rm -rf test', 'npm install', 'npm run build', 'sed -n 1,5p vitest.config.ts', 'testify run'])
    assert.ok(!isTestCommand(no), no);
});

test('a ticket parked on an unanswered question frees its slot: the item is parked, not counted, said in the thread, and the next item starts; the lead may start it again', async () => {
  // Item 1's author asks a question with no declared answer; nobody answers it.
  const asks: readonly FakeStep[] = [started, { question: { requestId: 'q1', questions: [{ question: 'Which order?' }] } }];
  const t = await plans({ plan: { maxParallel: 1 }, scripts: { authors: [asks] } });
  const { plan } = await t.runner.propose(TWO);
  await t.runner.approve(plan, 'u1');
  await t.settle();
  const ticket = t.itemsOf(plan)[0]!.ticket!;
  const second = t.itemsOf(plan)[1]!.ticket!;
  await t.tick(30 * 60_000);
  assert.equal(t.itemsOf(plan)[0]!.state, 'running', 'at 30 min the lead is asked; the item still runs');
  assert.ok(!t.authors().some((s) => s.input.ticket === second), 'the next item waits for the slot');
  await t.tick(10 * 60_000);
  assert.equal(t.itemsOf(plan)[0]!.state, 'parked');
  assert.equal(t.itemsOf(plan)[0]!.putBacks, 0, 'a parked ticket did not fail');
  const said = t.lead.lines.filter((line) => line.includes(ticket));
  assert.equal(said.length, 1);
  assert.match(said[0]!, /parked/);
  assert.match(said[0]!, /Which order\?/);
  assert.match(said[0]!, /start_ticket/);

  await t.tick();
  assert.ok(t.authors().some((s) => s.input.ticket === second), 'the next item starts');
  assert.equal(t.itemsOf(plan)[0]!.state, 'parked', 'a tick leaves a parked item alone');
  assert.equal(t.authors().filter((s) => s.input.ticket === ticket).length, 1);
  assert.match(t.runner.stateLines(), /#1 parked/);

  await until(() => t.itemsOf(plan)[1]!.state === 'needs_approval', 'item 2 waits for its approval');
  await t.settle();
  const started_ = await t.runner.startTicket(ticket, 'The owner answered: newest first.');
  assert.deepEqual(started_, { started: ticket });
  await t.settle();
  const again = t.authors().filter((s) => s.input.ticket === ticket).at(-1)!;
  assert.match(again.input.prompt, /The owner answered: newest first\./);
});
