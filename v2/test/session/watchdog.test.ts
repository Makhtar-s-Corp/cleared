// The idle watchdog (issue #290, lane j3-autonomy), on a simulated clock: a
// timer of its own that reads the ledger, not the flow's memory, and stops
// every author, reviewer or reader session with no event for
// CLEARED_V2_IDLE_MINUTES (15), waiting for a person included. The flow's
// engine stops a session it runs keeping what a resume needs: its question
// stays in the inbox, and its answer resumes it. A session nobody runs has
// its containers and networks, labelled cleared.dev=v2, removed by name; its
// volume stays. Each stop is a row of the ledger's events table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Docker } from '../../src/container/docker.ts';
import { sessionNames } from '../../src/container/session-runtime.ts';
import { FlowEngine } from '../../src/flow/engine.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { Role } from '../../src/session/contract.ts';
import type { CustomValue } from '../../src/session/events.ts';
import { IdleWatchdog, type IdleOutcome } from '../../src/session/watchdog.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { finished, setup, started, text, until, type Setup } from '../flow/support.ts';

const MIN = 60_000;
const QUESTION: CustomValue['cleared.question'] = { requestId: 'q1', questions: [{ question: 'Which order?', options: [{ label: 'Oldest first' }, { label: 'Newest first (Recommended)' }] }] };
const asks: readonly FakeStep[] = [started, ...text('a1', 'One thing to settle.'), { question: QUESTION }];
// What the author does once resumed: reads the answer, ends its turn.
const resumed: readonly FakeStep[] = [{ awaitMessage: true }, started, ...text('a2', 'Newest first, then.'), finished(0.2)];

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// What a session leaves in Docker while it runs: its containers, its two networks, its volume.
function running(fake: FakeDocker, session: string): void {
  const names = sessionNames(session);
  const labels = { 'cleared.dev': 'v2', 'cleared.session': session };
  fake.containers.push({ id: `${session}-c1`, name: names.container, labels: { ...labels }, state: 'running' }, { id: `${session}-c2`, name: names.egress, labels: { ...labels }, state: 'running' });
  fake.networks.push({ id: `${session}-n1`, name: names.network, labels: { ...labels } }, { id: `${session}-n2`, name: names.outNetwork, labels: { ...labels } });
  fake.volumes.push({ id: names.volume, name: names.volume, labels: { ...labels } });
}

function watchdog(t: Setup, fake: FakeDocker, owner?: (id: string) => Promise<IdleOutcome>) {
  return new IdleWatchdog({
    store: t.store, project: 'guestbook', idleMs: 15 * MIN, now: () => new Date(t.clock.now),
    release: (session) => new Docker(fake.runner).releaseStopped([session]),
    ...(owner ? { owner } : {}),
  });
}

const stops = (t: Setup) => (t.store.db.prepare("SELECT ticket, detail, source FROM events WHERE kind = 'session_idle_stopped'").all() as { ticket: string; detail: string; source: string }[])
  .map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));

// A session row of the ledger with its last event `minutes` ago.
function row(t: Setup, id: string, role: Role, status: string, minutes: number): void {
  const at = new Date(t.clock.now - minutes * MIN).toISOString();
  t.store.sessions.put({ id, project: 'guestbook', ticket: t.ticket.id, role, harness: 'claude-code', model: 'claude-opus-5-5', status, createdAt: at, updatedAt: at });
  t.store.events.append({ at, sessionId: id, ticket: t.ticket.id, project: 'guestbook', event: { type: 'RUN_STARTED', threadId: 't', runId: 'r' } });
}

