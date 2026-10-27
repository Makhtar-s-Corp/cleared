// The image's entrypoint (v2/images/cleared/entrypoint.ts, issue #406): each
// role runs as the owner of the state folder, never as root, with the Docker
// socket's group for the service; a state folder Docker made for root, or one
// others may write, stops the role; the broker waits for a project, then
// starts by itself on the workspace the setup assistant writes (issue #438).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { ROLES, brokerProject, groupsOf, roleFile, stateOwner } from '../../images/cleared/entrypoint.ts';
import { writeSettings } from '../../src/setup/settings.ts';

const entrypoint = new URL('../../images/cleared/entrypoint.ts', import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), 'cleared-v2-entrypoint-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('each role is a program of the image, from its root', () => {
  assert.deepEqual(Object.keys(ROLES).sort(), ['app', 'broker', 'cleared', 'install', 'service']);
  assert.equal(roleFile('service', '/opt/cleared'), '/opt/cleared/v2/src/main.ts');
  assert.equal(roleFile('app', '/opt/cleared'), '/opt/cleared/v2/app/main.ts');
  assert.equal(roleFile('broker', '/opt/cleared'), '/opt/cleared/serve/release-broker.ts');
  assert.equal(roleFile('install', '/opt/cleared'), '/opt/cleared/v2/src/cli/install.ts');
  assert.equal(roleFile('cleared', '/opt/cleared'), '/opt/cleared/v2/src/cli/cleared.ts');
  assert.equal(roleFile('shell', '/opt/cleared'), undefined);
});

test('the state folder\'s owner, refused when missing, root\'s, or writable by others', () => {
  const good = join(scratch, 'good');
  mkdirSync(good, { mode: 0o700 });
  assert.deepEqual(stateOwner(good), { uid: process.getuid!(), gid: process.getgid!() });
  assert.throws(() => stateOwner(join(scratch, 'missing')), { name: 'EntryError', message: 'state_missing' });
  const loose = join(scratch, 'loose');
  mkdirSync(loose);
  chmodSync(loose, 0o777);
  assert.throws(() => stateOwner(loose), { name: 'EntryError', message: 'state_open' });
  const file = join(scratch, 'file');
  writeFileSync(file, '');
  assert.throws(() => stateOwner(file), { name: 'EntryError', message: 'state_missing' });
  assert.throws(() => stateOwner(good, () => ({ uid: 0, gid: 0, mode: 0o40700, directory: true })), { name: 'EntryError', message: 'state_root' });
});

// Issue #430: `cleared doctor` runs as the cleared role in the service's
// container (`docker compose run service cleared doctor`) and asks Docker,
// so it drops root as the service does, the socket's group kept.
test('the groups: the owner\'s, and the Docker socket\'s for the service and the cleared command only', () => {
  for (const role of ['service', 'cleared'] as const) {
    assert.deepEqual(groupsOf(role, { uid: 1000, gid: 1000 }, 990), [1000, 990], role);
    assert.deepEqual(groupsOf(role, { uid: 1000, gid: 1000 }, 1000), [1000], role);
    assert.deepEqual(groupsOf(role, { uid: 1000, gid: 1000 }, undefined), [1000], role);
  }
  for (const role of ['app', 'broker'] as const) assert.deepEqual(groupsOf(role, { uid: 1000, gid: 1000 }, 990), [1000], role);
});

test('the broker\'s project: CLEARED_V2_PROJECT_DIR with its .cleared/agents.conf, else none yet', () => {
  const project = join(scratch, 'project');
  assert.equal(brokerProject({}), undefined);
  assert.equal(brokerProject({ CLEARED_V2_PROJECT_DIR: project }), undefined);
  mkdirSync(join(project, '.cleared'), { recursive: true });
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[security]\nallow_shared_uid = true\n');
  assert.equal(brokerProject({ CLEARED_V2_PROJECT_DIR: project }), project);
  assert.equal(brokerProject({ CLEARED_REPO: project }), project);
});

// Issue #438: on an install by the setup assistant nothing names
// CLEARED_V2_PROJECT_DIR. The broker reads the workspace the assistant
// wrote, which <state>/settings.conf names, and locks the service whose lock
// is the default one (no broker_socket, no broker_state): the one this
// container serves on the state folder's socket.
const workspaceFile = (state: string, service: string) => {
  const file = join(state, 'workspace.conf');
  writeFileSync(file, `[workspace]\nid = guestbook\n\n${service}`, { mode: 0o600 });
  return file;
};
const guestbook = (dir: string, more = '') => `[service guestbook]\nrepository = demo/guestbook\nurl = https://example.invalid/demo/guestbook.git\ndir = ${dir}\n${more}`;
const withConf = (dir: string) => {
  mkdirSync(join(dir, '.cleared'), { recursive: true });
  writeFileSync(join(dir, '.cleared', 'agents.conf'), '[security]\nallow_shared_uid = true\n');
};

