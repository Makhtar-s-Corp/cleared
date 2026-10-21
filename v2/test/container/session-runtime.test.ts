import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Docker, LABEL } from '../../src/container/docker.ts';
import { parseServices } from '../../src/container/services.ts';
import {
  ALLOW_FILE, DEFAULT_ALLOW_HOSTS, DEFAULT_LIMITS, EGRESS_IMAGE, SESSION_IMAGE, buildBaseImages, removeSessionVolume,
  sessionImage, sessionNames, startSession, stopSession, writeAllowList, type SessionRuntimeSpec,
} from '../../src/container/session-runtime.ts';
import { FakeDocker, type FakeObject } from './fake-docker.ts';

const SESSION = '0b7f3c1e-5d0a-4a6e-9f3b-1c2d3e4f5a6b';

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-runtime-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runtimeSpec(overrides: Partial<SessionRuntimeSpec> = {}): SessionRuntimeSpec {
  const dir = scratch();
  return {
    session: SESSION,
    workdir: join(dir, 'work'),
    tokenFile: join(dir, 'claude.token'),
    allowDir: join(dir, 'egress'),
    allowHosts: ['github.com'],
    hostAddresses: ['203.0.113.7', '100.88.177.1'],
    services: parseServices('postgres:16'),
    user: '1000:1000',
    command: ['sleep', 'infinity'],
    readyPollMs: 0,
    ...overrides,
  };
}

const hasPair = (args: readonly string[] | undefined, flag: string, value: string): boolean =>
  (args ?? []).some((arg, index) => arg === flag && args?.[index + 1] === value);

const byName = (objects: FakeObject[], name: string): FakeObject => {
  const found = objects.find((object) => object.name === name);
  assert.ok(found, `no object named ${name}`);
  return found;
};

test('a session gets an internal network, an egress network, a config volume, its services, the egress proxy and its container', async () => {
  const fake = new FakeDocker();
  const spec = runtimeSpec();
  const started = await startSession(new Docker(fake.runner), spec);
  const names = sessionNames(SESSION);

  assert.equal(started.session, SESSION);
  assert.deepEqual(fake.networks.map((n) => n.name).sort(), [names.network, names.outNetwork].sort());
  assert.ok(byName(fake.networks, names.network).args?.includes('--internal'), 'the session network has no route out');
  // Without it, the bridge holds a gateway address on the host, and the
  // session reaches every host service listening on 0.0.0.0 (seen in the
  // first doctor run: a host service answered on the gateway address).
  assert.ok(hasPair(byName(fake.networks, names.network).args, '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated'), 'the session network has no address on the host');
  assert.ok(!byName(fake.networks, names.outNetwork).args?.includes('--opt'));
  assert.ok(!byName(fake.networks, names.outNetwork).args?.includes('--internal'));
  assert.deepEqual(fake.volumes.map((v) => v.name), [names.volume]);
  assert.deepEqual(fake.containers.map((c) => c.name), [names.service('postgres'), names.egress, names.container]);
  for (const object of fake.all()) {
    assert.equal(object.labels['cleared.dev'], 'v2', object.name);
    assert.equal(object.labels['cleared.session'], SESSION, object.name);
  }
  assert.deepEqual(fake.containers.map((c) => c.state), ['running', 'running', 'running']);

  const postgres = byName(fake.containers, names.service('postgres')).args;
  assert.ok(hasPair(postgres, '--network', `name=${names.network},alias=postgres`));
  assert.ok(hasPair(postgres, '--tmpfs', '/var/lib/postgresql/data'), 'the image volume is a tmpfs, not an anonymous volume');
  assert.ok(hasPair(postgres, '--env', 'POSTGRES_HOST_AUTH_METHOD=trust'));
  assert.ok(hasPair(postgres, '--memory', '1g'));

  const egress = byName(fake.containers, names.egress).args;
  assert.ok(hasPair(egress, '--network', `name=${names.outNetwork}`));
  assert.ok(hasPair(egress, '--network', `name=${names.network},alias=egress`));
  assert.ok(hasPair(egress, '--mount', `type=bind,source=${spec.allowDir},target=/etc/cleared/egress,readonly`));
  assert.ok(hasPair(egress, '--env', 'EGRESS_DENY_ADDRESSES=203.0.113.7,100.88.177.1'));
  assert.ok(hasPair(egress, '--cap-drop', 'ALL') && egress?.includes('--read-only'));
  assert.equal(egress?.at(-1), EGRESS_IMAGE);

  const session = byName(fake.containers, names.container).args;
  const expected: [string, string][] = [
    ['--network', `name=${names.network}`], ['--user', '1000:1000'], ['--tmpfs', '/tmp'], ['--cap-drop', 'ALL'],
    ['--security-opt', 'no-new-privileges'], ['--memory', DEFAULT_LIMITS.memory], ['--cpus', DEFAULT_LIMITS.cpus],
    ['--pids-limit', String(DEFAULT_LIMITS.pids)],
    ['--mount', `type=bind,source=${spec.workdir},target=/workspace`],
    ['--mount', `type=bind,source=${spec.tokenFile},target=/run/cleared/claude.token,readonly`],
    ['--mount', `type=volume,source=${names.volume},target=/var/lib/cleared/claude-config`],
    ['--env', 'HTTPS_PROXY=http://egress:3128'], ['--env', 'HTTP_PROXY=http://egress:3128'],
    ['--env', 'https_proxy=http://egress:3128'], ['--env', 'http_proxy=http://egress:3128'],
    ['--env', 'NO_PROXY=localhost,127.0.0.1,postgres'], ['--env', 'no_proxy=localhost,127.0.0.1,postgres'],
    ['--env', 'DATABASE_URL=postgres://postgres@postgres:5432/postgres'], ['--env', 'HOME=/tmp'],
    ['--workdir', '/workspace'],
  ];
  for (const [flag, value] of expected) assert.ok(hasPair(session, flag, value), `${flag} ${value}`);
  assert.ok(session?.includes('--read-only'));
  assert.deepEqual(session?.slice(-3), [SESSION_IMAGE, 'sleep', 'infinity']);
});

