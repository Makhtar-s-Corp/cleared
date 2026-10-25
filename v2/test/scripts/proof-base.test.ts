// The clean base of the multi-service proof (scripts/proof-base.ts): the
// settings, the guards that keep a run off main, the check of the frozen
// commit, and the run branch recreated in temporary bare repositories,
// never a real remote.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BaseError, FROZEN_BRANCH, baseModeOf, RUN_BRANCH, StartRefusal, checksRunOn, closeStale, defaultBranchOf, frozenCommits, readBaseSettings, readWatchers, reader, recreate, refusal, runCommand,
  ticketChangesIn, watcherOf, watcherRefusal, workflowTriggers, workflowsAt, type BaseSettings, type Run, type Watcher,
} from '../../scripts/proof-base.ts';
import { rehearsalWorkspace } from '../../scripts/proof-rehearsal-multi.ts';

const root = mkdtempSync(join(tmpdir(), 'cleared-proof-base-'));
after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Proof', '-c', 'user.email=proof@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();

// A bare "remote" whose default branch is main, with a frozen branch and a
// run branch an earlier run moved on; and a clone of it.
function world(name: string): { origin: string; clone: string; frozen: string; stale: string; main: string } {
  const seed = join(root, `${name}-seed`);
  mkdirSync(seed);
  git(seed, 'init', '--quiet');
  writeFileSync(join(seed, 'words.txt'), 'scam\n');
  git(seed, 'add', '--all');
  git(seed, 'commit', '--quiet', '-m', 'the base');
  const frozen = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'on main after the freeze');
  const main = git(seed, 'rev-parse', 'HEAD');
  const origin = join(root, `${name}.git`);
  git(root, 'clone', '--quiet', '--bare', seed, origin);
  git(origin, 'branch', FROZEN_BRANCH, frozen);
  git(seed, 'checkout', '--quiet', '-b', 'run', frozen);
  git(seed, 'commit', '--quiet', '--allow-empty', '-m', 'what an earlier run merged');
  const stale = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'push', '--quiet', origin, `HEAD:refs/heads/${RUN_BRANCH}`);
  const clone = join(root, `${name}-clone`);
  git(root, 'clone', '--quiet', origin, clone);
  return { origin, clone, frozen, stale, main };
}

const settingsFor = (repos: BaseSettings['repos'], over: Partial<BaseSettings> = {}): BaseSettings => ({ frozen: FROZEN_BRANCH, run: RUN_BRANCH, remote: 'origin', repos, deployMs: 60_000, ...over });

test('the settings: none without PROOF_REPOS; the clones by service; the branches and the remote by default', () => {
  assert.equal(readBaseSettings({}), undefined);
  assert.deepEqual(readBaseSettings({ PROOF_REPOS: 'guestbook=/srv/proof/guestbook, filter-api=/srv/proof/filter-api' }), {
    frozen: 'proof-base', run: 'proof-run', remote: 'origin', deployMs: 600_000,
    repos: [{ service: 'guestbook', clone: '/srv/proof/guestbook' }, { service: 'filter-api', clone: '/srv/proof/filter-api' }],
  });
  assert.equal(readBaseSettings({ PROOF_REPOS: 'guestbook=/c', PROOF_RUN_BRANCH: 'proof-run-2', PROOF_BASE_BRANCH: 'frozen', PROOF_DEPLOY_MINUTES: '3' })?.run, 'proof-run-2');
  for (const bad of ['guestbook', 'guestbook=relative/path', '=/c', 'Guest Book=/c', 'guestbook=/a,guestbook=/b']) assert.throws(() => readBaseSettings({ PROOF_REPOS: bad }), BaseError, bad);
  assert.throws(() => readBaseSettings({ PROOF_REPOS: 'guestbook=/c', PROOF_REMOTE: '--upload-pack=x' }), BaseError);
  assert.throws(() => readBaseSettings({ PROOF_REPOS: 'guestbook=/c', PROOF_DEPLOY_MINUTES: '0' }), BaseError);
});

