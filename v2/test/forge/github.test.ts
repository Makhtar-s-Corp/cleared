// The GitHub adapter (milestone 5 plan, section 6): the same gh calls the
// service made before the forge was a contract, each one's command line, its
// folder and its environment pinned here, so that moving the calls behind the
// adapter changed nothing GitHub sees. gh is a fake on PATH (fake-gh.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { ForgeError, type Forge } from '../../src/forge/contract.ts';
import { GitHubForge } from '../../src/forge/github.ts';
import { forgeFor, forgeKindOf } from '../../src/forge/index.ts';
import { seed } from './contract-cases.ts';
import { COMMIT, pullUrl, type WorldPull } from './fake.ts';
import { fakeGh } from './fake-gh.ts';

const REPO = 'example/guestbook';
const BRANCH = 'cleared/DEMO-7';
const JOB = (n: number) => `https://github.com/${REPO}/actions/runs/1/job/${n}`;
const PROJECTION = '{repo: .full_name, url: .clone_url, base: .default_branch, private: .private, archived: .archived} | tojson';

const pull = (over: Partial<WorldPull> & { number: number }): WorldPull => ({
  repo: REPO, url: pullUrl(REPO, over.number), base: 'main', head: BRANCH, headCommit: COMMIT,
  title: 'T', body: 'B', state: 'open', checks: [], comments: [], ...over,
});

function setup(pulls: WorldPull[] = [], options: { fail?: string; token?: string } = {}) {
  const gh = fakeGh(seed(pulls), options.fail ? { fail: options.fail } : {});
  const env = options.token ? { ...gh.env, GH_TOKEN: options.token } : gh.env;
  return { gh, forge: new GitHubForge({ dir: gh.root, env }) };
}

test('each call is the gh command the service ran before, in the folder it is given', async () => {
  const { gh, forge } = setup([pull({ number: 7, checks: [{ name: 'test', bucket: 'fail', url: JOB(2), log: 'boom' }] })]);
  await forge.listRepositories();
  await forge.repository(REPO);
  await forge.openPullRequestOf(REPO, BRANCH);
  await forge.pullRequestBody(REPO, 7);
  await forge.editPullRequestBody(REPO, 7, 'new');
  await forge.pullRequest(REPO, 7);
  await forge.headCommit(REPO, 7);
  await forge.headCommit(undefined, 7);
  await forge.checks(REPO, 7);
  await forge.failedChecks(REPO, 7);
  await forge.createPullRequest({ repo: REPO, base: 'main', head: 'cleared/DEMO-8', title: 'Newest entry first', body: 'body' });
  await forge.closePullRequest(REPO, 7, 'Closed from Cleared: done.');
  const calls = gh.calls();
  const bodyFile = (i: number) => calls[i]?.args[calls[i]!.args.indexOf('--body-file') + 1] ?? '';
  assert.deepEqual(calls.map((c) => c.args), [
    ['api', '--paginate', '--jq', `.[] | ${PROJECTION}`, 'user/repos?per_page=100'],
    ['api', `repos/${REPO}`],
    ['pr', 'list', '--repo', REPO, '--head', BRANCH, '--state', 'open', '--json', 'number,url'],
    ['pr', 'view', '7', '--repo', REPO, '--json', 'body'],
    ['pr', 'edit', '7', '--repo', REPO, '--body-file', bodyFile(4)],
    ['pr', 'view', '7', '--repo', REPO, '--json', 'state,headRefName'],
    ['pr', 'view', '7', '--repo', REPO, '--json', 'headRefOid'],
    ['pr', 'view', '7', '--json', 'headRefOid'],
    ['pr', 'checks', '7', '--repo', REPO, '--json', 'bucket'],
    ['pr', 'view', '7', '--json', 'headRefOid,statusCheckRollup', '--repo', REPO],
    ['run', 'view', '--job', '2', '--log-failed', '--repo', REPO],
    ['pr', 'create', '--repo', REPO, '--base', 'main', '--head', 'cleared/DEMO-8', '--title', 'Newest entry first', '--body-file', bodyFile(11)],
    ['pr', 'close', '7', '--repo', REPO, '--comment', 'Closed from Cleared: done.'],
  ]);
  assert.ok(calls.every((c) => c.cwd === gh.root), 'gh runs in the folder the forge is given');
  assert.equal(calls[4]?.body, 'new');
  assert.equal(calls[11]?.body, 'body');
  assert.equal(existsSync(bodyFile(4)) || existsSync(bodyFile(11)), false, 'a body file is removed after the call');
});

