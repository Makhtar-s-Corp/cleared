import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Docker, LABEL } from '../../src/container/docker.ts';
import { parseServices } from '../../src/container/services.ts';
import {
  ALLOW_FILE, DEFAULT_ALLOW_HOSTS, DEFAULT_LIMITS, EGRESS_IMAGE, FAKE_IMAGE, READ_ONLY_MARK, SESSION_IMAGE, SKILLS_MOUNT, WORKDIR_MOUNT, buildBaseImages, removeSessionVolume,
  sessionImage, sessionNames, startSession, stopSession, writeAllowList, type SessionRuntimeSpec,
} from '../../src/container/session-runtime.ts';
import { FakeDocker, type FakeObject } from './fake-docker.ts';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createClaudeCodeAdapter } from '../../src/session/adapters/claude-code.ts';
import { createCleaner } from '../../src/session/clean.ts';
import type { StartInput } from '../../src/session/contract.ts';
import { DEFAULT_SAFE_COMMANDS } from '../../src/session/policy.ts';

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
    // The folder the runner's user setting source reads (B5.5b), where the skills are mounted.
    ['--env', 'CLAUDE_CONFIG_DIR=/var/lib/cleared/claude-config'],
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
  // Said in seconds, as the flow's other waits are: the message reaches the ticket's comment.
  await assert.rejects(startSession(new Docker(fake.runner), runtimeSpec({ readyTimeoutMs: 0 })), /: postgres did not become ready within 0 seconds$/);
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
    [SESSION_IMAGE, '/repo/v2/images/session'], [EGRESS_IMAGE, '/repo/v2/images/egress'], [FAKE_IMAGE, '/repo/v2/images/fake'],
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

test('a second start of a running session is refused and leaves the running session as it was', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  await startSession(docker, runtimeSpec());
  const running = fake.withLabel('cleared.session', SESSION).map((o) => `${o.name} ${o.state ?? ''}`).sort();
  const callsBefore = fake.calls.length;

  await assert.rejects(startSession(docker, runtimeSpec()), /already has 3 containers and 2 networks: stop it first/);

  assert.deepEqual(fake.withLabel('cleared.session', SESSION).map((o) => `${o.name} ${o.state ?? ''}`).sort(), running);
  const second = fake.calls.slice(callsBefore).map((call) => call.args[0] === 'network' || call.args[0] === 'volume' ? `${call.args[0]} ${call.args[1]}` : call.args[0]);
  assert.deepEqual(second, ['ps', 'network ls'], 'the refusal only lists');
});

test('a failed start removes only what that call created', async () => {
  const fake = new FakeDocker();
  const names = sessionNames(SESSION);
  // Another start of the same session wins a race after the check: its
  // container must survive the cleanup of this one.
  fake.intercept = (args) => {
    if (args[0] !== 'create' || !args.includes('cleared.role=egress')) return undefined;
    fake.containers.push({ id: 'c'.repeat(64), name: `${names.container}-other`, labels: { 'cleared.dev': 'v2', 'cleared.session': SESSION }, state: 'running' });
    return { code: 125, stdout: '', stderr: 'Error: boom' };
  };
  await assert.rejects(startSession(new Docker(fake.runner), runtimeSpec()), /boom/);
  assert.deepEqual(onlyVolume(fake).sort(), [`${names.container}-other`, names.volume].sort());
});

test('a cleanup that fails after a failed start is reported with the first error', async () => {
  const fake = new FakeDocker();
  fake.intercept = (args) => {
    if (args[0] === 'create' && args.includes('cleared.role=egress')) return { code: 125, stdout: '', stderr: 'Error: boom' };
    if (args[0] === 'rm') return { code: 1, stdout: '', stderr: 'Error: cannot remove' };
    return undefined;
  };
  await assert.rejects(startSession(new Docker(fake.runner), runtimeSpec()), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /boom/);
    assert.match(error.message, /cleanup failed: docker rm failed \(1\): Error: cannot remove/);
    assert.match(error.message, /left behind: cleared-v2-.*-svc-postgres/);
    assert.match(String((error as Error & { cause?: unknown }).cause), /boom/);
    return true;
  });
});

