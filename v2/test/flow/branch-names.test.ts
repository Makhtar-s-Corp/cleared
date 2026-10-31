// A ticket never takes a branch that is already on the remote and that it did
// not create (issues #508 and #510): the name is chosen once, at the ticket's
// first start, from what the remote holds, and kept in the ledger, so a repair
// round or a restart finds the same name and the same pull request. Nothing is
// ever forced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BranchNames, freeBranch } from '../../src/flow/branch-names.ts';
import { realEffects } from '../../src/flow/effects.ts';
import type { FlowEffects } from '../../src/flow/engine.ts';
import { publish } from '../../src/workspace/publish.ts';
import { commit, gitIn, remote, tempDir } from '../workspace/git.ts';
import { CONFIG, REPORT_FIX, REPORT_PASS, quickAuthor, reopenScript, reviewerScript, setup, until } from './support.ts';

test('the first free name: the ticket\'s own, else a number after a dot, past a folder of the same name', () => {
  assert.equal(freeBranch('LOCAL-5', []), 'cleared/LOCAL-5');
  assert.equal(freeBranch('LOCAL-5', ['cleared/LOCAL-55', 'cleared/LOCAL-5-2']), 'cleared/LOCAL-5', 'another ticket\'s branch is not this one');
  assert.equal(freeBranch('LOCAL-5', ['cleared/LOCAL-5']), 'cleared/LOCAL-5.2');
  assert.equal(freeBranch('LOCAL-5', ['cleared/LOCAL-5', 'cleared/LOCAL-5.2', 'cleared/LOCAL-5.3']), 'cleared/LOCAL-5.4');
  // git cannot hold cleared/LOCAL-5 beside cleared/LOCAL-5/x, so that name is taken too.
  assert.equal(freeBranch('LOCAL-5', ['cleared/LOCAL-5/x']), 'cleared/LOCAL-5.2');
  assert.notEqual(freeBranch('LOCAL-5', ['cleared/LOCAL-5']), 'cleared/LOCAL-5.r1', 'a resume\'s name stays apart');
});

test('a name kept in the ledger is read back after a restart', () => {
  const db = new DatabaseSync(':memory:');
  const first = new BranchNames(db);
  assert.equal(first.get('LOCAL-5'), undefined);
  first.keep('LOCAL-5', 'guestbook', 'cleared/LOCAL-5.2');
  assert.equal(new BranchNames(db).get('LOCAL-5'), 'cleared/LOCAL-5.2');
});

const taken = (names: readonly string[]): Partial<FlowEffects> => ({ async remoteBranches() { return { names, checkout: null }; } });

test('a ticket whose branch is on the remote works, is reviewed and publishes under a free name', async () => {
  const branches: (string | undefined)[] = [];
  const published: string[] = [];
  const t = await setup({
    scripts: { author: quickAuthor },
    effects: {
      ...taken(['cleared/LOCAL-1']),
      async prepareWorkdir({ ticket, role, branch }) {
        branches.push(`${role}:${branch}`);
        return { workdir: `/work/${ticket.id}`, briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null } };
      },
      async publish(input) { published.push(input.branch); return { url: 'https://example.invalid/pull/7', number: 7, head: 'abc123', created: true }; },
    },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((item) => item.kind === 'release'), 'the release item', 5000);
  assert.deepEqual(branches, ['author:cleared/LOCAL-1.2', 'reviewer:cleared/LOCAL-1.2']);
  assert.deepEqual(published, ['cleared/LOCAL-1.2']);
  await t.engine.settled();
});

test('a repair round keeps its name: the branch it pushed is its own, on the remote or not', async () => {
  let asked = 0;
  const branches: (string | undefined)[] = [];
  const t = await setup({
    scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_FIX), reviewerScript(REPORT_PASS)], reopen: reopenScript },
    effects: {
      async remoteBranches() { asked += 1; return { names: asked === 1 ? ['cleared/LOCAL-1'] : ['cleared/LOCAL-1', 'cleared/LOCAL-1.2'], checkout: null }; },
      async prepareWorkdir({ ticket, branch }) {
        branches.push(branch);
        return { workdir: `/work/${ticket.id}`, briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null } };
      },
    },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((item) => item.kind === 'release'), 'the release item', 5000);
  assert.equal(asked, 1, 'the remote is asked once, when the ticket first gets its name');
  assert.ok(branches.every((branch) => branch === 'cleared/LOCAL-1.2'), branches.join(', '));
  await t.engine.settled();
});