test('an installation token lists the installation\'s repositories, any other credential the account\'s', async () => {
  // Token-shaped words built from parts, so that the guard does not read a secret here.
  const app = setup([], { token: ['gh', 's_', 'x'.repeat(36)].join('') });
  assert.equal((await app.forge.listRepositories()).length, 3);
  assert.deepEqual(app.gh.calls()[0]?.args, ['api', '--paginate', '--jq', `.repositories[] | ${PROJECTION}`, 'installation/repositories?per_page=100']);
  assert.equal(app.gh.calls()[0]?.token, true, 'the environment it is given reaches gh');
  const user = setup([], { token: ['gh', 'p_', 'y'.repeat(36)].join('') });
  await user.forge.listRepositories();
  assert.equal(user.gh.calls()[0]?.args.at(-1), 'user/repos?per_page=100');
});

test('a repository that is not owner/name, or a pull request that is not a number, never reaches gh', async () => {
  const { gh, forge } = setup([pull({ number: 7 })]);
  for (const repo of ['--repo', 'example', 'example/guestbook;rm', 'a/b/c', ''])
    await assert.rejects(forge.pullRequest(repo, 7), ForgeError, repo);
  await assert.rejects(forge.repository('../x'), ForgeError);
  for (const pr of [0, -1, 1.5, Number.NaN]) await assert.rejects(forge.checks(REPO, pr), ForgeError, String(pr));
  assert.deepEqual(gh.calls(), []);
});

test('a gh that fails is a ForgeError that names the call and ends with what gh said', async () => {
  const { forge } = setup([pull({ number: 7 })], { fail: 'pr close' });
  await assert.rejects(forge.closePullRequest(REPO, 7, 'x'), (error: unknown) =>
    error instanceof ForgeError && /^gh pr close failed: HTTP 502: the forge is down$/.test(error.message));
  const api = setup([], { fail: 'api' });
  await assert.rejects(api.forge.listRepositories(), /gh api failed: HTTP 502/);
});

test('a pending check makes gh exit 8, and its list is read all the same; another exit is an error', async () => {
  const { forge } = setup([pull({ number: 7, checks: [{ name: 'test', bucket: 'pending', url: null }] })]);
  assert.equal(await forge.checks(REPO, 7), 'pending');
  const failing = setup([pull({ number: 7 })], { fail: 'pr checks' });
  await assert.rejects(failing.forge.checks(REPO, 7), /gh pr checks failed/);
});

test('an answer of a shape the adapter does not know is an error, never read as nothing', async () => {
  const { forge } = setup([pull({ number: 7, state: 'weird' as never })]);
  await assert.rejects(forge.pullRequest(REPO, 7), /unknown state/);
  const missing = setup();
  await assert.rejects(missing.forge.pullRequest(REPO, 7), ForgeError);
});

test('the logs of the first five failed checks are read; the others keep their name, with no log', async () => {
  const checks = Array.from({ length: 7 }, (_, i) => ({ name: `check ${i + 1}`, bucket: 'fail' as const, url: JOB(i + 1), log: `log ${i + 1}` }));
  const { gh, forge } = setup([pull({ number: 7, checks })]);
  const failures = await forge.failedChecks(REPO, 7);
  assert.deepEqual(failures.checks.map((c) => c.log), ['log 1', 'log 2', 'log 3', 'log 4', 'log 5', null, null]);
  assert.equal(gh.calls().filter((c) => c.args[0] === 'run').length, 5);
});

test('the list of repositories stops at 1000', async () => {
  const world = seed();
  world.repositories = Array.from({ length: 1005 }, (_, i) => ({ repo: `example/r${String(i).padStart(4, '0')}`, url: `https://github.com/example/r${i}.git`, base: 'main', private: false, archived: false }));
  const gh = fakeGh(world);
  const listed = await new GitHubForge({ dir: gh.root, env: gh.env }).listRepositories();
  assert.equal(listed.length, 1000);
  assert.equal(listed[0]?.repo, 'example/r0000');
});

test('a service names its forge, GitHub by default', () => {
  const at = { dir: '/nowhere', env: {} };
  assert.equal(forgeKindOf(undefined), 'github');
  assert.equal(forgeKindOf({ forge: 'github' }), 'github');
  assert.equal(forgeKindOf({}), 'github');
  const forge: Forge = forgeFor('github', at);
  assert.ok(forge instanceof GitHubForge);
  assert.equal(forge.kind, 'github');
  assert.throws(() => forgeFor('gitlab' as never, at), ForgeError);
});
