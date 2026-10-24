// The flow's event bus (docs/v2/milestone-2-plan.md, section 10): every
// FlowEvent is fired by a test of this file, after the write it reports.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import type { QuestionItem, ReleaseItem } from '../../src/api/types.ts';
import { FLOW_EVENT_TYPES, type FlowEvent } from '../../src/flow/events.ts';
import { REPORT_PASS, approved, finished, ledgerRow, quickAuthor, releaseRow, reviewerScript, setup, started, text, simulatedCi, until, type Setup } from './support.ts';

const fired = new Set<FlowEvent['type']>();
const record = (t: Setup) => { for (const e of t.flowEvents) fired.add(e.type); };
const of = <K extends FlowEvent['type']>(t: Setup, type: K) => t.flowEvents.filter((e): e is Extract<FlowEvent, { type: K }> => e.type === type);
const waiting = (t: Setup) => t.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting');

after(() => {
  assert.deepEqual(FLOW_EVENT_TYPES.filter((type) => !fired.has(type)), [], 'every FlowEvent is fired by a test of this file');
});

test('a whole ticket says, in order: started, permission raised and answered, author done, verdict, release requested and approved', async () => {
  const t = await setup();
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(author) === 1);
  const [permission] = of(t, 'permission_raised');
  assert.deepEqual({ ...permission, at: undefined }, {
    type: 'permission_raised', at: undefined, project: 'guestbook', ticket: t.ticket.id, session: author, requestId: 'request-1', item: `permission:${author}:request-1`, tool: 'Bash',
  });
  // Said after the write: the item is in the inbox when the listener runs.
  assert.equal(t.inbox.list()[0]?.id, permission?.item);
  await t.engine.answer(author, 'request-1', { kind: 'allow_once' }, 'u1');
  await t.engine.send(author, 'go on', 'u1');
  await until(() => waiting(t));
  await t.engine.settled();
  await t.tickets.recordApproval(t.ticket.id, { kind: 'human', id: 'u1' });
  await t.engine.tick();
  record(t);

  assert.deepEqual(t.flowEvents.map((e) => e.type), [
    'ticket_started', 'permission_raised', 'request_answered', 'author_done', 'review_verdict', 'release_requested', 'release_approved',
  ]);
  const [startedEvent] = of(t, 'ticket_started');
  assert.equal(startedEvent?.by, 'u1');
  assert.equal(startedEvent?.origin, null);
  assert.equal(startedEvent?.session, author);
  assert.deepEqual(of(t, 'request_answered').map((e) => [e.requestId, e.by, e.item]), [['request-1', 'u1', `permission:${author}:request-1`]]);
  assert.equal(of(t, 'author_done')[0]?.session, author);
  const reviewer = t.startedSessions[1]!.id;
  assert.deepEqual(of(t, 'review_verdict').map((e) => [e.session, e.verdict, e.round]), [[reviewer, 'pass', 1]]);
  const [requested] = of(t, 'release_requested');
  assert.equal(requested?.pr, 7);
  assert.equal(requested?.url, 'https://example.invalid/pull/7');
  assert.equal(requested?.session, reviewer);
  assert.equal(t.inbox.list().find((i) => i.kind === 'release')?.id, requested?.item);
  const [approval] = of(t, 'release_approved');
  assert.deepEqual([approval?.by, approval?.pr, approval?.item], ['u1', 7, requested?.item]);
  for (const e of t.flowEvents) {
    assert.equal(e.project, 'guestbook');
    assert.equal(e.ticket, t.ticket.id);
    assert.ok(!Number.isNaN(Date.parse(e.at)));
  }
});