test('the broker\'s project on an install by the assistant: the workspace its settings name, the service of the default lock', () => {
  const state = join(scratch, 'state-assistant');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const checkout = join(state, 'repositories', 'demo', 'guestbook');
  assert.equal(brokerProject({}, state), undefined, 'no settings yet');
  const file = workspaceFile(state, guestbook(checkout));
  writeSettings(join(state, 'settings.conf'), { env: { CLEARED_V2_WORKSPACE: file } });
  assert.equal(brokerProject({}, state), undefined, 'the checkout has no .cleared/agents.conf yet');
  withConf(checkout);
  assert.equal(brokerProject({}, state), checkout);
  assert.equal(brokerProject({ CLEARED_V2_WORKSPACE: file }, join(scratch, 'elsewhere')), checkout, 'the environment\'s workspace, as the service reads it');

  const named = join(scratch, 'named');
  withConf(named);
  assert.equal(brokerProject({ CLEARED_V2_PROJECT_DIR: named }, state), named, 'a project named by hand wins');

  workspaceFile(state, `${guestbook(checkout, `broker_socket = ${join(state, 'other.sock')}\nbroker_state = ${join(state, 'other')}\n`)}`);
  assert.equal(brokerProject({}, state), undefined, 'a service with a broker of its own is that broker\'s');
  workspaceFile(state, '[service guestbook]\nrepository = not a repository\n');
  assert.equal(brokerProject({}, state), undefined, 'a workspace the service would refuse locks nothing');
});

test('run as the broker role: it waits, then starts by itself once the assistant wrote the workspace, with no restart', async () => {
  const state = join(scratch, 'state-broker');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const checkout = join(state, 'repositories', 'demo', 'guestbook');
  const env = { ...process.env, CLEARED_V2_APP_LANGUAGE: 'en', CLEARED_V2_STATE_DIR: state, CLEARED_STATE_DIR: state, CLEARED_V2_PROJECT_DIR: '', CLEARED_REPO: '', ORCH_REPO: '', CLEARED_RELEASE_SOCKET: '', CLEARED_V2_WORKSPACE: '', CLEARED_CONF: '', ORCH_CONF: '' };
  const child = spawn(process.execPath, [entrypoint, 'broker'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk; });
  child.stderr.on('data', (chunk: Buffer) => { out += chunk; });
  const seen = async (pattern: RegExp, ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 100))) if (pattern.test(out)) return;
    assert.fail(`not seen in ${ms / 1000} s: ${pattern}\n${out}`);
  };
  try {
    await seen(/waits for a project/, 10_000);
    assert.doesNotMatch(out, /Restart the broker/, 'nothing to restart by hand');
    withConf(checkout);
    assert.equal(spawnSync('git', ['init', '-q', checkout]).status, 0, 'the assistant\'s clone is a git checkout');
    writeSettings(join(state, 'settings.conf'), { env: { CLEARED_V2_WORKSPACE: workspaceFile(state, guestbook(checkout)) } });
    await seen(new RegExp(`starts for ${checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 15_000);
    for (const end = Date.now() + 10_000; Date.now() < end && !existsSync(join(state, 'release.sock')); ) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(existsSync(join(state, 'release.sock')), `the lock listens on the state folder's socket, as the service asks it\n${out}`);
  } finally {
    child.kill('SIGKILL');
  }
});

test('run as a command: an unknown role is the usage, a state folder that is not there stops the role', () => {
  const unknown = spawnSync(process.execPath, [entrypoint, 'shell'], { encoding: 'utf8', env: { ...process.env, CLEARED_V2_APP_LANGUAGE: 'en' } });
  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /service, app, broker, install or cleared/);
  const missing = spawnSync(process.execPath, [entrypoint, 'service'], { encoding: 'utf8', env: { ...process.env, CLEARED_V2_APP_LANGUAGE: 'en', CLEARED_V2_STATE_DIR: join(scratch, 'nowhere') } });
  assert.equal(missing.status, 78);
  assert.match(missing.stderr, /docker compose -f v2\/compose\.yaml run --rm install/);
});
