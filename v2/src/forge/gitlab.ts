// The GitLab adapter of the forge contract (milestone 5 plan, section 11):
// merge requests, their commit statuses and job logs, notes and projects,
// over GitLab's REST API through lib/gitlab.ts, which keeps the token in its
// header. A service on GitLab names `forge = gitlab` in the workspace file;
// the address (CLEARED_V2_GITLAB_URL, gitlab.com by default) and the token's
// file (CLEARED_V2_GITLAB_TOKEN_FILE, mode 600) are the settings the
// assistant's forge step writes. A pull request of the contract is a merge
// request's iid. The lock's merge is merge-pr.ts's GitLab branch, on the
// same client.
import { execFileSync } from 'node:child_process';
import { checkIid, checkProject, commitStatuses, conclusionOf, GitLabClient, GitLabError, gitlabAddress as addressOf, projectSegment, readGitLabToken } from '../../../lib/gitlab.ts';
import { logTail, type CiFailures, type FailedCheck } from '../flow/ci-repair.ts';
import { ForgeError, type ChecksState, type Forge, type ForgeRepository, type PullRequestRef, type PullRequestSeen } from './contract.ts';

export const GITLAB_URL = 'CLEARED_V2_GITLAB_URL';
export const GITLAB_FILE_SETTING = 'CLEARED_V2_GITLAB_TOKEN_FILE';

const MAX_REPOSITORIES = 1000;
const LIST_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 30_000;
const LOG_BYTES = 256 * 1024;                // the end of a job's log that is read; logTail cuts it further

export type GitLabForgeOptions = {
  readonly address: string;
  readonly token: string;
  readonly dir: string;                     // the service's checkout: its origin names the project when none is given
  readonly fetch?: typeof fetch;
};

// GitLab's errors as the contract's, with GitLab's status when it answered.
const forgeError = (error: unknown): ForgeError => {
  if (error instanceof ForgeError) return error;
  return new ForgeError(error instanceof Error ? error.message : String(error), error instanceof GitLabError ? { status: error.status } : {});
};

async function forged<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { throw forgeError(error); }
}

export function gitlabAddress(given: string | undefined): string {
  try { return addressOf(given); } catch (error) { throw forgeError(error); }
}

function repositoryOf(value: unknown): ForgeRepository | undefined {
  const p = value as Record<string, unknown> | null;
  if (typeof p?.path_with_namespace !== 'string' || typeof p.http_url_to_repo !== 'string') throw new ForgeError('GitLab gave a project of a shape it does not know');
  // A project with no commit has no branch yet: nothing to work on.
  if (typeof p.default_branch !== 'string' || p.default_branch === '') return undefined;
  return { repo: p.path_with_namespace, url: p.http_url_to_repo, base: p.default_branch, private: p.visibility !== 'public', archived: p.archived === true };
}

const refOf = (value: unknown, what: string): PullRequestRef => {
  const mr = value as { iid?: unknown; web_url?: unknown } | null;
  if (typeof mr?.iid !== 'number' || typeof mr.web_url !== 'string') throw new ForgeError(`GitLab gave ${what} of a shape it does not know`);
  return { number: mr.iid, url: mr.web_url };
};

// locked: GitLab is merging it.
const STATES: Readonly<Record<string, PullRequestSeen['state']>> = { opened: 'open', locked: 'open', closed: 'closed', merged: 'merged' };

export class GitLabForge implements Forge {
  readonly kind = 'gitlab';
  readonly address: string;
  readonly #client: GitLabClient;
  readonly #dir: string;

  constructor(options: GitLabForgeOptions) {
    this.address = gitlabAddress(options.address);
    try {
      this.#client = new GitLabClient({ address: this.address, token: options.token, ...(options.fetch ? { fetch: options.fetch } : {}) });
    } catch (error) { throw forgeError(error); }
    this.#dir = options.dir;
  }