test('merged and landed follow the approval; a rollback says rolled_back, then the put back', async () => {
  const landed = await setup({ scripts: { author: quickAuthor } });
  await approved(landed);
  landed.clock.now += 60_000;
  await landed.engine.tick();
  await landed.engine.settled();
  releaseRow(landed.store, { ticket: landed.ticket.id, pr: 7, status: 'complete', mergedAt: new Date(landed.clock.now).toISOString() });
  ledgerRow(landed.store, { kind: 'release_watch_complete', ticket: landed.ticket.id, pr: 7, at: new Date(landed.clock.now + 1000).toISOString() });
  landed.clock.now += 60_000;
  await landed.engine.tick();
  await landed.engine.settled();
  record(landed);
  assert.deepEqual(landed.flowEvents.map((e) => e.type).slice(-2), ['release_merged', 'release_landed']);

  const back = await setup({ scripts: { author: quickAuthor } });
  await approved(back);
  back.clock.now += 60_000;
  await back.engine.tick();
  await back.engine.settled();
  ledgerRow(back.store, { kind: 'rollback_pushed', ticket: back.ticket.id, pr: 7, at: new Date(back.clock.now + 1000).toISOString(), detail: 'reverted' });
  back.clock.now += 60_000;
  await back.engine.tick();
  await back.engine.settled();
  record(back);
  assert.deepEqual(back.flowEvents.map((e) => e.type).slice(-3), ['release_merged', 'rolled_back', 'ticket_put_back']);
});

test('a watch that ends failing says release_unhealthy', async () => {
  const t = await setup({ scripts: { author: quickAuthor } });
  await approved(t);
  t.clock.now += 60_000;
  await t.engine.tick();
  await t.engine.settled();
  ledgerRow(t.store, { kind: 'release_watch_failed', ticket: t.ticket.id, pr: 7, at: new Date(t.clock.now + 1000).toISOString(), detail: 'the monitor stopped' });
  t.clock.now += 60_000;
  await t.engine.tick();
  await t.engine.settled();
  record(t);
  assert.equal(t.flowEvents.at(-1)?.type, 'release_unhealthy');
});

