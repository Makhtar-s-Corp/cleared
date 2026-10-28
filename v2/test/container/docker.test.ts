import test from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Docker, LABEL, LabelRuleError, assertLabelRule, assertSessionId, commandRunner, type ContainerSpec } from '../../src/container/docker.ts';
import { FakeDocker, type Call } from './fake-docker.ts';

const SESSION = '0b7f3c1e-5d0a-4a6e-9f3b-1c2d3e4f5a6b';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d';

const CREATES = new Set(['create', 'build', 'network create', 'volume create']);
const LISTS = new Set(['ps', 'network ls', 'volume ls', 'image ls']);
const TARGETED = new Set(['start', 'stop', 'kill', 'rm', 'exec', 'inspect', 'logs', 'network rm', 'network inspect', 'volume rm', 'image inspect', 'image rm']);

const verbOf = (args: readonly string[]): string =>
  args[0] === 'network' || args[0] === 'volume' || args[0] === 'image' ? `${args[0]} ${args[1]}` : (args[0] ?? '');

const hasPair = (args: readonly string[], flag: string, value: string): boolean =>
  args.some((arg, index) => arg === flag && args[index + 1] === value);

// The ids a list printed: container, network and image rows carry an ID, volume rows a Name.
function listedIds(call: Call): string[] {
  return call.result.stdout.split('\n').filter(Boolean).map((line) => {
    const row = JSON.parse(line) as { ID?: string; Name?: string };
    return verbOf(call.args) === 'volume ls' ? (row.Name ?? '') : (row.ID ?? '');
  });
}

// The rule the wrapper promises, checked on a recorded call log: every
// create carries the label, every list the label filter, and every command
// that acts on an object names only ids the previous labelled list returned.
function assertLog(calls: readonly Call[]): void {
  let lastListed: string[] = [];
  for (const call of calls) {
    const verb = verbOf(call.args);
    const shown = call.args.join(' ');
    if (CREATES.has(verb)) {
      assert.ok(hasPair(call.args, '--label', LABEL), `create without the label: ${shown}`);
      if (verb !== 'build') assert.ok(call.args.some((arg, i) => arg === '--label' && call.args[i + 1]?.startsWith('cleared.session=')), `create without the session label: ${shown}`);
    } else if (LISTS.has(verb)) {
      assert.ok(hasPair(call.args, '--filter', `label=${LABEL}`), `list without the label filter: ${shown}`);
      lastListed = listedIds(call);
    } else if (TARGETED.has(verb)) {
      const at = call.args.indexOf('--');
      assert.ok(at > 0, `targeted command without "--": ${shown}`);
      const ids = verb === 'exec' ? call.args.slice(at + 1, at + 2) : call.args.slice(at + 1);
      assert.ok(ids.length > 0, `targeted command without a target: ${shown}`);
      for (const id of ids) assert.ok(lastListed.includes(id), `${verb} on ${id}, which the previous labelled list did not return: ${shown}`);
    } else {
      assert.equal(verb, 'version', `unexpected docker command: ${shown}`);
    }
  }
}

function spec(name: string, overrides: Partial<ContainerSpec> = {}): ContainerSpec {
  return { name, session: SESSION, role: 'session', image: 'cleared-v2-session:test', networks: [{ name: `cleared-v2-${SESSION}` }], ...overrides };
}

// Every public method of the wrapper, once.
async function everyMethod(docker: Docker): Promise<void> {
  // attach spawns `docker start --attach --interactive`: recorded like the other calls.
  await docker.version();
  await docker.build({ context: '/images/session', tag: 'cleared-v2-session:test' });
  await docker.build({ context: '/work/ticket', dockerfile: '/state/ticket-layer/Dockerfile', tag: `cleared-v2-${SESSION}-sib-api:ticket`, network: 'none', session: SESSION });
  await docker.image('cleared-v2-session:test');
  await docker.images(SESSION);
  await docker.createNetwork({ name: `cleared-v2-${SESSION}`, session: SESSION, internal: true });
  await docker.createVolume({ name: `cleared-v2-${SESSION}-config`, session: SESSION });
  await docker.createContainer(spec(`cleared-v2-${SESSION}-session`, { command: ['sleep', 'infinity'], interactive: true }));
  await docker.start(SESSION, `cleared-v2-${SESSION}-session`);
  await docker.exec(SESSION, `cleared-v2-${SESSION}-session`, ['true']);
  await docker.inspect(SESSION, `cleared-v2-${SESSION}-session`);
  await docker.inspectNetwork(SESSION, `cleared-v2-${SESSION}`);
  await docker.logs(SESSION, `cleared-v2-${SESSION}-session`);
  await docker.kill(SESSION, `cleared-v2-${SESSION}-session`);
  await docker.attach(SESSION, `cleared-v2-${SESSION}-session`);
  await docker.containers();
  await docker.networks(SESSION);
  await docker.volumes(SESSION);
  await docker.removeSession(SESSION);
  await docker.removeVolumes(SESSION);
}