test('a session nobody runs, idle 15 minutes while waiting for a person, has its labelled containers and networks removed by name, its volume kept, its row stopped, the stop in the ledger', async () => {
  const t = await setup();
  const fake = new FakeDocker();
  const [waiting, busy, lead, done, almost] = [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)];
  row(t, waiting, 'author', 'waiting_human', 16);
  row(t, busy, 'reviewer', 'reviewing', 5);
  row(t, lead, 'lead', 'waiting_human', 120);
  row(t, done, 'author', 'done', 120);
  row(t, almost, 'author', 'working', 14 + 59 / 60);
  for (const id of [waiting, busy, lead, almost]) running(fake, id);
  // An unlabelled container named as the session's is never listed, never removed.
  fake.containers.push({ id: 'foreign', name: `${sessionNames(waiting).container}-x`, labels: {}, state: 'running' });

  const stopped = await watchdog(t, fake).tick();
  assert.deepEqual(stopped.map((s) => s.session), [waiting]);
  assert.equal(t.store.sessions.get(waiting)?.status, 'stopped');
  const last = t.store.events.after(waiting).at(-1)?.event;
  assert.equal(last?.type === 'RUN_ERROR' ? last.code : undefined, 'idle');
  for (const id of [busy, almost]) assert.notEqual(t.store.sessions.get(id)?.status, 'stopped');
  assert.equal(t.store.sessions.get(lead)?.status, 'waiting_human', 'the permanent lead keeps its own lifecycle');

  assert.deepEqual(fake.containers.filter((c) => c.name.startsWith(`cleared-v2-${waiting}`)).map((c) => c.id), ['foreign']);
  assert.equal(fake.networks.filter((n) => n.name.startsWith(`cleared-v2-${waiting}`)).length, 0);
  assert.equal(fake.volumes.filter((v) => v.name === sessionNames(waiting).volume).length, 1, 'the config volume stays, for a resume');
  for (const call of fake.calls) {
    if (call.args[0] === 'ps' || (call.args[0] === 'network' && call.args[1] === 'ls')) assert.ok(call.args.includes('label=cleared.dev=v2'), `${call.args.join(' ')} filters on the label`);
    assert.ok(!(call.args[0] === 'volume' && call.args[1] === 'rm'), 'no volume is removed');
  }

  assert.deepEqual(stops(t), [{
    ticket: t.ticket.id, source: 'watchdog',
    detail: {
      session: waiting, role: 'author', status: 'waiting_human', idleMinutes: 16, by: 'watchdog',
      containers: [sessionNames(waiting).container, sessionNames(waiting).egress], networks: [sessionNames(waiting).network, sessionNames(waiting).outNetwork], kept: [sessionNames(waiting).volume],
    },
  }]);
  assert.deepEqual(await watchdog(t, fake).tick(), [], 'a second tick finds nothing');
});

test('the engine that runs a session stops it itself; a session the human holds is left alone', async () => {
  const t = await setup();
  const fake = new FakeDocker();
  const [mine, held] = [uuid(6), uuid(7)];
  row(t, mine, 'author', 'waiting_human', 20);
  row(t, held, 'author', 'waiting_human', 20);
  const asked: string[] = [];
  const owner = async (id: string): Promise<IdleOutcome> => {
    asked.push(id);
    if (id === held) return 'skipped';
    t.store.sessions.put({ ...t.store.sessions.get(id)!, status: 'stopped' });
    return 'stopped';
  };
  const stopped = await watchdog(t, fake, owner).tick();
  assert.deepEqual(asked, [mine, held]);
  assert.deepEqual(stopped.map((s) => [s.session, s.by]), [[mine, 'engine']]);
  assert.equal(t.store.sessions.get(held)?.status, 'waiting_human');
  assert.deepEqual(stops(t).map((s) => s.detail.session), [mine]);
});

test('a ledger without the events table still stops the session; the stop is said on the console', async () => {
  const t = await setup({ ledger: false });
  const fake = new FakeDocker();
  row(t, uuid(8), 'reader', 'working', 30);
  const stopped = await watchdog(t, fake).tick();
  assert.equal(stopped.length, 1);
  assert.equal(t.store.sessions.get(uuid(8))?.status, 'stopped');
});

