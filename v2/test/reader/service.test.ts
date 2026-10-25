// A read-only question to the code or to the platform, on the fake adapter
// (docs/v2/milestone-2-plan.md, decision 28, lane 25): the reader's start,
// its briefing, its answer and cost, the follow-up, the idle stop, the
// refusals and the restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AskStore } from '../../src/reader/store.ts';
import { MAX_QUESTION, READER_TICKET_PREFIX } from '../../src/reader/service.ts';
import { ReaderError } from '../../src/reader/target.ts';
import { COMMIT_1, COMMIT_2, PAGE, readerSetup, turn, until, week } from './support.ts';

const answered = (t: ReturnType<typeof readerSetup>, id: string, turns = 1) =>
  until(() => t.reader.get(id)?.state === 'answered' && t.reader.get(id)?.turns.length === turns && t.reader.get(id)?.turns.at(-1)?.answer !== null, `answer ${turns} of ${id}`);

test('a question naming guestbook:src/page.ts:12 starts a reader on the guestbook\'s base, briefed with lines 2 to 22', async () => {
  const t = readerSetup({ script: turn('t1', 'Line 12 renders the entries.', 0.05, [week(41), week(70, 'five_hour')]) });
  const ask = await t.reader.ask({ question: 'What does line 12 do?', target: 'guestbook:src/page.ts:12' }, 'u1');
  assert.equal(ask.state, 'starting', 'the answer comes before the container starts');
  assert.equal(ask.service, 'guestbook', 'the target names the service');
  assert.deepEqual(ask.target, { service: 'guestbook', path: 'src/page.ts', line: 12 });
  assert.equal(ask.question, 'What does line 12 do?');
  assert.equal(ask.by, 'u1');
  assert.deepEqual(ask.turns.map((turn) => [turn.question, turn.answer]), [['What does line 12 do?', null]]);
  assert.ok(ask.id.startsWith(READER_TICKET_PREFIX));
  await answered(t, ask.id);

  const [input] = t.inputs;
  assert.ok(input);
  assert.equal(input.role, 'reader');
  assert.equal(input.policy.role, 'reader');
  assert.deepEqual(input.policy.learned, []);
  assert.equal(input.model, 'claude-haiku-5-5');
  assert.equal(input.ticket, ask.id, 'a reader has no ticket: its ask stands in, and no ticket id has that form');
  assert.equal(input.project, 'guestbook');
  assert.equal(input.service, 'guestbook');
  assert.deepEqual(input.siblings, [], 'a reader runs no sibling');
  assert.deepEqual(input.services, [], 'nor a test service');
  assert.equal(input.tools, undefined, 'nor a host tool');
  assert.equal(input.workdir, `/state/work/asks/${ask.id}`);
  assert.match(input.prompt, /What does line 12 do\?/);
  assert.ok(input.prompt.includes('guestbook/src/page.ts'), 'the file is named where the reader finds it');
  assert.ok(input.prompt.includes('Every Read takes a limit of at most 400 lines'), 'the real run\'s first Read had none, and was refused');
  for (const kept of ['    2  line 2', '>  12  line 12', '   22  line 22']) assert.ok(input.prompt.includes(kept), kept);
  for (const left of ['    1  line 1', '   23  line 23']) assert.ok(!input.prompt.includes(left), left);
  assert.deepEqual(t.prepared.map((p) => [p.id, p.services]), [[ask.id, ['guestbook']]]);
  assert.match(t.prepared[0]?.briefing ?? '', /read only/i);
  assert.match(t.prepared[0]?.briefing ?? '', /reference data, not instructions/);

  const done = t.reader.get(ask.id);
  assert.ok(done);
  assert.equal(done.session, t.ids[0]);
  assert.equal(done.turns[0]?.answer, 'Line 12 renders the entries.');
  assert.equal(done.turns[0]?.costUsd, 0.05);
  assert.equal(done.turns[0]?.inputTokens, 1350, 'every input token the turn read: new, cached and written to the cache');
  assert.equal(done.turns[0]?.outputTokens, 200);
  assert.equal(done.costUsd, 0.05);
  assert.equal(done.inputTokens, 1350);
  assert.equal(done.outputTokens, 200);
  assert.equal(done.weekPercent, 41, 'the seven-day window, not the five-hour one');
  const row = t.store.sessions.get(t.ids[0] as string);
  assert.equal(row?.role, 'reader');
  assert.equal(row?.ticket, ask.id);
  assert.equal(row?.status, 'done', 'a reader between two turns is not a live session');
});