test('every docker command line carries the label on create and acts only on what a labelled list returned', async () => {
  const fake = new FakeDocker();
  await everyMethod(new Docker(fake.runner, fake.spawner));
  assert.ok(fake.calls.length > 15);
  assertLog(fake.calls);
  const verbs = new Set(fake.calls.map((call) => verbOf(call.args)));
  for (const verb of [...CREATES, ...LISTS, ...TARGETED]) assert.ok(verbs.has(verb), `the scenario never ran ${verb}`);
});

test('removing a session never touches an unlabelled object or another session', async () => {
  const fake = new FakeDocker();
  fake.containers.push({ id: 'f'.repeat(64), name: 'production-db', labels: {}, state: 'running' });
  fake.networks.push({ id: 'e'.repeat(64), name: 'bridge', labels: {} });
  fake.volumes.push({ id: 'production-data', name: 'production-data', labels: {} });
  const docker = new Docker(fake.runner);
  for (const session of [SESSION, OTHER]) {
    await docker.createNetwork({ name: `cleared-v2-${session}`, session, internal: true });
    await docker.createVolume({ name: `cleared-v2-${session}-config`, session });
    await docker.createContainer({ ...spec(`cleared-v2-${session}-session`), session, networks: [{ name: `cleared-v2-${session}` }] });
  }

  const removed = await docker.removeSession(SESSION);
  assert.deepEqual(removed, { containers: 1, networks: 1, images: 0 });
  assert.equal(await docker.removeVolumes(SESSION), 1);

  assert.deepEqual(fake.withLabel('cleared.session', SESSION), []);
  assert.equal(fake.withLabel('cleared.session', OTHER).length, 3, 'the other session is left alone');
  assert.deepEqual(fake.all().filter((o) => Object.keys(o.labels).length === 0).map((o) => o.name).sort(), ['bridge', 'production-data', 'production-db']);
  assertLog(fake.calls);
});

test('a list that returns an unlabelled row is refused, even if the CLI ignored the filter', async () => {
  const fake = new FakeDocker();
  fake.containers.push({ id: 'f'.repeat(64), name: 'production-db', labels: {}, state: 'running' });
  fake.honourFilters = false;
  const docker = new Docker(fake.runner);
  await assert.rejects(docker.containers(), LabelRuleError);
  await assert.rejects(docker.removeSession(SESSION), LabelRuleError);
  assert.ok(!fake.calls.some((call) => call.args[0] === 'rm' || call.args[0] === 'stop'), 'nothing was stopped or removed');
});

test('an object not found by the labelled list cannot be targeted', async () => {
  const fake = new FakeDocker();
  fake.containers.push({ id: 'f'.repeat(64), name: `cleared-v2-${SESSION}-session`, labels: {}, state: 'running' });
  const docker = new Docker(fake.runner);
  await assert.rejects(docker.exec(SESSION, `cleared-v2-${SESSION}-session`, ['true']), /no container named/);
  await assert.rejects(docker.start(SESSION, `cleared-v2-${SESSION}-session`), /no container named/);
  await assert.rejects(docker.inspect(SESSION, `cleared-v2-${SESSION}-session`), /no container named/);
  await assert.rejects(docker.kill(SESSION, `cleared-v2-${SESSION}-session`), /no container named/);
  assert.ok(!fake.calls.some((call) => ['exec', 'start', 'inspect', 'kill'].includes(call.args[0] ?? '')));
});