test('stop removes the containers and the networks and keeps the config volume until the ticket is done', async () => {
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  await startSession(docker, runtimeSpec());
  assert.deepEqual(await stopSession(docker, SESSION), { containers: 3, networks: 2, images: 0 });
  assert.deepEqual(fake.withLabel('cleared.session', SESSION).map((o) => o.name), [sessionNames(SESSION).volume]);
  assert.equal(await removeSessionVolume(docker, SESSION), 1);
  assert.deepEqual(fake.withLabel('cleared.session', SESSION), []);
  assert.deepEqual(await stopSession(docker, SESSION), { containers: 0, networks: 0, images: 0 }, 'a second stop is a no-op');
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

// ------------------------------------------ siblings and skills (milestone 2, decision 20)

const PACKAGE = '{"name":"guestbook","dependencies":{"pg":"8.13.1"}}';

// A base folder and a ticket checkout of the guestbook, with the same
// dependencies unless `checkoutPackage` says otherwise; the filter API's
// contract, copied from lane 28's example.
function workspaceFiles(checkoutPackage = PACKAGE) {
  const dir = scratch();
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  write('base/guestbook/Dockerfile', 'FROM node:24-slim\nWORKDIR /app\nCOPY . .\nRUN npm ci\n');
  write('base/guestbook/package.json', PACKAGE);
  write('work/T-1/guestbook/package.json', checkoutPackage);
  write('work/T-1/guestbook/src/main.ts', 'changed by the session');
  write('base/filter-api/contract/openapi.yaml', readFileSync(new URL('./fixtures/filter-api.openapi.yaml', import.meta.url), 'utf8'));
  write('skills/cleared-guestbook/SKILL.md', '---\nname: cleared-guestbook\ndescription: x\n---\n');
  return {
    skills: join(dir, 'skills'),
    contract: join(dir, 'base/filter-api/contract/openapi.yaml'),
    guestbook: { name: 'guestbook', port: 8793, real: { base: join(dir, 'base/guestbook'), dockerfile: 'Dockerfile', tag: 'cleared-v2-base-guestbook:cafe0b1ec7ed', checkout: join(dir, 'work/T-1/guestbook') } },
    filter: { name: 'filter-api', port: 8795, contract: join(dir, 'base/filter-api/contract/openapi.yaml') },
  };
}

// The text of each generated Dockerfile, read while its build runs: the
// folder is removed after the build.
function recordGenerated(fake: FakeDocker): string[] {
  const texts: string[] = [];
  fake.intercept = (args) => {
    if (args[0] === 'build' && args.includes('--network')) texts.push(readFileSync(args[args.indexOf('--file') + 1] ?? '', 'utf8'));
    return undefined;
  };
  return texts;
}

const builds = (fake: FakeDocker) => fake.calls.filter((call) => call.args[0] === 'build').map((call) => call.args);

test('a real sibling is built in two layers: the base from the landed branch with its own Dockerfile, the ticket layer with no network and FROM and COPY only', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  const generated = recordGenerated(fake);
  const started = await startSession(new Docker(fake.runner), runtimeSpec({ siblings: [files.guestbook] }));
  const [base, ticket, ...more] = builds(fake);
  assert.deepEqual(more, []);
  assert.ok(base && hasPair(base, '--label', LABEL) && hasPair(base, '--tag', 'cleared-v2-base-guestbook:cafe0b1ec7ed'), base?.join(' '));
  assert.ok(base && hasPair(base, '--file', join(files.guestbook.real.base, 'Dockerfile')) && base.at(-1) === files.guestbook.real.base);
  assert.ok(base && !base.includes('--network') && !base.includes(`cleared.session=${SESSION}`), 'the base layer is shared, and may install its dependencies');
  assert.ok(ticket && hasPair(ticket, '--network', 'none'), `the ticket layer reaches no network: ${ticket?.join(' ')}`);
  assert.ok(ticket && hasPair(ticket, '--label', LABEL) && hasPair(ticket, '--label', `cleared.session=${SESSION}`));
  assert.ok(ticket && hasPair(ticket, '--tag', sessionNames(SESSION).siblingImage('guestbook')));
  assert.equal(ticket?.at(-1), files.guestbook.real.checkout, 'the checkout is the build context');
  assert.ok(!(ticket?.[ticket.indexOf('--file') + 1] ?? '').startsWith(files.guestbook.real.checkout), 'the generated Dockerfile is not in the checkout');
  assert.equal(generated.length, 1);
  assert.deepEqual(generated[0]?.split('\n').filter((line) => line && !line.startsWith('#')), ['FROM cleared-v2-base-guestbook:cafe0b1ec7ed', 'COPY . /app/']);
  assert.deepEqual(started.siblings, [{ name: 'guestbook', container: sessionNames(SESSION).sibling('guestbook'), kind: 'ticket', ready: true }]);
});

test('a fake is told the format of its contract, and OpenAPI is told nothing (M11)', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  const proto = { name: 'royalties', port: 8801, contract: join(files.contract, '..', 'royalties.proto'), contractFormat: 'protobuf' as const };
  await startSession(new Docker(fake.runner), runtimeSpec({ siblings: [files.filter, proto] }));
  const names = sessionNames(SESSION);
  const protoArgs = byName(fake.containers, names.sibling('royalties')).args ?? [];
  assert.ok(hasPair(protoArgs, '--env', 'FAKE_CONTRACT=/etc/cleared/fake/royalties.proto') && hasPair(protoArgs, '--env', 'FAKE_FORMAT=protobuf'), protoArgs.join(' '));
  const openapiArgs = byName(fake.containers, names.sibling('filter-api')).args ?? [];
  assert.ok(!openapiArgs.some((arg) => arg.startsWith('FAKE_FORMAT=')));
});

