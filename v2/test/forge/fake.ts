// A forge in memory, and the world the contract's cases seed: the
// repositories a credential reaches and the pull requests on them. The
// contract's cases (contract-cases.ts) run on this fake and on each adapter
// over its own fake of the forge (fake-gh.ts for GitHub), from the same
// world, so an adapter that passes them answers as this one does.
import { logTail } from '../../src/flow/ci-repair.ts';
import type { ChecksState, Forge, ForgeRepository, PullRequestRef, PullRequestSeen } from '../../src/forge/contract.ts';
import type { CiFailures } from '../../src/flow/ci-repair.ts';

export type Bucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
export type WorldCheck = { readonly name: string; readonly bucket: Bucket; readonly url: string | null; readonly log?: string };
export type WorldPull = {
  repo: string;
  number: number;
  url: string;
  base: string;
  head: string;
  headCommit: string;
  title: string;
  body: string;
  state: 'open' | 'closed' | 'merged';
  checks: WorldCheck[];
  comments: string[];
};
export type World = { repositories: ForgeRepository[]; pulls: WorldPull[] };

export const COMMIT = 'c'.repeat(40);
export const pullUrl = (repo: string, number: number) => `https://forge.invalid/${repo}/pull/${number}`;

export class FakeForge implements Forge {
  readonly kind = 'github';
  readonly world: World;
  constructor(world: World) {
    this.world = world;
  }

  #pull(repo: string, pr: number): WorldPull {
    const pull = this.world.pulls.find((p) => p.repo === repo && p.number === pr);
    if (!pull) throw new Error(`no pull request ${repo}#${pr}`);
    return pull;
  }

  async listRepositories(): Promise<ForgeRepository[]> {
    return [...this.world.repositories].sort((a, b) => a.repo.localeCompare(b.repo));
  }

  async repository(repo: string): Promise<ForgeRepository> {
    const found = this.world.repositories.find((r) => r.repo === repo);
    if (!found) throw new Error(`no repository ${repo}`);
    return found;
  }

  async openPullRequestOf(repo: string, branch: string): Promise<PullRequestRef | undefined> {
    const pull = this.world.pulls.find((p) => p.repo === repo && p.head === branch && p.state === 'open');
    return pull ? { number: pull.number, url: pull.url } : undefined;
  }

  async createPullRequest(input: { repo: string; base: string; head: string; title: string; body: string }): Promise<PullRequestRef> {
    const number = Math.max(0, ...this.world.pulls.filter((p) => p.repo === input.repo).map((p) => p.number)) + 1;
    const url = pullUrl(input.repo, number);
    this.world.pulls.push({ ...input, number, url, headCommit: COMMIT, state: 'open', checks: [], comments: [] });
    return { number, url };
  }

  async pullRequestBody(repo: string, pr: number): Promise<string> {
    return this.#pull(repo, pr).body;
  }

  async editPullRequestBody(repo: string, pr: number, body: string): Promise<void> {
    this.#pull(repo, pr).body = body;
  }

  async pullRequest(repo: string, pr: number): Promise<PullRequestSeen> {
    const { state, head } = this.#pull(repo, pr);
    return { state, head };
  }

  async headCommit(repo: string | undefined, pr: number): Promise<string> {
    if (!repo) throw new Error('the fake forge needs the repository');
    return this.#pull(repo, pr).headCommit;
  }

  async checks(repo: string, pr: number): Promise<ChecksState> {
    const checks = this.#pull(repo, pr).checks;
    if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'failed';
    if (checks.length === 0 || checks.some((c) => c.bucket === 'pending')) return 'pending';
    return 'passed';
  }

  async failedChecks(repo: string, pr: number): Promise<CiFailures> {
    const pull = this.#pull(repo, pr);
    const failed = pull.checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel');
    return { head: pull.headCommit, checks: failed.map((c) => ({ name: c.name, url: c.url, log: c.log === undefined ? null : logTail(c.log) })) };
  }

  async closePullRequest(repo: string, pr: number, comment: string): Promise<void> {
    const pull = this.#pull(repo, pr);
    pull.comments.push(comment);
    pull.state = 'closed';
  }
}
