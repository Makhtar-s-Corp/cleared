import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { CheckoutPathError, checkoutReadEnv, checkoutTopLevel, gitRefusal, READ_OVERRIDES } from '../lib/git-checkout.mjs';
import { ORCH_HOME } from '../lib/conf.mjs';
import { foreignTest, fixtureProject, scratch } from './support.mjs';

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

// The GIT_CONFIG_* entries of an environment, in order.
const entriesOf = (env) => Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);

test('the read environment declares one checkout safe and overrides what its configuration could run, for one command only', () => {
  const dir = realpathSync(scratch('orch-checkout-'));
  execFileSync(REAL_GIT, ['init', '-q', dir]);
  const base = { PATH: '/usr/bin', GIT_CONFIG_GLOBAL: '/dev/null' };
  const env = checkoutReadEnv(dir, base);
  assert.deepEqual(entriesOf(env), [['safe.directory', dir], ...READ_OVERRIDES]);
  for (const key of ['core.fsmonitor', 'core.hooksPath', 'core.pager', 'core.editor', 'core.askPass', 'credential.helper', 'core.sshCommand',
    'protocol.allow', 'diff.external', 'log.showSignature', 'gpg.program']) assert.ok(READ_OVERRIDES.some(([name]) => name === key), key);
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0', 'a read never writes the index of the checkout');
  assert.equal(env.GIT_PAGER, 'cat');
  assert.equal(env.GIT_EDITOR, 'false');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.deepEqual(base, { PATH: '/usr/bin', GIT_CONFIG_GLOBAL: '/dev/null' }, 'the caller\'s environment is not changed');
  assert.equal(entriesOf(env).filter(([key]) => key === 'safe.directory').length, 1, 'one path only');
});

test('the read environment appends to the GIT_CONFIG_COUNT the caller already exported and keeps those entries', () => {
  const dir = realpathSync(scratch('orch-checkout-'));
  const exported = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Cleared',
    GIT_CONFIG_KEY_1: 'url.git@github.com:.insteadOf', GIT_CONFIG_VALUE_1: 'https://github.com/',
  };
  const env = checkoutReadEnv(dir, exported);
  assert.equal(env.GIT_CONFIG_COUNT, String(3 + READ_OVERRIDES.length));
  assert.deepEqual(entriesOf(env), [['user.name', 'Cleared'], ['url.git@github.com:.insteadOf', 'https://github.com/'], ['safe.directory', dir], ...READ_OVERRIDES]);
  assert.equal(exported.GIT_CONFIG_COUNT, '2', 'the input is not modified');
});

test('the read environment reads an unreadable count as none, resolves a relative path, and refuses an empty, a missing or a ~ path', () => {
  const dir = realpathSync(scratch('orch-checkout-'));
  assert.equal(checkoutReadEnv(dir, { GIT_CONFIG_COUNT: 'many' }).GIT_CONFIG_KEY_0, 'safe.directory');
  // A relative path is taken from the current directory (it must exist now: a missing one is refused below).
  assert.equal(checkoutReadEnv(relative(process.cwd(), dir), {}).GIT_CONFIG_VALUE_0, dir);
  assert.throws(() => checkoutReadEnv(''), CheckoutPathError);
  assert.throws(() => checkoutReadEnv(undefined), CheckoutPathError);
  assert.throws(() => checkoutReadEnv(join(dir, 'gone')), /the checkout .*gone does not exist or cannot be reached/);
  assert.throws(() => checkoutReadEnv('~/project'), /starts with "~", which Cleared does not expand/);
});