test('the gate refuses a command line that breaks the label rule', () => {
  const owned = new Set(['abc']);
  const refused: string[][] = [
    ['create', '--name', 'x', 'image'],
    ['create', '--label', 'cleared.dev=v1', 'image'],
    ['network', 'create', '--label', 'cleared.session=s', 'n'],
    ['volume', 'create', 'v'],
    ['build', '-t', 'x', '.'],
    ['ps', '-a'],
    ['ps', '--filter', 'label=cleared.session=s'],
    ['network', 'ls'],
    ['volume', 'ls', '--filter', 'dangling=true'],
    ['rm', '-f', 'abc'],
    ['rm', '-f', '--', 'other'],
    ['rm', '-f', '--'],
    ['stop', '--', 'abc', 'other'],
    ['exec', '--', 'other', 'true'],
    ['network', 'rm', '--', 'bridge'],
    ['volume', 'rm', '--', 'production-data'],
    ['run', '--label', LABEL, 'image'],
    ['system', 'prune', '-af'],
    ['container', 'prune', '-f'],
    ['kill', '--', 'other'],
    ['kill', 'abc'],
    ['pull', 'postgres:16'],
    ['image', 'ls'],
    ['image', 'ls', '--filter', 'reference=x'],
    ['image', 'rm', '--', 'other'],
    ['image', 'inspect', '--', 'other'],
    ['image', 'prune', '-af'],
    ['rmi', 'abc'],
    [],
  ];
  for (const args of refused) assert.throws(() => assertLabelRule(args, owned), LabelRuleError, args.join(' '));
  const accepted: string[][] = [
    ['version', '--format', '{{json .}}'],
    ['create', '--label', LABEL, '--label', 'cleared.session=s', 'image'],
    ['build', '--label', LABEL, '-t', 'x', '.'],
    ['ps', '-a', '--filter', `label=${LABEL}`],
    ['rm', '-f', '--', 'abc'],
    ['kill', '--', 'abc'],
    ['exec', '--', 'abc', 'rm', '-rf', '/tmp/x'],
    ['image', 'ls', '--filter', `label=${LABEL}`],
    ['image', 'rm', '--force', '--', 'abc'],
  ];
  for (const args of accepted) assert.doesNotThrow(() => assertLabelRule(args, owned), args.join(' '));
});

// Milestone 2, decision 20: a sibling's ticket layer is built with no
// network, for the session, so that it goes with the session.
test('a build may run with no network and carry the session label', async () => {
  const fake = new FakeDocker();
  await new Docker(fake.runner).build({ context: '/work/ticket', dockerfile: '/state/layer/Dockerfile', tag: `cleared-v2-${SESSION}-sib-api:ticket`, network: 'none', session: SESSION });
  const args = fake.calls[0]?.args ?? [];
  const end = args.indexOf('--');
  assert.ok(hasPair(args, '--network', 'none') && args.indexOf('--network') < end, args.join(' '));
  assert.ok(hasPair(args, '--label', LABEL) && hasPair(args, '--label', `cleared.session=${SESSION}`), args.join(' '));
  assert.deepEqual(args.slice(end), ['--', '/work/ticket']);
  const plain = new FakeDocker();
  await new Docker(plain.runner).build({ context: '/images/fake', tag: 'cleared-v2-fake:1' });
  assert.ok(!(plain.calls[0]?.args ?? []).includes('--network'), 'a base image is built with the default network');
  await assert.rejects(new Docker(plain.runner).build({ context: '/x', tag: 'x:1', session: '--all' }));
});

