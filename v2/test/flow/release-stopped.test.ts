// A stopped session leaves no network behind (issue 265, requirement P50):
// the engine, the Docker wrapper and a fake docker CLI together. A session
// whose own stop did not remove its objects (the adapter's removal failed,
// or its container exited and the stop never ran) has its containers and
// networks, labelled cleared.dev=v2, removed by name at the next tick,
// within 60 seconds of the stop; an unlabelled network is never touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Docker } from '../../src/container/docker.ts';
import { sessionNames } from '../../src/container/session-runtime.ts';
import { FlowEngine } from '../../src/flow/engine.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { setup } from './support.ts';

// What a session leaves in Docker when its removal did not run.
function leftBehind(fake: FakeDocker, session: string): void {
  const names = sessionNames(session);
  const labels = { 'cleared.dev': 'v2', 'cleared.session': session };
  fake.containers.push(
    { id: `${session}-c1`, name: names.container, labels: { ...labels }, state: 'exited' },
    { id: `${session}-c2`, name: names.egress, labels: { ...labels }, state: 'running' },
    { id: `${session}-c3`, name: names.sibling('filter-api'), labels: { ...labels }, state: 'running' },
  );
  fake.networks.push({ id: `${session}-n1`, name: names.network, labels: { ...labels } }, { id: `${session}-n2`, name: names.outNetwork, labels: { ...labels } });
  fake.volumes.push({ id: names.volume, name: names.volume, labels: { ...labels } });
}

test('a session stopped while the service runs has its containers and networks removed by name at the next tick, within 60 s; its volume and any unlabelled network stay', async () => {
  const t = await setup();
  const fake = new FakeDocker();
  const engine = new FlowEngine({ ...t.deps, release: (sessions) => new Docker(fake.runner).releaseStopped(sessions) });
  await engine.start(t.ticket.id, 'u1');
  const session = t.startedSessions[0]?.id as string;
  leftBehind(fake, session);
  // An unlabelled network named as the session's: never listed, never removed.
  fake.networks.push({ id: 'foreign', name: `${sessionNames(session).network}-x`, labels: {} });
  await engine.tick();
  assert.equal(fake.containers.length, 3, 'a live session is never released');

  const stoppedAt = t.clock.now;
  await engine.setAside(t.ticket.id, 'u1');
  assert.equal(t.store.sessions.get(session)?.status, 'stopped');
  t.clock.now = stoppedAt + 30_000;                     // the engine ticks every 30 s
  await engine.tick();

  assert.deepEqual(fake.containers, [], 'the containers are gone');
  assert.deepEqual(fake.networks.map((n) => n.id), ['foreign'], 'the labelled networks are gone; the unlabelled one stays');
  assert.equal(fake.volumes.length, 1, 'the config volume stays');
  assert.ok(t.clock.now - stoppedAt <= 60_000);
  const removals = fake.calls.filter((c) => c.args[0] === 'rm' || (c.args[0] === 'network' && c.args[1] === 'rm')).map((c) => c.args.join(' '));
  assert.deepEqual(removals, [
    `rm --force -- ${sessionNames(session).container} ${sessionNames(session).egress} ${sessionNames(session).sibling('filter-api')}`,
    `network rm -- ${sessionNames(session).network} ${sessionNames(session).outNetwork}`,
  ]);
  await engine.close();
});

test('the tick looks only at sessions stopped in the last ten minutes, and asks Docker nothing when there are none; the restart takes every one', async () => {
  const t = await setup();
  const fake = new FakeDocker();
  const old = '00000000-0000-4000-8000-0000000000aa';
  const at = new Date(t.clock.now - 11 * 60_000).toISOString();
  t.store.sessions.put({ id: old, project: 'guestbook', ticket: t.ticket.id, role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', status: 'stopped', createdAt: at, updatedAt: at });
  leftBehind(fake, old);
  const engine = new FlowEngine({ ...t.deps, release: (sessions) => new Docker(fake.runner).releaseStopped(sessions) });
  await engine.tick();
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.networks.length, 2);
  await engine.recover();
  assert.equal(fake.networks.length, 0);
  assert.equal(fake.containers.length, 0);
});

// A reader that answered writes its row `done` and waits for a follow-up
// in a session that still runs (reader/service.ts); the reader module
// releases its own (its idle rule, recoverAsks at a restart). The real run
// of 2026-10-28 (issue #469) saw the flow's tick remove a waiting reader's
// containers 22 seconds after its answer.
test('a reader\'s session is never the flow\'s to release, at a tick or at the restart', async () => {
  const t = await setup();
  const fake = new FakeDocker();
  const reader = '00000000-0000-4000-8000-0000000000bb';
  const at = new Date(t.clock.now).toISOString();
  t.store.sessions.put({ id: reader, project: 'guestbook', ticket: 'ask-00000000-0000-4000-8000-000000000001', role: 'reader', harness: 'claude-code', model: 'claude-haiku-5-5', status: 'done', createdAt: at, updatedAt: at });
  leftBehind(fake, reader);
  const engine = new FlowEngine({ ...t.deps, release: (sessions) => new Docker(fake.runner).releaseStopped(sessions) });
  await engine.tick();
  await engine.recover();
  assert.equal(fake.containers.length, 3);
  assert.equal(fake.networks.length, 2);
  assert.deepEqual(fake.calls.filter((c) => c.args[0] === 'rm' || c.args[1] === 'rm'), []);
});
