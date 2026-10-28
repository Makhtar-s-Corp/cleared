// A session whose container stops before its work is done (issue #453): the
// flow keeps what a resume needs (the session's id, its checkout, its input,
// its phase), removes what the dead container left, recreates the container
// through the adapter's resume after a wait that grows, and tells the
// session to carry on. At most CONTAINER_RECREATIONS times; then the session
// fails with its reason and its ticket goes back to Todo, with no loop. A
// session the owner took over is never recreated by the flow (P25), and one
// that waits for a person waits for the answer before its container is made
// again, so nothing runs a turn meanwhile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdapter, type FakeAdapter, type FakeStep } from '../../src/session/adapters/fake.ts';
import { CONTAINER_LOST, type SessionAdapter, type SessionHandle, type SessionId, type StartInput } from '../../src/session/contract.ts';
import type { AgUiEvent, SessionEvent } from '../../src/session/events.ts';
import { CONTAINER_FAILED, CONTAINER_RECREATIONS } from '../../src/flow/engine.ts';
import { REPORT_PASS, finished, permission, reviewerScript, setup, started, text, until, type Setup, type SetupOptions } from './support.ts';

const lose: FakeStep = { lose: 137 };
const carriesOn: readonly FakeStep[] = [{ awaitMessage: true }, started, ...text('a2', 'Sorted, the draft kept.'), finished(0.3)];
const losesAgain: readonly FakeStep[] = [{ awaitMessage: true }, started, lose];

type Crash = Setup & {
  readonly fakes: FakeAdapter[];
  readonly authors: SessionId[];
  readonly order: string[];                       // stop:<id> and resume:<id>, in the order the flow called them
  readonly forgotten: SessionId[];                // the volumes removed
};

// An adapter whose author plays `first`, each resume the next script of
// `resumes` ('throw': the resume fails, as a session image gone would).
async function crashing(first: readonly FakeStep[], resumes: (readonly FakeStep[] | 'throw')[], options: SetupOptions = {}): Promise<Crash> {
  const forgotten: SessionId[] = [];
  const t = await setup({ ...options, config: { recreateBackoffMs: 1, ...options.config }, forget: async (id) => { forgotten.push(id); } });
  const fakes: FakeAdapter[] = [];
  const authors: SessionId[] = [];
  const order: string[] = [];
  const inputs = new Map<SessionId, StartInput>();
  const tracked = (handle: SessionHandle): SessionHandle => ({ ...handle, stop: async () => { order.push(`stop:${handle.id}`); await handle.stop(); } });
  const adapter: SessionAdapter = {
    harness: 'claude-code',
    async start(input) {
      const fake = createFakeAdapter({ log: t.store.events, script: input.role === 'reviewer' ? reviewerScript(REPORT_PASS) : first });
      fakes.push(fake);
      const handle = await fake.start(input);
      inputs.set(handle.id, input);
      if (input.role === 'author') authors.push(handle.id);
      return tracked(handle);
    },
    async resume(id) {
      order.push(`resume:${id}`);
      const next = resumes.shift();
      const input = inputs.get(id);
      if (next === undefined || next === 'throw' || !input) throw new Error('the session image is gone');
      const fake = createFakeAdapter({ log: t.store.events, script: next, newId: () => id });
      fakes.push(fake);
      return tracked(await fake.start(input));
    },
  };
  t.registry.sessionAdapters['claude-code'] = adapter;
  return { ...t, fakes, authors, order, forgotten };
}

const run = (t: Crash): Promise<void> => t.engine.start(t.ticket.id, 'u1');

const of = (t: Setup, id: SessionId): SessionEvent[] => t.store.events.after(id);
// The flow reads the loss from the session's stream, a moment after the adapter journals it.
const read = () => new Promise((resolve) => setTimeout(resolve, 20));
const codes = (events: readonly SessionEvent[]) => events.flatMap(({ event }) => (event.type === 'RUN_ERROR' ? [event.code] : []));
const recreated = (events: readonly SessionEvent[]) => events.flatMap(({ event }) => (event.type === 'CUSTOM' && event.name === 'cleared.container_recreated' ? [event.value] : []));
const said = (events: readonly SessionEvent[]) => events.flatMap(({ event }) => (event.type === 'TEXT_MESSAGE_CONTENT' ? [event.delta] : []));
const userBy = (events: readonly SessionEvent[]) => events.flatMap(({ event }) => (event.type === 'TEXT_MESSAGE_START' && event.role === 'user' ? [event.name] : []));