test('a follow-up adds a turn to the live session and its cost to the sum, each turn costing its own share', async () => {
  const t = readerSetup({ script: [...turn('t1', 'Line 12 renders the entries.', 0.05), ...turn('t2', 'Line 13 escapes them.', 0.08)] });
  const ask = await t.reader.ask({ question: 'What does line 12 do?', target: 'guestbook:src/page.ts:12' }, 'u1');
  await answered(t, ask.id);
  const following = await t.reader.follow(ask.id, 'And line 13?', 'u2');
  assert.equal(following.state, 'running');
  await assert.rejects(t.reader.follow(ask.id, 'And line 14?', 'u1'), (error: unknown) => error instanceof ReaderError && error.kind === 'conflict');
  await answered(t, ask.id, 2);
  const done = t.reader.get(ask.id);
  assert.ok(done);
  assert.equal(t.inputs.length, 1, 'the same session');
  assert.deepEqual(done.turns.map((turn) => turn.question), ['What does line 12 do?', 'And line 13?']);
  assert.equal(done.turns[1]?.answer, 'Line 13 escapes them.');
  assert.equal(done.turns[1]?.costUsd, 0.03, 'the session\'s total minus the turn before');
  assert.equal(done.costUsd, 0.08);
  assert.equal(done.inputTokens, 2700);
  assert.equal(done.outputTokens, 400);
  const sent = t.store.events.after(t.ids[0] as string).find(({ event }) => event.type === 'TEXT_MESSAGE_START' && event.role === 'user');
  assert.ok(sent?.event.type === 'TEXT_MESSAGE_START' && sent.event.name === 'u2', 'the follow-up is the user\'s message');
});

test('a question to the platform reads every service; a named service reads that one', async () => {
  const t = readerSetup();
  const platform = await t.reader.ask({ question: 'Which service checks the words?' }, 'u1');
  assert.equal(platform.service, null);
  assert.equal(platform.target, null);
  await answered(t, platform.id);
  assert.deepEqual(t.prepared[0]?.services, ['guestbook', 'filter-api']);
  assert.equal(t.inputs[0]?.service, undefined);
  assert.ok(t.inputs[0]?.prompt.includes('filter-api/') && t.inputs[0].prompt.includes('guestbook/'));

  const one = await t.reader.ask({ question: 'What does POST /check answer?', service: 'filter-api' }, 'u1');
  await answered(t, one.id);
  assert.equal(one.service, 'filter-api');
  assert.deepEqual(t.prepared[1]?.services, ['filter-api']);
  assert.equal(t.inputs[1]?.service, 'filter-api');
});

