// What Cleared asks of a forge (milestone 5 plan, decision 10, matrix M10):
// the repositories its credential reaches, one of them, and a pull request's
// life: find the open one of a branch, open one, read and replace its body,
// read its state, its head and its checks, close it with a comment. Each
// service names its forge in the workspace file (`forge = github` by
// default). GitHub is the first adapter (github.ts, over gh); GitLab is the
// second (gitlab.ts, over its REST API, section 11). The lock's merge stays
// outside the contract: merge-pr.ts makes it, with gh for GitHub and
// lib/gitlab.ts for a service whose agents.conf says [forge] adapter = gitlab.
//
// Every call runs on the host, where the forge's credential is: a session's
// container never holds it. A repository is owner/name; a pull request is
// its number on that repository.
import type { CiFailures } from '../flow/ci-repair.ts';

export const FORGE_KINDS = ['github', 'gitlab'] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

export class ForgeError extends Error {
  override name = 'ForgeError';
  readonly status: number | undefined;   // the forge's answer (401, 403...), when it gave one
  constructor(message: string, options: { readonly status?: number | undefined } = {}) {
    super(message);
    this.status = options.status;
  }
}

// A repository as the setup assistant and the workspace file need it.
export type ForgeRepository = {
  readonly repo: string;                 // owner/name
  readonly url: string;                  // what a checkout clones, over https
  readonly base: string;                 // its default branch
  readonly private: boolean;
  readonly archived: boolean;
};

export type PullRequestRef = { readonly number: number; readonly url: string };
export type PullRequestSeen = { readonly state: 'open' | 'closed' | 'merged'; readonly head: string };   // head: its branch

// The checks of a pull request as the release card says them: one failed or
// cancelled fails them, one still running (or none reported yet) keeps them
// pending.
export type ChecksState = 'pending' | 'passed' | 'failed';

export interface Forge {
  readonly kind: ForgeKind;
  // The repositories the credential reaches, by name, at most 1000.
  listRepositories(): Promise<ForgeRepository[]>;
  repository(repo: string): Promise<ForgeRepository>;
  // The open pull request whose head is `branch`, if there is one.
  openPullRequestOf(repo: string, branch: string): Promise<PullRequestRef | undefined>;
  // Never a draft: the lock refuses a draft.
  createPullRequest(input: { readonly repo: string; readonly base: string; readonly head: string; readonly title: string; readonly body: string }): Promise<PullRequestRef>;
  pullRequestBody(repo: string, pr: number): Promise<string>;
  editPullRequestBody(repo: string, pr: number, body: string): Promise<void>;
  pullRequest(repo: string, pr: number): Promise<PullRequestSeen>;
  // The commit of the pull request's head. With no repository, the one the
  // checkout the forge runs in points at.
  headCommit(repo: string | undefined, pr: number): Promise<string>;
  checks(repo: string, pr: number): Promise<ChecksState>;
  // The head the checks ran on and the checks that failed, each with the
  // end of its log when the forge gives one.
  failedChecks(repo: string, pr: number): Promise<CiFailures>;
  // Closes it with `comment`, and never deletes its branch.
  closePullRequest(repo: string, pr: number, comment: string): Promise<void>;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// A repository and a pull request number are checked before any call, so
// that neither can reach the forge's command as a flag.
export function checkRepo(repo: string): void {
  if (!REPO.test(repo) || repo.startsWith('-') || repo.split('/').some((part) => part === '.' || part === '..'))
    throw new ForgeError(`"${repo.slice(0, 100)}" is not owner/name`);
}

export function checkPr(pr: number): void {
  if (!Number.isSafeInteger(pr) || pr < 1) throw new ForgeError(`${pr} is not a pull request number`);
}
