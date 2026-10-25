// The model step's throwaway container (docs/v2/milestone-5-plan.md,
// decision 7, lane v2-j5-assistant): the session image, labelled, with no
// checkout, no credential and no folder of the host, its capabilities
// dropped; removed when its terminal closes. Against the fake docker CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Docker, LABEL } from '../../src/container/docker.ts';
import { SESSION_IMAGE } from '../../src/container/session-runtime.ts';
import { throwawayContainer } from '../../src/setup/container.ts';
import { FakeDocker } from '../container/fake-docker.ts';

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams & { kill(): boolean };
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: () => { child.emit('close', 0); return true; } });
  return child;
}

test('a terminal opens a labelled container of the session image with nothing of the host, and its close removes it', async () => {
  const fake = new FakeDocker();
  const scripted: string[][] = [];
  const docker = new Docker(fake.runner, fake.spawner, (args) => { scripted.push([...args]); return fakeChild(); });
  const container = throwawayContainer(docker, SESSION_IMAGE);
  const process = await container.terminal('setup', { cols: 80, rows: 24 }, ['bash', '-l']);
  const create = fake.calls.find((call) => call.args[0] === 'create')?.args ?? [];
  assert.ok(create.includes(LABEL), 'labelled cleared.dev=v2');
  assert.ok(create.includes('cleared.role=setup'));
  assert.ok(!create.includes('--mount'), 'no folder of the host, no login file, no checkout');
  assert.ok(!create.some((arg) => /TOKEN|CREDENTIAL|KEY/.test(arg)), 'no credential in its environment');
  assert.deepEqual(create.slice(create.indexOf('--cap-drop'), create.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
  assert.ok(create.includes('no-new-privileges'));
  assert.ok(create.includes('--memory'));
  assert.equal(create[create.indexOf('--') + 1], SESSION_IMAGE);
  assert.ok(fake.calls.some((call) => call.args[0] === 'start'));
  assert.equal(scripted.length, 1, 'the terminal is a docker exec under script, as a session\'s');
  assert.equal(fake.withLabel('cleared.role', 'setup').length, 1);
  await process.end();
  assert.equal(fake.withLabel('cleared.role', 'setup').length, 0, 'removed at the close');
});

test('each terminal gets a container of its own, named from a fresh id', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner, fake.spawner, () => fakeChild());
  const container = throwawayContainer(docker, SESSION_IMAGE);
  const one = await container.terminal('setup', { cols: 80, rows: 24 }, ['bash', '-l']);
  await one.end();
  const two = await container.terminal('setup', { cols: 80, rows: 24 }, ['bash', '-l']);
  const names = fake.calls.filter((call) => call.args[0] === 'create').map((call) => call.args[call.args.indexOf('--name') + 1]);
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  await two.end();
});
