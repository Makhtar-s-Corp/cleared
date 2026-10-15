// The checkout the human's commands read belongs to another account, which can put commands in its
// .git/config and .git/hooks. These tests plant such commands in a repository of their own, have git treat
// it as owned by someone else (GIT_TEST_ASSUME_DIFFERENT_OWNER, in the environment of the git that runs,
// never in the runner's), and go through each place Cleared's Node code reads a checkout: none of the planted
// commands may run. They use only what the code exported before the read environment existed, so they can
// be run against an older version too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.mjs';
import { openLedger } from '../lib/ledger.mjs';
import { scratch } from './support.mjs';

const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const HOOKS = ['post-index-change', 'reference-transaction', 'post-checkout', 'post-merge', 'pre-auto-gc', 'post-rewrite', 'pre-commit', 'pre-push'];
const OWNER = { GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };

// A copy of `sha` with a (fake) signature header: git log and show -s run gpg.program on it when
// log.showSignature is true.
function signed(git, sha) {
  const lines = git('cat-file', 'commit', sha).split('\n');
  const committer = lines.findIndex((line) => line.startsWith('committer '));
  lines.splice(committer + 1, 0, 'gpgsig -----BEGIN PGP SIGNATURE-----', ' ', ' AAAA', ' -----END PGP SIGNATURE-----');
  return execFileSync(REAL_GIT, ['-C', git.dir, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: lines.join('\n'), encoding: 'utf8' }).trim();
}

// A repository with the committed settings of the example, two commits on main (the last one signed), a lane
// worktree, and, once all that is made, the planted commands: each writes its name to `marker` when it runs.
function plantedRepo() {
  const root = realpathSync(scratch('orch-planted-'));
  const repo = join(root, 'project');
  const marker = join(root, 'ran.log');
  const git = (...args) => execFileSync(REAL_GIT, ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' }).trim();
  git.dir = repo;
  mkdirSync(join(repo, '.cleared'), { recursive: true });
  mkdirSync(join(repo, 'scripts'));
  mkdirSync(join(repo, 'docs'));
  execFileSync(REAL_GIT, ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, '.cleared', 'agents.conf'), readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8'));
  for (const file of ['codex-guard-allow.json', 'private-terms.json']) cpSync(join(ORCH_HOME, 'test', 'fixtures', 'guard', file), join(repo, 'scripts', file));
  writeFileSync(join(repo, 'docs', 'project.md'), '# Project\n\nA committed memory file.\n');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-qm', 'one');
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  writeFileSync(join(repo, 'b.txt'), 'new\n');
  git('add', '.');
  git('commit', '-qm', 'two');
  const head = signed(git, git('rev-parse', 'HEAD'));
  git('update-ref', 'refs/heads/main', head);
  git('reset', '-q', '--hard', head);
  git('worktree', 'add', '-q', join(root, 'lanes', 'dev-x'), '-b', 'dev/x', head);

  const plant = join(root, 'plant');
  writeFileSync(plant, `#!/bin/sh\necho "planted $*" >> '${marker}'\nexit 0\n`);
  chmodSync(plant, 0o755);
  const hooks = join(root, 'hooks');
  mkdirSync(hooks);
  for (const hook of HOOKS) {
    for (const dir of [hooks, join(repo, '.git', 'hooks')]) {
      writeFileSync(join(dir, hook), `#!/bin/sh\necho "hook ${hook}" >> '${marker}'\n`);
      chmodSync(join(dir, hook), 0o755);
    }
  }
  const included = join(root, 'included.conf');
  writeFileSync(included, `[core]\n\tfsmonitor = ${plant}\n[pager]\n\tshow = ${plant}\n`);
  writeFileSync(join(repo, '.git', 'info', 'attributes'), '* diff=planted filter=planted\n');
  for (const [key, value] of [
    ['core.fsmonitor', plant], ['core.hooksPath', hooks], ['core.pager', plant], ['pager.log', plant], ['pager.diff', plant],
    ['core.editor', plant], ['core.askPass', plant], ['core.sshCommand', plant], ['credential.helper', plant],
    ['diff.external', plant], ['diff.planted.textconv', plant], ['diff.planted.command', plant],
    ['filter.planted.clean', plant], ['filter.planted.smudge', plant],
    ['log.showSignature', 'true'], ['gpg.program', plant], ['gpg.ssh.program', plant],
    ['remote.origin.url', 'ssh://git@example.invalid/project.git'], ['remote.origin.uploadpack', plant],
    ['include.path', included],
  ]) git('config', '--add', key, value);
  const ran = () => (existsSync(marker) ? readFileSync(marker, 'utf8') : '');
  return { root, repo, marker, head, git, ran };
}

// The environment of a child: the runner's, without a project named and without exported git settings.
function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^GIT_CONFIG_/.test(name) || /^(CLEARED|ORCH)_(REPO|CONF|STATE_DIR|LEDGER)$/.test(name)) delete env[name];
  }
  return { ...env, ...extra };
}

