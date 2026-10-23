// The clean base of the multi-service proof (scripts/proof-base.ts): the
// settings, the guards that keep a run off main, the check of the frozen
// commit, and the run branch recreated in temporary bare repositories,
// never a real remote.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BaseError, FROZEN_BRANCH, RUN_BRANCH, closeStale, defaultBranchOf, frozenCommits, readBaseSettings, reader, recreate, refusal, runCommand, ticketChangesIn, type BaseSettings, type Run,
} from '../../scripts/proof-base.ts';

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
  assert.equal(refusal({ frozen: 'proof-base', run: 'proof-run', repos }, bases, { guestbook: 'main', 'filter-api': 'main' }), undefined);
  assert.match(refusal({ frozen: 'proof-base', run: 'main', repos }, { guestbook: 'main', 'filter-api': 'main' }) ?? '', /never writes main/);
  assert.match(refusal({ frozen: 'proof-base', run: 'master', repos }, bases) ?? '', /never writes main or master/);
  assert.match(refusal({ frozen: 'proof-run', run: 'proof-run', repos }, bases) ?? '', /only ever read/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos }, bases, { 'filter-api': 'proof-run' }) ?? '', /default branch of filter-api/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos }, { guestbook: 'proof-run', 'filter-api': 'main' }) ?? '', /base of filter-api is main/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos: repos.slice(0, 1) }, bases) ?? '', /no clone is named for filter-api/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos: [...repos, { service: 'other', clone: '/c/o' }] }, bases) ?? '', /other is not a service/);
  assert.match(refusal({ frozen: 'proof-base', run: 'proof-run', repos: [] }, {}) ?? '', /no proof repository/);
  for (const name of ['-f', 'a..b', 'x.lock', 'with space', '']) assert.match(refusal({ frozen: 'proof-base', run: name, repos }, bases) ?? '', /not a branch name/, name);
});

test('the default branch as ls-remote --symref says it', () => {
  assert.equal(defaultBranchOf('ref: refs/heads/main\tHEAD\n0123456789abcdef0123456789abcdef01234567\tHEAD\n'), 'main');
  assert.equal(defaultBranchOf('0123456789abcdef0123456789abcdef01234567\tHEAD\n'), null);
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

test('recreate refuses main, master, the frozen branch and the default branch before any push', async () => {
  const w = world('refuse');
  const calls: string[][] = [];
  const run: Run = async (_command, args) => { calls.push([...args]); return ''; };
  const repo = { service: 'guestbook', clone: w.clone };
  for (const [over, fallback] of [[{ run: 'main' }, 'trunk'], [{ run: 'master' }, 'trunk'], [{ run: 'proof-base' }, 'main'], [{ run: 'trunk' }, 'trunk']] as const)
    await assert.rejects(recreate(run, repo, settingsFor([repo], over), w.frozen, fallback), BaseError, JSON.stringify(over));
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