test('a session whose container stops while it works is recreated on the same checkout and carries on, its thread continuous', async () => {
  const t = await crashing([started, ...text('a1', 'Sorting the entries.'), lose], [carriesOn]);
  await run(t);
  await until(() => t.calls.some((c) => c.startsWith('requestRelease')), 'the release asked after the review');
  await t.engine.settled();
  const id = t.authors[0] as SessionId;
  const events = of(t, id);
  // The loss, then the recreation, then the session's own words: one thread, one numbering.
  assert.deepEqual(codes(events), [CONTAINER_LOST]);
  assert.deepEqual(recreated(events), [{ attempt: 1, limit: CONTAINER_RECREATIONS, waitedMs: 1 }]);
  const lostAt = events.findIndex(({ event }) => event.type === 'RUN_ERROR');
  const recreatedAt = events.findIndex(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.container_recreated');
  const carriedOn = events.findIndex(({ event }) => event.type === 'TEXT_MESSAGE_CONTENT' && event.delta === 'Sorted, the draft kept.');
  assert.ok(lostAt < recreatedAt && recreatedAt < carriedOn, 'loss, recreation, then the work');
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  // The session is told, by the flow, that its container was recreated and its checkout kept.
  assert.deepEqual(userBy(events).slice(-1), ['cleared']);
  assert.match(said(events).find((line) => /recreated/.test(line)) ?? '', /uncommitted/);
  // What the dead container left is removed before the new one starts, and the checkout is the same.
  assert.deepEqual(t.order.slice(0, 2), [`stop:${id}`, `resume:${id}`]);
  assert.deepEqual(t.calls.filter((c) => c === 'prepareWorkdir:author'), ['prepareWorkdir:author']);
  // The flow went on: no stop, no put back, no failure.
  assert.equal(t.flowEvents.some((e) => e.type === 'ticket_put_back'), false);
  assert.equal(t.flowEvents.some((e) => e.type === 'session_stopped' && e.session === id), false);
  assert.equal(t.authors.length, 1, 'no new author session');
  assert.deepEqual(t.forgotten, []);
});

test('a container that keeps stopping is recreated three times, waiting longer each time; the next loss fails the session with its reason and releases it', async () => {
  const t = await crashing([started, lose], [losesAgain, losesAgain, losesAgain], { config: { recreateBackoffMs: 2 } });
  await run(t);
  await until(() => t.flowEvents.some((e) => e.type === 'ticket_put_back'), 'the ticket put back');
  await t.engine.settled();
  const id = t.authors[0] as SessionId;
  const events = of(t, id);
  assert.deepEqual(recreated(events).map((r) => [r.attempt, r.waitedMs]), [[1, 2], [2, 4], [3, 8]]);
  assert.deepEqual(codes(events), [CONTAINER_LOST, CONTAINER_LOST, CONTAINER_LOST, CONTAINER_LOST, CONTAINER_FAILED]);
  assert.equal(t.order.filter((c) => c.startsWith('resume:')).length, CONTAINER_RECREATIONS, 'never a fourth recreation');
  const put = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.ok(put && put.type === 'ticket_put_back');
  assert.equal(put.reason, 'container_lost');
  assert.match(put.note, /container stopped 4 times/);
  assert.equal(t.store.sessions.get(id)?.status, 'failed');
  const stopped = t.flowEvents.find((e) => e.type === 'session_stopped' && e.session === id);
  assert.ok(stopped && stopped.type === 'session_stopped' && stopped.phase === 'failed');
  // Its containers and networks (the handle's stop) and its volume go: nothing will resume it.
  assert.equal(t.order.at(-1), `stop:${id}`);
  assert.deepEqual(t.forgotten, [id]);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, t.tickets.states.todo);
});

test('a recreation that fails is tried again after a longer wait; one that succeeds then goes on', async () => {
  const t = await crashing([started, lose], ['throw', carriesOn]);
  await run(t);
  await until(() => t.calls.some((c) => c.startsWith('requestRelease')), 'the release asked');
  await t.engine.settled();
  const id = t.authors[0] as SessionId;
  assert.deepEqual(recreated(of(t, id)).map((r) => [r.attempt, r.waitedMs]), [[2, 2]]);
  assert.deepEqual(t.order.slice(0, 4), [`stop:${id}`, `resume:${id}`, `stop:${id}`, `resume:${id}`]);
  assert.equal(t.order.filter((c) => c.startsWith('resume:')).length, 2);
  assert.equal(t.flowEvents.some((e) => e.type === 'ticket_put_back'), false);
});