test('a name kept in the ledger is used without asking the remote again, as after a restart or at a second start', async () => {
  let asked = 0;
  const branches: (string | undefined)[] = [];
  const t = await setup({
    scripts: { author: quickAuthor },
    effects: {
      async remoteBranches() { asked += 1; return { names: ['cleared/LOCAL-1', 'cleared/LOCAL-1.5'], checkout: null }; },
      async prepareWorkdir({ ticket, branch }) {
        branches.push(branch);
        return { workdir: `/work/${ticket.id}`, briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null } };
      },
    },
  });
  new BranchNames(t.store.db).keep(t.ticket.id, 'guestbook', 'cleared/LOCAL-1.5');
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((item) => item.kind === 'release'), 'the release item', 5000);
  await t.engine.settled();
  assert.equal(asked, 0);
  assert.ok(branches.every((branch) => branch === 'cleared/LOCAL-1.5'), branches.join(', '));
});

test('a ticket with a checkout from before keeps the branch of that checkout', async () => {
  const branches: (string | undefined)[] = [];
  const t = await setup({
    scripts: { author: quickAuthor },
    effects: {
      async remoteBranches() { return { names: ['cleared/LOCAL-1'], checkout: 'cleared/LOCAL-1' }; },
      async prepareWorkdir({ ticket, branch }) {
        branches.push(branch);
        return { workdir: `/work/${ticket.id}`, briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null } };
      },
    },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((item) => item.kind === 'release'), 'the release item', 5000);
  assert.ok(branches.every((branch) => branch === 'cleared/LOCAL-1'), branches.join(', '));
  await t.engine.settled();
});

test('a remote that cannot be asked does not stop the ticket: its own name, not kept, and asked again at the next start', async () => {
  const said: string[] = [];
  const error = console.error;
  console.error = (line: unknown) => { said.push(String(line)); };
  try {
    const t = await setup({ scripts: { author: quickAuthor }, effects: { async remoteBranches() { throw new Error('could not read from remote'); } } });
    await t.engine.start(t.ticket.id, 'u1');
    await until(() => t.inbox.list().some((item) => item.kind === 'release'), 'the release item', 5000);
    await t.engine.settled();
    assert.equal(new BranchNames(t.store.db).get(t.ticket.id), undefined);
    assert.ok(said.some((line) => /branch/.test(line) && /LOCAL-1/.test(line)), said.join('\n'));
  } finally {
    console.error = error;
  }
});

test('a ticket of several services takes a name free on each of them, and publishes under it', async () => {
  const services = [
    { name: 'guestbook', kind: 'repository', repo: 'example-org/guestbook', url: 'https://example.invalid/guestbook.git', base: 'main', path: null, dir: '/srv/guestbook', healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null },
    { name: 'filter-api', kind: 'repository', repo: 'example-org/filter-api', url: 'https://example.invalid/filter-api.git', base: 'main', path: null, dir: '/srv/filter-api', healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null },
  ];
  const published: string[] = [];
  const prepared: (string | undefined)[] = [];
  const t = await setup({
    scripts: { author: quickAuthor }, config: { workspace: { id: 'pair', name: 'pair', file: null, services } as never },
    effects: {
      async remoteBranches({ service }) { return { names: service?.name === 'filter-api' ? ['cleared/LOCAL-2', 'cleared/LOCAL-2.2'] : ['cleared/LOCAL-2'], checkout: null }; },
      async prepareWorkdir({ ticket, branch, service }) {
        prepared.push(branch);
        return { workdir: `/work/${ticket.id}/${service?.name}`, briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null } };
      },
      async publish(input) { published.push(input.branch); return { url: 'https://example.invalid/pull/7', number: 7, head: 'abc123', created: true }; },
      async changes() { return { files: [], diff: '' }; },
    },
    locks: () => ({ async requestRelease() { return {}; }, async prChecks() { return 'passed'; } }) as never,
  });
  const ticket = await t.tickets.create({ title: 'Two services', body: 'Both.', project: 'guestbook', services: ['guestbook', 'filter-api'] }, { kind: 'human', id: 'u1' });
  await t.engine.start(ticket.id, 'u1');
  await until(() => published.length === 2, 'both publishes', 5000);
  assert.deepEqual(published, ['cleared/LOCAL-2.3', 'cleared/LOCAL-2.3']);
  assert.ok(prepared.every((branch) => branch === 'cleared/LOCAL-2.3'), prepared.join(', '));
  await t.engine.settled();
});

