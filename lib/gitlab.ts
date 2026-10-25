// GitLab's REST API (/api/v4) as Cleared asks it (docs/v2/milestone-5-plan.md,
// section 11): the client the v2 forge adapter (v2/src/forge/gitlab.ts) and
// the lock's GitLab branch (merge-pr.ts, lib/release.ts) share. The token
// travels in the PRIVATE-TOKEN header only: never in an address, an error or
// a log. An answer that redirects is refused, so the header never follows it
// to another host. The address is https, or http on loopback for a test, and
// may carry a path for a GitLab served under one.
//
// The lock's part reads what merge-pr.ts reads of a GitHub pull request, in
// GitHub's words, so that one set of rules judges both forges: the merge
// request's state, draft, branches, head and its checks (the commit statuses
// of the head, GitLab's jobs included); the pipelines still running; the
// base's last change; then the merge at the commit it checked.
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const GITLAB_COM = 'https://gitlab.com';
export const GITLAB_TIMEOUT_MS = 15_000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const PER_PAGE = 100;

export class GitLabError extends Error {
  override name = 'GitLabError';
  readonly status: number | undefined;   // GitLab's answer; undefined when it gave none
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

// The address of a GitLab: gitlab.com when none is given.
export function gitlabAddress(given: string | undefined): string {
  const text = (given ?? '').trim();
  if (text === '') return GITLAB_COM;
  let url: URL;
  try { url = new URL(text); } catch { throw new GitLabError('the GitLab address is not an address'); }
  if (url.username || url.password || url.search || url.hash || text.includes('?') || text.includes('#')) throw new GitLabError('the GitLab address takes no user, query or fragment');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new GitLabError('the GitLab address is https (http only on loopback)');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const PROJECT = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

// A project's path (group/name, or group/subgroup/name), checked before any
// call: it reaches GitLab as one encoded segment.
export function checkProject(project: string): void {
  if (!PROJECT.test(project) || project.split('/').some((part) => part === '.' || part === '..' || part.startsWith('-')))
    throw new GitLabError(`"${project.slice(0, 100)}" is not a GitLab project path (group/name)`);
}

export function checkIid(iid: number): void {
  if (!Number.isSafeInteger(iid) || iid < 1) throw new GitLabError(`${iid} is not a merge request number`);
}

export const projectSegment = (project: string): string => encodeURIComponent(project);

// The token, from a file of one line, of this account, that no one else can
// read and that is not a link; `name` is the setting that names it.
export function readGitLabToken(file: string, name: string): string {
  if (!isAbsolute(file)) throw new GitLabError(`${name} must be an absolute path`);
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) {
    throw new GitLabError(`${name} cannot be opened (${(error as NodeJS.ErrnoException).code ?? 'error'}): a file of this account, not a link`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new GitLabError(`${name} is not a file`);
    if (stat.uid !== process.getuid?.()) throw new GitLabError(`${name} belongs to another account`);
    if ((stat.mode & 0o077) !== 0) throw new GitLabError(`${name} must be mode 600: others can read it`);
    const value = readFileSync(fd, 'utf8').trim();
    if (value === '' || /[\s\0]/.test(value)) throw new GitLabError(`${name} must hold the token alone, on one line`);
    return value;
  } finally {
    closeSync(fd);
  }
}

export type GitLabClientOptions = { readonly address: string; readonly token: string; readonly fetch?: typeof fetch; readonly timeoutMs?: number };
type Query = Readonly<Record<string, string | number | boolean>>;
type Answer = { readonly status: number; readonly headers: Headers; readonly value: unknown };

// The words of GitLab's refusal, cut short, on one line: never its whole body.
const said = (value: unknown): string => {
  const message = (value as { message?: unknown; error?: unknown } | null)?.message ?? (value as { error?: unknown } | null)?.error;
  const text = typeof message === 'string' ? message : message === undefined ? '' : JSON.stringify(message);
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
};

// The end of a long text answer (a job's log): at most `limit` bytes are kept.
async function tailOf(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let kept = Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    kept = Buffer.concat([kept, Buffer.from(value)]);
    if (kept.length > limit * 2) kept = kept.subarray(kept.length - limit);
  }
  return kept.subarray(Math.max(0, kept.length - limit)).toString('utf8');
}

export class GitLabClient {
  readonly address: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeout: number;

  constructor(options: GitLabClientOptions) {
    this.address = gitlabAddress(options.address);
    if (!options.token || /[\s\0]/.test(options.token)) throw new GitLabError('the GitLab token is one word');
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#timeout = options.timeoutMs ?? GITLAB_TIMEOUT_MS;
  }