  #project(repo: string): string {
    try { checkProject(repo); } catch (error) { throw forgeError(error); }
    return `/projects/${projectSegment(repo)}`;
  }

  #mr(repo: string, pr: number): string {
    try { checkIid(pr); } catch (error) { throw forgeError(error); }
    return `${this.#project(repo)}/merge_requests/${pr}`;
  }

  async #get(path: string): Promise<Record<string, unknown>> {
    return (await this.#client.call('GET', path, { timeoutMs: CALL_TIMEOUT_MS })).value as Record<string, unknown>;
  }

  async #head(repo: string, pr: number): Promise<string> {
    const sha = (await this.#get(this.#mr(repo, pr))).sha;
    if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new ForgeError(`GitLab gave merge request !${pr} no head`);
    return sha;
  }

  // The token's own projects (membership), never every public project of
  // the instance; those with no branch yet are left out.
  async listRepositories(): Promise<ForgeRepository[]> {
    return forged(async () => {
      const all = await this.#client.pages('/projects', { membership: true, order_by: 'id', sort: 'asc' }, MAX_REPOSITORIES, { timeoutMs: LIST_TIMEOUT_MS });
      const repositories = all.map(repositoryOf).filter((r): r is ForgeRepository => r !== undefined);
      return repositories.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
    });
  }

  async repository(repo: string): Promise<ForgeRepository> {
    const path = this.#project(repo);
    return forged(async () => {
      const found = repositoryOf(await this.#get(path));
      if (!found) throw new ForgeError(`${repo} has no branch yet`);
      return found;
    });
  }

  async openPullRequestOf(repo: string, branch: string): Promise<PullRequestRef | undefined> {
    const path = `${this.#project(repo)}/merge_requests`;
    return forged(async () => {
      const open = (await this.#client.call('GET', path, { query: { state: 'opened', source_branch: branch }, timeoutMs: CALL_TIMEOUT_MS })).value;
      const first = Array.isArray(open) ? open[0] : undefined;
      return first === undefined ? undefined : refOf(first, 'a merge request');
    });
  }

  // Never asks GitLab to remove the branch once merged.
  async createPullRequest(input: { readonly repo: string; readonly base: string; readonly head: string; readonly title: string; readonly body: string }): Promise<PullRequestRef> {
    const path = `${this.#project(input.repo)}/merge_requests`;
    return forged(async () => refOf((await this.#client.call('POST', path, {
      body: { source_branch: input.head, target_branch: input.base, title: input.title, description: input.body, remove_source_branch: false }, timeoutMs: CALL_TIMEOUT_MS,
    })).value, 'the merge request it opened'));
  }

  async pullRequestBody(repo: string, pr: number): Promise<string> {
    const path = this.#mr(repo, pr);
    return forged(async () => {
      const description = (await this.#get(path)).description;
      return typeof description === 'string' ? description : '';
    });
  }

  async editPullRequestBody(repo: string, pr: number, body: string): Promise<void> {
    const path = this.#mr(repo, pr);
    return forged(async () => { await this.#client.call('PUT', path, { body: { description: body }, timeoutMs: CALL_TIMEOUT_MS }); });
  }

  async pullRequest(repo: string, pr: number): Promise<PullRequestSeen> {
    const path = this.#mr(repo, pr);
    return forged(async () => {
      const mr = await this.#get(path);
      const state = STATES[String(mr.state)];
      if (!state || typeof mr.source_branch !== 'string') throw new ForgeError(`GitLab gave merge request !${pr} an unknown state (${String(mr.state).slice(0, 40)})`);
      return { state, head: mr.source_branch };
    });
  }

  // With no repository, the project the checkout's origin names on this GitLab.
  async headCommit(repo: string | undefined, pr: number): Promise<string> {
    const project = repo ?? this.#origin();
    this.#mr(project, pr);
    return forged(() => this.#head(project, pr));
  }

  #origin(): string {
    let remote: string;
    try { remote = execFileSync('git', ['-C', this.#dir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { throw new ForgeError('the checkout has no origin to name its GitLab project'); }
    let url: URL;
    try { url = new URL(remote); } catch { throw new ForgeError('the checkout\'s origin is not an address on this GitLab'); }
    const at = new URL(this.address);
    const prefix = at.pathname.replace(/\/+$/, '');
    if (url.host !== at.host || !url.pathname.startsWith(`${prefix}/`)) throw new ForgeError('the checkout\'s origin is not on this GitLab');
    return decodeURIComponent(url.pathname.slice(prefix.length + 1).replace(/\.git$/, ''));
  }

  // GitHub's sum: one failed or cancelled fails them; one still running, or
  // none yet, keeps them pending. A failure GitLab allows does not fail them.
  async checks(repo: string, pr: number): Promise<ChecksState> {
    this.#mr(repo, pr);
    return forged(async () => {
      const conclusions = (await commitStatuses(this.#client, repo, await this.#head(repo, pr))).map(conclusionOf);
      if (conclusions.some((c) => c === 'FAILURE' || c === 'CANCELLED')) return 'failed';
      if (conclusions.length === 0 || conclusions.some((c) => c === 'PENDING')) return 'pending';
      return 'passed';
    });
  }

  // The head's failed and cancelled statuses, each job's log cut to its end
  // for the first five; a log that cannot be read is left out, the check's
  // name stays. An external status has no job, so no log.
  async failedChecks(repo: string, pr: number): Promise<CiFailures> {
    const project = this.#project(repo);
    this.#mr(repo, pr);
    return forged(async () => {
      const head = await this.#head(repo, pr);
      const failed = (await commitStatuses(this.#client, repo, head)).filter((s) => ['FAILURE', 'CANCELLED'].includes(conclusionOf(s)));
      const checks: FailedCheck[] = [];
      for (const [index, status] of failed.entries()) {
        const id = Number(status.id);
        const log = index < 5 && Number.isSafeInteger(id) && id > 0
          ? await this.#client.text(`${project}/jobs/${id}/trace`, LOG_BYTES, { timeoutMs: CALL_TIMEOUT_MS }).then((text) => logTail(text), () => null)
          : null;
        checks.push({ name: String(status.name ?? ''), url: typeof status.target_url === 'string' && status.target_url ? status.target_url : null, log });
      }
      return { head, checks };
    });
  }

  // The comment as a note, then the close; the branch is kept.
  async closePullRequest(repo: string, pr: number, comment: string): Promise<void> {
    const path = this.#mr(repo, pr);
    return forged(async () => {
      await this.#client.call('POST', `${path}/notes`, { body: { body: comment }, timeoutMs: CALL_TIMEOUT_MS });
      await this.#client.call('PUT', path, { body: { state_event: 'close' }, timeoutMs: CALL_TIMEOUT_MS });
    });
  }
}

// The service's adapter: its address and its token's file from the settings.
export function gitlabForgeOf(at: { readonly dir: string; readonly env: NodeJS.ProcessEnv }, options: { readonly fetch?: typeof fetch } = {}): GitLabForge {
  const file = at.env[GITLAB_FILE_SETTING]?.trim();
  if (!file) throw new ForgeError(`${GITLAB_FILE_SETTING} is not set: connect GitLab in the setup assistant's forge step`);
  let token: string;
  try { token = readGitLabToken(file, GITLAB_FILE_SETTING); } catch (error) { throw forgeError(error); }
  return new GitLabForge({ address: at.env[GITLAB_URL] ?? '', token, dir: at.dir, ...options });
}
