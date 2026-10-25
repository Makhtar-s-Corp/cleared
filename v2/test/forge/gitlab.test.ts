// The GitLab adapter (milestone 5 plan, section 11): what it asks of GitLab's
// REST API beyond the contract's cases (contract.test.ts). The token goes in
// the PRIVATE-TOKEN header only, never in an address, an error or a log; a
// project's path is one encoded segment, so a nested group reads as one; the
// listing is the token's own projects, page by page, at most 1000; an answer
// that redirects is refused, so the header never follows it; the address is
// https, or http on loopback for a test; the token comes from a file of mode
// 600 of this account. Against a fake GitLab on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForgeError } from '../../src/forge/contract.ts';
import { forgeFor } from '../../src/forge/index.ts';
import { gitlabAddress, GitLabForge, gitlabForgeOf } from '../../src/forge/gitlab.ts';
import { tempDir } from '../workspace/git.ts';
import { emptyGitLab, FakeGitLab, type GitLabMr, type GitLabProject, type GitLabWorld } from './fakes/gitlab.ts';

const TOKEN = ['gitlab', 'credential', 'of', 'the', 'test'].join('-');
const PROJECT = 'example/guestbook';
const NESTED = 'example/apps/filter-api';

const project = (path: string, over: Partial<GitLabProject> = {}): GitLabProject => ({
  path_with_namespace: path, http_url_to_repo: `https://gitlab.invalid/${path}.git`, default_branch: 'main', visibility: 'private', archived: false, access_level: 30, ...over,
});
const mr = (over: Partial<GitLabMr> & { iid: number }): GitLabMr => ({
  project: PROJECT, web_url: `https://gitlab.invalid/${PROJECT}/-/merge_requests/${over.iid}`, source_branch: 'cleared/DEMO-7', target_branch: 'main',
  sha: 'c'.repeat(40), title: 'T', description: 'B', state: 'opened', draft: false, created_at: '2026-10-25T10:00:00.000Z', notes: [], merge_commit_sha: null, merged_at: null, ...over,
});

async function withLab(world: Partial<GitLabWorld>, run: (lab: FakeGitLab, forge: GitLabForge, address: string) => Promise<void>): Promise<void> {
  const lab = new FakeGitLab(TOKEN, { ...emptyGitLab(), projects: [project(PROJECT), project(NESTED)], ...world });
  const address = await lab.listen();
  try {
    await run(lab, new GitLabForge({ address, token: TOKEN, dir: tempDir('gitlab-dir') }), address);
  } finally {
    await lab.close();
  }
}

test('the address is https on any host, or http on loopback only; a trailing slash is dropped, a path kept, a user, a query or a fragment refused', () => {
  assert.equal(gitlabAddress(undefined), 'https://gitlab.com');
  assert.equal(gitlabAddress(''), 'https://gitlab.com');
  assert.equal(gitlabAddress('https://gitlab.example.org/'), 'https://gitlab.example.org');
  assert.equal(gitlabAddress('https://example.org/gitlab/'), 'https://example.org/gitlab');
  assert.equal(gitlabAddress('http://127.0.0.1:4010'), 'http://127.0.0.1:4010');
  assert.equal(gitlabAddress('http://localhost:4010/'), 'http://localhost:4010');
  for (const bad of ['http://gitlab.example.org', 'ftp://gitlab.example.org', 'gitlab.example.org', ['https://user', 'pw@gitlab.example.org'].join(':'), 'https://gitlab.example.org/?x=1', 'https://gitlab.example.org/#top'])
    assert.throws(() => gitlabAddress(bad), ForgeError, bad);
});

test('every call carries the token in the PRIVATE-TOKEN header only, and a nested group\'s project is one encoded segment', async () => {
  await withLab({ mrs: [mr({ iid: 3, project: NESTED })] }, async (lab, forge) => {
    await forge.repository(NESTED);
    await forge.pullRequest(NESTED, 3);
    await forge.listRepositories();
    assert.ok(lab.requests.length >= 3);
    for (const request of lab.requests) {
      assert.equal(request.token, true, request.path);
      assert.ok(!JSON.stringify(request).includes(TOKEN), 'never in an address or a body');
    }
    assert.deepEqual(lab.requests.slice(0, 2).map((r) => r.path), ['/api/v4/projects/example%2Fapps%2Ffilter-api', '/api/v4/projects/example%2Fapps%2Ffilter-api/merge_requests/3']);
  });
});