test('the declared path is the top level of the working tree, found without git: a subdirectory, a linked worktree, no repository', () => {
  const root = realpathSync(scratch('orch-top-'));
  const repo = join(root, 'repo');
  execFileSync(REAL_GIT, ['init', '-q', '-b', 'main', repo]);
  mkdirSync(join(repo, '.cleared', 'deeper'), { recursive: true });
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  execFileSync(REAL_GIT, ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'add', '.']);
  execFileSync(REAL_GIT, ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-qm', 'a']);
  execFileSync(REAL_GIT, ['-C', repo, 'worktree', 'add', '-q', join(root, 'linked'), '-b', 'other']);
  mkdirSync(join(root, 'linked', 'sub'));
  mkdirSync(join(root, 'plain'));
  assert.equal(checkoutTopLevel(repo), repo);
  assert.equal(checkoutTopLevel(join(repo, '.cleared', 'deeper')), repo);
  assert.equal(checkoutTopLevel(join(root, 'linked', 'sub')), join(root, 'linked'), 'a linked worktree has a .git file');
  assert.equal(checkoutTopLevel(join(root, 'plain')), join(root, 'plain'), 'no .git above: the path itself, git says it is not a repository');
  // git agrees, with the checkout treated as another user's.
  const owner = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
  for (const path of [join(repo, '.cleared', 'deeper'), join(root, 'linked', 'sub')]) {
    const run = spawnSync(REAL_GIT, ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env: checkoutReadEnv(path, owner) });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), checkoutTopLevel(path));
  }
});

test('a refusal is named with the first line of what git said', () => {
  const error = Object.assign(new Error('Command failed'), { stderr: 'fatal: detected dubious ownership in repository at \'/x\'\nmore\n' });
  assert.equal(gitRefusal('/x', error), "git refused or could not read /x: fatal: detected dubious ownership in repository at '/x'");
  assert.equal(gitRefusal('/y', new Error('spawnSync git ENOENT')), 'git refused or could not read /y: spawnSync git ENOENT');
  assert.equal(gitRefusal('/z', new CheckoutPathError('the checkout /z does not exist or cannot be reached')), 'the checkout /z does not exist or cannot be reached',
    'a path that cannot be used is not called a refusal');
});

