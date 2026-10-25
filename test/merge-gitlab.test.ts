// The lock's merge for a GitLab service (docs/v2/milestone-5-plan.md, section
// 11): a service whose agents.conf says `[forge] adapter = gitlab` goes live
// through GitLab's REST API, with the checks the GitHub path makes, in the
// same order: open, not a draft, to the base, its checks green on the head
// (a failure GitLab allows does not fail them, a manual job is not run, a
// running one waits); its branch holds the base; reviewed at this version;
// the agreement, asked for the head GitLab names (ask-validation.ts) and
// given by the user's own move; the host free (no pipeline running or
// pending, the base still for ten minutes). It merges the very commit it checked (`sha`), never
// removes the branch, and starts the health watch on GitLab's merge commit.
// gh is never called. Against a fake GitLab on loopback; merge-pr.ts and
// ask-validation.ts run as processes of their own, so the fake can answer
// while they wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openLedger } from '../lib/ledger.ts';
import { reviewedPull, type Pull } from './support.ts';
import { emptyGitLab, FakeGitLab, type GitLabStatus } from '../v2/test/forge/fakes/gitlab.ts';

const TOKEN = ['gitlab', 'credential', 'of', 'the', 'lock'].join('-');
const PROJECT = 'example/guestbook';
const TOOLING = ['ops/cleared/wake.sh', 'docs/decisions.md'];
const HOUR_AGO = () => new Date(Date.now() - 3_600_000).toISOString();

type Ran = { status: number | null; stdout: string; stderr: string };

const labs: FakeGitLab[] = [];
test.after(() => Promise.all(labs.map((lab) => lab.close())));

const success = (id = 1, name = 'test'): GitLabStatus => ({ id, name, status: 'success', target_url: null, allow_failure: false });