test('the real effects read the remote: the branches of this ticket, its checkout\'s branch, and nothing of another ticket', async () => {
  const url = remote({ 'README.md': 'hello\n' });
  const root = tempDir('branch-names');
  const dir = join(root, 'project');
  execFileSync('git', ['clone', '--quiet', url, dir]);
  for (const name of ['cleared/LOCAL-5', 'cleared/LOCAL-5.2', 'cleared/LOCAL-55']) gitIn(dir, ['push', '--quiet', 'origin', `HEAD:refs/heads/${name}`]);
  const config = { ...CONFIG, projectDir: dir, repoUrl: url, workdirRoot: join(root, 'work') };
  const effects = realEffects(config, { env: { ...process.env, CLEARED_REPO: dir } });
  const read = await effects.remoteBranches?.({ ticket: 'LOCAL-5' });
  assert.deepEqual([...(read?.names ?? [])].sort(), ['cleared/LOCAL-5', 'cleared/LOCAL-5.2']);
  assert.equal(read?.checkout, null);
  mkdirSync(join(root, 'work', 'LOCAL-5', '.git'), { recursive: true });
  writeFileSync(join(root, 'work', 'LOCAL-5', '.git', 'HEAD'), 'ref: refs/heads/cleared/LOCAL-5\n');
  assert.equal((await effects.remoteBranches?.({ ticket: 'LOCAL-5' }))?.checkout, 'cleared/LOCAL-5');
});

test('published under the free name, the other install\'s branch stays where it was: nothing is forced', async () => {
  const url = remote({ 'README.md': 'hello\n', '.cleared/agents.conf': '[guard]\nterms = none\nallowed = none\n' });
  const root = tempDir('branch-names-push');
  const dir = join(root, 'project');
  execFileSync('git', ['clone', '--quiet', url, dir]);
  const other = commit(dir, { 'other.txt': 'from another install\n' }, 'Another install');
  gitIn(dir, ['push', '--quiet', 'origin', `${other}:refs/heads/cleared/LOCAL-1`]);
  gitIn(dir, ['reset', '--quiet', '--hard', 'origin/main']);
  const workdir = join(root, 'ticket');
  execFileSync('git', ['clone', '--quiet', url, workdir]);
  gitIn(workdir, ['checkout', '--quiet', '-b', 'cleared/LOCAL-1.2']);
  commit(workdir, { 'mine.txt': 'the ticket\n' }, 'The ticket');
  const forge = { async openPullRequestOf() { return null; }, async createPullRequest() { return { url: 'https://example.invalid/pull/1', number: 1 }; } };
  const env = { ...process.env };
  await publish({ project: dir, workdir, base: 'main', branch: 'cleared/LOCAL-1.2', repo: 'example-org/guestbook', ticket: 'LOCAL-1', gitEnv: env, ghEnv: env, forge: forge as never });
  assert.equal(gitIn(dir, ['ls-remote', 'origin', 'refs/heads/cleared/LOCAL-1']).split('\t')[0], other);
  assert.match(gitIn(dir, ['ls-remote', 'origin', 'refs/heads/cleared/LOCAL-1.2']), /cleared\/LOCAL-1\.2/);
});