test('the guards: never main or master, never the default branch, never the frozen branch, and only the branch the workspace merges into', () => {
  const repos = [{ service: 'guestbook', clone: '/c/g' }, { service: 'filter-api', clone: '/c/f' }];
  const bases = { guestbook: 'proof-run', 'filter-api': 'proof-run' };
  const defaults = { guestbook: 'main', 'filter-api': 'main' };
  assert.equal(refusal({ frozen: 'proof-base', run: 'proof-run', repos }, bases, defaults), undefined);
  assert.match(refusal({ frozen: 'proof-base', run: 'main', repos }, { guestbook: 'main', 'filter-api': 'main' }, defaults) ?? '', /never writes main/);
  assert.match(refusal({ frozen: 'proof-base', run: 'master', repos }, bases, defaults) ?? '', /never writes main or master/);
  assert.match(refusal({ frozen: 'proof-run', run: 'proof-run', repos }, bases, defaults) ?? '', /only ever read/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos }, bases, { guestbook: 'main', 'filter-api': 'proof-run' }) ?? '', /default branch of filter-api/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos }, { guestbook: 'proof-run', 'filter-api': 'main' }, defaults) ?? '', /base of filter-api is main/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos: repos.slice(0, 1) }, bases, defaults) ?? '', /no clone is named for filter-api/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos: [...repos, { service: 'other', clone: '/c/o' }] }, bases, { ...defaults, other: 'main' }) ?? '', /other is not a service/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos: [] }, {}, {}) ?? '', /no proof repository/);
  for (const name of ['-f', 'a..b', 'x.lock', 'with space', '']) assert.match(refusal({ frozen: 'proof-base', run: name, repos }, bases, defaults) ?? '', /not a branch name/, name);
});

test('the guards fail closed (review 1 of pull request 275, followup 1): an unread default branch, a run branch not named proof-<something>', () => {
  const repos = [{ service: 'guestbook', clone: '/c/g' }, { service: 'filter-api', clone: '/c/f' }];
  const bases = { guestbook: 'proof-run', 'filter-api': 'proof-run' };
  // ls-remote --symref said no default branch: refused, whatever the run branch is.
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos }, bases, { guestbook: 'main', 'filter-api': null }) ?? '', /default branch of filter-api's repository could not be read/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos }, bases, { guestbook: 'main' }) ?? '', /default branch of filter-api's repository could not be read/);
  // A default branch named neither main nor master (v2, develop) is still never the run branch: the run branch is proof-<something>.
  for (const run of ['v2', 'develop', 'proof', 'proof-', 'run-proof', 'Proof-run']) {
    const named = { guestbook: run, 'filter-api': run };
    assert.match(refusal({ frozen: 'proof-base', run, repos }, named, { guestbook: 'trunk', 'filter-api': 'trunk' }) ?? '', /always proof-<something>/, run);
  }
  assert.equal(refusal({ frozen: 'proof-base', run: 'proof-run-2', repos }, { guestbook: 'proof-run-2', 'filter-api': 'proof-run-2' }, { guestbook: 'main', 'filter-api': 'main' }), undefined);
});

test('a workspace whose base is main or master for any service is refused, named service by service (review 1 of pull request 275, followup 2)', () => {
  const repos = [{ service: 'guestbook', clone: '/c/g' }, { service: 'filter-api', clone: '/c/f' }];
  const defaults = { guestbook: 'main', 'filter-api': 'main' };
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos }, { guestbook: 'main', 'filter-api': 'proof-run' }, defaults) ?? '', /base of guestbook is main: the proof's tickets would merge into it/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos }, { guestbook: 'master', 'filter-api': 'main' }, defaults) ?? '', /guestbook is master, filter-api is main/);
  // Even a service with no clone named: its base alone refuses the run.
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos: repos.slice(0, 1) }, { guestbook: 'proof-run', 'filter-api': 'main' }, defaults) ?? '', /base of filter-api is main/);
});