test('a session\'s images are removed with it, each confirmed labelled by inspect before the removal', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  await docker.build({ context: '/a', tag: `cleared-v2-${SESSION}-sib-api:ticket`, network: 'none', session: SESSION });
  await docker.build({ context: '/b', tag: `cleared-v2-${OTHER}-sib-api:ticket`, network: 'none', session: OTHER });
  await docker.build({ context: '/c', tag: 'cleared-v2-base-api:cafe0b1ec7ed' });
  fake.images.push({ id: 'sha256:' + 'f'.repeat(64), name: 'production:latest', labels: {} });
  const removed = await docker.removeSession(SESSION);
  assert.deepEqual(removed, { containers: 0, networks: 0, images: 1 });
  assert.deepEqual(fake.images.map((image) => image.name).sort(), [`cleared-v2-${OTHER}-sib-api:ticket`, 'cleared-v2-base-api:cafe0b1ec7ed', 'production:latest'].sort());
  assertLog(fake.calls);
  const rm = fake.calls.findIndex((call) => verbOf(call.args) === 'image rm');
  assert.ok(rm > 0 && verbOf(fake.calls[rm - 1]?.args ?? []) === 'image inspect', 'inspected just before the removal');

  // A CLI that ignored the filters lists the unlabelled image: inspect
  // shows it has no label, and nothing is removed.
  const broken = new FakeDocker();
  broken.images.push({ id: 'sha256:' + 'f'.repeat(64), name: 'production:latest', labels: {} });
  broken.honourFilters = false;
  await assert.rejects(new Docker(broken.runner).removeSession(SESSION), LabelRuleError);
  assert.ok(!broken.calls.some((call) => verbOf(call.args) === 'image rm'));
  assert.equal(broken.images.length, 1);
});

test('an image is found by its tag among the labelled images, with its working folder', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  await docker.build({ context: '/c', tag: 'cleared-v2-base-api:cafe0b1ec7ed' });
  fake.images.push({ id: 'sha256:' + 'f'.repeat(64), name: 'node:24-slim', labels: {} });
  const found = await docker.image('cleared-v2-base-api:cafe0b1ec7ed');
  assert.equal(found?.workdir, '/app');
  assert.equal(found?.labels['cleared.dev'], 'v2');
  assert.equal(await docker.image('node:24-slim'), undefined, 'an image without the label is not one of ours');
  assert.equal(await docker.image('cleared-v2-missing:1'), undefined);
  await assert.rejects(docker.image('--all'));
  assertLog(fake.calls);
});

test('a labelled image is removed by its tag; an unlabelled one never is', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  await docker.build({ context: '/c', tag: 'cleared-v2-base-api:cafe0b1ec7ed' });
  fake.images.push({ id: 'sha256:' + 'f'.repeat(64), name: 'node:24-slim', labels: {} });
  assert.equal(await docker.removeImage('cleared-v2-base-api:cafe0b1ec7ed'), true);
  assert.equal(await docker.removeImage('node:24-slim'), false);
  assert.equal(await docker.removeImage('cleared-v2-base-api:cafe0b1ec7ed'), false, 'already gone');
  assert.deepEqual(fake.images.map((image) => image.name), ['node:24-slim']);
  assertLog(fake.calls);
});

test('a session id that could be read as an option or a pattern is refused', async () => {
  for (const id of ['', '--all', 'a b', 'ABC', 'x'.repeat(65), '../etc', 'a=b']) assert.throws(() => assertSessionId(id), id);
  assert.doesNotThrow(() => assertSessionId(SESSION));
  const docker = new Docker(new FakeDocker().runner);
  await assert.rejects(docker.removeSession('--all'));
});

test('a failed docker command throws with the command and its message', async () => {
  const fake = new FakeDocker();
  fake.intercept = (args) => (args[0] === 'network' ? { code: 1, stdout: '', stderr: 'Error response from daemon: boom\nmore' } : undefined);
  await assert.rejects(new Docker(fake.runner).createNetwork({ name: 'n', session: SESSION, internal: true }), /docker network create failed \(1\): Error response from daemon: boom/);
});