// A reviewed pull request (support.ts) whose lock is on GitLab: the fake's
// merge request 7 is its branch at its head, green, and the base has not
// changed for an hour. gh is replaced by a program that only says it ran.
async function onGitLab(files: string[] = TOOLING, forge: (address: string, tokenFile: string) => string = (address, file) => `[forge]\nadapter = gitlab\ngitlab_url = ${address}\ngitlab_project = ${PROJECT}\ngitlab_token_file = ${file}\n`) {
  const pull = reviewedPull(files);
  const lab = new FakeGitLab(TOKEN, {
    ...emptyGitLab(),
    projects: [{ path_with_namespace: PROJECT, http_url_to_repo: `https://gitlab.invalid/${PROJECT}.git`, default_branch: 'main', visibility: 'private', archived: false, access_level: 40 }],
    mrs: [{ project: PROJECT, iid: 7, web_url: `https://gitlab.invalid/${PROJECT}/-/merge_requests/7`, source_branch: 'feat/w', target_branch: 'main', sha: pull.headOf(), title: 'The work', description: 'b', state: 'opened', draft: false, created_at: '2026-01-01T00:00:00.000Z', notes: [], merge_commit_sha: null, merged_at: null }],
    statuses: { [pull.headOf()]: [success()] },
    commits: { [`${PROJECT}@main`]: { id: 'd'.repeat(40), committed_date: HOUR_AGO() } },
  });
  const address = await lab.listen();
  const tokenFile = join(pull.box.home, 'forge-gitlab.token');
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const conf = join(pull.box.home, 'agents.conf');
  writeFileSync(conf, `${readFileSync(conf, 'utf8')}\n${forge(address, tokenFile)}`);
  writeFileSync(join(pull.box.home, 'bin', 'gh'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(join(pull.box.home, 'gh-called'))}, process.argv.slice(2).join(' ') + '\\n');\nprocess.exit(1);\n`, { mode: 0o755 });
  // GitLab's merge, done for real on the remote: a merge commit of the branch into main.
  lab.onMerge = (_mr, sha) => {
    const work = join(pull.box.home, `merge-${Date.now()}`);
    const git = (...args: string[]) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' }).trim();
    execFileSync('git', ['clone', '-q', pull.lane.remote, work]);
    git('merge', '-q', '--no-ff', '-m', 'Merge branch feat/w into main', sha);
    git('push', '-q', 'origin', 'HEAD:main');
    return git('rev-parse', 'HEAD');
  };
  const spawned = (script: string, args: string[], input?: string): Promise<Ran> => new Promise((resolve) => {
    const child = spawn(join(pull.box.home, script), args, { env: pull.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(input ?? '');
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const run = (args: string[] = [], input?: string) => spawned('merge-pr.ts', ['7', 'X-5', ...args], input);
  const ask = (input = '**Ce qui change.** Je la mets en ligne ?') => spawned('ask-validation.ts', ['X-5', '-', '--pr', '7'], input);
  const ghCalled = () => existsSync(join(pull.box.home, 'gh-called'));
  const merges = () => lab.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/merge'));
  labs.push(lab);
  return { pull, lab, address, tokenFile, run, ask, ghCalled, merges };
}

const releases = (pull: Pull) => {
  const db = openLedger(join(pull.box.state, 'ledger.db'));
  try { return db.prepare("select name from sqlite_master where type = 'table' and name = 'releases'").get() ? db.prepare('select pr, merge_sha, status from releases').all() : []; }
  finally { db.close(); }
};
const events = (pull: Pull, kind: string) => {
  const db = openLedger(join(pull.box.state, 'ledger.db'));
  try { return db.prepare('select detail from events where kind = ?').all(kind).map((row) => String(row.detail)); }
  finally { db.close(); }
};

test('a reviewed, green merge request of tooling goes live through GitLab at the very commit checked, its branch kept, the watch on GitLab\'s merge commit, and gh never called', async () => {
  const { pull, lab, run, ghCalled, merges } = await onGitLab();
  const dry = await run(['--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual({ ...JSON.parse(dry.stdout), reviewed_commit: undefined }, { would_merge: 7, ticket: 'X-5', head: pull.headOf(), reviewed_commit: undefined, kind: 'tooling', agreement: 'none needed' });
  assert.equal(merges().length, 0, 'a dry run merges nothing');
  const done = await run();
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(merges().map((r) => r.body), [{ sha: pull.headOf(), should_remove_source_branch: false }]);
  assert.ok(lab.requests.every((r) => r.token), 'every call with the token, in its header');
  assert.deepEqual(pull.ledgerKinds(), ['merged_by_script']);
  const merged = lab.world.mrs[0]?.merge_commit_sha;
  assert.match(String(merged), /^[0-9a-f]{40}$/);
  assert.deepEqual(releases(pull).map((row) => [row.pr, row.merge_sha]), [[7, merged]], 'the health watch starts on the merge commit GitLab names');
  assert.deepEqual(events(pull, 'release_watch_failed'), []);
  assert.equal(ghCalled(), false, 'a GitLab service never reaches gh');
  assert.ok(!`${done.stdout}${done.stderr}${dry.stdout}${dry.stderr}`.includes(TOKEN), 'the token is never printed');
});

test('what GitLab says of the merge request comes first: closed, a draft or to another branch is refused for good, with the reason', async () => {
  const { lab, run, merges } = await onGitLab();
  const mr = lab.world.mrs[0]!;
  mr.state = 'closed';
  assert.match((await run(['--dry-run'])).stderr, /#7 is not put live: it is not open/);
  mr.state = 'opened';
  mr.draft = true;
  const draft = await run(['--dry-run']);
  assert.equal(draft.status, 6);
  assert.match(draft.stderr, /it is a draft/);
  mr.draft = false;
  mr.target_branch = 'release';
  assert.match((await run(['--dry-run'])).stderr, /it does not go to main/);
  assert.equal(merges().length, 0);
});

test('its checks on the head: running waits in the queue, a failure is refused, only skipped or manual jobs is no check, a failure GitLab allows beside a success goes', async () => {
  const { pull, lab, run } = await onGitLab();
  const head = pull.headOf();
  const at = (statuses: Partial<GitLabStatus>[]) => { lab.world.statuses[head] = statuses.map((s, i) => ({ ...success(i + 1, `job ${i + 1}`), ...s })); };
  at([{}, { status: 'running' }]);
  const running = await run(['--dry-run']);
  assert.equal(running.status, 3, running.stderr);
  assert.match(running.stdout, /its checks still run/);
  at([{}, { status: 'failed' }]);
  const failed = await run(['--dry-run']);
  assert.equal(failed.status, 6);
  assert.match(failed.stderr, /a check is not green/);
  at([{ status: 'skipped' }, { status: 'manual' }]);
  assert.match((await run(['--dry-run'])).stderr, /no check ran on it/);
  lab.world.statuses[head] = [];
  assert.match((await run(['--dry-run'])).stderr, /no check ran on it/, 'no pipeline on this head');
  at([{}, { status: 'failed', allow_failure: true }]);
  assert.equal((await run(['--dry-run'])).status, 0);
  assert.ok(lab.requests.some((r) => r.path === `/api/v4/projects/example%2Fguestbook/repository/commits/${head}/statuses`), 'the statuses of the head itself, never of an older commit');
});

test('a head GitLab names that is not the branch\'s waits; so does a busy host: a pipeline running or pending, the base changed minutes ago', async () => {
  const { pull, lab, run, merges } = await onGitLab();
  lab.world.mrs[0]!.sha = 'e'.repeat(40);
  lab.world.statuses['e'.repeat(40)] = [success()];
  const moved = await run(['--dry-run']);
  assert.equal(moved.status, 3);
  assert.match(moved.stdout, /its branch moved while it was read/);
  lab.world.mrs[0]!.sha = pull.headOf();
  for (const status of ['running', 'pending']) {
    lab.world.pipelines = [{ project: PROJECT, status }];
    const busy = await run(['--dry-run']);
    assert.equal(busy.status, 3, status);
    assert.match(busy.stdout, /the host is not free for a merge/);
  }
  lab.world.pipelines = [];
  lab.world.commits[`${PROJECT}@main`] = { id: 'd'.repeat(40), committed_date: new Date(Date.now() - 120_000).toISOString() };
  assert.equal((await run(['--dry-run'])).status, 3, 'a deployment may be settling');
  assert.equal(merges().length, 0);
});

test('GitLab silent is "not now", never a refusal; a refusal of its own is said; a merge GitLab refuses records nothing as merged', async () => {
  const { pull, lab, run } = await onGitLab();
  lab.status = 503;
  const down = await run(['--dry-run']);
  assert.equal(down.status, 3, down.stderr);
  assert.match(down.stdout, /GitLab does not answer/);
  lab.status = 401;
  const refused = await run(['--dry-run']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /merge request !7 could not be read: GitLab answered 401/);
  lab.status = undefined;
  lab.onMerge = () => undefined;
  const failed = await run();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /GitLab did not merge !7/);
  assert.deepEqual(pull.ledgerKinds(), [], 'nothing recorded as merged');
});

test('the lock\'s GitLab settings are checked before anything is read: an address in clear off loopback, a token file others can read or not absolute, no project', async () => {
  const cases: [string, (address: string, file: string) => string, RegExp][] = [
    ['clear', (_a, file) => `[forge]\nadapter = gitlab\ngitlab_url = http://gitlab.example.org\ngitlab_project = ${PROJECT}\ngitlab_token_file = ${file}\n`, /gitlab_url/],
    ['relative', (address) => `[forge]\nadapter = gitlab\ngitlab_url = ${address}\ngitlab_project = ${PROJECT}\ngitlab_token_file = forge-gitlab.token\n`, /gitlab_token_file must be an absolute path/],
    ['no project', (address, file) => `[forge]\nadapter = gitlab\ngitlab_url = ${address}\ngitlab_token_file = ${file}\n`, /gitlab_project/],
    ['app keys', (address, file) => `[forge]\nadapter = gitlab\ngitlab_url = ${address}\ngitlab_project = ${PROJECT}\ngitlab_token_file = ${file}\napp_id = 1\n`, /GitHub App/],
  ];
  for (const [name, forge, reason] of cases) {
    const { lab, run } = await onGitLab(TOOLING, forge);
    const ran = await run(['--dry-run']);
    assert.notEqual(ran.status, 0, name);
    assert.match(ran.stderr, reason, name);
    assert.equal(lab.requests.length, 0, `${name}: nothing asked of GitLab`);
  }
  const { lab, run, tokenFile } = await onGitLab();
  chmodSync(tokenFile, 0o644);
  const open = await run(['--dry-run']);
  assert.notEqual(open.status, 0);
  assert.match(open.stderr, /600/);
  assert.equal(lab.requests.length, 0);
});