  async #send(method: string, path: string, options: { readonly query?: Query; readonly body?: unknown; readonly timeoutMs?: number }): Promise<Response> {
    const search = new URLSearchParams(Object.entries(options.query ?? {}).map(([key, value]): [string, string] => [key, String(value)]));
    const where = `${this.address}/api/v4${path}${search.size ? `?${search}` : ''}`;
    let response: Response;
    try {
      response = await this.#fetch(where, {
        method, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? this.#timeout),
        headers: { 'private-token': this.#token, accept: 'application/json', 'user-agent': 'cleared', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      const reason = (error as Error)?.name === 'TimeoutError' ? 'no answer in time' : (error as { cause?: { code?: unknown } })?.cause?.code ?? (error as Error)?.name ?? 'error';
      throw new GitLabError(`GitLab did not answer ${method} ${path} (${String(reason)})`);
    }
    if (response.status < 200 || response.status >= 300) {
      let value: unknown;
      try { value = await response.json(); } catch { value = undefined; }
      const words = said(value);
      throw new GitLabError(`GitLab answered ${response.status} to ${method} ${path}${words ? `: ${words}` : ''}`, response.status);
    }
    return response;
  }

  async call(method: string, path: string, options: { readonly query?: Query; readonly body?: unknown; readonly timeoutMs?: number } = {}): Promise<Answer> {
    const response = await this.#send(method, path, options);
    let value: unknown;
    try { value = await response.json(); } catch { throw new GitLabError(`GitLab's answer to ${method} ${path} is not JSON`, response.status); }
    return { status: response.status, headers: response.headers, value };
  }