test('a real run needs PROOF_REPOS; PROOF_REPOS=none is the rehearsal\'s only (review 1 of pull request 275, followup 2)', () => {
  assert.throws(() => baseModeOf({}, false), /PROOF_REPOS is not set: a real run starts from its clean base/);
  assert.throws(() => baseModeOf({ PROOF_REPOS: '  ' }, false), /PROOF_REPOS is not set/);
  assert.throws(() => baseModeOf({ PROOF_REPOS: 'none' }, false), /none is for the rehearsal only/);
  assert.deepEqual(baseModeOf({ PROOF_REPOS: 'guestbook=/c/g,filter-api=/c/f' }, false), { kind: 'reset', settings: readBaseSettings({ PROOF_REPOS: 'guestbook=/c/g,filter-api=/c/f' }) });
  assert.throws(() => baseModeOf({ PROOF_REPOS: 'guestbook=relative' }, false), BaseError);
  // The rehearsal resets its own bare copies, unless PROOF_REPOS=none.
  assert.deepEqual(baseModeOf({}, true), { kind: 'reset', settings: undefined });
  assert.deepEqual(baseModeOf({ PROOF_REPOS: 'none' }, true), { kind: 'none' });
  assert.throws(() => baseModeOf({ PROOF_REPOS: 'guestbook=/c/g' }, true), /resets its own bare copies/);
});

test('the driver stops before anything else when a real run has no PROOF_REPOS, or PROOF_REPOS=none', () => {
  const driver = fileURLToPath(new URL('../../scripts/proof-j2-multi.ts', import.meta.url));
  for (const [repos, said] of [[undefined, /PROOF_REPOS is not set/], ['none', /none is for the rehearsal only/]] as const) {
    // Paths that do not exist: the driver must stop before it reads either.
    const missing = join(root, 'missing');
    const env: NodeJS.ProcessEnv = { ...process.env, PROOF_PLAYWRIGHT: missing, PROOF_PASSWORD_FILE: missing, PROOF_OUT: join(root, 'driver-out') };
    delete env.PROOF_REHEARSAL;
    delete env.PROOF_REPOS;
    if (repos !== undefined) env.PROOF_REPOS = repos;
    const run = spawnSync(process.execPath, ['--no-warnings', driver], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 64, run.stderr);
    assert.match(run.stderr, said);
  }
});

test('the default branch as ls-remote --symref says it', () => {
  assert.equal(defaultBranchOf(`ref: refs/heads/main\tHEAD\n${'f'.repeat(40)}\tHEAD\n`), 'main');
  assert.equal(defaultBranchOf(`${'f'.repeat(40)}\tHEAD\n`), null);
});

test('a frozen base that already holds a change of the proof\'s tickets is refused', async () => {
  const files = (map: Record<string, string>) => async (path: string) => map[path];
  assert.deepEqual(await ticketChangesIn('filter-api', files({ 'contract/openapi.yaml': 'ok: true\nwords: []\n', 'words.txt': 'scam\n' })), []);
  assert.deepEqual(await ticketChangesIn('filter-api', files({ 'contract/openapi.yaml': 'severity: none\npositions: {}\n', 'words.txt': 'scam\nCasino\n' })),
    ['contract/openapi.yaml already has severity', 'contract/openapi.yaml already has positions', 'words.txt already has casino']);
  assert.deepEqual(await ticketChangesIn('guestbook', files({ 'src/config.ts': 'export const PROOF_BREAK_HEALTH: boolean = false;\n' })), []);
  assert.deepEqual(await ticketChangesIn('guestbook', files({ 'src/config.ts': 'export const PROOF_BREAK_HEALTH: boolean = true;\n', 'src/filter.ts': 'const severity = body.severity;' })),
    ['src/config.ts already turns PROOF_BREAK_HEALTH on', 'src/filter.ts already reads severity']);
});

