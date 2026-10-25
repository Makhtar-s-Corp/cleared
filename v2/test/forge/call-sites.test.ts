// The four places that called gh now call the forge (milestone 5 plan,
// section 6): publish, the flow's effects, the Close of a pull request and
// the approval's head. Each one takes the forge it is given, or the one its
// service names; with GitHub, the gh calls are the ones of before (their
// own tests, under test/workspace and test/flow, are unchanged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { headOnForge } from '../../src/approval/service.ts';
import { realEffects } from '../../src/flow/effects.ts';
import { closePullRequest } from '../../src/flow/pr-close.ts';
import { publish } from '../../src/workspace/publish.ts';
import { projectCheckout, ticketCheckout } from '../../src/workspace/checkout.ts';
import type { ServiceConfig } from '../../src/workspace/config.ts';
import { CONFIG } from '../flow/support.ts';
import { commit, gitIn, remote, tempDir } from '../workspace/git.ts';
import { seed } from './contract-cases.ts';
import { COMMIT, FakeForge, pullUrl, type WorldPull } from './fake.ts';
import { fakeGh } from './fake-gh.ts';

const REPO = 'example/guestbook';
const BRANCH = 'cleared/DEMO-7';
const pull = (over: Partial<WorldPull> & { number: number }): WorldPull => ({
  repo: REPO, url: pullUrl(REPO, over.number), base: 'main', head: BRANCH, headCommit: COMMIT,
  title: 'T', body: 'B', state: 'open', checks: [], comments: [], ...over,
});

test('the Close of a pull request goes through the forge it is given', async () => {
  const forge = new FakeForge(seed([pull({ number: 4 })]));
  const outcome = await closePullRequest({ pr: 4, repo: REPO, dir: '/nowhere', base: 'main', branches: [BRANCH], reason: 'Not needed.', env: {}, forge });
  assert.equal(outcome, 'closed');
  assert.equal(forge.world.pulls[0]?.state, 'closed');
  assert.deepEqual(forge.world.pulls[0]?.comments, [`Closed from Cleared: Not needed.\n\nThe branch ${BRANCH} is kept.`]);
  assert.equal(await closePullRequest({ pr: 4, repo: REPO, dir: '/nowhere', base: 'main', branches: [BRANCH], reason: 'Again.', env: {}, forge }), 'already_closed');
});

test('publish opens the pull request through the forge it is given, and reuses the open one', async () => {
  const root = tempDir('forge-publish');
  const url = remote({ 'src/app.ts': 'export const order = "oldest";\n' });
  const project = await projectCheckout({ url, dir: join(root, 'project'), base: 'main' });
  const workdir = join(root, 'w');
  await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: BRANCH });
  const head = commit(workdir, { 'src/app.ts': 'export const order = "newest";\n' }, 'Show the newest entry first');
  const forge = new FakeForge(seed());
  const input = { project: project.dir, workdir, base: 'main', branch: BRANCH, repo: REPO, ticket: 'DEMO-7', gitEnv: process.env, ghEnv: { PATH: '/nowhere' }, forge };
  const first = await publish(input);
  assert.deepEqual(first, { url: pullUrl(REPO, 1), number: 1, head, created: true });
  assert.equal(gitIn(url, ['rev-parse', `refs/heads/${BRANCH}`]), head);
  const opened = forge.world.pulls[0];
  assert.equal(opened?.title, 'Show the newest entry first');
  assert.equal(opened?.base, 'main');
  assert.match(opened?.body ?? '', /- Show the newest entry first/);
  const second = await publish(input);
  assert.deepEqual(second, { url: pullUrl(REPO, 1), number: 1, head, created: false });
  assert.equal(forge.world.pulls.length, 1);
});

test('the flow\'s effects read the checks, the failures and close through the forge of the service, in its checkout', async () => {
  const gh = fakeGh(seed([pull({ number: 7, checks: [{ name: 'test', bucket: 'fail', url: null }] })]));
  const env: NodeJS.ProcessEnv = { ...gh.env, CLEARED_STATE_DIR: join(gh.root, 'state') };
  for (const name of ['CLEARED_CONF', 'ORCH_CONF', 'ORCH_LEDGER', 'ORCH_STATE_DIR']) delete env[name];
  const service: ServiceConfig = {
    name: 'guestbook', kind: 'repository', repo: REPO, url: 'https://example.invalid/guestbook.git', base: 'main', path: null, dir: gh.root,
    healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, forge: 'github',
  };
  const flow = realEffects({ ...CONFIG, projectDir: '/nowhere' }, { env });
  assert.equal(await flow.prChecks(7, service), 'failed');
  assert.deepEqual(await flow.ciFailures?.({ pr: 7, service }), { head: COMMIT, checks: [{ name: 'test', url: null, log: null }] });
  assert.equal(await flow.closePullRequest?.({ pr: 7, branches: [BRANCH], reason: 'Done.', service }), 'closed');
  const calls = gh.calls();
  assert.deepEqual(calls.map((c) => c.args.slice(0, 2)), [['pr', 'checks'], ['pr', 'view'], ['pr', 'view'], ['pr', 'close']]);
  assert.ok(calls.every((c) => c.cwd === gh.root && c.args.includes(REPO)), 'in the service\'s checkout, on its repository');
});

test('the approval reads a pull request\'s head in the project\'s checkout, and nothing when it cannot', async () => {
  const gh = fakeGh(seed([pull({ number: 7, headCommit: 'a'.repeat(40) })]));
  const path = process.env.PATH;
  process.env.PATH = gh.env.PATH;
  try {
    assert.equal(await headOnForge(gh.root)(7), 'a'.repeat(40));
    assert.equal(await headOnForge(gh.root)(8), undefined, 'a pull request gh cannot read');
    assert.equal(await headOnForge(undefined)(7), undefined, 'no project');
  } finally {
    process.env.PATH = path;
  }
  assert.deepEqual(gh.calls().map((c) => [c.args, c.cwd]), [
    [['pr', 'view', '7', '--json', 'headRefOid'], gh.root],
    [['pr', 'view', '8', '--json', 'headRefOid'], gh.root],
  ]);
});