test('a sibling runs labelled on the session network under its name, without privilege, with the test services\' variables', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  await startSession(new Docker(fake.runner), runtimeSpec({ siblings: [files.guestbook, files.filter] }));
  const names = sessionNames(SESSION);
  const sibling = byName(fake.containers, names.sibling('guestbook')).args ?? [];
  assert.ok(hasPair(sibling, '--label', LABEL) && hasPair(sibling, '--label', `cleared.session=${SESSION}`) && hasPair(sibling, '--label', 'cleared.role=sibling'));
  assert.ok(hasPair(sibling, '--network', `name=${names.network},alias=guestbook`));
  assert.ok(hasPair(sibling, '--cap-drop', 'ALL') && hasPair(sibling, '--security-opt', 'no-new-privileges'));
  assert.ok(hasPair(sibling, '--env', 'DATABASE_URL=postgres://postgres@postgres:5432/postgres'));
  assert.ok(sibling.includes(names.siblingImage('guestbook')));
  const fakeArgs = byName(fake.containers, names.sibling('filter-api')).args ?? [];
  assert.ok(hasPair(fakeArgs, '--label', LABEL) && hasPair(fakeArgs, '--label', `cleared.session=${SESSION}`) && hasPair(fakeArgs, '--label', 'cleared.role=fake'));
  assert.ok(hasPair(fakeArgs, '--network', `name=${names.network},alias=filter-api`));
  assert.ok(hasPair(fakeArgs, '--mount', `type=bind,source=${join(files.contract, '..')},target=/etc/cleared/fake,readonly`), 'the contract is mounted read only');
  assert.ok(hasPair(fakeArgs, '--env', 'FAKE_CONTRACT=/etc/cleared/fake/openapi.yaml') && hasPair(fakeArgs, '--env', 'FAKE_PORT=8795'));
  assert.ok(fakeArgs.includes('--read-only') && hasPair(fakeArgs, '--cap-drop', 'ALL'));
  assert.ok(fakeArgs.includes(FAKE_IMAGE));
  for (const args of [sibling, fakeArgs]) for (const flag of ['-p', '--publish', '--publish-all', '-P', '--privileged']) assert.ok(!args.includes(flag));
  const session = byName(fake.containers, names.container).args ?? [];
  const noProxy = session[session.findIndex((arg, i) => arg === '--env' && session[i + 1]?.startsWith('NO_PROXY=')) + 1];
  assert.equal(noProxy, 'NO_PROXY=localhost,127.0.0.1,postgres,guestbook,filter-api');
});

// The probe connects to the sibling's address on the session network, read
// from a labelled inspect while it runs: a name that no longer resolves on
// that network would be looked up outside it, through the egress container.
test('each sibling is awaited from the egress container, at its address on the session network, before the session starts', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  const probes: string[] = [];
  fake.execAnswer = (command) => {
    if (command[0] === 'node') probes.push(command.slice(-2).join(':'));
    return { code: 0, stdout: '', stderr: '' };
  };
  await startSession(new Docker(fake.runner), runtimeSpec({ siblings: [files.guestbook, files.filter] }));
  const address = (name: string) => `172.30.0.${fake.containers.findIndex((c) => c.name === sessionNames(SESSION).sibling(name)) + 2}`;
  assert.deepEqual(probes, [`${address('guestbook')}:8793`, `${address('filter-api')}:8795`]);
  const egress = fake.containers.find((c) => c.name === sessionNames(SESSION).egress)?.id;
  for (const call of fake.calls.filter((c) => c.args[0] === 'exec' && c.args.includes('node'))) assert.equal(call.args[call.args.indexOf('--') + 1], egress);
});