async function engineWatched() {
  const t = await setup({ scripts: { author: asks, reopen: resumed } });
  const fake = new FakeDocker();
  const engine = t.engine as FlowEngine;
  await engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  running(fake, id);
  await until(() => t.inbox.waitingFor(id) === 1, 'the question');
  await engine.settled();
  const asked = t.clock.now;
  const dog = watchdog(t, fake, (session) => engine.idleStop(session));
  const at = async (minutes: number) => {
    t.clock.now = asked + minutes * MIN;
    await dog.tick();
    await engine.tick();
    await engine.settled();
  };
  return { ...t, fake, engine, id, at };
}

test('a session waiting for an answer is stopped by the watchdog at 15 min with what a resume needs: its question stays, its ticket stays In Progress, nothing is put back', async () => {
  const t = await engineWatched();
  await t.at(14 + 59 / 60);
  assert.equal(t.store.sessions.get(t.id)?.status, 'waiting_human');
  await t.at(15);
  assert.equal(t.store.sessions.get(t.id)?.status, 'stopped');
  assert.equal(t.fake.containers.length, 0, 'its containers are gone');
  assert.equal(t.fake.volumes.length, 1, 'its volume stays');
  assert.equal(t.inbox.waitingFor(t.id), 1, 'its question still waits');
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'In Progress');
  assert.equal(t.flowEvents.filter((e) => e.type === 'ticket_put_back').length, 0);
  assert.deepEqual(stops(t).map((s) => [s.detail.session, s.detail.by]), [[t.id, 'engine']]);
  await t.at(20);
  assert.equal(stops(t).length, 1, 'stopped once');
});

test('the owner\'s answer to the stopped session\'s question resumes it with the answer, and the ticket goes on', async () => {
  const t = await engineWatched();
  await t.at(15);
  await t.engine.answer(t.id, 'q1', { kind: 'answer', answers: { 'Which order?': 'Newest first (Recommended)' } }, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release');
  const messages = t.store.events.after(t.id).flatMap((e) => (e.event.type === 'TEXT_MESSAGE_CONTENT' ? [e.event.delta] : []));
  assert.ok(messages.some((m) => /Which order\?/.test(m) && /Newest first/.test(m)), 'the answer is said to the resumed session');
  assert.equal(t.inbox.list().find((i) => i.kind === 'question')?.state, 'handled');
});

test('the declared default reaches a session the watchdog stopped: at 40 min it is resumed with it, and the ticket goes on', async () => {
  const t = await engineWatched();
  await t.at(15);
  await t.at(30);
  assert.deepEqual(t.flowEvents.filter((e): e is Extract<FlowEvent, { type: 'question_timed_out' }> => e.type === 'question_timed_out').map((e) => e.stage), ['lead']);
  await t.at(40);
  await until(() => t.inbox.list().some((i) => i.kind === 'release'), 'the release');
  const messages = t.store.events.after(t.id).flatMap((e) => (e.event.type === 'TEXT_MESSAGE_CONTENT' ? [e.event.delta] : []));
  assert.ok(messages.some((m) => /default/.test(m) && /Newest first/.test(m)));
});

test('a stopped session whose question has no default is parked at 40 min: its ticket in Todo, put back as parked', async () => {
  const t = await setup({ scripts: { author: [started, { question: { requestId: 'q1', questions: [{ question: 'What should the empty page say?' }] } }], reopen: resumed } });
  const fake = new FakeDocker();
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(id) === 1);
  await t.engine.settled();
  const dog = watchdog(t, fake, (session) => t.engine.idleStop(session));
  const asked = t.clock.now;
  for (const minutes of [15, 30, 40]) {
    t.clock.now = asked + minutes * MIN;
    await dog.tick();
    await t.engine.tick();
    await t.engine.settled();
  }
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.deepEqual(t.flowEvents.filter((e) => e.type === 'ticket_put_back').map((e) => e.type === 'ticket_put_back' && e.reason), ['parked']);
  assert.equal(t.inbox.waitingFor(id), 0);
});

test('the watchdog ticks on its own timer, which never keeps the process alive, and closes', async () => {
  const t = await setup();
  const dog = watchdog(t, new FakeDocker());
  dog.startTimer(60_000);
  dog.startTimer(60_000);
  await dog.close();
});