test('a project path that could leave its segment, and a merge request number that is not one, are refused before any call', async () => {
  await withLab({}, async (lab, forge) => {
    for (const bad of ['example', '../x', 'example/../x', '-x/y', 'example//x', 'example/x?y', 'example/x#y', 'example/x%2F'])
      await assert.rejects(forge.repository(bad), ForgeError, bad);
    await assert.rejects(forge.pullRequest(PROJECT, 0), ForgeError);
    await assert.rejects(forge.pullRequest(PROJECT, 1.5), ForgeError);
    assert.equal(lab.requests.length, 0);
  });
});

test('the listing is the projects the token is a member of, page by page, those with no branch yet left out, internal ones counted private', async () => {
  const many = Array.from({ length: 230 }, (_, i) => project(`example/p${String(i).padStart(3, '0')}`));
  await withLab({ projects: [...many, project('example/empty', { default_branch: null }), project('example/inside', { visibility: 'internal' }), project('example/open', { visibility: 'public' })] }, async (lab, forge) => {
    const listed = await forge.listRepositories();
    assert.equal(listed.length, 232, 'the empty project is left out');
    assert.ok(lab.requests.every((r) => r.query.membership === 'true'), 'never every public project of gitlab.com');
    assert.deepEqual(lab.requests.map((r) => r.query.page), ['1', '2', '3']);
    assert.equal(listed.find((r) => r.repo === 'example/inside')?.private, true);
    assert.equal(listed.find((r) => r.repo === 'example/open')?.private, false);
    assert.deepEqual(listed.map((r) => r.repo), [...listed.map((r) => r.repo)].sort(), 'by name');
    assert.equal(listed.find((r) => r.repo === 'example/p007')?.url, 'https://gitlab.invalid/example/p007.git');
  });
  const thousands = Array.from({ length: 1150 }, (_, i) => project(`example/q${String(i).padStart(4, '0')}`));
  await withLab({ projects: thousands }, async (lab, forge) => {
    assert.equal((await forge.listRepositories()).length, 1000, 'at most 1000');
    assert.equal(lab.requests.length, 10, 'and no page past them');
  });
});

test('a refusal says its status, an answer that redirects is refused and the header never follows it, and no error holds the token', async () => {
  const elsewhere = new FakeGitLab(TOKEN);
  const other = await elsewhere.listen();
  try {
    await withLab({}, async (lab, forge) => {
      lab.status = 401;
      const refused = await forge.listRepositories().catch((error: unknown) => error);
      assert.ok(refused instanceof ForgeError);
      assert.equal(refused.status, 401);
      lab.status = 403;
      assert.equal(((await forge.repository(PROJECT).catch((error: unknown) => error)) as ForgeError).status, 403);
      lab.status = undefined;
      lab.redirect = `${other}/api/v4/projects`;
      const moved = await forge.listRepositories().catch((error: unknown) => error);
      assert.ok(moved instanceof ForgeError);
      assert.equal(elsewhere.requests.length, 0, 'the redirect was not followed');
      for (const error of [refused, moved]) assert.ok(!String((error as Error).message).includes(TOKEN));
    });
    const gone = new GitLabForge({ address: other, token: TOKEN, dir: tempDir('gitlab-gone') });
    await elsewhere.close();
    const silent = await gone.listRepositories().catch((error: unknown) => error);
    assert.ok(silent instanceof ForgeError);
    assert.equal(silent.status, undefined, 'no answer is no status');
  } finally {
    await elsewhere.close();
  }
});

test('a pull request opened on GitLab never asks to remove its branch, and a close posts the comment first and keeps the branch', async () => {
  await withLab({ mrs: [mr({ iid: 4 })] }, async (lab, forge) => {
    await forge.createPullRequest({ repo: PROJECT, base: 'main', head: 'cleared/DEMO-8', title: 'Newest entry first', body: 'The body.' });
    const made = lab.requests.find((r) => r.method === 'POST' && r.path.endsWith('/merge_requests'));
    assert.deepEqual(made?.body, { source_branch: 'cleared/DEMO-8', target_branch: 'main', title: 'Newest entry first', description: 'The body.', remove_source_branch: false });
    lab.requests.length = 0;
    await forge.closePullRequest(PROJECT, 4, 'Closed from Cleared.');
    assert.deepEqual(lab.requests.map((r) => [r.method, r.path.replace('/api/v4/projects/example%2Fguestbook', ''), r.body]), [
      ['POST', '/merge_requests/4/notes', { body: 'Closed from Cleared.' }],
      ['PUT', '/merge_requests/4', { state_event: 'close' }],
    ]);
  });
});