test('the run branch is recreated at the frozen commit; main and the frozen branch never move', async () => {
  const w = world('recreate');
  const pushes: string[][] = [];
  const run: Run = async (command, args, cwd) => { if (args[0] === 'push') pushes.push([...args]); return await runCommand(command, args, cwd); };
  const settings = settingsFor([{ service: 'filter-api', clone: w.clone }]);
  const { commits, defaults } = await frozenCommits(run, settings);
  assert.deepEqual(commits, { 'filter-api': w.frozen });
  assert.deepEqual(defaults, { 'filter-api': 'main' });
  assert.equal(await reader(run, w.clone, w.frozen)('words.txt'), 'scam\n');
  assert.equal(await reader(run, w.clone, w.frozen)('missing.txt'), undefined);
  assert.equal(git(w.origin, 'rev-parse', `refs/heads/${RUN_BRANCH}`), w.stale);
  await recreate(run, settings.repos[0] as BaseSettings['repos'][number], settings, w.frozen, defaults['filter-api'] ?? null);
  assert.equal(git(w.origin, 'rev-parse', `refs/heads/${RUN_BRANCH}`), w.frozen);
  assert.equal(git(w.origin, 'rev-parse', 'refs/heads/main'), w.main, 'main never moves');
  assert.equal(git(w.origin, 'rev-parse', `refs/heads/${FROZEN_BRANCH}`), w.frozen);
  assert.deepEqual(pushes, [['push', '--quiet', '--force', 'origin', `${w.frozen}:refs/heads/${RUN_BRANCH}`]], 'one push, to the run branch, named in full');
});

test('recreate refuses main, master, the frozen branch, the default branch, an unread default branch and a run branch not named proof-<something>, before any push', async () => {
  const w = world('refuse');
  const calls: string[][] = [];
  const run: Run = async (_command, args) => { calls.push([...args]); return ''; };
  const repo = { service: 'guestbook', clone: w.clone };
  const cases: readonly [Partial<BaseSettings>, string | null][] = [
    [{ run: 'main' }, 'trunk'], [{ run: 'master' }, 'trunk'], [{ run: 'proof-base' }, 'main'], [{ run: 'proof-run' }, 'proof-run'],
    [{ run: 'proof-run' }, null], [{ run: 'v2' }, 'trunk'], [{ run: 'develop' }, 'main'], [{ run: 'proof-' }, 'main'],
  ];
  for (const [over, fallback] of cases)
    await assert.rejects(recreate(run, repo, settingsFor([repo], over), w.frozen, fallback), BaseError, `${JSON.stringify(over)} with ${fallback}`);
  await assert.rejects(recreate(run, repo, settingsFor([repo]), 'not-a-commit', 'main'), BaseError);
  assert.deepEqual(calls, []);
  assert.equal(git(w.origin, 'rev-parse', 'refs/heads/main'), w.main);
});

test('the open pull requests into the run branch are closed, and only those', async () => {
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([{ number: 7, baseRefName: 'proof-run' }, { number: 8, baseRefName: 'main' }, { number: 9, baseRefName: 'proof-run' }]);
    return '';
  };
  assert.deepEqual(await closeStale(run, { service: 'guestbook', clone: '/c/g' }, 'proof-run'), [7, 9]);
  assert.deepEqual(calls, [
    ['gh', 'pr', 'list', '--base', 'proof-run', '--state', 'open', '--limit', '100', '--json', 'number,baseRefName'],
    ['gh', 'pr', 'close', '7'],
    ['gh', 'pr', 'close', '9'],
  ]);
});

