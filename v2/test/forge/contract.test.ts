// The forge contract (milestone 5 plan, decision 10, sections 6 and 11): the
// in-memory fake, the GitHub adapter over a fake gh and the GitLab adapter
// over a fake GitLab on loopback pass the same cases from the same world. No
// call reaches GitHub or GitLab.
import test from 'node:test';
import { GitHubForge } from '../../src/forge/github.ts';
import { GitLabForge } from '../../src/forge/gitlab.ts';
import { forgeContractCases } from './contract-cases.ts';
import { FakeForge, type Bucket, type World } from './fake.ts';
import { fakeGh } from './fake-gh.ts';
import { emptyGitLab, FakeGitLab, type GitLabStatus, type GitLabWorld } from './fakes/gitlab.ts';
import { tempDir } from '../workspace/git.ts';

forgeContractCases('the fake forge', (world) => {
  const forge = new FakeForge(structuredClone(world));
  return { forge, world: () => forge.world };
});

forgeContractCases('the GitHub adapter', (world) => {
  const gh = fakeGh(world);
  return { forge: new GitHubForge({ dir: gh.root, env: gh.env }), world: gh.world };
});

// The contract's world as GitLab holds it: projects, merge requests, and the
// checks of each head commit as its commit statuses.
const STATUS: Record<Bucket, string> = { pass: 'success', fail: 'failed', pending: 'running', skipping: 'skipped', cancel: 'canceled' };

function gitlabWorldOf(world: World): GitLabWorld {
  let id = 0;
  const statuses: Record<string, GitLabStatus[]> = {};
  for (const pull of world.pulls) {
    const made = pull.checks.map((check) => ({ id: ++id, name: check.name, status: STATUS[check.bucket], target_url: check.url, allow_failure: false, ...(check.log === undefined ? {} : { log: check.log }) }));
    const before = statuses[pull.headCommit];
    if (before && JSON.stringify(before.map(({ id: _id, ...s }) => s)) !== JSON.stringify(made.map(({ id: _id, ...s }) => s))) throw new Error(`two pull requests on ${pull.headCommit} with other checks`);
    statuses[pull.headCommit] ??= made;
  }
  return {
    ...emptyGitLab(),
    projects: world.repositories.map((r) => ({ path_with_namespace: r.repo, http_url_to_repo: r.url, default_branch: r.base, visibility: r.private ? 'private' : 'public', archived: r.archived, access_level: 30 })),
    mrs: world.pulls.map((p) => ({
      project: p.repo, iid: p.number, web_url: p.url, source_branch: p.head, target_branch: p.base, sha: p.headCommit, title: p.title, description: p.body,
      state: p.state === 'open' ? 'opened' : p.state, draft: false, created_at: '2026-10-25T10:00:00.000Z', notes: [...p.comments], merge_commit_sha: null, merged_at: null,
    })),
    statuses,
  };
}

const worldOf = (lab: GitLabWorld, from: World): World => ({
  repositories: from.repositories,
  pulls: lab.mrs.map((mr) => ({
    repo: mr.project, number: mr.iid, url: mr.web_url, base: mr.target_branch, head: mr.source_branch, headCommit: mr.sha, title: mr.title, body: mr.description,
    state: mr.state === 'opened' || mr.state === 'locked' ? 'open' : mr.state, checks: [], comments: [...mr.notes],
  })),
});

// Built here, so no line of the repository holds a value shaped like a credential.
const TOKEN = ['gitlab', 'credential', 'of', 'the', 'contract'].join('-');
const lab = new FakeGitLab(TOKEN);
const address = await lab.listen();
test.after(() => lab.close());
const dir = tempDir('forge-gitlab');

forgeContractCases('the GitLab adapter', (world) => {
  lab.world = gitlabWorldOf(world);
  return { forge: new GitLabForge({ address, token: TOKEN, dir }), world: () => worldOf(lab.world, world) };
});