test('a checkout whose package.json dependencies differ from the base makes the sibling a fake, with the reason', async () => {
  const files = workspaceFiles('{"name":"guestbook","dependencies":{"pg":"9.0.0"}}');
  const fake = new FakeDocker();
  const started = await startSession(new Docker(fake.runner), runtimeSpec({ siblings: [{ ...files.guestbook, contract: files.contract }] }));
  assert.ok(!builds(fake).some((args) => args.includes('--network')), 'no ticket layer is built');
  assert.deepEqual(started.siblings, [{ name: 'guestbook', container: sessionNames(SESSION).sibling('guestbook'), kind: 'fake', ready: true, reason: 'the ticket changes the package.json dependencies' }]);
  assert.ok(byName(fake.containers, sessionNames(SESSION).sibling('guestbook')).args?.includes(FAKE_IMAGE));
});

test('with no contract to fake, a sibling whose ticket layer cannot be built runs the base layer', async () => {
  const files = workspaceFiles('{"name":"guestbook","dependencies":{"pg":"9.0.0"}}');
  const fake = new FakeDocker();
  const started = await startSession(new Docker(fake.runner), runtimeSpec({ siblings: [files.guestbook] }));
  assert.equal(started.siblings[0]?.kind, 'base');
  assert.ok(byName(fake.containers, sessionNames(SESSION).sibling('guestbook')).args?.includes('cleared-v2-base-guestbook:cafe0b1ec7ed'));
});

test('a ticket layer that fails to build falls back to the fake', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  fake.intercept = (args) => (args[0] === 'build' && args.includes('--network') ? { code: 1, stdout: '', stderr: 'ERROR: failed to solve: boom' } : undefined);
  const started = await startSession(new Docker(fake.runner), runtimeSpec({ siblings: [{ ...files.guestbook, contract: files.contract }] }));
  assert.equal(started.siblings[0]?.kind, 'fake');
  assert.match(started.siblings[0]?.reason ?? '', /the ticket layer could not be built: .*boom/);
});

test('a sibling that is not running is never probed, and is reported not ready', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  const sibling = sessionNames(SESSION).sibling('guestbook');
  // Its start leaves it created, as a container that exits at once would be.
  fake.intercept = (args) => (args[0] === 'start' && fake.containers.find((c) => c.id === args.at(-1))?.name === sibling ? { code: 0, stdout: '', stderr: '' } : undefined);
  const probes: string[] = [];
  fake.execAnswer = (command) => {
    if (command[0] === 'node') probes.push(command.join(' '));
    return { code: 0, stdout: '', stderr: '' };
  };
  const started = await startSession(new Docker(fake.runner), runtimeSpec({ siblings: [files.guestbook], readyTimeoutMs: 0 }));
  assert.equal(started.siblings[0]?.ready, false);
  assert.deepEqual(probes, []);
});

test('the VOLUME paths of a sibling\'s image are tmpfs: no unlabelled anonymous volume is created', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  fake.volumesOf = (tag) => (tag.includes('guestbook') ? ['/data', '/var/cache/app'] : []);
  await startSession(new Docker(fake.runner), runtimeSpec({ siblings: [files.guestbook] }));
  const args = byName(fake.containers, sessionNames(SESSION).sibling('guestbook')).args ?? [];
  assert.ok(hasPair(args, '--tmpfs', '/data') && hasPair(args, '--tmpfs', '/var/cache/app'), args.join(' '));
  assert.ok(!args.some((arg) => arg.startsWith('type=volume')));
  // The base layer too, when it runs.
  const base = new FakeDocker();
  base.volumesOf = (tag) => (tag.startsWith('cleared-v2-base-') ? ['/data'] : []);
  await startSession(new Docker(base.runner), runtimeSpec({ siblings: [{ ...files.guestbook, real: { ...files.guestbook.real, checkout: undefined } }] }));
  assert.ok(hasPair(byName(base.containers, sessionNames(SESSION).sibling('guestbook')).args ?? [], '--tmpfs', '/data'));
});