test('the container spec becomes flags, never a free argument list', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  await docker.createContainer(spec(`cleared-v2-${SESSION}-session`, {
    networks: [{ name: `cleared-v2-${SESSION}-out` }, { name: `cleared-v2-${SESSION}`, aliases: ['egress'] }],
    user: '1000:1000',
    readOnly: true,
    tmpfs: ['/tmp'],
    dropAllCapabilities: true,
    noNewPrivileges: true,
    limits: { memory: '2g', cpus: '1.5', pids: 256 },
    mounts: [
      { type: 'bind', source: '/srv/work', target: '/workspace' },
      { type: 'bind', source: '/srv/token', target: '/run/cleared/claude.token', readonly: true },
      { type: 'volume', source: `cleared-v2-${SESSION}-config`, target: '/var/lib/cleared/claude-config' },
    ],
    env: { HTTPS_PROXY: 'http://egress:3128' },
    workdir: '/workspace',
    command: ['sleep', 'infinity'],
  }));
  const args = fake.calls.at(-1)?.args ?? [];
  const expectPairs: [string, string][] = [
    ['--label', LABEL], ['--label', `cleared.session=${SESSION}`], ['--label', 'cleared.role=session'],
    ['--network', `name=cleared-v2-${SESSION}-out`], ['--network', `name=cleared-v2-${SESSION},alias=egress`],
    ['--user', '1000:1000'], ['--tmpfs', '/tmp'], ['--cap-drop', 'ALL'], ['--security-opt', 'no-new-privileges'],
    ['--memory', '2g'], ['--memory-swap', '2g'], ['--cpus', '1.5'], ['--pids-limit', '256'],
    ['--mount', 'type=bind,source=/srv/work,target=/workspace'],
    ['--mount', 'type=bind,source=/srv/token,target=/run/cleared/claude.token,readonly'],
    ['--mount', `type=volume,source=cleared-v2-${SESSION}-config,target=/var/lib/cleared/claude-config`],
    ['--env', 'HTTPS_PROXY=http://egress:3128'], ['--workdir', '/workspace'],
  ];
  for (const [flag, value] of expectPairs) assert.ok(hasPair(args, flag, value), `${flag} ${value} in ${args.join(' ')}`);
  assert.ok(args.includes('--read-only'));
  assert.deepEqual(args.slice(-3), ['cleared-v2-session:test', 'sleep', 'infinity']);
});

test('a spec value that could smuggle a flag or another mount is refused', async () => {
  const docker = new Docker(new FakeDocker().runner);
  const bad: Partial<ContainerSpec>[] = [
    { image: '--privileged' },
    { name: '-x' },
    { mounts: [{ type: 'bind', source: '/a,target=/b', target: '/c' }] },
    { mounts: [{ type: 'bind', source: 'relative', target: '/c' }] },
    { env: { 'A=B': 'c' } },
    { networks: [{ name: 'n,alias=x' }] },
    { limits: { memory: '2g; rm', cpus: '1', pids: 1 } },
    { tmpfs: ['/tmp:exec,uid=0', 'relative'] },
  ];
  for (const overrides of bad) await assert.rejects(docker.createContainer(spec(`cleared-v2-${SESSION}-session`, overrides)), JSON.stringify(overrides));
});

test('the CLI runner reports a command that exits without reading its input, or is missing, instead of crashing', async () => {
  // Several megabytes of input to a command that never reads it: writing to its stdin fails with EPIPE.
  const input = 'x'.repeat(8 * 1024 * 1024);
  const result = await commandRunner('true')([], { input });
  assert.equal(result.code, 0);
  await assert.rejects(commandRunner('cleared-v2-no-such-command')([], { input }), /ENOENT/);
});

// The web terminal (milestone 2, decision 32, lane 31): `docker exec
// --interactive --tty` on the owned id, as the session's user, in its
// checkout, under the host's `script`; what the human types goes to the
// process's input and never into a command line.
test('the terminal runs docker exec --interactive --tty on the owned id under script, and a typed line reaches the input only', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner, fake.spawner, (args) => {
    scripted.push([...args]);
    const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    children.push(child);
    return child;
  });
  const scripted: string[][] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const name = `cleared-v2-${SESSION}-session`;
  await docker.createContainer(spec(name));
  const id = fake.containers[0]!.id;
  const child = await docker.terminal(SESSION, name, { user: '1000:1000', workdir: '/workspace', command: ['sh', '-c', 'echo $$ > /tmp/.cleared-terminal.pid; exec bash -l'] });
  assertLog(fake.calls);
  assert.equal(scripted.length, 1);
  const args = scripted[0]!;
  assert.deepEqual([...args.slice(0, 4), args.at(-1)], ['--quiet', '--return', '--flush', '--command', '/dev/null']);
  assert.equal(args[4], `'docker' 'exec' '--interactive' '--tty' '--env' 'TERM=xterm-256color' '--user' '1000:1000' '--workdir' '/workspace' '--' '${id}' 'sh' '-c' 'echo $$ > /tmp/.cleared-terminal.pid; exec bash -l'`);

  const typed: Buffer[] = [];
  child.stdin.on('data', (chunk: Buffer) => typed.push(chunk));
  child.stdin.write("git push; echo '$(rm -rf /)'\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Buffer.concat(typed).toString(), "git push; echo '$(rm -rf /)'\r");
  assert.equal(scripted.length, 1, 'no new command line');
  assert.ok(!scripted[0]!.join(' ').includes('git push'));

  await assert.rejects(docker.terminal(SESSION, name, { user: "1000; rm -rf /", workdir: '/workspace', command: ['bash'] }), /invalid user/);
  await assert.rejects(docker.terminal(SESSION, name, { user: '1000:1000', workdir: "/workspace'; id; '", command: ['bash'] }), /invalid workdir/);
  await assert.rejects(docker.terminal(OTHER, name, { user: '1000:1000', workdir: '/workspace', command: ['bash'] }), /no container named/, 'another session\'s container is not found');
  assert.equal(scripted.length, 1);
});

