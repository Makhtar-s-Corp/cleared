// The GitHub adapter of the forge contract (milestone 5 plan, section 6):
// the gh calls the service made before the contract, unchanged, each with
// the timeout and the output cap its call site had. gh runs in `dir` (the
// service's checkout) with `env`, the forge's gh environment of lib/forge.ts,
// which carries the token; nothing here reads or prints the token, but for
// its prefix, which says whether it is an app installation's.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failedChecks, jobOf, logTail, type CiFailures } from '../flow/ci-repair.ts';
import { checkPr, checkRepo, ForgeError, type ChecksState, type Forge, type ForgeRepository, type PullRequestRef, type PullRequestSeen } from './contract.ts';

export type GitHubForgeOptions = {
  readonly dir: string;                   // gh runs here
  readonly env: NodeJS.ProcessEnv;        // the forge's gh environment
};

type Call = {
  readonly timeout?: number;              // none: as long as gh takes
  readonly maxBuffer?: number;            // none: execFile's own
  readonly tail: number;                  // how much of gh's stderr an error keeps
  readonly exits?: readonly number[];     // exit codes whose output is read as an answer
};

// The calls as their call sites made them: publish's (workspace/publish.ts),
// the Close's (flow/pr-close.ts), the release card's checks and the repair's
// failures (flow/effects.ts), the approval's head (approval/service.ts).
const PUBLISH: Call = { maxBuffer: 64 * 1024 * 1024, tail: 2000 };
const CLOSE: Call = { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, tail: 300 };
// gh exits 8 while a check is pending, and prints the list all the same.
const CHECKS: Call = { timeout: 15_000, tail: 300, exits: [8] };
const FAILURES: Call = { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, tail: 300 };
const HEAD: Call = { timeout: 15_000, tail: 300 };
const LIST: Call = { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, tail: 300 };
const READ: Call = { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, tail: 300 };

const MAX_REPOSITORIES = 1000;
// Each repository as one line of JSON, page by page.
const PROJECTION = '{repo: .full_name, url: .clone_url, base: .default_branch, private: .private, archived: .archived} | tojson';

// What the release card says of a pull request's checks, from the buckets of
// `gh pr checks --json bucket`.
export function checksOf(checks: readonly { readonly bucket: string }[]): ChecksState {
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'cancel')) return 'failed';
  if (checks.length === 0 || checks.some((c) => c.bucket === 'pending')) return 'pending';
  return 'passed';
}

function repositoryOf(value: unknown): ForgeRepository {
  const r = value as Record<string, unknown> | null;
  if (typeof r?.repo !== 'string' || typeof r.url !== 'string' || typeof r.base !== 'string' || typeof r.private !== 'boolean' || typeof r.archived !== 'boolean')
    throw new ForgeError('gh api gave a repository of a shape it does not know');
  return { repo: r.repo, url: r.url, base: r.base, private: r.private, archived: r.archived };
}

function json(text: string, what: string): unknown {
  try { return JSON.parse(text); }
  catch { throw new ForgeError(`${what} did not answer JSON`); }
}