test('nothing of the host is reachable through the command lines: no socket, no published port, no host network, no privilege', async () => {
  const fake = new FakeDocker();
  await startSession(new Docker(fake.runner), runtimeSpec());
  for (const call of fake.calls) {
    const shown = call.args.join(' ');
    assert.ok(!shown.includes('docker.sock'), shown);
    for (const flag of ['-p', '--publish', '--publish-all', '-P', '--privileged', '--pid', '--ipc', '--cap-add', '--device']) {
      assert.ok(!call.args.includes(flag), `${flag} in ${shown}`);
    }
    assert.ok(!call.args.some((arg) => /^name=(host|bridge|none)\b/.test(arg) || arg === 'host'), shown);
  }
});

test('the session starts after its services answer their readiness command', async () => {
  const fake = new FakeDocker();
  let probes = 0;
  fake.execAnswer = (command) => {
    if (command[0] !== 'pg_isready') return { code: 0, stdout: '', stderr: '' };
    probes += 1;
    return { code: probes < 3 ? 2 : 0, stdout: '', stderr: '' };
  };
  await startSession(new Docker(fake.runner), runtimeSpec());
  assert.equal(probes, 3);
  const order = fake.calls.map((call) => call.args[0] === 'create' ? `create ${call.args[call.args.indexOf('--name') + 1]}` : call.args[0]);
  assert.ok(order.lastIndexOf('exec') < order.indexOf(`create ${sessionNames(SESSION).container}`), 'the session container is created after the last readiness probe');
});

// The config volume holds the harness's session history: a failed start
// (a resume included) keeps it, as stop does.
const onlyVolume = (fake: FakeDocker): string[] => fake.withLabel('cleared.session', SESSION).map((o) => o.name);

test('a service that never becomes ready stops the start and removes what was created', async () => {
  const fake = new FakeDocker();
  fake.execAnswer = () => ({ code: 2, stdout: '', stderr: '' });
  await assert.rejects(startSession(new Docker(fake.runner), runtimeSpec({ readyTimeoutMs: 0 })), /postgres did not become ready/);
  assert.deepEqual(onlyVolume(fake), [sessionNames(SESSION).volume]);
});

test('a failure halfway removes everything the start created, labelled objects only', async () => {
  const fake = new FakeDocker();
  fake.containers.push({ id: 'f'.repeat(64), name: 'production-db', labels: {}, state: 'running' });
  fake.intercept = (args) => (args[0] === 'create' && args.includes(`cleared.role=egress`) ? { code: 125, stdout: '', stderr: 'Error: boom' } : undefined);
  await assert.rejects(startSession(new Docker(fake.runner), runtimeSpec()), /boom/);
  assert.deepEqual(onlyVolume(fake), [sessionNames(SESSION).volume]);
  assert.deepEqual(fake.containers.map((c) => c.name), ['production-db']);
});

test('an interactive session is created and left for the adapter to start attached', async () => {
  const fake = new FakeDocker();
  const started = await startSession(new Docker(fake.runner), runtimeSpec({ interactive: true }));
  const session = byName(fake.containers, sessionNames(SESSION).container);
  assert.equal(session.state, 'created');
  assert.ok(session.args?.includes('--interactive'));
  assert.equal(started.started, false);
});

