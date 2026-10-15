import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { checkoutGitEnv, gitRefusal } from '../lib/git-checkout.mjs';
import { ORCH_HOME } from '../lib/conf.mjs';
import { fixtureProject, scratch } from './support.mjs';

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

// A git stand-in on PATH. It records each call with its GIT_CONFIG_* environment, and refuses a checkout
// owned by another user (FAKE_GIT_OWNED) unless the command declares that path safe, as git does.
// FAKE_GIT_REFUSE_ALL refuses every command, for the message a human sees.
function fakeGit() {
  const dir = scratch('orch-fake-git-');
  const log = join(dir, 'calls.log');
  const script = [
    '#!/usr/bin/env bash',
    '{ echo "ARGS $*"; env | grep "^GIT_CONFIG_" | sort; echo END; } >> "$FAKE_GIT_LOG"',
    'if [ "$1" = "-C" ] && [ -n "$2" ]; then',
    '  path=$(readlink -f -- "$2")',
    '  declared=0',
    '  count=${GIT_CONFIG_COUNT:-0}',
    '  for ((i = 0; i < count; i++)); do',
    '    key=GIT_CONFIG_KEY_$i; value=GIT_CONFIG_VALUE_$i',
    '    if [ "${!key}" = safe.directory ] && [ "${!value}" = "$path" ]; then declared=1; fi',
    '  done',
    '  if [ -n "$FAKE_GIT_REFUSE_ALL" ] || { [ "$declared" = 0 ] && [ "$path" = "$FAKE_GIT_OWNED" ]; }; then',
    '    echo "fatal: detected dubious ownership in repository at \'$path\'" >&2',
    '    exit 128',
    '  fi',
    'fi',
    'exec "$FAKE_GIT_REAL" "$@"',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'git'), script);
  chmodSync(join(dir, 'git'), 0o755);
  return { bin: dir, log };
}

// The environment of a child process: the test's own, without the project named by the machine and without any git
// settings the runner exported, with the stand-in first.
function childEnv(fake, extra = {}) {
  const env = { ...process.env, PATH: `${fake.bin}:${process.env.PATH}`, FAKE_GIT_LOG: fake.log, FAKE_GIT_REAL: REAL_GIT };
  for (const name of Object.keys(env)) if (/^GIT_CONFIG_/.test(name) || ['CLEARED_REPO', 'ORCH_REPO', 'FAKE_GIT_OWNED', 'FAKE_GIT_REFUSE_ALL'].includes(name)) delete env[name];
  return { ...env, ...extra };
}

function calls(fake) {
  const out = [];
  let current = null;
  for (const line of readFileSync(fake.log, 'utf8').split('\n')) {
    if (line.startsWith('ARGS ')) current = { args: line.slice(5), config: {} };
    else if (line === 'END') { out.push(current); current = null; }
    else if (current) { const [name, ...value] = line.split('='); current.config[name] = value.join('='); }
  }
  return out;
}

test('the helper declares one checkout safe for one command, through the command-scope environment only', () => {
  const dir = scratch('orch-checkout-');
  const base = { PATH: '/usr/bin', GIT_CONFIG_GLOBAL: '/dev/null' };
  const env = checkoutGitEnv(dir, base);
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'safe.directory');
  assert.equal(env.GIT_CONFIG_VALUE_0, realpathSync(dir));
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.deepEqual(base, { PATH: '/usr/bin', GIT_CONFIG_GLOBAL: '/dev/null' }, 'the caller\'s environment is not changed');
  assert.equal(Object.keys(env).filter((name) => name.startsWith('GIT_CONFIG_KEY_')).length, 1, 'one path only');
});

test('the helper appends to the GIT_CONFIG_COUNT the caller already exported and keeps those entries', () => {
  const dir = scratch('orch-checkout-');
  const exported = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Cleared',
    GIT_CONFIG_KEY_1: 'url.git@github.com:.insteadOf', GIT_CONFIG_VALUE_1: 'https://github.com/',
  };
  const env = checkoutGitEnv(dir, exported);
  assert.equal(env.GIT_CONFIG_COUNT, '3');
  assert.equal(env.GIT_CONFIG_KEY_0, 'user.name');
  assert.equal(env.GIT_CONFIG_VALUE_0, 'Cleared');
  assert.equal(env.GIT_CONFIG_KEY_1, 'url.git@github.com:.insteadOf');
  assert.equal(env.GIT_CONFIG_VALUE_1, 'https://github.com/');
  assert.equal(env.GIT_CONFIG_KEY_2, 'safe.directory');
  assert.equal(env.GIT_CONFIG_VALUE_2, realpathSync(dir));
  assert.equal(exported.GIT_CONFIG_COUNT, '2', 'the input is not modified');
});

