import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { toolCall, toolCopy } from './support.ts';
import { ORCH_HOME, loadConf, parseConf } from '../lib/conf.ts';

// A scratch project, its home and the environment that names it.
type Project = { root: string; project: string; env: NodeJS.ProcessEnv };
// The same with a git repository, a commit of everything in it and the guard run on a text.
type GuardProject = Project & { git: (...args: string[]) => Buffer; commit: () => void; check: (text: string) => SpawnSyncReturns<string> };

function withProject(run: (project: Project) => void) {
  const root = mkdtempSync(join(tmpdir(), 'cleared-paths-'));
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  const env = { ...process.env, HOME: root, CLEARED_REPO: project, XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config') };
  try { run({ root, project, env }); } finally { rmSync(root, { recursive: true, force: true }); }
}
// What the scripts read of the project, through lib/script.ts (m), as they read it.
function shell(env: NodeJS.ProcessEnv, expression: string) {
  return toolCall(ORCH_HOME, 'lib/script.ts', expression, env);
}
function nodeValue(env: NodeJS.ProcessEnv, expression: string) {
  const script = `import * as conf from ${JSON.stringify(join(ORCH_HOME, 'lib', 'conf.ts'))}; console.log(${expression});`;
  return spawnSync('node', ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
}
function trackProjectConfig(project: string) {
  execFileSync('git', ['-C', project, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', project, 'add', '.cleared/agents.conf']);
}

function committedGuardProject(run: (project: GuardProject) => void) {
  return withProject(({ project, env, root }) => {
    const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args]);
    git('init', '-q', '-b', 'main');
    mkdirSync(join(project, '.cleared'), { recursive: true });
    mkdirSync(join(project, 'scripts'), { recursive: true });
    const commit = () => { git('add', '.'); git('commit', '-q', '-m', 'test configuration'); };
    const check = (text: string) => {
      const input = join(root, 'input.txt');
      writeFileSync(input, text);
      return spawnSync(join(ORCH_HOME, 'lib', 'tracker', 'guard.ts'), [input], {
        env: { ...env, ORCH_GUARD_REF: 'HEAD', ORCH_GUARD_TOOL_REF: '' }, encoding: 'utf8',
      });
    };
    run({ project, env, root, git, commit, check });
  });
}

test('fingerprints with another salt refuse the whole guard, including headerless lists', () => committedGuardProject(({ project, commit, check }) => {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const firstSalt = 'example-salt-a';
  const secondSalt = 'example-salt-b';
  const term = 'private meadow';
  const list = join(project, 'scripts', 'private-terms.json');
  writeFileSync(join(project, '.cleared', 'agents.conf'), `[guard]\nsalt = ${secondSalt}\nterms = scripts/private-terms.json\nallowed = none\n`);
  writeFileSync(list, JSON.stringify({ salt_id: hash(firstSalt).slice(0, 12), hashes: [hash(firstSalt + term)] }));
  commit();
  const mismatch = check(`A ${term} is here.`);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /These fingerprints were made with another salt\. Set \[guard\] salt to the salt that made them, or rebuild the list\./);
  writeFileSync(list, JSON.stringify([hash(firstSalt + term)]));
  commit();
  const headerlessMismatch = check(`A ${term} is here.`);
  assert.notEqual(headerlessMismatch.status, 0);
  assert.match(headerlessMismatch.stderr, /These fingerprints were made with another salt/);
}));

test('guard salt comes from the committed config beside the fingerprint list', () => committedGuardProject(({ project, env, root, commit, check }) => {
  const salt = 'committed-example-salt';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const term = 'quiet valley';
  const config = join(project, '.cleared', 'agents.conf');
  writeFileSync(config, `[guard]\nsalt = ${salt}\nterms = scripts/private-terms.json\nallowed = none\n`);
  writeFileSync(join(project, 'scripts', 'private-terms.json'), JSON.stringify({ salt_id: hash(salt).slice(0, 12), hashes: [hash(salt + term)] }));
  commit();
  writeFileSync(config, '[guard]\nsalt = uncommitted-wrong-salt\nterms = scripts/private-terms.json\nallowed = none\n');
  assert.notEqual(check(term).status, 0, 'the committed term remains protected');
  const input = join(root, 'scan.txt');
  writeFileSync(input, term);
  const direct = spawnSync('node', [join(ORCH_HOME, 'lib', 'guard', 'private-terms.ts'), 'scan', input], {
    env: { ...env, ORCH_GUARD_REF: 'HEAD' }, encoding: 'utf8',
  });
  assert.equal(direct.status, 1, direct.stderr);
  assert.match(direct.stdout, /quiet valley/);
}));

test('fingerprint lists without a committed salt refuse with the line to commit', () => committedGuardProject(({ project, env, root, commit, check }) => {
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[guard]\nterms = scripts/private-terms.json\nallowed = none\n');
  writeFileSync(join(project, 'scripts', 'private-terms.json'), JSON.stringify({ salt_id: '123456789abc', hashes: [] }));
  commit();
  const result = check('A harmless sentence.');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[guard\] salt = <random value>/);
  assert.match(result.stderr, /commit/);
  const input = join(root, 'scan.txt');
  writeFileSync(input, 'A harmless sentence.');
  const direct = spawnSync('node', [join(ORCH_HOME, 'lib', 'guard', 'private-terms.ts'), 'scan', input], { env: { ...env, ORCH_GUARD_REF: 'HEAD' }, encoding: 'utf8' });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /Missing committed \[guard\] salt/);
}));

