// The forge contract's cases (milestone 5 plan, decision 10, section 6): what
// Cleared asks of a forge, run on any adapter from a seeded world. `make`
// gives the forge to test and a way to read the world after the calls. The
// in-memory fake, the GitHub adapter and the GitLab adapter (section 11) run
// them (contract.test.ts), each over its own fake of the forge.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Forge } from '../../src/forge/contract.ts';
import { COMMIT, pullUrl, type World, type WorldPull } from './fake.ts';

export type MakeForge = (world: World) => { readonly forge: Forge; readonly world: () => World };

const REPO = 'example/guestbook';
const OTHER = 'example/filter-api';
const BRANCH = 'cleared/DEMO-7';
const JOB = (n: number) => `https://github.com/${REPO}/actions/runs/1/job/${n}`;

const pull = (over: Partial<WorldPull> & { number: number }): WorldPull => ({
  repo: REPO, url: pullUrl(over.repo ?? REPO, over.number), base: 'main', head: BRANCH, headCommit: COMMIT,
  title: 'Newest entry first', body: 'The body.', state: 'open', checks: [], comments: [], ...over,
});

export function seed(pulls: WorldPull[] = []): World {
  return {
    repositories: [
      { repo: REPO, url: `https://github.com/${REPO}.git`, base: 'main', private: false, archived: false },
      { repo: 'example/archive', url: 'https://github.com/example/archive.git', base: 'master', private: true, archived: true },
      { repo: OTHER, url: `https://github.com/${OTHER}.git`, base: 'trunk', private: true, archived: false },
    ],
    pulls,
  };
}