// In this process, for one call: the project named, and git told the checkout is someone else's.
async function asForeign(project, call) {
  const saved = { CLEARED_REPO: process.env.CLEARED_REPO, ORCH_REPO: process.env.ORCH_REPO, GIT_TEST_ASSUME_DIFFERENT_OWNER: process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER };
  Object.assign(process.env, { CLEARED_REPO: project, ORCH_REPO: project }, OWNER);
  try { return await call(); }
  finally { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}

test('control: git refuses the planted checkout as another user\'s, and with safe.directory alone its fsmonitor runs on ls-files', (t) => {
  const p = plantedRepo();
  const refused = spawnSync(REAL_GIT, ['-C', p.repo, 'ls-files', '--error-unmatch', '--', '.cleared/agents.conf'], { encoding: 'utf8', env: childEnv(OWNER) });
  if (refused.status === 0) { t.skip('this git does not honour GIT_TEST_ASSUME_DIFFERENT_OWNER'); return; }
  assert.equal(refused.status, 128);
  assert.match(refused.stderr, /dubious ownership/);
  assert.equal(p.ran(), '', 'a refused repository runs nothing');
  const declaredOnly = spawnSync(REAL_GIT, ['-C', p.repo, 'ls-files', '--error-unmatch', '--', '.cleared/agents.conf'], { encoding: 'utf8',
    env: childEnv({ ...OWNER, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: p.repo }) });
  assert.equal(declaredOnly.status, 0, declaredOnly.stderr);
  assert.match(p.ran(), /^planted /m, 'the planted fsmonitor ran: the vector is real');
});

test('the tracked-file check of the project config runs nothing the checkout planted', () => {
  const p = plantedRepo();
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `import { confPath } from ${JSON.stringify(join(ORCH_HOME, 'lib', 'conf.mjs'))}; console.log(confPath());`],
    { encoding: 'utf8', env: childEnv({ CLEARED_REPO: p.repo, ...OWNER }) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), join(p.repo, '.cleared', 'agents.conf'), 'the committed config is read');
  assert.equal(run.stderr, '', 'the read environment makes git say nothing: the human sees no warning on every command');
  assert.equal(p.ran(), '');
});

test('the tool\'s own checkout, found by git when no project is named, runs nothing it planted (and a subdirectory of it is declared by its top level)', () => {
  const p = plantedRepo();
  // The tool as a folder of the planted repository: lib/conf.mjs lists the worktrees of <repo>/tool.
  cpSync(join(ORCH_HOME, 'lib'), join(p.repo, 'tool', 'lib'), { recursive: true });
  cpSync(join(ORCH_HOME, 'agents.example.conf'), join(p.repo, 'tool', 'agents.example.conf'));
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `import { projectDir } from ${JSON.stringify(join(p.repo, 'tool', 'lib', 'conf.mjs'))}; console.log(projectDir());`],
    { encoding: 'utf8', env: childEnv({ ...OWNER, XDG_CONFIG_HOME: scratch('orch-no-project-') }) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), p.repo);
  assert.equal(p.ran(), '');
});

function seededLedger(p) {
  const state = scratch('orch-planted-state-');
  const db = openLedger(join(state, 'ledger.db'));
  db.exec('CREATE TABLE IF NOT EXISTS releases (id INTEGER PRIMARY KEY, ticket TEXT, pr INTEGER, merge_sha TEXT, title TEXT, merged_at TEXT, status TEXT)');
  db.prepare('INSERT INTO releases(ticket, pr, merge_sha, title, merged_at, status) VALUES (?,?,?,?,?,?)').run('LOCAL-9', 9, p.head, 'Planted', new Date().toISOString(), 'complete');
  db.close();
  return state;
}