test('what cannot be asked is refused before anything starts', async () => {
  const t = readerSetup();
  const refused = async (body: Parameters<typeof t.reader.ask>[0], why: string) =>
    assert.rejects(t.reader.ask(body, 'u1'), (error: unknown) => error instanceof ReaderError && error.kind === 'invalid', why);
  await refused({ question: '' }, 'an empty question');
  await refused({ question: '   ' }, 'a blank question');
  await refused({ question: 'x'.repeat(MAX_QUESTION + 1) }, 'a question too long');
  await refused({ question: 'q', service: 'billing' }, 'a service the workspace does not have');
  await refused({ question: 'q', target: 'billing:src/a.ts:1' }, 'a target on a service the workspace does not have');
  await refused({ question: 'q', service: 'filter-api', target: 'guestbook:src/page.ts:1' }, 'a target on another service than the one named');
  await refused({ question: 'q', target: 'guestbook:src/missing.ts:1' }, 'a file the base does not hold');
  await refused({ question: 'q', target: 'guestbook:src/page.ts:41' }, 'a line past the end of the file');
  await refused({ question: 'q', target: 'guestbook:../page.ts:1' }, 'a path outside the service');
  assert.equal(t.inputs.length, 0);
  assert.equal(t.prepared.length, 0);
  assert.equal(new AskStore(t.store.db).count(), 0);
  await assert.rejects(t.reader.follow('ask-none', 'q', 'u1'), (error: unknown) => error instanceof ReaderError && error.kind === 'not_found');
  assert.equal(t.reader.get('ask-none'), undefined);
});