export function forgeContractCases(name: string, make: MakeForge): void {
  const at = (pulls: WorldPull[] = []) => make(seed(pulls));

  test(`${name}: lists the repositories the credential reaches, by name, with their clone address, base, and whether private or archived`, async () => {
    const { forge } = at();
    assert.deepEqual(await forge.listRepositories(), [
      { repo: 'example/archive', url: 'https://github.com/example/archive.git', base: 'master', private: true, archived: true },
      { repo: OTHER, url: `https://github.com/${OTHER}.git`, base: 'trunk', private: true, archived: false },
      { repo: REPO, url: `https://github.com/${REPO}.git`, base: 'main', private: false, archived: false },
    ]);
  });

  test(`${name}: reads one repository; one it cannot read is an error`, async () => {
    const { forge } = at();
    assert.deepEqual(await forge.repository(OTHER), { repo: OTHER, url: `https://github.com/${OTHER}.git`, base: 'trunk', private: true, archived: false });
    await assert.rejects(forge.repository('example/missing'));
  });

  test(`${name}: finds the open pull request of a branch, and none when the branch has only a closed one`, async () => {
    const { forge } = at([pull({ number: 3, state: 'closed' }), pull({ number: 4, head: 'cleared/DEMO-8' }), pull({ number: 5, repo: OTHER })]);
    assert.equal(await forge.openPullRequestOf(REPO, BRANCH), undefined);
    assert.deepEqual(await forge.openPullRequestOf(REPO, 'cleared/DEMO-8'), { number: 4, url: pullUrl(REPO, 4) });
    assert.deepEqual(await forge.openPullRequestOf(OTHER, BRANCH), { number: 5, url: pullUrl(OTHER, 5) });
  });

  test(`${name}: opens a pull request with its title and body, which is then the branch's open one`, async () => {
    const { forge, world } = at([pull({ number: 1, state: 'merged', head: 'cleared/DEMO-1' })]);
    const body = 'First line.\n\n--delete-branch is text, not a flag.\n';
    const opened = await forge.createPullRequest({ repo: REPO, base: 'main', head: BRANCH, title: 'Newest entry first', body });
    assert.equal(opened.number, 2);
    assert.equal(opened.url, pullUrl(REPO, 2));
    assert.deepEqual(await forge.openPullRequestOf(REPO, BRANCH), opened);
    const made = world().pulls.find((p) => p.number === 2);
    assert.equal(made?.title, 'Newest entry first');
    assert.equal(made?.base, 'main');
    assert.equal(made?.body, body);
    assert.deepEqual(await forge.pullRequest(REPO, 2), { state: 'open', head: BRANCH });
  });

  test(`${name}: reads and replaces a pull request's body`, async () => {
    const { forge, world } = at([pull({ number: 7, body: 'Old receipt.' })]);
    assert.equal(await forge.pullRequestBody(REPO, 7), 'Old receipt.');
    await forge.editPullRequestBody(REPO, 7, 'New receipt.\n');
    assert.equal(world().pulls[0]?.body, 'New receipt.\n');
    assert.equal(await forge.pullRequestBody(REPO, 7), 'New receipt.\n');
  });

  test(`${name}: says a pull request's state and branch, open, closed or merged`, async () => {
    const { forge } = at([pull({ number: 1 }), pull({ number: 2, state: 'closed', head: 'b2' }), pull({ number: 3, state: 'merged', head: 'b3' })]);
    assert.deepEqual(await forge.pullRequest(REPO, 1), { state: 'open', head: BRANCH });
    assert.deepEqual(await forge.pullRequest(REPO, 2), { state: 'closed', head: 'b2' });
    assert.deepEqual(await forge.pullRequest(REPO, 3), { state: 'merged', head: 'b3' });
    await assert.rejects(forge.pullRequest(REPO, 99));
  });

  test(`${name}: reads the commit a pull request's head is on`, async () => {
    const { forge } = at([pull({ number: 9, headCommit: 'a'.repeat(40) })]);
    assert.equal(await forge.headCommit(REPO, 9), 'a'.repeat(40));
  });

  test(`${name}: sums up the checks: pending with none or one running, failed with one failed or cancelled, else passed`, async () => {
    const check = (bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel', n = 1) => ({ name: `check ${n}`, bucket, url: null });
    // Checks belong to a commit: each pull request is on a head of its own.
    const head = (n: number) => String(n).repeat(40);
    const { forge } = at([
      pull({ number: 1, headCommit: head(1) }),
      pull({ number: 2, headCommit: head(2), checks: [check('pass'), check('skipping', 2)] }),
      pull({ number: 3, headCommit: head(3), checks: [check('pass'), check('pending', 2)] }),
      pull({ number: 4, headCommit: head(4), checks: [check('pending'), check('fail', 2)] }),
      pull({ number: 5, headCommit: head(5), checks: [check('cancel')] }),
    ]);
    assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map((n) => forge.checks(REPO, n))), ['pending', 'passed', 'pending', 'failed', 'failed']);
  });

  test(`${name}: names the failed checks on the head, with the end of each one's log when it can be read`, async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n');
    const { forge } = at([pull({
      number: 6, headCommit: 'b'.repeat(40), checks: [
        { name: 'build', bucket: 'pass', url: JOB(1), log: 'fine' },
        { name: 'test', bucket: 'fail', url: JOB(2), log: lines },
        { name: 'lint', bucket: 'cancel', url: JOB(3) },
        { name: 'external', bucket: 'fail', url: null },
      ],
    })]);
    const failures = await forge.failedChecks(REPO, 6);
    assert.equal(failures.head, 'b'.repeat(40));
    assert.deepEqual(failures.checks.map((c) => [c.name, c.url]), [['test', JOB(2)], ['lint', JOB(3)], ['external', null]]);
    const log = failures.checks[0]?.log ?? '';
    assert.ok(log.endsWith('line 80'), 'the end of the log');
    assert.equal(log.includes('line 20\n'), false, 'cut to its end');
    assert.equal(failures.checks[1]?.log, null, 'a log that cannot be read is left out, the check stays');
    assert.equal(failures.checks[2]?.log, null);
  });

  test(`${name}: closes a pull request with a comment, which reaches the forge as text`, async () => {
    const { forge, world } = at([pull({ number: 12 }), pull({ number: 13, head: 'other' })]);
    const comment = 'Closed from Cleared: --delete-branch; rm -rf $HOME `x` "quoted"\n\nThe branch cleared/DEMO-7 is kept.';
    await forge.closePullRequest(REPO, 12, comment);
    const after = world().pulls;
    assert.equal(after[0]?.state, 'closed');
    assert.deepEqual(after[0]?.comments, [comment]);
    assert.equal(after[1]?.state, 'open', 'only that pull request');
    assert.deepEqual(await forge.pullRequest(REPO, 12), { state: 'closed', head: BRANCH });
  });
}