test('the helper reads an unreadable count as none, resolves a relative path, and refuses an empty one', () => {
  assert.equal(checkoutGitEnv(scratch('orch-checkout-'), { GIT_CONFIG_COUNT: 'many' }).GIT_CONFIG_COUNT, '1');
  const relativeEnv = checkoutGitEnv('some/checkout', {});
  assert.ok(isAbsolute(relativeEnv.GIT_CONFIG_VALUE_0), relativeEnv.GIT_CONFIG_VALUE_0);
  assert.equal(relative(process.cwd(), relativeEnv.GIT_CONFIG_VALUE_0), 'some/checkout');
  assert.throws(() => checkoutGitEnv(''), /needs the checkout path/);
  assert.throws(() => checkoutGitEnv(undefined), /needs the checkout path/);
});

test('a refusal is named with the first line of what git said', () => {
  const error = Object.assign(new Error('Command failed'), { stderr: 'fatal: detected dubious ownership in repository at \'/x\'\nmore\n' });
  assert.equal(gitRefusal('/x', error), "git refused or could not read /x: fatal: detected dubious ownership in repository at '/x'");
  assert.equal(gitRefusal('/y', new Error('spawnSync git ENOENT')), 'git refused or could not read /y: spawnSync git ENOENT');
});

test('the stand-in refuses the other user\'s checkout without the declaration (control for the tests below)', () => {
  const project = fixtureProject();
  const fake = fakeGit();
  const bare = spawnSync('git', ['-C', project, 'ls-files'], { encoding: 'utf8', env: childEnv(fake, { FAKE_GIT_OWNED: realpathSync(project) }) });
  assert.equal(bare.status, 128);
  assert.match(bare.stderr, /detected dubious ownership/);
  const declared = spawnSync('git', ['-C', project, 'ls-files'], { encoding: 'utf8', env: { ...childEnv(fake, { FAKE_GIT_OWNED: realpathSync(project) }), ...checkoutGitEnv(project, {}) } });
  assert.equal(declared.status, 0, declared.stderr);
});

test('the tracked-file check passes the declaration on every git call, and the committed project config is read', () => {
  const project = fixtureProject();
  const fake = fakeGit();
  const env = childEnv(fake, { CLEARED_REPO: project, FAKE_GIT_OWNED: realpathSync(project) });
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `import { confPath } from ${JSON.stringify(join(ORCH_HOME, 'lib', 'conf.mjs'))}; console.log(confPath());`],
    { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.split('\n')[0], join(project, '.cleared', 'agents.conf'), 'the committed config is the one used');
  const projectCalls = calls(fake).filter((call) => call.args.startsWith(`-C ${project} `));
  assert.ok(projectCalls.length >= 1);
  for (const call of projectCalls) {
    assert.equal(call.config.GIT_CONFIG_COUNT, '1', call.args);
    assert.equal(call.config.GIT_CONFIG_KEY_0, 'safe.directory', call.args);
    assert.equal(call.config.GIT_CONFIG_VALUE_0, realpathSync(project), call.args);
  }
  assert.ok(calls(fake).every((call) => !call.args.includes('safe.directory')), 'no -c or config write names the path');
});

test('the guard reads the committed configuration of the other user\'s checkout, declared for each of its git calls', () => {
  const project = fixtureProject();
  const fake = fakeGit();
  const scan = join(scratch('orch-guard-input-'), 'input.txt');
  writeFileSync(scan, 'an ordinary sentence\n');
  const run = spawnSync(process.execPath, [join(ORCH_HOME, 'lib', 'guard', 'private-terms.mjs'), 'scan', scan], { encoding: 'utf8',
    env: childEnv(fake, { CLEARED_REPO: project, FAKE_GIT_OWNED: realpathSync(project), ORCH_GUARD_REF: 'HEAD' }) });
  assert.equal(run.status, 0, run.stderr);
  const guardCalls = calls(fake).filter((call) => call.args.startsWith(`-C ${project} `));
  assert.ok(guardCalls.length >= 1, 'the guard ran git on the project');
  for (const call of guardCalls) assert.equal(call.config.GIT_CONFIG_VALUE_0, realpathSync(project), call.args);
});