test('the preview of cleared rollback lists the files and runs nothing the checkout planted, from the top level or a subdirectory', () => {
  const p = plantedRepo();
  const state = seededLedger(p);
  for (const project of [p.repo, join(p.repo, '.cleared')]) {
    const run = spawnSync(process.execPath, [join(ORCH_HOME, 'cleared'), 'rollback', 'LOCAL-9'], { encoding: 'utf8', input: 'no\n',
      env: childEnv({ CLEARED_REPO: project, CLEARED_STATE_DIR: state, ORCH_LEDGER: join(state, 'ledger.db'), ...OWNER }) });
    assert.match(run.stdout, /Files:\na\.txt\nb\.txt/, `${project}: ${run.stderr}`);
    assert.match(run.stderr, /Rollback cancelled/);
    assert.equal(p.ran(), '', project);
  }
});

// Checks that the call carries the read environment, not that a planted setting is neutralised: `git show <ref>:<path>`
// and `symbolic-ref` run no program of the checkout, so no planted setting is reachable through them here.
test('the guard reads the committed lists with the read environment (a call check: no planted program is reachable here)', () => {
  const p = plantedRepo();
  const input = join(scratch('orch-planted-input-'), 'input.txt');
  writeFileSync(input, 'an ordinary sentence\n');
  for (const ref of [{ ORCH_GUARD_REF: 'HEAD' }, {}]) {
    spawnSync(process.execPath, [join(ORCH_HOME, 'lib', 'guard', 'private-terms.mjs'), 'scan', input], { encoding: 'utf8',
      env: childEnv({ CLEARED_REPO: p.repo, ...OWNER, ...ref }) });
  }
  const scan = spawnSync(process.execPath, [join(ORCH_HOME, 'lib', 'guard', 'private-terms.mjs'), 'scan', input], { encoding: 'utf8',
    env: childEnv({ CLEARED_REPO: p.repo, ORCH_GUARD_REF: 'HEAD', ...OWNER }) });
  assert.equal(scan.status, 0, scan.stderr);
  assert.equal(p.ran(), '');
});

test('the status of the lanes reads the checkout (worktrees, the date of each lane) and runs nothing it planted', async () => {
  const p = plantedRepo();
  const { collectStatus } = await import('../lib/heartbeat.mjs');
  const state = scratch('orch-planted-state-');
  const db = openLedger(join(state, 'ledger.db'));
  const conf = { sections: { lanes: { root: join(p.root, 'lanes') }, security: { agent_user: 'agents' } }, roles: { dev: 'any' } };
  const result = await asForeign(p.repo, () => collectStatus(db, conf, { repo: p.repo, state, probe: false, readUrls: false }));
  db.close();
  assert.deepEqual(result.snapshot.lanes.map((lane) => lane.name), ['dev/x']);
  assert.ok(result.snapshot.lanes[0].branchMovedAt, 'the date of the lane was read');
  assert.equal(p.ran(), '');
});

// A call check only: `git show HEAD:<path>` runs no program of the checkout, so nothing planted is reachable here.
test('the memory index reads its committed files with the read environment (a call check: no planted program is reachable here)', async () => {
  const p = plantedRepo();
  const { LocalMemory } = await import('../lib/memory/adapters/local.mjs');
  const db = openLedger(':memory:');
  const conf = { sections: { memory: { enabled: 'true', project: 'docs/project.md', decisions: 'docs/decisions/', glossary: 'docs/glossary.md', lessons: 'none' } }, roles: {} };
  await asForeign(p.repo, () => new LocalMemory({ project: p.repo, conf, db }).index('dev'));
  const committed = db.prepare('SELECT committed FROM memory_files').all().map((row) => row.committed);
  assert.ok(committed.includes(1), 'the committed file was recognised');
  assert.equal(p.ran(), '');
});