export class GitHubForge implements Forge {
  readonly kind = 'github';
  readonly #dir: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(options: GitHubForgeOptions) {
    this.#dir = options.dir;
    this.#env = options.env;
  }

  #gh(args: readonly string[], call: Call): Promise<string> {
    const what = args[0] === 'api' ? 'gh api' : `gh ${args[0]} ${args[1] ?? ''}`;
    return new Promise((resolve, reject) => {
      execFile('gh', [...args], { cwd: this.#dir, env: this.#env, encoding: 'utf8', ...(call.timeout ? { timeout: call.timeout } : {}), ...(call.maxBuffer ? { maxBuffer: call.maxBuffer } : {}) },
        (error, stdout, stderr) => {
          if (!error || call.exits?.includes((error as { code?: unknown }).code as number)) return resolve(stdout);
          reject(new ForgeError(`${what} failed: ${String(stderr).trim().slice(-call.tail) || error.message}`));
        });
    });
  }

  // A body reaches gh as a file of this process's own, removed after the call.
  async #withBody<T>(body: string, use: (file: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-forge-'));
    try {
      const file = join(dir, 'body.md');
      writeFileSync(file, body, { mode: 0o600 });
      return await use(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async listRepositories(): Promise<ForgeRepository[]> {
    // An app installation's token (ghs_) reaches the installation's
    // repositories; a person's, those of its account and organisations.
    const token = this.#env.GH_TOKEN || this.#env.GITHUB_TOKEN || '';
    const [items, endpoint] = token.startsWith('ghs_') ? ['.repositories[]', 'installation/repositories?per_page=100'] : ['.[]', 'user/repos?per_page=100'];
    const out = await this.#gh(['api', '--paginate', '--jq', `${items} | ${PROJECTION}`, endpoint], LIST);
    const repositories = out.split('\n').filter((line) => line.trim()).map((line) => repositoryOf(json(line, 'gh api')));
    return repositories.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0)).slice(0, MAX_REPOSITORIES);
  }

  async repository(repo: string): Promise<ForgeRepository> {
    checkRepo(repo);
    const r = json(await this.#gh(['api', `repos/${repo}`], READ), 'gh api') as Record<string, unknown> | null;
    return repositoryOf({ repo: r?.full_name, url: r?.clone_url, base: r?.default_branch, private: r?.private, archived: r?.archived });
  }

  async openPullRequestOf(repo: string, branch: string): Promise<PullRequestRef | undefined> {
    checkRepo(repo);
    const open = json(await this.#gh(['pr', 'list', '--repo', repo, '--head', branch, '--state', 'open', '--json', 'number,url'], PUBLISH), 'gh pr list');
    const first = (Array.isArray(open) ? open[0] : undefined) as { number?: unknown; url?: unknown } | undefined;
    return first && typeof first.number === 'number' && typeof first.url === 'string' ? { number: first.number, url: first.url } : undefined;
  }

  async createPullRequest(input: { readonly repo: string; readonly base: string; readonly head: string; readonly title: string; readonly body: string }): Promise<PullRequestRef> {
    checkRepo(input.repo);
    const url = (await this.#withBody(input.body, (file) =>
      this.#gh(['pr', 'create', '--repo', input.repo, '--base', input.base, '--head', input.head, '--title', input.title, '--body-file', file], PUBLISH))).trim();
    const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
    if (!Number.isSafeInteger(number)) throw new ForgeError('gh gave no pull request address');
    return { number, url };
  }

  async pullRequestBody(repo: string, pr: number): Promise<string> {
    checkRepo(repo);
    checkPr(pr);
    const seen = json(await this.#gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'body'], PUBLISH), 'gh pr view') as { body?: unknown } | null;
    return typeof seen?.body === 'string' ? seen.body : '';
  }

  async editPullRequestBody(repo: string, pr: number, body: string): Promise<void> {
    checkRepo(repo);
    checkPr(pr);
    await this.#withBody(body, (file) => this.#gh(['pr', 'edit', String(pr), '--repo', repo, '--body-file', file], PUBLISH));
  }

  async pullRequest(repo: string, pr: number): Promise<PullRequestSeen> {
    checkRepo(repo);
    checkPr(pr);
    const seen = json(await this.#gh(['pr', 'view', String(pr), '--repo', repo, '--json', 'state,headRefName'], CLOSE), 'gh pr view') as { state?: unknown; headRefName?: unknown } | null;
    if (typeof seen?.state !== 'string' || typeof seen.headRefName !== 'string') throw new ForgeError('gh pr view gave no state and no branch');
    const state = ({ OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' } as const)[seen.state as 'OPEN' | 'CLOSED' | 'MERGED'];
    if (!state) throw new ForgeError(`gh pr view gave an unknown state (${seen.state.slice(0, 40)})`);
    return { state, head: seen.headRefName };
  }

  async headCommit(repo: string | undefined, pr: number): Promise<string> {
    if (repo !== undefined) checkRepo(repo);
    checkPr(pr);
    const where = repo === undefined ? [] : ['--repo', repo];
    const seen = json(await this.#gh(['pr', 'view', String(pr), ...where, '--json', 'headRefOid'], HEAD), 'gh pr view') as { headRefOid?: unknown } | null;
    if (typeof seen?.headRefOid !== 'string') throw new ForgeError('gh pr view gave no head');
    return seen.headRefOid;
  }

  async checks(repo: string, pr: number): Promise<ChecksState> {
    checkRepo(repo);
    checkPr(pr);
    return checksOf(json(await this.#gh(['pr', 'checks', String(pr), '--repo', repo, '--json', 'bucket'], CHECKS), 'gh pr checks') as { bucket: string }[]);
  }

  // Each GitHub Actions job's failed steps' log, cut to its end, for the
  // first five failed checks; a log that cannot be read is left out, the
  // check's name stays.
  async failedChecks(repo: string, pr: number): Promise<CiFailures> {
    checkRepo(repo);
    checkPr(pr);
    const read = (args: readonly string[]) => this.#gh([...args, '--repo', repo], FAILURES);
    const failures = failedChecks(json(await read(['pr', 'view', String(pr), '--json', 'headRefOid,statusCheckRollup']), 'gh pr view'));
    const checks = [];
    for (const check of failures.checks.slice(0, 5)) {
      const job = jobOf(check.url);
      const log = job ? await read(['run', 'view', '--job', job, '--log-failed']).then((out) => logTail(out), () => null) : null;
      checks.push({ ...check, log });
    }
    return { head: failures.head, checks: [...checks, ...failures.checks.slice(5)] };
  }

  async closePullRequest(repo: string, pr: number, comment: string): Promise<void> {
    checkRepo(repo);
    checkPr(pr);
    await this.#gh(['pr', 'close', String(pr), '--repo', repo, '--comment', comment], CLOSE);
  }
}