test('a question raised and answered by its session', async () => {
  const t = await setup({
    scripts: {
      author: [started, { emit: { type: 'CUSTOM', name: 'cleared.question', value: { requestId: 'q1', questions: [{ question: 'Which date format?' }] } } },
        { emit: { type: 'CUSTOM', name: 'cleared.answered', value: { requestId: 'q1', by: 'u1' } } }, { awaitMessage: true }],
    },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.flowEvents.some((e) => e.type === 'request_answered'));
  record(t);
  const author = t.startedSessions[0]!.id;
  assert.deepEqual(of(t, 'question_raised').map((e) => [e.requestId, e.item]), [['q1', `question:${author}:q1`]]);
  assert.deepEqual(of(t, 'request_answered').map((e) => [e.requestId, e.by]), [['q1', 'u1']]);
});

test('a stopped session and its ticket put back say why: idle, then a failed run', async () => {
  const idle = await setup({ scripts: { author: [started, ...text('a1', 'Thinking.'), { awaitMessage: true }] } });
  await idle.engine.start(idle.ticket.id, 'u1');
  await idle.engine.settled();
  idle.clock.now += 15 * 60_000;
  await idle.engine.tick();
  record(idle);
  assert.deepEqual(of(idle, 'session_stopped').map((e) => [e.session, e.role, e.phase]), [[idle.startedSessions[0]!.id, 'author', 'stopped']]);
  assert.match(of(idle, 'session_stopped')[0]?.reason ?? '', /15 minutes/);
  assert.deepEqual(of(idle, 'ticket_put_back').map((e) => e.reason), ['idle']);
  // Said after the move: the ticket is in Todo when the listener runs.
  assert.equal((await idle.tickets.get(idle.ticket.id))?.status, 'Todo');

  const failed = await setup({ scripts: { author: [started, { emit: { type: 'RUN_ERROR', message: 'the runner died', code: 'runner' } }] } });
  await failed.engine.start(failed.ticket.id, 'u1');
  await until(() => failed.flowEvents.some((e) => e.type === 'ticket_put_back'));
  assert.deepEqual(of(failed, 'session_stopped').map((e) => e.phase), ['failed']);
  assert.deepEqual(of(failed, 'ticket_put_back').map((e) => e.reason), ['failed']);
});

test('each way the flow puts a ticket back names its reason', async () => {
  const noVerdict = await setup({ scripts: { author: quickAuthor, reviewers: [[started, ...text('r1', 'Fine.'), finished(0.1)]] } });
  await noVerdict.engine.start(noVerdict.ticket.id, 'u1');
  await until(() => noVerdict.flowEvents.some((e) => e.type === 'ticket_put_back'));
  assert.deepEqual(of(noVerdict, 'ticket_put_back').map((e) => e.reason), ['no_verdict']);

  const refused = await setup({ scripts: { author: quickAuthor }, effects: { async publish() { throw new Error('the guard refuses it'); } } });
  await refused.engine.start(refused.ticket.id, 'u1');
  await until(() => refused.flowEvents.some((e) => e.type === 'ticket_put_back'));
  assert.deepEqual(of(refused, 'ticket_put_back').map((e) => [e.reason, /guard refuses it/.test(e.note)]), [['publish_refused', true]]);

  const lock = await setup({ scripts: { author: quickAuthor }, effects: { async requestRelease() { throw new Error('the lock is down'); } } });
  await lock.engine.start(lock.ticket.id, 'u1');
  await until(() => lock.flowEvents.some((e) => e.type === 'ticket_put_back'));
  assert.deepEqual(of(lock, 'ticket_put_back').map((e) => e.reason), ['release_refused']);

  const budget = await setup({ scripts: { author: [started, ...text('a1', 'Expensive.'), finished(6.5)] }, config: { budgetUsd: 5 } });
  await budget.engine.start(budget.ticket.id, 'u1');
  await until(() => budget.flowEvents.some((e) => e.type === 'ticket_put_back'));
  assert.deepEqual(of(budget, 'ticket_put_back').map((e) => e.reason), ['budget']);

  const start = await setup({ scripts: { author: quickAuthor }, effects: { async prepareWorkdir() { throw new Error('no clone'); } } });
  await assert.rejects(start.engine.start(start.ticket.id, 'u1'), /no clone/);
  assert.deepEqual(of(start, 'ticket_put_back').map((e) => e.reason), ['start_failed']);
  assert.deepEqual(of(start, 'ticket_started'), [], 'a start that failed was never started');
});

test('a ticket started for a plan says its origin, in the event and in the comment, and the note reaches the author', async () => {
  const t = await setup({ scripts: { author: quickAuthor } });
  await t.engine.start(t.ticket.id, 'u1', { plan: 'plan-1', item: 3, note: 'Integrate the base branch first.' });
  record(t);
  assert.deepEqual(of(t, 'ticket_started')[0]?.origin, { plan: 'plan-1', item: 3, note: 'Integrate the base branch first.' });
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /Started by the lead for plan plan-1 \(item 3\), approved by u1\./);
  assert.match(t.startedSessions[0]!.input.prompt, /Integrate the base branch first\./);
  assert.match(t.startedSessions[0]!.input.prompt, /Newest entry first/);
});

test('an approval the lock merged and moved to Done before the tick is still the human\'s approval', async () => {
  const t = await setup({ scripts: { author: quickAuthor } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => waiting(t));
  await t.engine.settled();
  await t.tickets.recordApproval(t.ticket.id, { kind: 'human', id: 'u1' });
  await t.tickets.move(t.ticket.id, 'Done', { kind: 'agents', id: 'lock' });
  await t.engine.tick();
  assert.deepEqual(of(t, 'release_approved').map((e) => [e.by, e.pr]), [['u1', 7]]);
  const item = t.store.db.prepare("SELECT handled_by FROM flow_inbox WHERE kind = 'release'").get() as { handled_by: string };
  assert.equal(item.handled_by, 'u1');
});

test('a release sent back by a person is not an approval', async () => {
  const t = await setup({ scripts: { author: quickAuthor } });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => waiting(t));
  await t.engine.settled();
  await t.tickets.move(t.ticket.id, 'Todo', { kind: 'human', id: 'u1' });
  await t.engine.tick();
  assert.equal(t.inbox.list().find((i) => i.kind === 'release')?.state, 'handled');
  assert.deepEqual(of(t, 'release_approved'), []);
});

