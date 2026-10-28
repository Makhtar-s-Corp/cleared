// The flow's git on an install with no GitHub App (issue #421): the
// fetches and pushes of the service's checkouts take git's environment from
// lib/forge.ts (forgeEnvironments), which, without an app, is the ambient
// one. On a Compose install nothing else gives git GitHub's credential, so
// that environment names gh as the helper, as the workspace step's clones
// do, and gh reads GH_TOKEN itself: the value is in no git setting, no
// argument and no debug output. With an app, the forge's own helper stays
// the only one. A fake gh on PATH; git's own credential lookup; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgeEnvironments } from '../../src/workspace/publish.ts';
import { gitIn, tempDir } from './git.ts';

// Built here, so no line of the repository holds a value shaped like a credential.
const TOKEN = ['forge', 'credential', 'of', 'the', 'test'].join('-');
const APP_TOKEN = ['installation', 'credential', 'of', 'the', 'test'].join('-');
const GH_HELPER = '!gh auth git-credential';

// A project checkout with its agents.conf, and a gh that answers git's
// credential requests from GH_TOKEN, as the real one does, and logs its calls.
function world(conf = '[project]\nname = guestbook\n') {
  const root = tempDir('forge-git');
  const project = join(root, 'guestbook');
  mkdirSync(join(project, '.cleared'), { recursive: true });
  writeFileSync(join(project, '.cleared', 'agents.conf'), conf);
  execFileSync('git', ['init', '-q', project]);
  // lib/conf.ts reads a tracked agents.conf only.
  gitIn(project, ['add', '.cleared/agents.conf']);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'gh.log');
  writeFileSync(join(bin, 'gh'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');
if (args.join(' ') !== 'auth git-credential get') process.exit(1);
const asked = fs.readFileSync(0, 'utf8');
if (/^host=github\\.com$/m.test(asked) && process.env.GH_TOKEN) process.stdout.write('protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=' + process.env.GH_TOKEN + '\\n');
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const home = join(root, 'home');
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}`, HOME: home, CLEARED_STATE_DIR: join(root, 'state'), GIT_CONFIG_NOSYSTEM: '1' };
  return { root, project, env, log };
}

const entries = (env: NodeJS.ProcessEnv): [string, string][] =>
  Array.from({ length: Number(env.GIT_CONFIG_COUNT) || 0 }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`] ?? '', env[`GIT_CONFIG_VALUE_${i}`] ?? '']);

// What git's own lookup finds for a private repository on GitHub, as a fetch asks it.
function fill(env: NodeJS.ProcessEnv, cwd: string) {
  return spawnSync('git', ['credential', 'fill'], { cwd, env, input: 'protocol=https\nhost=github.com\npath=example-org/private.git\n\n', encoding: 'utf8' });
}

test('no GitHub App and GH_TOKEN set: git asks gh, which reads GH_TOKEN; the value is in no git setting, and no debug switch reaches git', async () => {
  const { project, env, log } = world();
  const { git } = await forgeEnvironments(project, { ...env, GH_TOKEN: TOKEN, GIT_TRACE: '1', GIT_CURL_VERBOSE: '1', GIT_TRACE_CURL: '1', GIT_TRACE_REDACT: '0' });
  assert.deepEqual(entries(git).filter(([key]) => key.startsWith('credential.')), [['credential.https://github.com.helper', ''], ['credential.https://github.com.helper', GH_HELPER]]);
  for (const name of ['GIT_TRACE', 'GIT_CURL_VERBOSE', 'GIT_TRACE_CURL', 'GIT_TRACE_REDACT']) assert.equal(git[name], undefined, name);
  for (const [name, value] of Object.entries(git)) if (name !== 'GH_TOKEN') assert.ok(!String(value).includes(TOKEN), name);

  // The helper git runs for https://github.com/: gh, given GH_TOKEN by its environment, never by an argument.
  const found = fill(git, project);
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, new RegExp(`^password=${TOKEN}$`, 'm'));
  assert.ok(!found.stderr.includes(TOKEN), 'nothing git says holds it');
  assert.equal(readFileSync(log, 'utf8'), 'auth git-credential get\n');
  assert.ok(!readFileSync(join(project, '.git', 'config'), 'utf8').includes(TOKEN), 'nor the checkout\'s settings');
});

test('no GitHub App and no token: git\'s environment is the ambient one, with no helper added', async () => {
  const { project, env } = world();
  const { git } = await forgeEnvironments(project, env);
  assert.deepEqual(entries(git), []);
});

test('with a GitHub App, the forge\'s own helper stays the only one: gh\'s is not added, whatever GH_TOKEN says', async () => {
  const { root, project, env } = world('[project]\nname = guestbook\n\n[forge]\napp_id = 11\ninstallation_id = 22\napp_private_key_file = /nonexistent/app.pem\napp_login = cleared-test[bot]\napp_user_id = 33\n');
  // A token still valid for an hour, in the forge's cache: nothing is minted.
  const state = join(root, 'state');
  mkdirSync(join(state, 'forge'), { recursive: true, mode: 0o700 });
  writeFileSync(join(state, 'forge', 'installation-token.json'), JSON.stringify({ app_id: '11', installation_id: '22', token: APP_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { mode: 0o600 });
  const { git, gh } = await forgeEnvironments(project, { ...env, GH_TOKEN: TOKEN });
  const helpers = entries(git).filter(([key]) => key === 'credential.https://github.com.helper').map(([, value]) => value);
  assert.equal(helpers.length, 2);
  assert.equal(helpers[0], '');
  assert.match(helpers[1] ?? '', /forge\.ts' credential$/);
  assert.ok(!helpers.includes(GH_HELPER));
  assert.equal(gh.GH_TOKEN, APP_TOKEN, 'gh runs as the app');
});