test('the base images are built with the label, and a devcontainer Dockerfile becomes a labelled project image', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  await buildBaseImages(docker, '/repo/v2/images');
  const builds = fake.calls.filter((c) => c.args[0] === 'build').map((c) => c.args);
  assert.deepEqual(builds.map((args) => [args[args.indexOf('--tag') + 1], args.at(-1)]), [
    [SESSION_IMAGE, '/repo/v2/images/session'], [EGRESS_IMAGE, '/repo/v2/images/egress'],
  ]);
  for (const args of builds) assert.ok(hasPair(args, '--label', LABEL));

  assert.equal(await sessionImage(docker, { kind: 'default', image: SESSION_IMAGE, ignored: [] }, 'guestbook'), SESSION_IMAGE);
  assert.equal(await sessionImage(docker, { kind: 'image', image: 'example/dev:1', ignored: [] }, 'guestbook'), 'example/dev:1');
  const tag = await sessionImage(docker, { kind: 'dockerfile', dockerfile: '/w/.devcontainer/Dockerfile', context: '/w/.devcontainer', ignored: [] }, 'guestbook');
  assert.equal(tag, 'cleared-v2-project-guestbook:latest');
  const last = fake.calls.at(-1)?.args ?? [];
  assert.ok(hasPair(last, '--label', LABEL) && hasPair(last, '--file', '/w/.devcontainer/Dockerfile') && last.at(-1) === '/w/.devcontainer');
  await assert.rejects(sessionImage(docker, { kind: 'dockerfile', dockerfile: '/w/D', context: '/w', ignored: [] }, 'Bad Name'));
});

test('stop removes the containers and the networks and keeps the config volume until the ticket is done', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  await startSession(docker, runtimeSpec());
  assert.deepEqual(await stopSession(docker, SESSION), { containers: 3, networks: 2 });
  assert.deepEqual(fake.withLabel('cleared.session', SESSION).map((o) => o.name), [sessionNames(SESSION).volume]);
  assert.equal(await removeSessionVolume(docker, SESSION), 1);
  assert.deepEqual(fake.withLabel('cleared.session', SESSION), []);
  assert.deepEqual(await stopSession(docker, SESSION), { containers: 0, networks: 0 }, 'a second stop is a no-op');
});

test('the allow list file holds the defaults and the declared hosts, and is replaced in one rename', () => {
  const dir = scratch();
  writeAllowList(dir, ['github.com', 'api.anthropic.com', '*.pkg.example.org:8443']);
  const text = readFileSync(join(dir, ALLOW_FILE), 'utf8');
  const hosts = text.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.deepEqual(hosts, [...DEFAULT_ALLOW_HOSTS, 'github.com', '*.pkg.example.org:8443']);
  assert.deepEqual(readdirSync(dir), [ALLOW_FILE], 'no temporary file is left behind');
  assert.equal(statSync(join(dir, ALLOW_FILE)).mode & 0o777, 0o644);
  assert.throws(() => writeAllowList(dir, ['http://evil.org']));
  assert.equal(readFileSync(join(dir, ALLOW_FILE), 'utf8'), text, 'an invalid list leaves the previous file in place');
});

test('a relative path, a bad user, a bad host or a reused alias is refused before any docker call', async () => {
  const cases: Partial<SessionRuntimeSpec>[] = [
    { workdir: 'work' }, { tokenFile: 'token' }, { allowDir: 'egress' }, { user: 'root' }, { user: '0:0' },
    { allowHosts: ['10.0.0.1'] }, { hostAddresses: ['not an ip'] }, { session: '--all' },
    { services: [...parseServices('postgres:16'), ...parseServices('postgres:16')] },
  ];
  for (const overrides of cases) {
    const fake = new FakeDocker();
    await assert.rejects(startSession(new Docker(fake.runner), runtimeSpec(overrides)), JSON.stringify(overrides));
    assert.deepEqual(fake.calls, [], JSON.stringify(overrides));
  }
});

test('the labels are the only way the runtime finds its objects', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  await startSession(docker, runtimeSpec());
  await stopSession(docker, SESSION);
  for (const call of fake.calls.filter((c) => ['ps', 'network', 'volume'].includes(c.args[0] ?? '') && c.args.includes('--filter'))) {
    assert.ok(hasPair(call.args, '--filter', `label=${LABEL}`), call.args.join(' '));
    assert.ok(hasPair(call.args, '--filter', `label=cleared.session=${SESSION}`), call.args.join(' '));
  }
});
