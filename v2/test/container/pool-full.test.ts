// Docker's address pools and the sessions that stop (issue 265). A network
// Docker cannot give a subnet to fails at once with a reason that names the
// pools and the doctor, instead of a session start that waits for its
// delay; and N sessions started then stopped give Docker back every network
// they took, through the stop or, when the stop failed, through the release
// of stopped sessions. Fake docker CLI only; no real Docker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Docker, DockerError, PoolFullError } from '../../src/container/docker.ts';
import { sessionNames, startSession, stopSession, type SessionRuntimeSpec } from '../../src/container/session-runtime.ts';
import { FakeDocker } from './fake-docker.ts';

const SESSION = '0b7f3c1e-5d0a-4a6e-9f3b-1c2d3e4f5a6b';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d';

// What the daemon says when its pools are spent: today's (moby's
// ipamapi.ErrNoMoreSubnets), and the older Docker releases' wording.
const SPENT = 'Error response from daemon: all predefined address pools have been fully subnetted';
const SPENT_BEFORE = 'Error response from daemon: could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network';

const scratch = mkdtempSync(join(tmpdir(), 'cleared-pool-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function spec(session: string): SessionRuntimeSpec {
  return {
    session, workdir: join(scratch, session, 'work'), tokenFile: join(scratch, 'claude.token'), allowDir: join(scratch, session, 'egress'),
    allowHosts: [], hostAddresses: [], services: [], user: '1000:1000', command: ['sleep', 'infinity'], readyPollMs: 0,
  };
}

const spent = (fake: FakeDocker, stderr: string, after = 0): void => {
  let created = 0;
  fake.intercept = (args) => (args[0] === 'network' && args[1] === 'create' && created++ >= after ? { code: 1, stdout: '', stderr } : undefined);
};

test('a network Docker has no subnet for fails at once with a PoolFullError that names the pools and cleared doctor, for both wordings of the daemon', async () => {
  for (const stderr of [SPENT, SPENT_BEFORE]) {
    const fake = new FakeDocker();
    spent(fake, stderr);
    const error = await new Docker(fake.runner).createNetwork({ name: sessionNames(SESSION).network, session: SESSION, internal: true }).catch((e: unknown) => e);
    assert.ok(error instanceof PoolFullError, String(error));
    assert.ok(error instanceof DockerError, 'still a DockerError for the callers that catch those');
    assert.match(error.message, /address pools/);
    assert.match(error.message, /cleared doctor/);
    assert.ok(error.message.includes(sessionNames(SESSION).network), 'it names the network it could not make');
    assert.ok(error.message.includes(stderr.replace('Error response from daemon: ', '')), 'the daemon\'s own line is kept');
    assert.ok(!/\u2014/.test(error.message));
    assert.equal(fake.networks.length, 0);
  }
});

test('any other failure of network create stays a plain DockerError', async () => {
  const fake = new FakeDocker();
  fake.intercept = (args) => (args[0] === 'network' && args[1] === 'create' ? { code: 1, stdout: '', stderr: 'Error response from daemon: permission denied' } : undefined);
  const error = await new Docker(fake.runner).createNetwork({ name: 'cleared-v2-x', session: SESSION, internal: false }).catch((e: unknown) => e);
  assert.ok(error instanceof DockerError);
  assert.ok(!(error instanceof PoolFullError));
});

test('a session whose second network finds the pools spent rejects with the PoolFullError and leaves no network behind', async () => {
  const fake = new FakeDocker();
  spent(fake, SPENT, 1);
  const error = await startSession(new Docker(fake.runner), spec(SESSION)).catch((e: unknown) => e);
  assert.ok(error instanceof PoolFullError, String(error));
  assert.deepEqual(fake.networks, [], 'the first network, made before the pools ran out, is removed');
  assert.deepEqual(fake.containers, []);
});

test('N sessions started then stopped: the count of networks comes back to where it was, the volumes stay, and what is not theirs is untouched (issue 265)', async () => {
  const fake = new FakeDocker();
  // Another program's network, and a network of another Cleared install on the same host.
  fake.networks.push(
    { id: 'n-foreign', name: 'bridge-of-another-program', labels: {} },
    { id: 'n-other', name: sessionNames(OTHER).network, labels: { 'cleared.dev': 'v2', 'cleared.session': OTHER } },
  );
  const before = fake.networks.map((n) => n.id);
  const docker = new Docker(fake.runner);
  const sessions = Array.from({ length: 6 }, (_, i) => `0b7f3c1e-5d0a-4a6e-9f3b-${String(i + 1).padStart(12, '0')}`);
  for (const session of sessions) await startSession(docker, spec(session));
  assert.equal(fake.networks.length, before.length + 2 * sessions.length, 'each session takes two networks');

  // Half stop well. The other half's stop fails half way, as when a
  // container does not stop in time: their networks stay, until the
  // service releases the stopped sessions by name.
  const [clean, failed] = [sessions.slice(0, 3), sessions.slice(3)];
  for (const session of clean) await stopSession(docker, session);
  const failing = new Set(failed.flatMap((session) => fake.containers.filter((c) => c.labels['cleared.session'] === session).map((c) => c.id)));
  fake.intercept = (args) => (args[0] === 'stop' && args.some((arg) => failing.has(arg)) ? { code: 1, stdout: '', stderr: 'Error response from daemon: cannot stop container: timeout' } : undefined);
  for (const session of failed) await assert.rejects(stopSession(docker, session), DockerError);
  assert.equal(fake.networks.length, before.length + 2 * failed.length, 'a failed stop leaves its two networks');

  fake.intercept = () => undefined;
  const released = await docker.releaseStopped(failed);
  assert.equal(released.networks.length, 2 * failed.length);
  assert.deepEqual(fake.networks.map((n) => n.id), before, 'the networks are back to what Docker had, the foreign and the other install\'s included');
  assert.deepEqual(fake.containers, []);
  assert.equal(fake.volumes.length, sessions.length, 'each session\'s config volume stays, for a resume');
  assert.ok(!fake.calls.some((c) => c.args.includes('prune')), 'never a prune');
});