test('two runs in a row start from the same commit: what the first run merged into the run branch is gone at the second', async () => {
  const w = world('twice');
  const settings = settingsFor([{ service: 'guestbook', clone: w.clone }]);
  const repo = settings.repos[0] as BaseSettings['repos'][number];
  const starts: string[] = [];
  for (const run of [1, 2]) {
    const { commits, defaults } = await frozenCommits(runCommand, settings);
    await recreate(runCommand, repo, settings, commits.guestbook as string, defaults.guestbook ?? null);
    starts.push(git(w.origin, 'rev-parse', `refs/heads/${RUN_BRANCH}`));
    // The run merges a ticket into the run branch, as the brokers do.
    const work = join(root, `twice-run-${run}`);
    git(root, 'clone', '--quiet', '--branch', RUN_BRANCH, w.origin, work);
    git(work, 'commit', '--quiet', '--allow-empty', '-m', `Merge pull request #${run}`);
    git(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${RUN_BRANCH}`);
  }
  assert.deepEqual(starts, [w.frozen, w.frozen]);
  assert.equal(git(w.origin, 'rev-parse', 'refs/heads/main'), w.main);
});

// The only pushes the proof's scripts make, each line as written: a test
// fails as soon as one of them pushes anything else, or names main.
const ALLOWED_PUSHES: Readonly<Record<string, readonly string[]>> = {
  // The workflow event `push` the start check reads (checksRunOn, issue 277), not a git push;
  // then the run branch, recreated at the frozen commit (guarded by recreate).
  'proof-base.ts': [
    "return events !== undefined && runsOn(events.get('push'), branch) && runsOn(events.get('pull_request'), branch);",
    "await run('git', ['push', '--quiet', '--force', settings.remote, `${commit}:refs/heads/${settings.run}`], repo.clone);",
  ],
  // The rehearsal's seeding of its temporary bare copy: the run branch an earlier run moved on.
  'proof-rehearsal-multi.ts': ["git(seed, 'push', '--quiet', p.origin, `HEAD:refs/heads/${RUN_BRANCH}`);"],
  // The rehearsals' stand-in brokers, into their temporary bare copies' base (the run branch for the multi-service proof).
  'proof-rehearsal.ts': ["await git('push', '--quiet', 'origin', base);", "await git('push', '--quiet', 'origin', base);"],
};

test('no proof script pushes to main: every push of scripts/proof-*.ts is one of the allowed lines', () => {
  const dir = new URL('../../scripts/', import.meta.url);
  const files = readdirSync(dir).filter((name) => /^proof-.*\.ts$/.test(name));
  assert.ok(files.includes('proof-j2-multi.ts') && files.includes('proof-base.ts'));
  for (const file of files) {
    const pushes = readFileSync(new URL(file, dir), 'utf8').split('\n').map((line) => line.trim()).filter((line) => /['"`]push['"`]/.test(line) && !line.startsWith('//'));
    assert.deepEqual(pushes, [...(ALLOWED_PUSHES[file] ?? [])], `${file} pushes something not allowed`);
    for (const line of pushes) assert.doesNotMatch(line, /\bmain\b|\bmaster\b/, `${file}: ${line}`);
  }
});

test('the multi-service rehearsal\'s workspace names the run branch as every service\'s base, never main', () => {
  const text = rehearsalWorkspace({ root: '/tmp/rehearsal', ports: { guestbook: 3000, 'filter-api': 3001 } });
  assert.deepEqual([...text.matchAll(/^base = (.+)$/gm)].map((m) => m[1]), [RUN_BRANCH, RUN_BRANCH]);
});

// ---- the start check: checks and watchers on the run branch (issue 277) ----------

// The proof repositories' checks workflow as recorded: the guestbook's before
// the orchestrator's decision of 2026-10-23 (main only, step 06 waited for
// nothing), and both after it (main and proof-run).
const GUESTBOOK_MAIN_ONLY = `name: checks

# The guestbook's tests against a Postgres service container, on every pull
# request to main and every push to it.
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: checks-\${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
`;
const GUESTBOOK_RUN = `name: checks

# The guestbook's tests against a Postgres service container, on every pull
# request to main or to proof-run (the multi-service proof's run branch) and
# every push to either.
on:
  push:
    branches: [main, proof-run]
  pull_request:
    branches: [main, proof-run]

concurrency:
  group: checks-\${{ github.ref }}
  cancel-in-progress: true
`;
const FILTER_API_RUN = `name: checks

# The filter API's tests and types, on every pull request to main or to
# proof-run (the multi-service proof's run branch) and every push to either. No
# service container: the filter API has no database.
on:
  push:
    branches: [main, proof-run]
  pull_request:
    branches: [main, proof-run]

concurrency:
  group: checks-\${{ github.ref }}
  cancel-in-progress: true
`;
const checks = (text: string) => [{ path: '.github/workflows/checks.yml', text }];

test('the recorded workflows: branches [main] refused, [main, proof-run] accepted (issue 277)', () => {
  assert.equal(checksRunOn(checks(GUESTBOOK_MAIN_ONLY), RUN_BRANCH), false);
  assert.equal(checksRunOn(checks(GUESTBOOK_RUN), RUN_BRANCH), true);
  assert.equal(checksRunOn(checks(FILTER_API_RUN), RUN_BRANCH), true);
  // This repository's example still runs on main only: a proof repository copied from it is refused.
  assert.equal(checksRunOn(checks(readFileSync(fileURLToPath(new URL('../../../examples/guestbook/.github/workflows/checks.yml', import.meta.url)), 'utf8')), RUN_BRANCH), false);
  assert.equal(checksRunOn([], RUN_BRANCH), false);
  assert.deepEqual(workflowTriggers(GUESTBOOK_RUN), new Map([['push', { branches: ['main', 'proof-run'] }], ['pull_request', { branches: ['main', 'proof-run'] }]]));
});

test('a workflow counts only when it surely runs on both a push and a pull request to the run branch; an unsure reading refuses', () => {
  const on = (block: string) => checksRunOn(checks(`name: checks\n${block}\njobs:\n  test:\n    runs-on: ubuntu-latest\n`), 'proof-run');
  for (const block of [
    'on: [push, pull_request]', "'on': [push, pull_request, workflow_dispatch]",
    'on:\n  push:\n  pull_request:',
    'on:\n  push:\n    branches:\n      - main\n      - "proof-run"   # the run branch\n  pull_request:\n    branches: [\'proof-run\']',
    'on:\n  push:\n    branches: [main, "proof-*"]\n  pull_request:\n    branches: ["**"]',
    'on:\n  push:\n    branches-ignore: [gh-pages]\n  pull_request:\n  workflow_dispatch:',
  ]) assert.equal(on(block), true, block);
  for (const block of [
    'on: push', 'on: [pull_request]', 'on:\n  push:\n    branches: [main, proof-run]',
    'on:\n  push:\n    branches: [main, proof-run]\n  pull_request:\n    branches: [main]',
    'on:\n  push:\n    branches: ["proof-*", "!proof-run"]\n  pull_request:',
    'on:\n  push:\n    branches-ignore: [proof-run]\n  pull_request:',
    'on:\n  push:\n    branches: [proof-run]\n    paths: [src/**]\n  pull_request:\n    branches: [proof-run]',
    'on:\n  push:\n    tags: [v*]\n  pull_request:',
    'on:\n  push: {branches: [proof-run]}\n  pull_request:',
    'on: {push: {}, pull_request: {}}', 'on:', '# on: [push, pull_request]', 'true: [push, pull_request]',
    'on:\n  push:\n    branches: []\n  pull_request:',
  ]) assert.equal(on(block), false, block);
  // One workflow that runs on both is enough.
  assert.equal(checksRunOn([...checks(GUESTBOOK_MAIN_ONLY), { path: '.github/workflows/run.yml', text: 'on: [push, pull_request]\n' }], 'proof-run'), true);
});

test('the workflows of a frozen commit are read from the clone, .yml and .yaml', async () => {
  const repo = join(root, 'workflows');
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  git(repo, 'init', '--quiet');
  writeFileSync(join(repo, '.github', 'workflows', 'checks.yml'), GUESTBOOK_RUN);
  writeFileSync(join(repo, '.github', 'workflows', 'pages.yaml'), 'on: push\n');
  writeFileSync(join(repo, '.github', 'workflows', 'notes.md'), 'not a workflow\n');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '-m', 'workflows');
  const commit = git(repo, 'rev-parse', 'HEAD');
  const read = await workflowsAt(runCommand, repo, commit);
  assert.deepEqual(read.map((w) => w.path), ['.github/workflows/checks.yml', '.github/workflows/pages.yaml']);
  assert.equal(checksRunOn(read, RUN_BRANCH), true);
  // A commit without workflows has none.
  git(repo, 'rm', '-r', '--quiet', '.github');
  git(repo, 'commit', '--quiet', '-m', 'none');
  assert.deepEqual(await workflowsAt(runCommand, repo, git(repo, 'rev-parse', 'HEAD')), []);
});