test('releaseStopped removes by name the containers, then the networks, of the stopped sessions only; never a volume, an image nor a prune (issue 265)', async () => {
  const fake = new FakeDocker();
  const ours = (session: string, extra: Record<string, string> = {}) => ({ [LABEL.split('=')[0] as string]: 'v2', 'cleared.session': session, ...extra });
  const STOPPED = SESSION;
  const LIVE = OTHER;
  fake.containers.push(
    { id: 'c1', name: `cleared-v2-${STOPPED}-session`, labels: ours(STOPPED), state: 'exited' },
    { id: 'c2', name: `cleared-v2-${STOPPED}-egress`, labels: ours(STOPPED), state: 'running' },
    { id: 'c3', name: `cleared-v2-${STOPPED}-sib-filter-api`, labels: ours(STOPPED), state: 'running' },
    { id: 'c4', name: `cleared-v2-${LIVE}-session`, labels: ours(LIVE), state: 'running' },
    // The stopped session's label on a name that is not its own: left alone.
    { id: 'c5', name: 'cleared-guestbook', labels: ours(STOPPED), state: 'running' },
    // The same name without the label: the labelled list never returns it.
    { id: 'c6', name: `cleared-v2-${STOPPED}-svc-db`, labels: { 'cleared.session': STOPPED }, state: 'running' },
  );
  fake.networks.push(
    { id: 'n1', name: `cleared-v2-${STOPPED}`, labels: ours(STOPPED) },
    { id: 'n2', name: `cleared-v2-${STOPPED}-out`, labels: ours(STOPPED) },
    { id: 'n3', name: `cleared-v2-${LIVE}`, labels: ours(LIVE) },
    { id: 'n4', name: 'bridge-of-someone-else', labels: {} },
  );
  fake.volumes.push({ id: `cleared-v2-${STOPPED}-config`, name: `cleared-v2-${STOPPED}-config`, labels: ours(STOPPED) });
  const docker = new Docker(fake.runner);
  const released = await docker.releaseStopped([STOPPED]);
  assert.deepEqual(released, {
    containers: [`cleared-v2-${STOPPED}-session`, `cleared-v2-${STOPPED}-egress`, `cleared-v2-${STOPPED}-sib-filter-api`],
    networks: [`cleared-v2-${STOPPED}`, `cleared-v2-${STOPPED}-out`],
  });
  assert.deepEqual(fake.containers.map((c) => c.id), ['c4', 'c5', 'c6']);
  assert.deepEqual(fake.networks.map((n) => n.id), ['n3', 'n4']);
  assert.equal(fake.volumes.length, 1, 'the config volume stays');
  const lines = fake.calls.map((c) => c.args.join(' '));
  assert.deepEqual(fake.calls.map((c) => verbOf(c.args)), ['ps', 'rm', 'network ls', 'network rm']);
  for (const call of fake.calls.filter((c) => LISTS.has(verbOf(c.args)))) assert.ok(hasPair(call.args, '--filter', `label=${LABEL}`), call.args.join(' '));
  assert.ok(!lines.some((line) => /--volumes|volume rm|image rm|prune/.test(line)), lines.join('\n'));
  assert.deepEqual(fake.calls[1]?.args, ['rm', '--force', '--', `cleared-v2-${STOPPED}-session`, `cleared-v2-${STOPPED}-egress`, `cleared-v2-${STOPPED}-sib-filter-api`]);
  assert.deepEqual(fake.calls[3]?.args, ['network', 'rm', '--', `cleared-v2-${STOPPED}`, `cleared-v2-${STOPPED}-out`]);
});

