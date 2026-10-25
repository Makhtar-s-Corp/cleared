// The image's entrypoint (v2/images/cleared/entrypoint.ts, issue #406): each
// role runs as the owner of the state folder, never as root, with the Docker
// socket's group for the service; a state folder Docker made for root, or one
// others may write, stops the role; the broker waits for a project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { ROLES, brokerProject, groupsOf, roleFile, stateOwner } from '../../images/cleared/entrypoint.ts';

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

test('the groups: the owner\'s, and the Docker socket\'s for the service only', () => {
  assert.deepEqual(groupsOf('service', { uid: 1000, gid: 1000 }, 990), [1000, 990]);
  assert.deepEqual(groupsOf('service', { uid: 1000, gid: 1000 }, 1000), [1000]);
  assert.deepEqual(groupsOf('service', { uid: 1000, gid: 1000 }, undefined), [1000]);
  for (const role of ['app', 'broker', 'cleared'] as const) assert.deepEqual(groupsOf(role, { uid: 1000, gid: 1000 }, 990), [1000], role);
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

test('run as a command: an unknown role is the usage, a state folder that is not there stops the role', () => {
  const unknown = spawnSync(process.execPath, [entrypoint, 'shell'], { encoding: 'utf8', env: { ...process.env, CLEARED_V2_APP_LANGUAGE: 'en' } });
  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /service, app, broker, install or cleared/);
  const missing = spawnSync(process.execPath, [entrypoint, 'service'], { encoding: 'utf8', env: { ...process.env, CLEARED_V2_APP_LANGUAGE: 'en', CLEARED_V2_STATE_DIR: join(scratch, 'nowhere') } });
  assert.equal(missing.status, 78);
  assert.match(missing.stderr, /docker compose -f v2\/compose\.yaml run --rm install/);
});