test('a sibling that never answers is reported and does not hold the session back', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  fake.execAnswer = (command) => ({ code: command[0] === 'node' ? 1 : 0, stdout: '', stderr: '' });
  const started = await startSession(new Docker(fake.runner), runtimeSpec({ siblings: [files.guestbook], readyTimeoutMs: 0 }));
  assert.equal(started.siblings[0]?.ready, false);
  assert.equal(byName(fake.containers, sessionNames(SESSION).container).state, 'running');
});

test('the project\'s skills are mounted read only where Claude Code reads its skills', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  await startSession(new Docker(fake.runner), runtimeSpec({ skills: files.skills }));
  const session = byName(fake.containers, sessionNames(SESSION).container).args ?? [];
  assert.equal(SKILLS_MOUNT, '/var/lib/cleared/claude-config/skills');
  assert.ok(hasPair(session, '--mount', `type=bind,source=${files.skills},target=${SKILLS_MOUNT},readonly`), session.join(' '));
  const without = new FakeDocker();
  await startSession(new Docker(without.runner), runtimeSpec());
  assert.ok(!(byName(without.containers, sessionNames(SESSION).container).args ?? []).some((arg) => arg.includes(SKILLS_MOUNT)));
});

test('stop removes the siblings and the ticket layer image; the shared base layer stays', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  const docker = new Docker(fake.runner);
  await startSession(docker, runtimeSpec({ siblings: [files.guestbook, files.filter] }));
  assert.deepEqual(await stopSession(docker, SESSION), { containers: 5, networks: 2, images: 1 });
  assert.deepEqual(fake.withLabel('cleared.session', SESSION).map((o) => o.name), [sessionNames(SESSION).volume]);
  assert.deepEqual(fake.images.map((image) => image.name), ['cleared-v2-base-guestbook:cafe0b1ec7ed']);
});

test('a failed start removes the ticket layer image it built', async () => {
  const files = workspaceFiles();
  const fake = new FakeDocker();
  fake.intercept = (args) => (args[0] === 'create' && args.includes('cleared.role=egress') ? { code: 125, stdout: '', stderr: 'Error: boom' } : undefined);
  await assert.rejects(startSession(new Docker(fake.runner), runtimeSpec({ siblings: [files.guestbook] })), /boom/);
  assert.deepEqual(onlyVolume(fake), [sessionNames(SESSION).volume]);
});

test('a sibling named like a test service or a reserved name, a bad port or a relative path is refused before any docker call', async () => {
  const files = workspaceFiles();
  const cases: Partial<SessionRuntimeSpec>[] = [
    { siblings: [{ ...files.filter, name: 'postgres' }] }, { siblings: [{ ...files.filter, name: 'egress' }] },
    { siblings: [files.filter, files.filter] }, { siblings: [{ ...files.filter, name: 'Filter_API' }] },
    { siblings: [{ ...files.filter, port: 0 }] }, { siblings: [{ ...files.filter, contract: 'contract.yaml' }] },
    { siblings: [{ name: 'nothing', port: 80 }] },
    { siblings: [{ ...files.guestbook, real: { ...files.guestbook.real, dockerfile: '../Dockerfile' } }] },
    { siblings: [{ ...files.guestbook, real: { ...files.guestbook.real, checkout: 'work' } }] },
    { siblings: [{ ...files.guestbook, real: { ...files.guestbook.real, tag: 'Bad Tag' } }] },
    { skills: 'skills' },
  ];
  for (const overrides of cases) {
    const fake = new FakeDocker();
    await assert.rejects(startSession(new Docker(fake.runner), runtimeSpec(overrides)), JSON.stringify(overrides));
    assert.deepEqual(fake.calls, [], JSON.stringify(overrides));
  }
});

// The one place the start input reaches the runtime: the Claude Code
// adapter passes its siblings and skills to startSession as they are.
test('the Claude Code adapter starts the siblings and mounts the skills its start input names', async () => {
  const files = workspaceFiles();
  const dir = scratch();
  const fake = new FakeDocker();
  const runner = () => {
    const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, exitCode: null, kill: () => true });
    return process as unknown as ChildProcessWithoutNullStreams;
  };
  const adapter = createClaudeCodeAdapter({
    log: { append: () => 0, after: () => [] } as never, cleaner: () => createCleaner({}),
    docker: new Docker(fake.runner, runner), newId: () => SESSION,
    runtime: { stateDir: join(dir, 'state'), loginFile: join(dir, 'claude.token'), hostAddresses: [], user: '1000:1000', stopTimeoutMs: 10 },
  });
  const input: StartInput = {
    project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-haiku-5-5', workdir: join(dir, 'work'),
    briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
    policy: { role: 'author', base: 'main', workdir: '/workspace', scripts: [], credentialFile: '/run/cleared/claude.token', safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [] },
    prompt: 'x', service: 'guestbook', siblings: [files.filter], skills: files.skills,
  };
  await adapter.start(input);
  const names = sessionNames(SESSION);
  assert.ok(byName(fake.containers, names.sibling('filter-api')).args?.includes(FAKE_IMAGE));
  assert.ok(hasPair(byName(fake.containers, names.container).args, '--mount', `type=bind,source=${files.skills},target=${SKILLS_MOUNT},readonly`));
});

