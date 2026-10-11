import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ORCH_HOME, loadConf, parseConf } from '../lib/conf.mjs';

function withProject(run) {
  const root = mkdtempSync(join(tmpdir(), 'cleared-paths-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const env = { ...process.env, HOME: root, CLEARED_REPO: project, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') };
  try { run({ root, project, env }); } finally { rmSync(root, { recursive: true, force: true }); }
}
function shell(env, command) {
  return spawnSync('bash', ['-c', `. "$1/lib/common.sh"; ${command}`, '_', ORCH_HOME], { env, encoding: 'utf8' });
}
function nodeValue(env, expression) {
  const script = `import * as conf from ${JSON.stringify(join(ORCH_HOME, 'lib', 'conf.mjs'))}; console.log(${expression});`;
  return spawnSync('node', ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
}

function committedGuardProject(run) {
  return withProject(({ project, env, root }) => {
    const git = (...args) => execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args]);
    git('init', '-q', '-b', 'main');
    mkdirSync(join(project, '.ferme'), { recursive: true });
    mkdirSync(join(project, 'scripts'), { recursive: true });
    const commit = () => { git('add', '.'); git('commit', '-q', '-m', 'test configuration'); };
    const check = (text) => {
      const input = join(root, 'input.txt');
      writeFileSync(input, text);
      return spawnSync('bash', ['-c', '. "$1/lib/common.sh"; guard_text "$2"', '_', ORCH_HOME, input], {
        env: { ...env, ORCH_GUARD_REF: 'HEAD', ORCH_GUARD_TOOL_REF: '' }, encoding: 'utf8',
      });
    };
    run({ project, env, root, git, commit, check });
  });
}

test('fingerprints with another salt refuse the whole guard, including legacy lists', () => committedGuardProject(({ project, commit, check }) => {
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const firstSalt = 'example-salt-a';
  const secondSalt = 'example-salt-b';
  const term = 'private meadow';
  const list = join(project, 'scripts', 'private-terms.json');
  writeFileSync(join(project, '.ferme', 'agents.conf'), `[guard]\nsalt = ${secondSalt}\nterms = scripts/private-terms.json\nallowed = none\n`);
  writeFileSync(list, JSON.stringify({ salt_id: hash(firstSalt).slice(0, 12), hashes: [hash(firstSalt + term)] }));
  commit();
  const mismatch = check(`A ${term} is here.`);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /These fingerprints were made with another salt\. Set \[guard\] salt to the salt that made them, or rebuild the list\./);
  writeFileSync(list, JSON.stringify([hash(firstSalt + term)]));
  commit();
  const legacyMismatch = check(`A ${term} is here.`);
  assert.notEqual(legacyMismatch.status, 0);
  assert.match(legacyMismatch.stderr, /These fingerprints were made with another salt/);
}));

test('tracked tool files contain no original project identifiers', () => {
  const forbidden = [
    'TWFraHRhcg==', 'Z2V0c2VldHU=', 'U2VldHU=', 'QUJDLQ==', 'U0VFLQ==',
    'L2hvbWUvbWFraHRhcg==', 'SnVzdGVzc2UgZHUgbW90ZXVy',
    'UmVmb250ZSBkZXMg6WNyYW5z',
  ].map((part) => Buffer.from(part, 'base64').toString('utf8'));
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: ORCH_HOME }).toString().split('\0').filter(Boolean);
  for (const path of paths) {
    if (!existsSync(join(ORCH_HOME, path))) continue;
    const source = readFileSync(join(ORCH_HOME, path), 'utf8');
    for (const term of forbidden) assert.ok(!source.toLowerCase().includes(term.toLowerCase()), `${path} contains a forbidden identifier`);
  }
});