test('installer asks for a committed salt and leaves the project untouched', () => committedGuardProject(({ project, env, root, commit }) => {
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[guard]\nterms = scripts/private-terms.json\nallowed = none\n');
  writeFileSync(join(project, 'scripts', 'private-terms.json'), JSON.stringify({ salt_id: '123456789abc', hashes: [] }));
  commit();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\necho 100.64.0.1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'ss'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // the test's listening ports, none: not the host's (lib/ports.ts)
  const before = execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' });
  const result = spawnSync(join(toolCopy(root), 'serve', 'install.ts'), [], {
    env: { ...env, ORCH_GUARD_REF: 'HEAD', PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\[guard\] salt = <random value>.*commit/);
  assert.equal(execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' }), before);
  assert.ok(existsSync(join(project, '.cleared', 'agents.conf')));
}));

test('installer refuses an active Cleared wake before changing units or the project', () => committedGuardProject(({ project, env, root, commit }) => {
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[guard]\nterms = none\nallowed = none\n');
  commit();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'systemctl.log');
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\necho 100.64.0.1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'ss'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // the test's listening ports, none: not the host's (lib/ports.ts)
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in *'is-active --quiet cleared-wake.service'*) exit 0;; *'is-active '*|*'is-enabled '*) exit 1;; esac\nexit 0\n`, { mode: 0o755 });
  const before = execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' });
  const result = spawnSync(join(toolCopy(root), 'serve', 'install.ts'), [], { env: { ...env, ORCH_GUARD_REF: 'HEAD', PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cleared wake.*active/i);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /enable --now cleared-/);
  assert.equal(execFileSync('git', ['-C', project, 'status', '--porcelain'], { encoding: 'utf8' }), before);
}));

test('installer refuses an activating wake even when its timer is disabled', () => committedGuardProject(({ project, env, root, commit }) => {
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[guard]\nterms = none\nallowed = none\n');
  commit();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'systemctl.log');
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\necho 100.64.0.1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'ss'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // the test's listening ports, none: not the host's (lib/ports.ts)
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\n' "$*" >> '${log}'\ncase "$*" in *'is-enabled cleared-wake.timer'*) exit 1;; *'show '*cleared-wake.service*) echo activating; exit 0;; *'is-active '*) exit 1;; esac\nexit 0\n`, { mode: 0o755 });
  const result = spawnSync(join(toolCopy(root), 'serve', 'install.ts'), [], { env: { ...env, ORCH_GUARD_REF: 'HEAD', PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /wake.*active/i);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /enable --now cleared-/);
}));