const WATCH = "export const LABELS = ['cleared.dev=v2', 'cleared.example=guestbook'] as const;\n";

test('a deploy watcher: its service from its script\'s label, its branch from --branch, main by default', async () => {
  assert.deepEqual(watcherOf(7, ['node', 'deploy/watch.ts', '--repo', '/srv/clone', '--branch', 'proof-run', '--interval', '30'], WATCH), { pid: 7, service: 'guestbook', branch: 'proof-run' });
  assert.deepEqual(watcherOf(8, ['node', '/srv/clone/deploy/watch.ts', '--repo', '/srv/clone'], WATCH.replace('guestbook', 'filter-api')), { pid: 8, service: 'filter-api', branch: 'main' });
  assert.deepEqual(watcherOf(9, ['node', 'deploy/watch.ts', '--branch', 'proof-run'], undefined), { pid: 9, service: null, branch: 'proof-run' });
  assert.equal(watcherOf(10, ['node', 'src/server.ts', '--branch', 'proof-run'], WATCH), undefined);

  // Read from a /proc of processes: arguments, working folder and script.
  const proc = join(root, 'proc');
  const clone = (name: string, label: string) => { const dir = join(root, `watch-${name}`); mkdirSync(join(dir, 'deploy'), { recursive: true }); writeFileSync(join(dir, 'deploy', 'watch.ts'), WATCH.replace('guestbook', label)); return dir; };
  const process = (pid: number, args: string[], cwd: string) => { mkdirSync(join(proc, String(pid)), { recursive: true }); writeFileSync(join(proc, String(pid), 'cmdline'), `${args.join('\0')}\0`); symlinkSync(cwd, join(proc, String(pid), 'cwd')); };
  process(101, ['node', 'deploy/watch.ts', '--repo', '.', '--branch', 'proof-run', '--interval', '30'], clone('guestbook', 'guestbook'));
  process(102, ['node', 'deploy/watch.ts', '--repo', '.'], clone('filter-api', 'filter-api'));
  process(103, ['node', 'src/server.ts'], root);
  mkdirSync(join(proc, 'self'), { recursive: true });
  const read = (await readWatchers(proc)).sort((a, b) => a.pid - b.pid);
  assert.deepEqual(read, [{ pid: 101, service: 'guestbook', branch: 'proof-run' }, { pid: 102, service: 'filter-api', branch: 'main' }]);
});