test('a refused tracked-file check is named as git\'s refusal, not as a missing [app] setting, and the exit code is kept', () => {
  const project = fixtureProject();
  const fake = fakeGit();
  const run = spawnSync(process.execPath, [join(ORCH_HOME, 'cleared'), 'app', 'passkey'], { encoding: 'utf8',
    env: childEnv(fake, { CLEARED_REPO: project, FAKE_GIT_REFUSE_ALL: '1' }) });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, new RegExp(`^cleared: git refused or could not read ${project.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: fatal: detected dubious ownership`, 'm'));
  assert.doesNotMatch(run.stderr, /set \[app\] grant_socket/);
});

test('git that cannot run is named too, and a file that is simply untracked keeps the old answer', () => {
  const project = fixtureProject();
  const empty = scratch('orch-no-git-');
  const missing = spawnSync(process.execPath, [join(ORCH_HOME, 'cleared'), 'app', 'passkey'], { encoding: 'utf8',
    env: { ...childEnv({ bin: empty, log: join(empty, 'calls.log') }), PATH: empty, CLEARED_REPO: project } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^cleared: git refused or could not read .*: spawnSync git ENOENT/m);

  const untracked = scratch('orch-untracked-');
  execFileSync(REAL_GIT, ['init', '-q', untracked]);
  mkdirSync(join(untracked, '.cleared'));
  writeFileSync(join(untracked, '.cleared', 'agents.conf'), '[app]\n');
  const fake = fakeGit();
  const plain = spawnSync(process.execPath, [join(ORCH_HOME, 'cleared'), 'app', 'passkey'], { encoding: 'utf8',
    env: childEnv(fake, { CLEARED_REPO: untracked }) });
  assert.equal(plain.status, 2);
  assert.match(plain.stderr, /set \[app\] grant_socket \(and \[app\] public_origin\) first/);
  assert.doesNotMatch(plain.stderr, /git refused/);
});

test('every git command the tool runs on a checkout is given the declaration (static check of the sources)', () => {
  const files = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!['node_modules', 'test', '.git'].includes(entry.name)) walk(join(dir, entry.name), `${prefix}${entry.name}/`); }
      else if (entry.name.endsWith('.mjs')) files.push([`${prefix}${entry.name}`, join(dir, entry.name)]);
    }
  };
  walk(join(ORCH_HOME, 'lib'), 'lib/');
  walk(join(ORCH_HOME, 'app'), 'app/');
  walk(join(ORCH_HOME, 'serve'), 'serve/');
  files.push(['cleared', join(ORCH_HOME, 'cleared')]);
  // The one wrapper that takes its environment from its callers (release.mjs runGit): git and tempGit declare or not.
  const delegated = { 'lib/release.mjs': 1 };
  // The guard is copied on its own from a git ref (lib/common.sh), so it carries its own copy of the declaration.
  const spawn = /\b(?:execFileSync|spawnSync|spawn|execFile|execSync)\(\s*'git'|\bcommand\(\s*'git'/;
  let sites = 0;
  for (const [name, path] of files) {
    const lines = readFileSync(path, 'utf8').split('\n');
    let undeclared = 0;
    lines.forEach((line, i) => {
      if (!spawn.test(line)) return;
      sites += 1;
      if (!/checkoutGitEnv|projectGitEnv/.test(lines.slice(i, i + 2).join('\n'))) undeclared += 1;
    });
    assert.equal(undeclared, delegated[name] ?? 0, `${name}: git calls without checkoutGitEnv`);
  }
  assert.ok(sites >= 10, `only ${sites} git calls found`);
  for (const [name, path] of files) {
    if (['lib/git-checkout.mjs', 'lib/guard/private-terms.mjs'].includes(name)) continue;
    assert.doesNotMatch(readFileSync(path, 'utf8'), /safe\.directory/, `${name} names safe.directory itself`);
  }
});