test('a listener that throws or rejects is logged and dropped; the others and the flow go on; unsubscribe stops the calls', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });
  const errors: string[] = [];
  const log = console.error;
  console.error = (line: unknown) => { errors.push(String(line)); };
  try {
    t.engine.subscribe(() => { throw new Error('a secret path /home/x'); });
    t.engine.subscribe(async () => { throw new Error('rejected'); });
    const seen: string[] = [];
    const stop = t.engine.subscribe((e) => { seen.push(e.type); });
    await t.engine.start(t.ticket.id, 'u1');
    await until(() => waiting(t));
    await t.engine.settled();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seen[0], 'ticket_started');
    assert.ok(t.flowEvents.some((e) => e.type === 'release_requested'), 'the flow went on');
    assert.ok(errors.length >= 2);
    assert.ok(errors.every((line) => !line.includes('/home/x')), 'the log names the error class, not its message');
    stop();
    const count = seen.length;
    await t.tickets.recordApproval(t.ticket.id, { kind: 'human', id: 'u1' });
    await t.engine.tick();
    assert.equal(seen.length, count);
  } finally {
    console.error = log;
  }
});

test('a team\'s question past its delay says question_timed_out, after the inbox item has the time the lead was asked (issue #290)', async () => {
  const t = await setup({ scripts: { author: [started, { question: { requestId: 'q1', questions: [{ question: 'Which order?', options: [{ label: 'Newest first (Recommended)' }] }] } }] } });
  await t.engine.start(t.ticket.id, 'u1');
  const author = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(author) === 1);
  await t.engine.settled();
  let leadAt: string | undefined;
  t.engine.subscribe((event) => {
    if (event.type === 'question_timed_out') leadAt = t.inbox.items().find((i): i is QuestionItem => i.kind === 'question' && i.state === 'waiting')?.timeout?.leadAt;
  });
  t.clock.now += 30 * 60_000;
  await t.engine.tick();
  record(t);
  const [timedOut] = of(t, 'question_timed_out');
  assert.deepEqual({ ...timedOut, at: undefined }, {
    type: 'question_timed_out', at: undefined, project: 'guestbook', ticket: t.ticket.id, session: author, requestId: 'q1', item: `question:${author}:q1`,
    stage: 'lead', minutes: 30, leadMinutes: 10, questions: ['Which order?'], answers: { 'Which order?': 'Newest first (Recommended)' },
  });
  assert.equal(leadAt, new Date(t.clock.now).toISOString(), 'said after the write');
});

test('a repair of failed checks says ci_repair at each step, after the card says it (issue #273)', async () => {
  const ci = simulatedCi(['failed', 'passed']);
  const t = await setup({ scripts: { author: quickAuthor }, effects: ci.effects });
  const card = () => t.inbox.list().filter((i): i is ReleaseItem => i.kind === 'release').sort((a, b) => Date.parse(b.since) - Date.parse(a.since) || b.requestedAt.localeCompare(a.requestedAt))[0];
  const said: (string | undefined)[] = [];
  t.engine.subscribe((event) => { if (event.type === 'ci_repair') said.push(card()?.repair?.state); });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => waiting(t), 'the release card', 5000);
  await t.engine.settled();
  t.clock.now += 61_000;
  await t.engine.tick();
  await until(() => t.inbox.list().filter((i) => i.kind === 'release').length === 2 && waiting(t), 'the repair\'s card', 5000);
  await t.engine.settled();
  t.clock.now += 61_000;
  await t.engine.tick();
  record(t);
  const events = of(t, 'ci_repair');
  assert.deepEqual(events.map((e) => ({ ...e, at: undefined })), [
    { type: 'ci_repair', at: undefined, project: 'guestbook', ticket: t.ticket.id, pr: 7, attempt: 1, limit: 2, state: 'started', checks: ['test'] },
    { type: 'ci_repair', at: undefined, project: 'guestbook', ticket: t.ticket.id, pr: 7, attempt: 1, limit: 2, state: 'pushed', checks: ['test'] },
    { type: 'ci_repair', at: undefined, project: 'guestbook', ticket: t.ticket.id, pr: 7, attempt: 1, limit: 2, state: 'repaired', checks: ['test'] },
  ]);
  assert.deepEqual(said, ['started', 'pushed', 'repaired'], 'said after the card has it');
  await t.engine.close();
});