  async text(path: string, limit: number, options: { readonly timeoutMs?: number } = {}): Promise<string> {
    return tailOf(await this.#send('GET', path, options), limit);
  }

  // Every item of a listing, page by page, at most `max`.
  async pages(path: string, query: Query, max: number, options: { readonly timeoutMs?: number } = {}): Promise<unknown[]> {
    const items: unknown[] = [];
    for (let page = 1; items.length < max; page++) {
      const answer = await this.call('GET', path, { ...options, query: { ...query, per_page: PER_PAGE, page } });
      if (!Array.isArray(answer.value)) throw new GitLabError(`GitLab's answer to GET ${path} is not a list`, answer.status);
      items.push(...answer.value);
      if (answer.value.length < PER_PAGE || !answer.headers.get('x-next-page')) break;
    }
    return items.slice(0, max);
  }
}

// ---- The lock's part (merge-pr.ts, lib/release.ts) ---------------------

export type GitLabLockSettings = { readonly address: string; readonly project: string; readonly tokenFile: string };

const APP_KEYS = ['app_id', 'installation_id', 'app_private_key_file', 'app_login', 'app_user_id', 'use_tracker_app'];

// A GitLab service's lock settings, from its [forge] section:
//   adapter = gitlab
//   gitlab_url = https://gitlab.example.org     gitlab.com by default
//   gitlab_project = group/name
//   gitlab_token_file = /abs/path               mode 600, outside the checkout
export function gitlabLockSettings(forge: Readonly<Record<string, string | undefined>>, checkout: string | null): GitLabLockSettings {
  const app = APP_KEYS.filter((key) => forge[key]);
  if (app.length) throw new GitLabError(`[forge] adapter = gitlab takes no GitHub App key (${app.join(', ')})`);
  let address: string;
  try { address = gitlabAddress(forge.gitlab_url); } catch (error) { throw new GitLabError(`[forge] gitlab_url: ${(error as Error).message}`); }
  const project = forge.gitlab_project ?? '';
  if (!project) throw new GitLabError('[forge] gitlab_project is missing (the project\'s path on GitLab, group/name)');
  try { checkProject(project); } catch (error) { throw new GitLabError(`[forge] gitlab_project: ${(error as Error).message}`); }
  const tokenFile = forge.gitlab_token_file ?? '';
  if (!tokenFile) throw new GitLabError('[forge] gitlab_token_file is missing (a file of mode 600 holding the token)');
  if (!isAbsolute(tokenFile)) throw new GitLabError('[forge] gitlab_token_file must be an absolute path');
  let real = tokenFile;
  try { real = realpathSync(tokenFile); } catch { /* checked again when it is read */ }
  let inside: string | null = null;
  try { inside = checkout ? realpathSync(checkout) : null; } catch { inside = null; }
  if (inside && (real === inside || real.startsWith(`${inside}/`))) throw new GitLabError('[forge] gitlab_token_file must be outside the project checkout');
  return { address, project, tokenFile };
}

export function gitlabLockClient(settings: GitLabLockSettings, options: { readonly fetch?: typeof fetch } = {}): GitLabClient {
  return new GitLabClient({ address: settings.address, token: readGitLabToken(settings.tokenFile, '[forge] gitlab_token_file'), ...options });
}

const LOCK_KEYS = ['gitlab_url', 'gitlab_project', 'gitlab_token_file', ...APP_KEYS];

export type GitLabLock = { readonly client: GitLabClient; readonly project: string };

// The lock of a service on GitLab, from its [forge] section as `read` gives
// each key ('' when unset); null for a service on GitHub. Throws, naming the
// key, when the settings or the token's file cannot work.
export function gitlabLockOf(read: (key: string) => string, checkout: string | null): GitLabLock | null {
  if (read('adapter') !== 'gitlab') return null;
  const settings = gitlabLockSettings(Object.fromEntries(LOCK_KEYS.map((key) => [key, read(key)])), checkout);
  return { client: gitlabLockClient(settings), project: settings.project };
}

// A merge request as merge-pr.ts reads a pull request (gh pr view's fields),
// its checks as the conclusions merge-pr.ts judges.
export type LockPull = {
  readonly state: string;
  readonly isDraft: boolean;
  readonly headRefName: string;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly createdAt: string;
  readonly checks: readonly string[];
};

// A commit status of GitLab (a job or an external status) in GitHub's
// words: a failure GitLab allows is neutral (it neither fails the checks
// nor counts as one that passed), a manual job not run is skipped, and
// every state before the end is pending.
export function conclusionOf(status: { readonly status?: unknown; readonly allow_failure?: unknown }): string {
  switch (status.status) {
    case 'success': return 'SUCCESS';
    case 'skipped': case 'manual': return 'SKIPPED';
    case 'failed': return status.allow_failure === true ? 'NEUTRAL' : 'FAILURE';
    case 'canceled': return 'CANCELLED';
    case 'created': case 'waiting_for_resource': case 'preparing': case 'pending': case 'running': case 'scheduled': return 'PENDING';
    default: return String(status.status ?? '').toUpperCase() || 'UNKNOWN';
  }
}

const mrPath = (project: string, iid: number) => `/projects/${projectSegment(project)}/merge_requests/${iid}`;

export async function commitStatuses(client: GitLabClient, project: string, sha: string): Promise<Record<string, unknown>[]> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitLabError('GitLab gave a head that is not a commit');
  return await client.pages(`/projects/${projectSegment(project)}/repository/commits/${sha}/statuses`, {}, 500) as Record<string, unknown>[];
}

export async function lockPull(client: GitLabClient, project: string, iid: number): Promise<LockPull> {
  checkProject(project);
  checkIid(iid);
  const mr = (await client.call('GET', mrPath(project, iid))).value as Record<string, unknown> | null;
  const text = (key: string) => (typeof mr?.[key] === 'string' ? mr[key] as string : '');
  if (!text('sha') || !text('source_branch') || !text('target_branch')) throw new GitLabError(`GitLab gave merge request !${iid} of a shape it does not know`);
  const state = text('state') === 'opened' ? 'OPEN' : text('state').toUpperCase();
  const statuses = await commitStatuses(client, project, text('sha'));
  return {
    state, isDraft: mr?.draft === true || mr?.work_in_progress === true, headRefName: text('source_branch'), headRefOid: text('sha'),
    baseRefName: text('target_branch'), createdAt: text('created_at'), checks: statuses.map(conclusionOf),
  };
}

// What keeps the host from a merge on GitLab's side: its pipelines running
// or waiting on the project, and when the base last changed.
export async function hostOnGitLab(client: GitLabClient, project: string, base: string): Promise<{ readonly runs: number; readonly baseChangedAt: number }> {
  const where = `/projects/${projectSegment(project)}`;
  const running = await client.pages(`${where}/pipelines`, { status: 'running' }, 20);
  const pending = await client.pages(`${where}/pipelines`, { status: 'pending' }, 20);
  const commit = (await client.call('GET', `${where}/repository/commits/${encodeURIComponent(base)}`)).value as { committed_date?: unknown } | null;
  return { runs: running.length + pending.length, baseChangedAt: Date.parse(String(commit?.committed_date ?? '')) };
}

// The merge, at the commit that was checked (GitLab refuses it when the
// branch moved since), the branch kept.
export async function mergeOnGitLab(client: GitLabClient, project: string, iid: number, sha: string): Promise<void> {
  checkProject(project);
  checkIid(iid);
  await client.call('PUT', `${mrPath(project, iid)}/merge`, { body: { sha, should_remove_source_branch: false }, timeoutMs: 120_000 });
}

// A merged merge request as lib/release.ts reads a merged pull request.
export async function mergedOnGitLab(client: GitLabClient, project: string, iid: number): Promise<{ number: number; title: string; mergeCommit: { oid: string } | null; mergedAt: string | null }> {
  const mr = (await client.call('GET', mrPath(project, iid))).value as Record<string, unknown> | null;
  const commit = typeof mr?.merge_commit_sha === 'string' ? mr.merge_commit_sha : null;
  return { number: Number(mr?.iid), title: String(mr?.title ?? ''), mergeCommit: commit ? { oid: commit } : null, mergedAt: typeof mr?.merged_at === 'string' ? mr.merged_at : null };
}