// Milestone 2, decision 28 (lane 25): a reader's workdir, which holds every
// service's checkout at its base, is mounted read only. The adapter gives
// the runtime the workdir only, so the workdir says it: the reader writes
// READ_ONLY_MARK in it before the start. Without the file, nothing changes.
test('a workdir that holds the read-only mark is mounted read only, and any other as before', async () => {
  const marked = runtimeSpec();
  mkdirSync(join(marked.workdir, 'guestbook'), { recursive: true });
  mkdirSync(join(marked.workdir, 'filter-api'), { recursive: true });
  writeFileSync(join(marked.workdir, READ_ONLY_MARK), '');
  const fake = new FakeDocker();
  await startSession(new Docker(fake.runner), marked);
  const session = byName(fake.containers, sessionNames(SESSION).container).args ?? [];
  assert.ok(hasPair(session, '--mount', `type=bind,source=${marked.workdir},target=${WORKDIR_MOUNT},readonly`), session.join(' '));
  const binds = session.filter((arg, i) => session[i - 1] === '--mount' && arg.startsWith('type=bind,'));
  assert.deepEqual(binds.filter((arg) => !arg.endsWith(',readonly')), [], 'no writable bind mount: the services\' checkouts are inside the read-only workdir');

  const plain = runtimeSpec();
  mkdirSync(plain.workdir, { recursive: true });
  const before = new FakeDocker();
  await startSession(new Docker(before.runner), plain);
  const args = byName(before.containers, sessionNames(SESSION).container).args ?? [];
  assert.ok(hasPair(args, '--mount', `type=bind,source=${plain.workdir},target=${WORKDIR_MOUNT}`), 'an author\'s checkout stays writable');

  // A folder or a link of that name is no mark: only a file the host wrote.
  for (const make of [(path: string) => mkdirSync(path), (path: string) => symlinkSync('/etc/hostname', path)]) {
    const odd = runtimeSpec();
    mkdirSync(odd.workdir, { recursive: true });
    make(join(odd.workdir, READ_ONLY_MARK));
    const docker = new FakeDocker();
    await startSession(new Docker(docker.runner), odd);
    assert.ok(hasPair(byName(docker.containers, sessionNames(SESSION).container).args, '--mount', `type=bind,source=${odd.workdir},target=${WORKDIR_MOUNT}`));
  }
});

test('the Claude Code adapter mounts a reader\'s workdir read only, from its mark alone', async () => {
  const dir = scratch();
  const workdir = join(dir, 'ask');
  mkdirSync(join(workdir, 'guestbook'), { recursive: true });
  writeFileSync(join(workdir, READ_ONLY_MARK), '');
  const fake = new FakeDocker();
  const runner = () => {
    const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, exitCode: null, kill: () => true });
    return process as unknown as ChildProcessWithoutNullStreams;
  };
  const adapter = createClaudeCodeAdapter({
    log: { append: () => 0, after: () => [] } as never, cleaner: () => createCleaner({}),
    docker: new Docker(fake.runner, runner), newId: () => SESSION,
    runtime: { stateDir: join(dir, 'state'), loginFile: join(dir, 'claude.token'), hostAddresses: [], user: '1000:1000', stopTimeoutMs: 10 },
  });
  await adapter.start({
    project: 'guestbook', ticket: 'ask-1', role: 'reader', harness: 'claude-code', model: 'claude-haiku-5-5', workdir,
    briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
    policy: { role: 'reader', base: 'main', workdir: '/workspace', scripts: [], credentialFile: '/run/cleared/claude.token', safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [] },
    prompt: 'x', services: [], siblings: [],
  });
  assert.ok(hasPair(byName(fake.containers, sessionNames(SESSION).container).args, '--mount', `type=bind,source=${workdir},target=${WORKDIR_MOUNT},readonly`));
});