test('a project with only legacy paths still resolves its settings and ledger', () => {
  const root = mkdtempSync(join(tmpdir(), 'cleared-legacy-'));
  try {
    const project = join(root, 'sample-project');
    const config = join(root, 'config');
    const state = join(root, 'state');
    mkdirSync(join(project, '.ferme', 'prompts'), { recursive: true });
    mkdirSync(join(config, 'ferme'), { recursive: true });
    mkdirSync(join(state, 'ferme', 'sample-project'), { recursive: true });
    writeFileSync(join(project, '.ferme', 'agents.conf'), '[owner]\nname = Example Owner\n');
    writeFileSync(join(config, 'ferme', 'project'), `${project}\n`);
    const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, HOME: root };
    const result = spawnSync('bash', ['-c', '. "$1/lib/common.sh"; printf "%s\\n%s\\n" "$ORCH_CONF" "$ORCH_STATE_DIR"; ledger init >/dev/null; ledger init >/dev/null', '_', ORCH_HOME], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [join(project, '.ferme', 'agents.conf'), join(state, 'ferme', 'sample-project')]);
    assert.ok(existsSync(join(state, 'ferme', 'sample-project', 'ledger.db')));
    const db = new DatabaseSync(join(state, 'ferme', 'sample-project', 'ledger.db'), { readOnly: true });
    assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'legacy_path_used'").get().n, 1);
    db.close();
    assert.ok(!existsSync(join(state, 'cleared', 'sample-project')));
    const migrationEnv = { ...env, CLEARED_REPO: project };
    const migration = (mode) => spawnSync(join(ORCH_HOME, 'migrate-from-ferme.sh'), [mode], { env: migrationEnv, encoding: 'utf8' });
    assert.equal(migration('--dry-run').status, 0);
    assert.ok(!existsSync(join(project, '.cleared')));
    assert.equal(migration('--apply').status, 0);
    assert.ok(existsSync(join(project, '.cleared', 'agents.conf')));
    assert.ok(existsSync(join(project, '.ferme', 'agents.conf')));
    assert.ok(existsSync(join(state, 'cleared', 'sample-project', 'ledger.db')));
    assert.ok(existsSync(join(state, 'ferme', 'sample-project', 'ledger.db')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('new project settings take precedence over legacy settings', () => withProject(({ project, env }) => {
  for (const name of ['.ferme', '.cleared']) mkdirSync(join(project, name));
  writeFileSync(join(project, '.ferme', 'agents.conf'), '[owner]\nname = Old\n');
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[owner]\nname = New\n');
  assert.equal(shell(env, 'printf "%s" "$ORCH_CONF"').stdout, join(project, '.cleared', 'agents.conf'));
  assert.equal(nodeValue(env, 'conf.confPath()').stdout.trim(), join(project, '.cleared', 'agents.conf'));
}));

test('new state takes precedence when both state directories exist', () => withProject(({ root, env }) => {
  mkdirSync(join(root, 'state', 'ferme', 'project'), { recursive: true });
  mkdirSync(join(root, 'state', 'cleared', 'project'), { recursive: true });
  assert.equal(shell(env, 'printf "%s" "$ORCH_STATE_DIR"').stdout, join(root, 'state', 'cleared', 'project'));
  assert.equal(nodeValue(env, 'conf.stateDir()').stdout.trim(), join(root, 'state', 'cleared', 'project'));
}));

test('CLEARED_REPO takes precedence over the older environment variable', () => withProject(({ project, env }) => {
  const both = { ...env, ORCH_REPO: '/unused/old/path' };
  assert.equal(shell(both, 'printf "%s" "$ORCH_REPO"').stdout, project);
  assert.equal(nodeValue(both, 'conf.projectDir()').stdout.trim(), project);
}));

test('CLEARED_CONF takes precedence over the older environment variable', () => withProject(({ root, env }) => {
  const current = join(root, 'current.conf');
  writeFileSync(current, '[owner]\nname = New\n');
  const both = { ...env, CLEARED_CONF: current, ORCH_CONF: '/unused/old.conf' };
  assert.equal(shell(both, 'printf "%s" "$ORCH_CONF"').stdout, current);
  assert.equal(nodeValue(both, 'conf.confPath()').stdout.trim(), current);
}));

test('CLEARED_STATE_DIR takes precedence over the older environment variable', () => withProject(({ root, env }) => {
  const current = join(root, 'current-state');
  const both = { ...env, CLEARED_STATE_DIR: current, ORCH_STATE_DIR: '/unused/old-state' };
  assert.equal(shell(both, 'printf "%s" "$ORCH_STATE_DIR"').stdout, current);
  assert.equal(nodeValue(both, 'conf.stateDir()').stdout.trim(), current);
}));

test('owner name defaults to the user', () => withProject(({ env }) => {
  const result = shell(env, 'owner_name');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'the user');
}));

test('project owner name overrides the example', () => withProject(({ project, env }) => {
  mkdirSync(join(project, '.cleared'));
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[owner]\nname = Example Owner\n');
  assert.equal(shell(env, 'owner_name').stdout.trim(), 'Example Owner');
}));

test('new prompt overrides the tool prompt', () => withProject(({ project, env }) => {
  mkdirSync(join(project, '.cleared', 'prompts'), { recursive: true });
  writeFileSync(join(project, '.cleared', 'prompts', 'dev.md'), 'new prompt');
  assert.equal(shell(env, 'prompt_text "$(prompt_file dev)"').stdout, 'new prompt');
}));

test('legacy prompt remains available when no new prompt exists', () => withProject(({ project, env }) => {
  mkdirSync(join(project, '.ferme', 'prompts'), { recursive: true });
  writeFileSync(join(project, '.ferme', 'prompts', 'dev.md'), 'legacy prompt');
  assert.equal(shell(env, 'prompt_text "$(prompt_file dev)"').stdout, 'legacy prompt');
}));

test('a complete project configuration retains exactly its settings', () => withProject(({ project }) => {
  mkdirSync(join(project, '.cleared'));
  const source = readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8');
  const config = join(project, '.cleared', 'agents.conf');
  writeFileSync(config, source);
  assert.deepEqual(loadConf(config), parseConf(source));
}));