test('the stand-in refuses the other user\'s checkout without the declaration (control for the tests below)', () => {
  const project = fixtureProject();
  const fake = fakeGit();
  const bare = spawnSync('git', ['-C', project, 'ls-files'], { encoding: 'utf8', env: childEnv(fake, { FAKE_GIT_OWNED: realpathSync(project) }) });
  assert.equal(bare.status, 128);
  assert.match(bare.stderr, /detected dubious ownership/);
  const declared = spawnSync('git', ['-C', project, 'ls-files'], { encoding: 'utf8', env: checkoutReadEnv(project, childEnv(fake, { FAKE_GIT_OWNED: realpathSync(project) })) });
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
    assert.equal(call.config.GIT_CONFIG_COUNT, String(1 + READ_OVERRIDES.length), call.args);
    assert.equal(call.config.GIT_CONFIG_KEY_0, 'safe.directory', call.args);
    assert.equal(call.config.GIT_CONFIG_VALUE_0, realpathSync(project), call.args);
    assert.equal(call.config.GIT_CONFIG_KEY_1, 'core.fsmonitor', call.args);
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

// What each planted setting would run, reached by a git command, with the read environment: nothing. The
// commands include some Cleared never runs on a checkout (status, a patch diff, a fetch): the environment
// holds for them too. textconv and filter drivers are not overridden by key: the commands leave them out.
test('the read environment drops GIT_CONFIG_PARAMETERS, which git reads after the overrides and would let a caller\'s -c win', () => {
  const dir = realpathSync(scratch('orch-params-'));
  execFileSync(REAL_GIT, ['init', '-q', dir]);
  const callers = { GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='touch marker'" };
  // Control: the caller's setting beats the count-based override when the read environment is not used.
  const beaten = execFileSync(REAL_GIT, ['-C', dir, 'config', '--get', 'core.fsmonitor'], { encoding: 'utf8',
    env: { ...process.env, ...callers, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' } }).trim();
  assert.equal(beaten, 'touch marker');
  const env = checkoutReadEnv(dir, { ...process.env, ...callers });
  assert.equal('GIT_CONFIG_PARAMETERS' in env, false);
  assert.equal(execFileSync(REAL_GIT, ['-C', dir, 'config', '--get', 'core.fsmonitor'], { encoding: 'utf8', env }).trim(), 'false');
});

// cleared status: when the project configuration cannot be read, --json still prints one schema 1 object with the
// reason (refused, or not a repository told apart), and exit 2; the text mode says the same on stderr.
test('cleared status says why the project configuration cannot be read: one JSON object with the reason, or the text line', () => {
  const project = fixtureProject();
  const plain = scratch('orch-not-a-repo-');
  mkdirSync(join(plain, '.cleared'));
  writeFileSync(join(plain, '.cleared', 'agents.conf'), '[lanes]\nbase = main\n');
  const state = scratch('orch-status-state-');
  const run = (repo, json, refuse) => spawnSync(process.execPath, [join(ORCH_HOME, 'cleared'), 'status', ...(json ? ['--json'] : [])],
    { encoding: 'utf8', env: childEnv(fakeGit(), { CLEARED_REPO: repo, CLEARED_STATE_DIR: state, ...(refuse ? { FAKE_GIT_REFUSE_ALL: '1' } : {}) }) });

  const refused = run(project, true, true);
  assert.equal(refused.status, 2, refused.stderr);
  const refusedDoc = JSON.parse(refused.stdout); // exactly one object: parsing the whole output fails otherwise
  assert.equal(refusedDoc.schema, 1);
  assert.equal(refusedDoc.ok, false);
  assert.equal(refusedDoc.problems[0].code, 'status_error');
  assert.match(refusedDoc.problems[0].message, new RegExp(`^git refused or could not read ${project.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: fatal: detected dubious ownership`));
  assert.doesNotMatch(refusedDoc.problems[0].message, /not a git repository/);

  const notRepo = run(plain, true, false);
  assert.equal(notRepo.status, 2, notRepo.stderr);
  const notRepoDoc = JSON.parse(notRepo.stdout);
  assert.equal(notRepoDoc.problems[0].code, 'status_error');
  assert.match(notRepoDoc.problems[0].message, new RegExp(`^${plain.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} is not a git repository: fatal: not a git repository`));
  assert.doesNotMatch(notRepoDoc.problems[0].message, /git refused/);

  const textRefused = run(project, false, true);
  assert.equal(textRefused.status, 2);
  assert.equal(textRefused.stdout, '', 'the text mode prints no document');
  assert.match(textRefused.stderr, /^cleared: git refused or could not read .*: fatal: detected dubious ownership/m);

  const textNotRepo = run(plain, false, false);
  assert.equal(textNotRepo.status, 2);
  assert.match(textNotRepo.stderr, /^cleared: .* is not a git repository: fatal: not a git repository/m);
  assert.doesNotMatch(textNotRepo.stderr, /git refused/);
});

foreignTest('the read environment stops every planted setting a read can reach, on the commands Cleared runs and beyond', (t) => {
  const root = realpathSync(scratch('orch-vectors-'));
  const repo = join(root, 'repo');
  const marker = join(root, 'ran.log');
  const git = (...args) => execFileSync(REAL_GIT, ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' }).trim();
  execFileSync(REAL_GIT, ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.'); git('commit', '-qm', 'one');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  git('commit', '-qam', 'two');
  const lines = git('cat-file', 'commit', 'HEAD').split('\n');
  lines.splice(lines.findIndex((line) => line.startsWith('committer ')) + 1, 0, 'gpgsig -----BEGIN PGP SIGNATURE-----', ' ', ' AAAA', ' -----END PGP SIGNATURE-----');
  const signedHead = execFileSync(REAL_GIT, ['-C', repo, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: `${lines.join('\n')}`, encoding: 'utf8' }).trim();
  git('update-ref', 'refs/heads/main', signedHead);
  const plant = join(root, 'plant');
  writeFileSync(plant, `#!/bin/sh\necho "planted $*" >> '${marker}'\nexit 0\n`);
  chmodSync(plant, 0o755);
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  for (const hook of ['post-index-change', 'reference-transaction']) { writeFileSync(join(hooks, hook), `#!/bin/sh\necho "hook ${hook}" >> '${marker}'\n`); chmodSync(join(hooks, hook), 0o755); }
  writeFileSync(join(root, 'included.conf'), `[core]\n\tfsmonitor = ${plant}\n`);
  for (const [key, value] of [['include.path', join(root, 'included.conf')], ['core.hooksPath', hooks], ['diff.external', plant],
    ['log.showSignature', 'true'], ['gpg.program', plant], ['remote.evil.url', repo], ['remote.evil.uploadpack', plant]]) git('config', key, value);
  const owner = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
  const runs = (args, env) => {
    try { execFileSync(REAL_GIT, ['-C', repo, ...args], { env, stdio: 'ignore' }); } catch { /* refused or failed: only what ran counts */ }
    const ran = existsSync(marker) ? readFileSync(marker, 'utf8') : '';
    writeFileSync(marker, '');
    return ran;
  };
  const declaredOnly = { ...owner, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: repo };
  const reach = [
    ['ls-files', '--error-unmatch', '--', 'a.txt'], // fsmonitor (from the included file)
    ['status'], // fsmonitor and the post-index-change hook of an index refresh
    ['log', '-1', '--format=%cI', 'main'], // gpg.program on the signed commit
    ['show', '-s', '--format=%B', 'main'],
    ['diff', 'HEAD^', 'HEAD'], // diff.external
    ['fetch', '-q', 'evil'], // remote.<name>.uploadpack, and the hook of the ref update
  ];
  writeFileSync(join(repo, 'a.txt'), 'three\n'); // a modified file: status refreshes the index
  let control = 0;
  for (const args of reach) {
    if (runs(args, declaredOnly)) control += 1;
    writeFileSync(join(repo, 'a.txt'), 'three\n');
    assert.equal(runs(args, checkoutReadEnv(repo, owner)), '', `git ${args.join(' ')}`);
  }
  if (!control) t.diagnostic('none of the planted settings ran with safe.directory alone on this git');
  assert.equal(control, reach.length, 'with safe.directory alone, each command runs a planted setting (control)');
  // What the environment does not override: a textconv driver named by the attributes runs on a patch diff,
  // which is why the reads are --name-only --no-ext-diff --no-textconv and never a patch.
  writeFileSync(join(repo, '.git', 'info', 'attributes'), '* diff=planted\n');
  git('config', 'diff.planted.textconv', plant);
  assert.match(runs(['diff', '--no-ext-diff', 'HEAD^', 'HEAD'], checkoutReadEnv(repo, owner)), /planted/, 'a patch diff still reaches textconv');
  assert.equal(runs(['diff', '--name-only', '--no-ext-diff', '--no-textconv', 'HEAD^', 'HEAD'], checkoutReadEnv(repo, owner)), '');
});

// The guard carries its own copy of the read environment (it is copied alone from a git ref): the same text,
// and the same result for the same input.
test('the guard\'s copy of the read environment is the helper\'s, word for word and in behaviour', async () => {
  const shared = (text) => {
    const start = text.indexOf('// --- shared with lib/guard/private-terms.mjs');
    const end = text.indexOf('// --- end of the shared part ---');
    assert.ok(start >= 0 && end > start, 'the shared part is marked');
    return text.slice(start, end);
  };
  assert.equal(shared(readFileSync(join(ORCH_HOME, 'lib', 'guard', 'private-terms.mjs'), 'utf8')),
    shared(readFileSync(join(ORCH_HOME, 'lib', 'git-checkout.mjs'), 'utf8')));
  const guard = await import('../lib/guard/private-terms.mjs');
  const repo = realpathSync(scratch('orch-guard-copy-'));
  execFileSync(REAL_GIT, ['init', '-q', repo]);
  mkdirSync(join(repo, 'sub'));
  for (const env of [{}, { PATH: '/bin', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c', GIT_CONFIG_KEY_1: 'd.e', GIT_CONFIG_VALUE_1: 'f' }]) {
    for (const path of [repo, join(repo, 'sub')]) assert.deepEqual(guard.checkoutReadEnv(path, env), checkoutReadEnv(path, env));
  }
  for (const bad of ['~/x', join(repo, 'gone'), '']) {
    assert.throws(() => guard.checkoutReadEnv(bad, {}), (error) => error.message === (() => { try { checkoutReadEnv(bad, {}); } catch (e) { return e.message; } })());
  }
});

// ---- Static checks of the sources ----

const sourceFiles = () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(ORCH_HOME, dir), { withFileTypes: true })) {
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!['node_modules', 'test', '.git', 'docs'].includes(entry.name) && !entry.name.startsWith('.')) walk(name); }
      else if (/\.(mjs|sh)$/.test(entry.name)) files.push(name);
    }
  };
  walk('');
  files.push('cleared');
  return files;
};
// The text of the call that opens at `open` (a parenthesis), strings and template literals skipped.
function callAt(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (!depth) return text.slice(open, i + 1); }
    else if (c === "'" || c === '"' || c === '`') { for (i += 1; i < text.length && text[i] !== c; i += 1) if (text[i] === '\\') i += 1; }
    else if (c === '/' && text[i + 1] === '*') i = text.indexOf('*/', i) + 1;
    else if (c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i);
  }
  throw new Error(`unclosed call at ${open}`);
}
const withoutComments = (text) => text.split('\n').filter((line) => !/^\s*(\/\/|#)/.test(line)).join('\n');
const GIT_SPAWN = /\b(?:execFileSync|spawnSync|spawn|execFile|command|run)\(\s*['"]git['"]|\b(?:execSync|exec)\(\s*[`'"]git\s/g;
function gitCalls(text) {
  const out = [];
  for (const match of text.matchAll(GIT_SPAWN)) {
    const open = text.indexOf('(', match.index);
    out.push({ at: open, text: callAt(text, open) });
  }
  return out;
}

test('every git command the Node code runs on a checkout has the read environment, or says why not (static check)', () => {
  const node = sourceFiles().filter((name) => name.endsWith('.mjs') || name === 'cleared');
  for (const root of ['release-request.mjs']) assert.ok(node.includes(root), `${root} is checked`);
  const files = new Set();
  for (const name of node) {
    const text = withoutComments(readFileSync(join(ORCH_HOME, name), 'utf8'));
    const calls = gitCalls(text);
    for (const call of calls) {
      files.add(name);
      // Not the human's: the service account on its own checkout, said in a git-env comment inside the call.
      if (/\/\* git-env: [^*]{20,}\*\//.test(call.text)) continue;
      assert.match(call.text, /\bcheckoutReadEnv\(/, `${name}: a git command without the read environment: ${call.text.slice(0, 160)}`);
      if (/'diff'/.test(call.text)) assert.match(call.text, /'--name-only'.*'--no-ext-diff'.*'--no-textconv'|'--no-ext-diff'.*'--no-textconv'.*'--name-only'|'--name-only'.*'--no-renames'.*'--no-ext-diff'.*'--no-textconv'/s, `${name}: a diff of a checkout is names only, without external diff or textconv`);
      for (const verb of ['status', 'add', 'checkout', 'pull', 'push', 'fetch', 'merge', 'rebase', 'commit', 'stash']) {
        if (!/git-env:/.test(call.text)) assert.doesNotMatch(call.text, new RegExp(`\\[[^\\]]*'${verb}'`), `${name}: ${verb} is not a read`);
      }
    }
    // The read environment is handed to git only, never to a script that would declare the checkout for every git it runs.
    if (['lib/git-checkout.mjs', 'lib/guard/private-terms.mjs'].includes(name)) continue;
    for (const use of text.matchAll(/\bcheckoutReadEnv\(/g)) {
      if (/^\s*import\b/.test(text.slice(text.lastIndexOf('\n', use.index) + 1))) continue;
      assert.ok(calls.some((call) => use.index > call.at && use.index < call.at + call.text.length), `${name}: the read environment outside a git command`);
    }
  }
  for (const name of ['cleared', 'lib/conf.mjs', 'lib/heartbeat.mjs', 'lib/release.mjs', 'lib/forge.mjs', 'lib/memory/adapters/local.mjs', 'lib/guard/private-terms.mjs'])
    assert.ok(files.has(name), `${name}: its git commands were not found by the check`);
  for (const name of node) {
    if (['lib/git-checkout.mjs', 'lib/guard/private-terms.mjs'].includes(name)) continue;
    assert.doesNotMatch(readFileSync(join(ORCH_HOME, name), 'utf8'), /safe\.directory/, `${name} names safe.directory itself`);
  }
});

// The shell scripts declare nothing: under the human's account git refuses the service-owned checkout before
// it reads its configuration. The scripts a human command starts, and what they exec or source, are named
// in docs/security.md when they run git on the project (they are not covered by the read environment).
test('no shell script declares a checkout safe, and those a human command reaches that run git on the project are documented (static check)', () => {
  const all = sourceFiles();
  const shells = all.filter((name) => name.endsWith('.sh'));
  for (const name of shells) assert.doesNotMatch(withoutComments(readFileSync(join(ORCH_HOME, name), 'utf8')), /safe\.directory/, `${name} declares a checkout safe`);
  const named = (text) => {
    const out = new Set();
    for (const match of text.matchAll(/([\w./-]*[\w-]+\.sh)\b/g)) {
      const token = match[1].replace(/^\.?\//, '');
      for (const shell of shells) if (shell === token || shell.endsWith(`/${token}`)) out.add(shell);
    }
    return out;
  };
  // The Node files the human's commands run (cleared and what it starts for status, app passkey and rollback),
  // and the scripts they start: the first argument of a spawn.
  const human = ['cleared', 'lib/heartbeat.mjs', 'app/main.mjs', 'release-request.mjs'];
  const reached = new Set();
  const queue = [];
  for (const name of human) {
    const text = withoutComments(readFileSync(join(ORCH_HOME, name), 'utf8'));
    for (const match of text.matchAll(/\b(?:execFileSync|spawnSync|spawn|execFile|command|run)\(/g)) {
      const call = callAt(text, match.index + match[0].length - 1);
      queue.push(...named(call.split(/,\s*[[{]/)[0]));
    }
  }
  assert.ok(queue.includes('tracker.sh'), 'cleared status starts tracker.sh: the check finds it');
  while (queue.length) {
    const name = queue.shift();
    if (reached.has(name)) continue;
    reached.add(name);
    for (const line of withoutComments(readFileSync(join(ORCH_HOME, name), 'utf8')).split('\n')) {
      if (/(?:^|[;&|)]|\bthen|\bdo|\belse)\s*(?:exec|\.|source)\s+.*\.sh/.test(line)) queue.push(...named(line));
    }
  }
  const project = /\bgit\s+-C\s+"\$\{?(?:ORCH_REPO|CLEARED_REPO|project|repo)\}?"/;
  const flagged = [...reached].filter((name) => project.test(withoutComments(readFileSync(join(ORCH_HOME, name), 'utf8'))));
  assert.ok(flagged.includes('lib/common.sh'), 'the tracked-file check of lib/common.sh is found');
  const security = readFileSync(join(ORCH_HOME, 'docs', 'security.md'), 'utf8');
  for (const name of [...flagged, 'serve/install.sh']) assert.ok(security.includes(name), `docs/security.md names ${name}`);
});