test('what the user of the app sees goes live on GitLab only on his own move, for the version GitLab named when he was asked', async () => {
  const { pull, lab, run, ask, ghCalled, merges } = await onGitLab(['server/core.mjs', 'frontend/pages/Today.jsx']);
  const live = (input = 'Annonce.') => run(['-'], input);
  const none = await live();
  assert.equal(none.status, 6);
  assert.match(none.stderr, /the user has not agreed/);
  // Asked: the version is the head GitLab names, kept in the record merge-pr.ts reads.
  writeFileSync(join(pull.box.home, 'tracker-moved'), '5');
  const asked = await ask();
  assert.equal(asked.status, 0, asked.stderr);
  assert.ok(lab.requests.some((r) => r.method === 'GET' && r.path === '/api/v4/projects/example%2Fguestbook/merge_requests/7'));
  assert.deepEqual(JSON.parse(readFileSync(join(pull.box.state, 'validations', 'X-5.json'), 'utf8')).pulls, [{ pr: 7, head: pull.headOf() }]);
  // Put in his status by him: it goes, at that version, and the ticket is closed.
  writeFileSync(join(pull.box.home, 'tracker-moved'), '0');
  const done = await live('**Mise en ligne** : ce qui change, où le voir, comment vérifier.');
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(merges().map((r) => r.body), [{ sha: pull.headOf(), should_remove_source_branch: false }]);
  assert.deepEqual(pull.ledgerKinds(), ['merged_by_script']);
  assert.deepEqual(pull.moves().slice(-1), ['X-5 -> Done']);
  assert.equal(ghCalled(), false, 'neither the ask nor the go-live reached gh');
});

test('a version on GitLab that is not the one he was shown is refused, and the ticket goes back to him', async () => {
  const { pull, run, merges } = await onGitLab(['server/core.mjs']);
  const before = pull.git('rev-parse', 'HEAD~1').trim();
  mkdirSync(join(pull.box.state, 'validations'), { recursive: true });
  writeFileSync(join(pull.box.state, 'validations', 'X-5.json'), JSON.stringify({ ticket: 'X-5', at: '2026-01-02T10:00:00Z', pulls: [{ pr: 7, head: before }] }));
  writeFileSync(join(pull.box.home, 'tracker-moved'), '0');
  const stale = await run(['-'], 'Annonce.');
  assert.equal(stale.status, 6);
  assert.match(stale.stderr, /is not the version he was shown/);
  assert.deepEqual(pull.moves(), ['X-5 -> À valider']);
  assert.deepEqual(pull.ledgerKinds(), ['merge_refused']);
  assert.equal(merges().length, 0);
});