// The live run of 2026-10-28 (issue #465): at a restart the flow's recovery
// and the lead's both release a stopped lead; the one that came second
// failed on what the first had removed, and the service said a failure.
test('releaseStopped run twice at once for the same session: both succeed and nothing of it is left; a removal that fails while its objects remain still fails', async () => {
  const fake = new FakeDocker();
  const labels = { [LABEL.split('=')[0] as string]: 'v2', 'cleared.session': SESSION };
  fake.containers.push({ id: 'c1', name: `cleared-v2-${SESSION}-session`, labels, state: 'exited' }, { id: 'c2', name: `cleared-v2-${SESSION}-egress`, labels, state: 'running' });
  fake.networks.push({ id: 'n1', name: `cleared-v2-${SESSION}`, labels }, { id: 'n2', name: `cleared-v2-${SESSION}-out`, labels });
  const docker = new Docker(fake.runner);
  const [one, two] = await Promise.all([docker.releaseStopped([SESSION]), docker.releaseStopped([SESSION])]);
  assert.deepEqual(one.containers, two.containers);
  assert.equal(fake.containers.length, 0);
  assert.equal(fake.networks.length, 0);

  fake.containers.push({ id: 'c3', name: `cleared-v2-${SESSION}-session`, labels, state: 'running' });
  fake.intercept = (args) => (args[0] === 'rm' ? { code: 1, stdout: '', stderr: 'Error: cannot remove container: device busy\n' } : undefined);
  await assert.rejects(docker.releaseStopped([SESSION]), /docker rm failed/);
  assert.equal(fake.containers.length, 1);
});

test('releaseStopped with no session asks Docker nothing, and refuses what is not a session id before any call', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  assert.deepEqual(await docker.releaseStopped([]), { containers: [], networks: [] });
  await assert.rejects(docker.releaseStopped([SESSION, '--all']), /not a session id/);
  assert.equal(fake.calls.length, 0);
});

// The test secrets (docs/v2/milestone-5-plan.md, decision 12): a private
// variable is named on the command line, `--env NAME`, and its value is in
// the client's own environment, where the CLI reads it; another account of
// the machine reads a command line in the process list, never this.
test('a private variable goes by name on the command line and by value in the client\'s environment', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  const value = ['sandbox', 'fake', 'value', '1'].join('-');
  await docker.createContainer(spec(`cleared-v2-${SESSION}-session`, { env: { HOME: '/tmp' }, privateEnv: { PAYMENT_SANDBOX_KEY: value } }));
  const call = fake.calls.find((c) => c.args[0] === 'create');
  assert.ok(call);
  assert.ok(call.args.includes('PAYMENT_SANDBOX_KEY') && call.args.includes('HOME=/tmp'));
  assert.ok(!call.args.some((arg) => arg.includes(value)));
  assert.deepEqual(call.options.env, { PAYMENT_SANDBOX_KEY: value });
  await assert.rejects(docker.createContainer(spec(`cleared-v2-${SESSION}-other`, { env: { HOME: '/tmp' }, privateEnv: { HOME: value } })), /HOME/, 'one name, one place');
  await assert.rejects(docker.createContainer(spec(`cleared-v2-${SESSION}-bad`, { privateEnv: { 'NOT A NAME': value } })), (error: Error) => !error.message.includes(value));
});

test('the command runner hands the client the environment it is given, over its own', async () => {
  const value = ['sandbox', 'fake', 'value', '2'].join('-');
  const run = commandRunner(process.execPath);
  const result = await run(['-e', 'process.stdout.write(JSON.stringify([process.env.PAYMENT_SANDBOX_KEY ?? null, typeof process.env.PATH]))'], { env: { PAYMENT_SANDBOX_KEY: value } });
  assert.deepEqual(JSON.parse(result.stdout), [value, 'string']);
  const plain = await run(['-e', 'process.stdout.write(String(process.env.PAYMENT_SANDBOX_KEY ?? null))'], {});
  assert.equal(plain.stdout, 'null');
});