// A call check only: `config --list` and `remote get-url` run no program of the checkout, so nothing planted is reachable here.
test('the forge environment reads the origin and the configuration with the read environment (a call check: no planted program is reachable here)', async () => {
  const p = plantedRepo();
  const { forgeEnv } = await import('../lib/forge.mjs');
  const conf = { sections: { forge: { app_id: '1', installation_id: '2', app_private_key_file: '/nonexistent/key.pem', app_login: 'cleared[bot]', app_user_id: '3' } } };
  const env = await asForeign(p.repo, () => forgeEnv(conf, childEnv(OWNER)));
  assert.match(env.GIT_SSH_COMMAND || '', /origin of the project leads to/, 'the origin was read (it is not github.com)');
  assert.equal(p.ran(), '');
});

test('the recovery of a pushed revert reads its message and runs nothing the checkout planted', async (t) => {
  const { activeRelease, rollbackRelease, resumeWatches } = await import('../lib/release.mjs');
  const root = realpathSync(scratch('orch-planted-release-'));
  const remote = join(root, 'remote.git');
  const repo = join(root, 'project');
  const marker = join(root, 'ran.log');
  const git = (...args) => execFileSync(REAL_GIT, ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' }).trim();
  git.dir = repo;
  execFileSync(REAL_GIT, ['init', '--bare', '-q', '-b', 'main', remote]);
  execFileSync(REAL_GIT, ['clone', '-q', remote, repo]);
  writeFileSync(join(repo, 'app.txt'), 'before\n');
  git('add', '.'); git('commit', '-qm', 'initial'); git('push', '-q', 'origin', 'main');
  git('checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'app.txt'), 'release\n');
  git('commit', '-qam', 'feature');
  git('checkout', '-q', 'main'); git('merge', '--no-ff', '-qm', 'Merge feature', 'feature'); git('push', '-q', 'origin', 'main');
  const db = openLedger(join(root, 'ledger.db'));
  activeRelease(db);
  db.prepare('INSERT INTO releases(ticket,pr,merge_sha,title,merged_at,status) VALUES (?,?,?,?,?,?)')
    .run('LOCAL-1', 1, git('rev-parse', 'HEAD'), 'Test release', new Date().toISOString(), 'watching');
  const row = db.prepare('SELECT * FROM releases').get();
  const conf = { sections: { lanes: { base: 'origin/main' }, tracker: { owner_id: 'human' },
    release: { health_command: 'true', deploy_grace_minutes: '0', watch_minutes: '2', failures_to_rollback: '3', auto_rollback: 'true', reopen_state: 'Todo' } } };
  rollbackRelease(conf, db, repo, row, { trackerFactory: () => ({ moveTicket: () => {} }), announce: () => {} });
  // The pushed revert, signed: the read of its message is where a signature check would run.
  const revert = execFileSync(REAL_GIT, ['-C', remote, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const lines = execFileSync(REAL_GIT, ['-C', remote, 'cat-file', 'commit', revert], { encoding: 'utf8' }).split('\n');
  lines.splice(lines.findIndex((line) => line.startsWith('committer ')) + 1, 0, 'gpgsig -----BEGIN PGP SIGNATURE-----', ' ', ' AAAA', ' -----END PGP SIGNATURE-----');
  const signedRevert = execFileSync(REAL_GIT, ['-C', remote, 'hash-object', '-t', 'commit', '-w', '--stdin'], { input: lines.join('\n'), encoding: 'utf8' }).trim();
  execFileSync(REAL_GIT, ['-C', remote, 'update-ref', 'refs/heads/main', signedRevert]);
  db.prepare("UPDATE releases SET status = 'rolling_back', rollback_sha = NULL, rollback_pushed_at = NULL, planned_rollback_sha = ? WHERE id = ?").run(signedRevert, row.id);
  const plant = join(root, 'plant');
  writeFileSync(plant, `#!/bin/sh\necho "planted $*" >> '${marker}'\nexit 0\n`);
  chmodSync(plant, 0o755);
  // Only what the fetch does not reach: the fetch is the service's, on its own checkout, with its own settings
  // (it reads the index, so it would run an fsmonitor of the checkout: the service's own).
  for (const [key, value] of [['log.showSignature', 'true'], ['gpg.program', plant], ['diff.external', plant], ['core.pager', plant]]) git('config', key, value);
  const resumed = [];
  resumeWatches(conf, db, repo, { running: () => false, lockAvailable: () => true, schedule: (_repo, id) => resumed.push(id), announce: () => {} });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT status FROM releases WHERE id = ?').get(row.id).status, 'verifying_rollback', 'the revert was found by its message');
  assert.equal(existsSync(marker) ? readFileSync(marker, 'utf8') : '', '');
});

// A git that refuses every checkout, as git does under another account than the owner's.
function refusingGit() {
  const dir = scratch('orch-refusing-git-');
  writeFileSync(join(dir, 'git'), `#!/bin/sh\necho "fatal: detected dubious ownership in repository at '$2'" >&2\nexit 128\n`);
  chmodSync(join(dir, 'git'), 0o755);
  return dir;
}

test('a refused checkout is not recorded as an untracked config', () => {
  const p = plantedRepo();
  const state = scratch('orch-refused-state-');
  // A command reads the settings, then opens the ledger, which records the configs that were ignored.
  const run = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
    `import { loadConf } from ${JSON.stringify(join(ORCH_HOME, 'lib', 'conf.mjs'))};
     import { openLedger } from ${JSON.stringify(join(ORCH_HOME, 'lib', 'ledger.mjs'))};
     try { loadConf(); } catch { /* said by the command */ }
     openLedger(${JSON.stringify(join(state, 'ledger.db'))}).close();`],
    { encoding: 'utf8', env: childEnv({ CLEARED_REPO: p.repo, PATH: `${refusingGit()}:${process.env.PATH}` }) });
  assert.equal(run.status, 0, run.stderr);
  const db = openLedger(join(state, 'ledger.db'), { readOnly: true });
  const events = db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'untracked_config_ignored'").get().n;
  db.close();
  assert.equal(events, 0);
});

test('the scripts\' shared setup says git refused the checkout and records no untracked config', () => {
  const p = plantedRepo();
  const run = spawnSync('bash', ['-c', `. ${JSON.stringify(join(ORCH_HOME, 'lib', 'common.sh'))}; echo "conf=$ORCH_CONF ignored=\${CLEARED_IGNORED_UNTRACKED_CONF:-}"`],
    { encoding: 'utf8', env: childEnv({ CLEARED_REPO: p.repo, ...OWNER }) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ignored=$/m);
  assert.match(run.stderr, new RegExp(`^cleared: git refused or could not read ${p.repo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: fatal: detected dubious ownership`, 'm'));
  assert.equal(p.ran(), '', 'no declaration in the scripts: git refuses before reading the planted configuration');
});

for (const command of [['status'], ['ticket', 'show', 'LOCAL-1'], ['rollback', 'LOCAL-1'], ['app', 'passkey'], ['app']]) {
  test(`cleared ${command.join(' ')} says that git refused the checkout, not a missing setting`, () => {
    const p = plantedRepo();
    const run = spawnSync(process.execPath, [join(ORCH_HOME, 'cleared'), ...command], { encoding: 'utf8', input: 'no\n', timeout: 30_000,
      env: childEnv({ CLEARED_REPO: p.repo, CLEARED_STATE_DIR: scratch('orch-refused-state-'), PATH: `${refusingGit()}:${process.env.PATH}` }) });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, new RegExp(`^cleared: git refused or could not read ${p.repo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}: fatal: detected dubious ownership`, 'm'));
    assert.doesNotMatch(run.stderr, /set \[app\] grant_socket|require \[tracker\] adapter/);
  });
}

test('a project path that is not there, or that starts with ~, is said as such', () => {
  for (const [project, said] of [[join(scratch('orch-gone-'), 'gone'), /does not exist/], ['~/project', /starts with "~", which Cleared does not expand/]]) {
    for (const command of [['app', 'passkey'], ['rollback', 'LOCAL-1'], ['status']]) {
      const run = spawnSync(process.execPath, [join(ORCH_HOME, 'cleared'), ...command], { encoding: 'utf8', input: 'no\n', timeout: 30_000,
        env: childEnv({ CLEARED_REPO: project, CLEARED_STATE_DIR: scratch('orch-gone-state-') }) });
      assert.equal(run.status, 2, `${command.join(' ')}: ${run.stderr}`);
      assert.match(run.stderr, said, command.join(' '));
      assert.doesNotMatch(run.stderr, /git refused|grant_socket/, command.join(' '));
    }
  }
});