test('the checks of a head: a failure GitLab allows does not fail them, a manual job is not waited for, a running one is', async () => {
  const sha = (n: number) => String(n).repeat(40);
  const status = (id: number, state: string, over: Record<string, unknown> = {}) => ({ id, name: `job ${id}`, status: state, target_url: null, allow_failure: false, ...over });
  await withLab({
    mrs: [1, 2, 3, 4].map((iid) => mr({ iid, sha: sha(iid) })),
    statuses: {
      [sha(1)]: [status(1, 'success'), status(2, 'failed', { allow_failure: true })],
      [sha(2)]: [status(3, 'success'), status(4, 'manual')],
      [sha(3)]: [status(5, 'success'), status(6, 'created')],
      [sha(4)]: [status(7, 'success'), status(8, 'failed')],
    },
  }, async (_lab, forge) => {
    assert.deepEqual(await Promise.all([1, 2, 3, 4].map((n) => forge.checks(PROJECT, n))), ['passed', 'passed', 'pending', 'failed']);
    const failures = await forge.failedChecks(PROJECT, 1);
    assert.deepEqual(failures.checks, [], 'a failure GitLab allows is not one to repair');
  });
});

test('the head of a pull request with no repository given is read on the project the checkout\'s origin names on this GitLab', async () => {
  await withLab({ mrs: [mr({ iid: 9, project: NESTED, sha: 'a'.repeat(40) })] }, async (_lab, _forge, address) => {
    const dir = tempDir('gitlab-checkout');
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', `${address}/${NESTED}.git`]);
    assert.equal(await new GitLabForge({ address, token: TOKEN, dir }).headCommit(undefined, 9), 'a'.repeat(40));
    execFileSync('git', ['-C', dir, 'remote', 'set-url', 'origin', 'https://elsewhere.invalid/example/guestbook.git']);
    await assert.rejects(new GitLabForge({ address, token: TOKEN, dir }).headCommit(undefined, 9), ForgeError, 'another host is not this GitLab');
  });
});

test('the service\'s adapter reads its address and its token file from the settings; a file of another mode, a link or none is refused', () => {
  const dir = tempDir('gitlab-env');
  const file = join(dir, 'forge-gitlab.token');
  writeFileSync(file, `${TOKEN}\n`, { mode: 0o600 });
  const forge = gitlabForgeOf({ dir, env: { CLEARED_V2_GITLAB_TOKEN_FILE: file, CLEARED_V2_GITLAB_URL: 'https://gitlab.example.org/' } });
  assert.equal(forge.kind, 'gitlab');
  assert.equal(forge.address, 'https://gitlab.example.org');
  assert.equal(gitlabForgeOf({ dir, env: { CLEARED_V2_GITLAB_TOKEN_FILE: file } }).address, 'https://gitlab.com', 'gitlab.com by default');
  assert.ok(forgeFor('gitlab', { dir, env: { CLEARED_V2_GITLAB_TOKEN_FILE: file } }) instanceof GitLabForge);
  assert.throws(() => gitlabForgeOf({ dir, env: {} }), /CLEARED_V2_GITLAB_TOKEN_FILE/);
  const relative = 'forge-gitlab.token';
  assert.throws(() => gitlabForgeOf({ dir, env: { CLEARED_V2_GITLAB_TOKEN_FILE: relative } }), /absolute/);
  assert.throws(() => gitlabForgeOf({ dir, env: { CLEARED_V2_GITLAB_TOKEN_FILE: join(dir, 'none') } }), ForgeError);
  const open = join(dir, 'open.token');
  writeFileSync(open, `${TOKEN}\n`);
  chmodSync(open, 0o644);
  assert.throws(() => gitlabForgeOf({ dir, env: { CLEARED_V2_GITLAB_TOKEN_FILE: open } }), /600/);
  mkdirSync(join(dir, 'links'));
  symlinkSync(file, join(dir, 'links', 'link.token'));
  assert.throws(() => gitlabForgeOf({ dir, env: { CLEARED_V2_GITLAB_TOKEN_FILE: join(dir, 'links', 'link.token') } }), ForgeError);
  for (const thrown of [() => gitlabForgeOf({ dir, env: { CLEARED_V2_GITLAB_TOKEN_FILE: open } })]) {
    try { thrown(); } catch (error) { assert.ok(!String(error).includes(TOKEN)); }
  }
});