test('three recreations that fail stop the session with the reason, and no fourth is tried', async () => {
  const t = await crashing([started, lose], ['throw', 'throw', 'throw', carriesOn]);
  await run(t);
  await until(() => t.flowEvents.some((e) => e.type === 'ticket_put_back'), 'the ticket put back');
  await t.engine.settled();
  const id = t.authors[0] as SessionId;
  assert.equal(t.order.filter((c) => c.startsWith('resume:')).length, 3);
  const failed = of(t, id).map(({ event }) => event).find((e): e is Extract<AgUiEvent, { type: 'RUN_ERROR' }> => e.type === 'RUN_ERROR' && e.code === CONTAINER_FAILED);
  assert.match(failed?.message ?? '', /could not be recreated.*the session image is gone/);
  assert.deepEqual(t.forgotten, [id]);
});

test('a session the owner took over is never recreated by the flow: its loss stops it, with the reason', async () => {
  const t = await crashing([started, ...text('a1', 'Working.'), { awaitMessage: true }, finished(0.2)], [carriesOn]);
  await run(t);
  await until(() => t.authors.length === 1, 'the author');
  const id = t.authors[0] as SessionId;
  await t.engine.takeOver(id, 'u1');
  (t.fakes[0] as FakeAdapter).lose(id, 137);
  await until(() => t.flowEvents.some((e) => e.type === 'ticket_put_back'), 'the ticket put back');
  await t.engine.settled();
  assert.deepEqual(t.order.filter((c) => c.startsWith('resume:')), [], 'no resume');
  assert.deepEqual(recreated(of(t, id)), []);
  const put = t.flowEvents.find((e) => e.type === 'ticket_put_back');
  assert.ok(put && put.type === 'ticket_put_back');
  assert.match(put.note, /taken over/);
  assert.equal(t.engine.takenOver(id), undefined);
});

test('a session that waits for a person when its container stops keeps its request; the answer recreates it, and no turn runs before', async () => {
  const t = await crashing([started, ...text('a1', 'May I touch the fixture?'), permission, { awaitMessage: true }, finished(0.4)], [[{ awaitMessage: true }, started, ...text('a2', 'Touched.'), finished(0.3)]]);
  await run(t);
  await until(() => t.inbox.list().length === 1, 'the permission item');
  const id = t.authors[0] as SessionId;
  (t.fakes[0] as FakeAdapter).lose(id, 137);
  await until(() => t.store.sessions.get(id)?.status === 'stopped', 'the session waiting with no container');
  await t.engine.settled();
  assert.deepEqual(t.order.filter((c) => c.startsWith('resume:')), [], 'nothing is recreated while the person has not answered');
  assert.deepEqual(t.order, [`stop:${id}`], 'what the dead container left is removed');
  assert.equal(t.inbox.list()[0]?.state, 'waiting', 'the request still waits');
  assert.equal(t.flowEvents.some((e) => e.type === 'ticket_put_back'), false);
  await t.engine.answer(id, 'request-1', { kind: 'allow_once' }, 'u1');
  await until(() => t.calls.some((c) => c.startsWith('requestRelease')), 'the release asked');
  await t.engine.settled();
  assert.deepEqual(recreated(of(t, id)).map((r) => r.attempt), [1]);
  assert.match(said(of(t, id)).join('\n'), /allowed your request/);
});

test('a ticket set aside while its session\'s container is being recreated stays aside: the recreation stops', async () => {
  const t = await crashing([started, lose], [carriesOn], { config: { recreateBackoffMs: 200 } });
  await run(t);
  await until(() => codes(of(t, t.authors[0] as SessionId)).includes(CONTAINER_LOST), 'the loss');
  await read();
  await t.engine.setAside(t.ticket.id, 'u1');
  await t.engine.settled();
  const id = t.authors[0] as SessionId;
  assert.deepEqual(t.order.filter((c) => c.startsWith('resume:')), []);
  assert.deepEqual(recreated(of(t, id)), []);
  assert.notEqual(t.store.sessions.get(id)?.status, 'working');
});

test('a message to a session being recreated is refused with a reason, not lost', async () => {
  const t = await crashing([started, lose], [carriesOn], { config: { recreateBackoffMs: 200 } });
  await run(t);
  const id = t.authors[0] as SessionId;
  await until(() => codes(of(t, id)).includes(CONTAINER_LOST), 'the loss');
  await read();
  await assert.rejects(t.engine.send(id, 'Are you there?', 'u1'), /being recreated/);
  await t.engine.settled();
  assert.deepEqual(recreated(of(t, id)).map((r) => r.attempt), [1]);
});