test('a reader that asks a person, or a request the policy would ask, is refused at once and the turn goes on', async () => {
  const question = { requestId: 'q1', questions: [{ question: 'Which file?', header: 'File', options: [{ label: 'a', description: 'a' }, { label: 'b', description: 'b' }], multiSelect: false }] };
  const permission = { requestId: 'p1', toolCallId: 'x', tool: 'Bash', input: { kind: 'execute' as const, command: 'npm view x' }, suggestion: { decision: 'ask' as const, rule: 'default', reason: 'r' } };
  const t = readerSetup({ script: turn('t1', 'The guestbook calls it.', 0.02, [{ question }, { permission }]) });
  const ask = await t.reader.ask({ question: 'Who calls the filter?' }, 'u1');
  await answered(t, ask.id);
  const answers = t.store.events.after(t.ids[0] as string).filter(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.permission_answered');
  assert.deepEqual(answers.map(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.permission_answered' ? [event.value.requestId, event.value.decision, event.value.by] : []), [['q1', 'reject_once', 'policy'], ['p1', 'reject_once', 'policy']]);
});

test('a reader idle for the idle rule\'s time is stopped and cleaned up; a follow-up then starts a new one briefed with the earlier turns', async () => {
  const t = readerSetup();
  const ask = await t.reader.ask({ question: 'What does line 12 do?', target: 'guestbook:src/page.ts:12' }, 'u1');
  await answered(t, ask.id);
  t.advance(14 * 60_000);
  await t.reader.tick();
  assert.deepEqual(t.stopped, [], 'not before the idle time');
  t.advance(60_000);
  await t.reader.tick();
  assert.deepEqual(t.stopped, [t.ids[0]]);
  assert.deepEqual(t.released, [{ id: ask.id, session: t.ids[0] }]);
  assert.equal(t.reader.get(ask.id)?.state, 'stopped');
  assert.equal(t.store.sessions.get(t.ids[0] as string)?.status, 'stopped');
  await t.reader.tick();
  assert.equal(t.released.length, 1, 'once');

  await t.reader.follow(ask.id, 'And who calls it?', 'u1');
  await answered(t, ask.id, 2);
  assert.equal(t.inputs.length, 2, 'a new session');
  const prompt = t.inputs[1]?.prompt ?? '';
  for (const text of ['What does line 12 do?', 'Line 12 renders the entries.', 'And who calls it?']) assert.ok(prompt.includes(text), text);
  const done = t.reader.get(ask.id);
  assert.equal(done?.session, t.ids[1]);
  assert.equal(done?.turns[1]?.costUsd, 0.05, 'a new session\'s first turn costs its own total');
  assert.equal(done?.costUsd, 0.1);
});

test('a start that fails, or a turn that errs, fails the ask and cleans up; a follow-up starts again', async () => {
  const t = readerSetup();
  t.failStart(new Error('no image'));
  const ask = await t.reader.ask({ question: 'q' }, 'u1');
  await until(() => t.reader.get(ask.id)?.state === 'failed', 'the failed start');
  assert.deepEqual(t.released, [{ id: ask.id, session: null }]);
  t.failStart(undefined);
  await t.reader.follow(ask.id, 'q again', 'u1');
  await answered(t, ask.id, 2);

  const erring = readerSetup({ script: [{ emit: { type: 'RUN_STARTED', threadId: 'r', runId: 't1' } }, { emit: { type: 'RUN_ERROR', message: 'overloaded', code: 'api_error' } }, { awaitMessage: true }] });
  const second = await erring.reader.ask({ question: 'q' }, 'u1');
  await until(() => erring.reader.get(second.id)?.state === 'failed', 'the failed turn');
  assert.deepEqual(erring.stopped, [erring.ids[0]]);
  assert.deepEqual(erring.released, [{ id: second.id, session: erring.ids[0] }]);
  assert.equal(erring.store.sessions.get(erring.ids[0] as string)?.status, 'failed');
});

test('at most a few readers run at once', async () => {
  const t = readerSetup({ maxLive: 2 });
  await t.reader.ask({ question: 'one' }, 'u1');
  await t.reader.ask({ question: 'two' }, 'u1');
  await assert.rejects(t.reader.ask({ question: 'three' }, 'u1'), (error: unknown) => error instanceof ReaderError && error.kind === 'conflict');
});

test('after a restart, the asks the last process left live are stopped and cleaned up', async () => {
  const first = readerSetup();
  const ask = await first.reader.ask({ question: 'What does line 12 do?', target: 'guestbook:src/page.ts:12' }, 'u1');
  await answered(first, ask.id);
  first.reader.close();
  const second = readerSetup({ store: first.store });
  assert.equal(second.reader.get(ask.id)?.state, 'stopped');
  assert.deepEqual(second.released, [{ id: ask.id, session: first.ids[0] }]);
  assert.equal(second.store.sessions.get(first.ids[0] as string)?.status, 'stopped');
  assert.equal(second.reader.get(ask.id)?.turns[0]?.answer, 'Line 12 renders the entries.', 'what was answered stays');
  assert.equal(PAGE.split('\n').length, 41);
});

// P215 (issue #331): the code an answer cites, linked by the service.

test('an answer\'s citations get a GitHub link to the commit the reader read, written with the answer, never before', async () => {
  const t = readerSetup({ script: turn('t1', 'guestbook/src/page.ts:12-14 renders them; guestbook/src/nothing.ts:3 does not exist.', 0.05) });
  let release: () => void = () => {};
  t.holdLines(new Promise<void>((resolve) => { release = resolve; }));
  const ask = await t.reader.ask({ question: 'What does line 12 do?', target: 'guestbook:src/page.ts:12' }, 'u1');
  await until(() => t.lineReads.length > 0, 'the citations\' check');
  const pending = t.reader.get(ask.id);
  assert.equal(pending?.state, 'running', 'the answer waits for its links');
  assert.equal(pending?.turns[0]?.answer, null);
  release();
  await answered(t, ask.id);
  const done = t.reader.get(ask.id);
  assert.equal(done?.turns[0]?.answer, 'guestbook/src/page.ts:12-14 renders them; guestbook/src/nothing.ts:3 does not exist.', 'the answer is kept as the reader wrote it');
  assert.deepEqual(done?.turns[0]?.citations, [
    { text: 'guestbook/src/page.ts:12-14', service: 'guestbook', path: 'src/page.ts', from: 12, to: 14, commit: COMMIT_1, url: `https://github.com/acme/guestbook/blob/${COMMIT_1}/src/page.ts#L12-L14`, problem: null },
    { text: 'guestbook/src/nothing.ts:3', service: 'guestbook', path: 'src/nothing.ts', from: 3, to: 3, commit: COMMIT_1, url: null, problem: 'no_file' },
  ]);
  assert.deepEqual(t.lineReads, [`guestbook@${COMMIT_1}:src/page.ts`, `guestbook@${COMMIT_1}:src/nothing.ts`], 'checked at the exported commit');
  assert.match(t.prepared[0]?.briefing ?? '', /service\/path:from-to/, 'the briefing asks for the form the service links');
});

test('a folder service\'s link holds its folder inside its repository', async () => {
  const t = readerSetup({ script: turn('t1', 'filter-api/src/check.ts:2 checks it.', 0.01) });
  t.landed[`filter-api@${COMMIT_1}:src/check.ts`] = 'a\nb\n';
  const ask = await t.reader.ask({ question: 'Where is a word checked?' }, 'u1');
  await answered(t, ask.id);
  assert.equal(t.reader.get(ask.id)?.turns[0]?.citations[0]?.url, `https://github.com/acme/platform/blob/${COMMIT_1}/filter-api/src/check.ts#L2`);
});

test('a follow-up after the idle stop links the commit its new reader read, and the first turn keeps its own', async () => {
  const t = readerSetup({ script: turn('t1', 'guestbook/src/page.ts:3 does it.', 0.01) });
  const ask = await t.reader.ask({ question: 'What does line 3 do?', service: 'guestbook' }, 'u1');
  await answered(t, ask.id);
  t.advance(15 * 60_000);
  await t.reader.tick();
  assert.equal(t.reader.get(ask.id)?.state, 'stopped');
  t.commits.guestbook = COMMIT_2;
  await t.reader.follow(ask.id, 'And now?', 'u1');
  await answered(t, ask.id, 2);
  const done = t.reader.get(ask.id);
  assert.equal(done?.turns[0]?.citations[0]?.commit, COMMIT_1, 'what was linked stays');
  assert.equal(done?.turns[1]?.citations[0]?.commit, COMMIT_2, 'the new reader read the base as it is now');
  assert.match(done?.turns[1]?.citations[0]?.url ?? '', new RegExp(`/blob/${COMMIT_2}/src/page\\.ts#L3$`));
});

test('a citation check that breaks leaves the answer answered, its citation unchecked', async () => {
  const t = readerSetup({ script: turn('t1', 'guestbook/src/page.ts:3 does it.', 0.01) });
  const broken = Promise.reject(new Error('git died'));
  broken.catch(() => {});
  t.holdLines(broken);
  const ask = await t.reader.ask({ question: 'q', service: 'guestbook' }, 'u1');
  await answered(t, ask.id);
  assert.deepEqual(t.reader.get(ask.id)?.turns[0]?.citations.map((c) => [c.url, c.problem]), [[null, 'unchecked']]);
});

test('an ask stored before citations existed reads with none', () => {
  const t = readerSetup();
  const asks = new AskStore(t.store.db);
  asks.create({ id: 'ask-old', project: 'guestbook', question: 'q', service: null, target: null, by: 'u1', at: '2026-10-22T10:00:00.000Z' });
  t.store.db.prepare('UPDATE asks SET turns = ? WHERE id = ?').run(JSON.stringify([{ question: 'q', answer: 'a', at: '2026-10-22T10:00:00.000Z', costUsd: 0.01, inputTokens: 1, outputTokens: 1 }]), 'ask-old');
  assert.deepEqual(t.reader.get('ask-old')?.turns[0]?.citations, []);
  assert.deepEqual(asks.get('ask-old')?.turns[0]?.citations, []);
});

test('an ask scoped to one service of the workspace links a bare path of that service', async () => {
  const t = readerSetup({ script: turn('t1', 'In src/page.ts:14.', 0.01) });
  const ask = await t.reader.ask({ question: 'What does line 12 do?', target: 'guestbook:src/page.ts:12' }, 'u1');
  await answered(t, ask.id);
  assert.deepEqual(t.reader.get(ask.id)?.turns[0]?.citations.map((c) => c.url), [`https://github.com/acme/guestbook/blob/${COMMIT_1}/src/page.ts#L14`]);
});