test('the watchers: each service of the run has one, and every one deploys the run branch (issue 277)', () => {
  const services = ['filter-api', 'guestbook'];
  const both: Watcher[] = [{ pid: 1, service: 'filter-api', branch: 'proof-run' }, { pid: 2, service: 'guestbook', branch: 'proof-run' }];
  assert.equal(watcherRefusal(both, services, 'proof-run'), undefined);
  // A watcher of another example, on its own branch, is not the run's.
  assert.equal(watcherRefusal([...both, { pid: 3, service: 'notes', branch: 'main' }], services, 'proof-run'), undefined);
  assert.match(watcherRefusal([both[0] as Watcher, { pid: 2, service: 'guestbook', branch: 'main' }], services, 'proof-run') ?? '', /the watcher of guestbook \(pid 2\) deploys main, not proof-run: restart it with --branch proof-run/);
  assert.match(watcherRefusal([both[0] as Watcher], services, 'proof-run') ?? '', /no deploy watcher runs for guestbook/);
  assert.match(watcherRefusal([], services, 'proof-run') ?? '', /no deploy watcher runs for filter-api, guestbook/);
  assert.match(watcherRefusal([...both, { pid: 4, service: null, branch: 'proof-run' }], services, 'proof-run') ?? '', /the service of the deploy watcher pid 4 could not be read/);
  // A refusal of the start check stops the run with code 64 (proof-j2-multi.ts), a BaseError still.
  assert.ok(new StartRefusal('x') instanceof BaseError);
});

test('the start check refuses a workspace whose service is not on the run branch, with code 64 (issue 277)', () => {
  const driver = readFileSync(fileURLToPath(new URL('../../scripts/proof-j2-multi.ts', import.meta.url)), 'utf8');
  assert.match(driver, /if \(refused\) throw new StartRefusal\(refused\);/);
  assert.match(driver, /process\.exit\(error instanceof StartRefusal \? 64 : 1\);/);
  assert.match(refusal({ frozen: FROZEN_BRANCH, run: RUN_BRANCH, repos: [{ service: 'guestbook', clone: '/c' }] }, { guestbook: 'proof-base' }, { guestbook: 'main' }) ?? '', /the workspace's base of guestbook is proof-base, not proof-run/);
});