test('installer allows its own wake to refresh units during self update', () => committedGuardProject(({ project, env, root, commit }) => {
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[guard]\nterms = none\nallowed = none\n');
  commit();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'systemctl.log');
  writeFileSync(join(bin, 'tailscale'), '#!/bin/sh\necho 100.64.0.1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'ss'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }); // the test's listening ports, none: not the host's (lib/ports.ts)
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\nprintf '%s\n' "$*" >> '${log}'\ncase "$*" in *"is-enabled cleared-wake.timer"*) echo enabled; exit 0;; *"show "*cleared-wake.service*) echo activating; exit 0;; *"is-active "*) exit 1;; esac\nexit 0\n`, { mode: 0o755 });
  const result = spawnSync(join(toolCopy(root), 'serve', 'install.ts'), [], { env: { ...env, ORCH_GUARD_REF: 'HEAD', CLEARED_INSTALL_FROM_WAKE: '1', PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.doesNotMatch(result.stderr, /wake.*active/i);
  assert.match(readFileSync(log, 'utf8'), /enable --now cleared-release-broker\.service cleared-wake\.timer cleared-app\.service/);
}));

test('missing trusted project configuration refuses the guard instead of disabling it', () => committedGuardProject(({ project, commit, check }) => {
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[guard]\nsalt = example\nterms = scripts/private-terms.json\nallowed = none\n');
  commit();
  execFileSync('git', ['-C', project, 'branch', '-m', 'master']);
  const result = spawnSync(join(ORCH_HOME, 'lib', 'tracker', 'guard.ts'), [join(project, '.cleared', 'agents.conf')], {
    env: { ...process.env, HOME: project, CLEARED_REPO: project, ORCH_GUARD_REF: 'origin/main', ORCH_GUARD_TOOL_REF: '' }, encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /committed project configuration.*could not be read/i);
}));

test('committed Cleared settings advance without stale config or guard bypass', () => committedGuardProject(({ project, env, git, commit, check }) => {
  const config = join(project, '.cleared', 'agents.conf');
  const salt = 'integration-salt';
  const term = 'private orchard';
  writeFileSync(config, '[owner]\nname = First Owner\n[guard]\nterms = none\nallowed = none\n');
  commit();
  assert.equal(shell(env, 'm.ownerName()').stdout.trim(), 'First Owner');
  writeFileSync(config, `[owner]\nname = Updated Owner\n[guard]\nsalt = ${salt}\nterms = scripts/private-terms.json\nallowed = none\n`);
  writeFileSync(join(project, 'scripts', 'private-terms.json'), JSON.stringify({ salt_id: createHash('sha256').update(salt).digest('hex').slice(0, 12), hashes: [createHash('sha256').update(salt + term).digest('hex')] }));
  git('add', '.cleared/agents.conf', 'scripts/private-terms.json');
  git('commit', '-q', '-m', 'advance project configuration');
  assert.equal(shell(env, 'm.ownerName()').stdout.trim(), 'Updated Owner');
  assert.equal(check('Public text.').status, 0);
  assert.notEqual(check(term).status, 0);
  writeFileSync(config, '[guard]\nsalt = local-wrong-salt\n');
  assert.notEqual(check(term).status, 0);
}));

test('CI checks all test files on draft pull requests', () => {
  const workflow = readFileSync(join(ORCH_HOME, '.github', 'workflows', 'checks.yml'), 'utf8');
  assert.match(workflow, /test\/\*\.test\.ts/);
  assert.doesNotMatch(workflow, /draft == false/);
});

test('without fingerprint lists or salt the generic guard runs and records one event', () => committedGuardProject(({ project, root, commit, check }) => {
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[owner]\nname = Example Owner\n');
  commit();
  assert.equal(check('A harmless sentence.').status, 0);
  assert.equal(check('Another harmless sentence.').status, 0);
  const db = new DatabaseSync(join(root, 'state', 'cleared', 'project', 'ledger.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'private_terms_disabled'").get()!.n, 1);
  db.close();
}));

test('project token prefixes are guarded only when committed in project settings', () => committedGuardProject(({ project, git, commit, check }) => {
  const config = join(project, '.cleared', 'agents.conf');
  const token = 'gs' + '_live_' + '123456789abc';
  writeFileSync(config, '[guard]\nterms = none\nallowed = none\n');
  commit();
  assert.equal(check(token).status, 0);
  writeFileSync(config, '[guard]\nterms = none\nallowed = none\ntoken_patterns = gs_live_\n');
  git('add', '.cleared/agents.conf');
  git('commit', '-q', '-m', 'configure project token prefix');
  const blocked = check(token);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /application token/);
}));

test('tracked tool files contain no original project identifiers', () => {
  const forbidden = [
    'TWFraHRhcg==', 'Z2V0c2VldHU=', 'U2VldHU=', 'QUJDLQ==', 'U0VFLQ==', 'YnVkZ2V0aW5n',
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

test('only Cleared settings and state paths are selected', () => withProject(({ root, project, env }) => {
  mkdirSync(join(project, '.cleared'));
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[owner]\nname = Cleared Owner\n');
  trackProjectConfig(project);
  assert.equal(shell(env, '(m.projectEnv(), `${process.env.ORCH_CONF}\\n${process.env.ORCH_STATE_DIR}`)').stdout.trim(), `${join(project, '.cleared', 'agents.conf')}\n${join(root, 'state', 'cleared', 'project')}`);
  assert.equal(nodeValue(env, 'conf.confPath()').stdout.trim(), join(project, '.cleared', 'agents.conf'));
  assert.equal(nodeValue(env, 'conf.stateDir()').stdout.trim(), join(root, 'state', 'cleared', 'project'));
}));

test('an old project configuration is never selected', () => withProject(({ project, env }) => {
  mkdirSync(join(project, '.ferme'));
  writeFileSync(join(project, '.ferme', 'agents.conf'), '[owner]\nname = Obsolete Owner\n');
  execFileSync('git', ['-C', project, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', project, 'add', '.ferme/agents.conf']);
  assert.equal(shell(env, 'm.ownerName()').stdout.trim(), 'the user');
  assert.equal(nodeValue(env, 'conf.loadConf().sections.owner?.name').stdout.trim(), 'undefined');
}));

test('an old state directory is never selected', () => withProject(({ root, env }) => {
  mkdirSync(join(root, 'state', 'ferme', 'project'), { recursive: true });
  assert.equal(shell(env, 'm.projectEnv().state').stdout.trim(), join(root, 'state', 'cleared', 'project'));
  assert.equal(nodeValue(env, 'conf.stateDir()').stdout.trim(), join(root, 'state', 'cleared', 'project'));
}));

test('the migration script is absent', () => {
  assert.ok(!existsSync(join(ORCH_HOME, 'migrate-from-ferme.sh')));
});

test('a committed old guard configuration is never trusted', () => committedGuardProject(({ project, git, check }) => {
  mkdirSync(join(project, '.ferme'));
  writeFileSync(join(project, '.ferme', 'agents.conf'), '[guard]\nsalt = obsolete\nterms = scripts/private-terms.json\n');
  writeFileSync(join(project, 'scripts', 'private-terms.json'), JSON.stringify({ salt_id: createHash('sha256').update('obsolete').digest('hex').slice(0, 12), hashes: [] }));
  git('add', '.'); git('commit', '-q', '-m', 'old configuration');
  const result = check('Public text.');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /committed project configuration.*could not be read/i);
}));

test('a headerless fingerprint list is refused even with a configured salt', () => committedGuardProject(({ project, commit, check }) => {
  const salt = 'new-project-salt';
  writeFileSync(join(project, '.cleared', 'agents.conf'), `[guard]\nsalt = ${salt}\nterms = scripts/private-terms.json\nallowed = none\n`);
  writeFileSync(join(project, 'scripts', 'private-terms.json'), JSON.stringify([createHash('sha256').update(salt + 'private meadow').digest('hex')]));
  commit();
  const result = check('private meadow');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /These fingerprints were made with another salt/);
}));

test('an untracked Cleared config is ignored and reported', () => withProject(({ project, root, env }) => {
  mkdirSync(join(project, '.cleared'));
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[owner]\nname = Stale Owner\n');
  execFileSync('git', ['-C', project, 'init', '-q', '-b', 'main']);
  const wake = shell(env, '(m.ledgerInit(), m.ownerName())');
  assert.equal(wake.stdout.trim(), 'the user');
  const db = new DatabaseSync(join(root, 'state', 'cleared', 'project', 'ledger.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'untracked_config_ignored'").get()!.n, 1);
  db.close();
}));

test('CLEARED_REPO takes precedence over the older environment variable', () => withProject(({ project, env }) => {
  const both = { ...env, ORCH_REPO: '/unused/old/path' };
  assert.equal(shell(both, 'm.projectEnv().repo').stdout.trim(), project);
  assert.equal(nodeValue(both, 'conf.projectDir()').stdout.trim(), project);
}));

test('CLEARED_CONF takes precedence over the older environment variable', () => withProject(({ root, env }) => {
  const current = join(root, 'current.conf');
  writeFileSync(current, '[owner]\nname = New\n');
  const both = { ...env, CLEARED_CONF: current, ORCH_CONF: '/unused/old.conf' };
  assert.equal(shell(both, 'm.projectEnv().conf').stdout.trim(), current);
  assert.equal(nodeValue(both, 'conf.confPath()').stdout.trim(), current);
}));

test('CLEARED_STATE_DIR takes precedence over the older environment variable', () => withProject(({ root, env }) => {
  const current = join(root, 'current-state');
  const both = { ...env, CLEARED_STATE_DIR: current, ORCH_STATE_DIR: '/unused/old-state' };
  assert.equal(shell(both, 'm.projectEnv().state').stdout.trim(), current);
  assert.equal(nodeValue(both, 'conf.stateDir()').stdout.trim(), current);
}));

test('owner name defaults to the user', () => withProject(({ env }) => {
  const result = shell(env, 'm.ownerName()');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'the user');
}));

test('duplicate project keys keep the first value and warn once in the ledger', () => committedGuardProject(({ project, root, env, commit }) => {
  const config = join(project, '.cleared', 'agents.conf');
  writeFileSync(config, '[owner]\nname = First Owner\nname = Second Owner\n');
  commit();
  assert.equal(loadConf(config).sections.owner!.name, 'First Owner');
  const wake = () => shell(env, '(m.ledgerInit(), m.ownerName())');
  assert.equal(wake().stdout.trim(), 'First Owner');
  assert.equal(wake().stdout.trim(), 'First Owner');
  const db = new DatabaseSync(join(root, 'state', 'cleared', 'project', 'ledger.db'), { readOnly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'duplicate_config_key' AND detail LIKE '%[owner] name%'").get()!.n, 1);
  db.close();
}));

test('project owner name overrides the example', () => withProject(({ project, env }) => {
  mkdirSync(join(project, '.cleared'));
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[owner]\nname = Example Owner\n');
  trackProjectConfig(project);
  assert.equal(shell(env, 'm.ownerName()').stdout.trim(), 'Example Owner');
}));

test('a complete project configuration retains exactly its settings', () => withProject(({ project }) => {
  mkdirSync(join(project, '.cleared'));
  const source = readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8');
  const config = join(project, '.cleared', 'agents.conf');
  writeFileSync(config, source);
  assert.deepEqual(loadConf(config), parseConf(source));
}));

test('the example never supplies missing project keys or a merge verdict', () => withProject(({ project, env, root }) => {
  mkdirSync(join(project, '.cleared'));
  const config = join(project, '.cleared', 'agents.conf');
  writeFileSync(config, '[owner]\nname = Example Owner\n');
  trackProjectConfig(project);
  const loaded = loadConf(config);
  assert.equal(loaded.sections.tracker?.team, undefined);
  assert.equal(loaded.sections.merge?.verdict, undefined);
  assert.equal(loaded.sections.limits!.max_lanes, '1');
  const missingTeam = shell(env, "m.confGet('tracker', 'team')");
  assert.notEqual(missingTeam.status, 0);
  assert.match(missingTeam.stderr, /Missing required \[tracker\] team/);
  const report = join(root, 'report.md');
  writeFileSync(report, '## Compte rendu\nVerdict : rien de bloquant\n');
  const result = spawnSync('node', [join(ORCH_HOME, 'lib', 'merge.ts'), 'verdict', report], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing required \[merge\] verdict/i);
}));

test('an empty required project setting is reported as missing', () => withProject(({ project, env }) => {
  mkdirSync(join(project, '.cleared'));
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[merge]\nverdict =\n');
  trackProjectConfig(project);
  const result = shell(env, "m.confGet('merge', 'verdict')");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing required \[merge\] verdict/);
}));

test('the merge check reads the configured verdict', () => withProject(({ project, env, root }) => {
  mkdirSync(join(project, '.cleared'));
  writeFileSync(join(project, '.cleared', 'agents.conf'), '[merge]\nverdict = approved for sample\n');
  trackProjectConfig(project);
  const report = join(root, 'report.md');
  writeFileSync(report, '## Compte rendu\nVerdict : approved for sample\n');
  const accepted = spawnSync('node', [join(ORCH_HOME, 'lib', 'merge.ts'), 'verdict', report], { env, encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  writeFileSync(report, '## Compte rendu\nVerdict : rien de bloquant\n');
  const refused = spawnSync('node', [join(ORCH_HOME, 'lib', 'merge.ts'), 'verdict', report], { env, encoding: 'utf8' });
  assert.notEqual(refused.status, 0);
}));
