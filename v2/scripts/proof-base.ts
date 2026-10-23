// The clean base of the multi-service proof (scripts/proof-j2-multi.ts):
// each run starts from the same commits, recreated automatically, and
// never by a push to main. Each proof repository keeps a frozen base
// branch, only ever read, and a run branch, recreated from it at the start
// of every run: the workspace's `base`, the release brokers' `[lanes] base`
// and the deploy watchers' `--branch` all name the run branch, so the
// tickets merge into it, the rollbacks revert on it and the watchers deploy
// it. The setup, done once, is in docs/v2/proof-clean-base.md.
//
// At the start of a run, in this order:
//   1. the earlier runs' tickets are set aside (POST /api/tickets/:id/set-aside),
//      so that none of them has a live session or anything waiting in the inbox;
//   2. each repository's open pull requests into the run branch are closed:
//      they were opened against a run branch that is about to be recreated;
//   3. each run branch is recreated from its frozen branch, with an explicit
//      refspec, after the guards below;
//   4. the run waits until each watcher deploys the frozen commit and each
//      service's health answers.
// The guards fail closed. They refuse a run branch that does not start with
// proof-, or is named main or master, or is the repository's default
// branch, or one whose default branch cannot be read, or the frozen branch
// itself, or one the workspace does not name as every service's base; a
// workspace whose base is main or master for any service; and a frozen
// commit that already holds a change one of the proof's tickets asks for
// (an empty contract diff never makes the inbox item step 3 waits for).
// A real run without PROOF_REPOS is refused: it would merge into whatever
// the workspace names. PROOF_REPOS=none skips the reset, in the rehearsal only.
//
//   PROOF_REPOS          service=<absolute path of a clone>[,...]: a clone of each
//                        proof repository that may push its run branch; required by
//                        a real run; none, in the rehearsal only, skips the reset
//   PROOF_REMOTE         the clones' remote (default origin)
//   PROOF_BASE_BRANCH    the frozen base branch (default proof-base)
//   PROOF_RUN_BRANCH     the run branch (default proof-run; always proof-<something>)
//   PROOF_DEPLOY_MINUTES how long the watchers have to deploy the base (default 10)
import { spawn } from 'node:child_process';

export const FROZEN_BRANCH = 'proof-base';
export const RUN_BRANCH = 'proof-run';
// Branches a run never writes, whatever the settings say; a run branch is always proof-<something>.
const NEVER = new Set(['main', 'master']);
export const RUN_PREFIX = 'proof-';
const runName = (name: string): boolean => name.startsWith(RUN_PREFIX) && name.length > RUN_PREFIX.length;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

export type ProofRepo = { readonly service: string; readonly clone: string };
export type BaseSettings = { readonly frozen: string; readonly run: string; readonly remote: string; readonly repos: readonly ProofRepo[]; readonly deployMs: number };

export class BaseError extends Error {
  override name = 'BaseError';
}

// What the run does with the base, from the environment: a real run needs
// PROOF_REPOS, and PROOF_REPOS=none is the rehearsal's only (it skips the
// reset of its own bare copies). Throws BaseError, which stops the run.
export type BaseMode = { readonly kind: 'reset'; readonly settings: BaseSettings | undefined } | { readonly kind: 'none' };
export function baseModeOf(env: NodeJS.ProcessEnv, rehearsal: boolean): BaseMode {
  const text = env.PROOF_REPOS?.trim() ?? '';
  if (rehearsal) {
    if (text === '') return { kind: 'reset', settings: undefined };        // the rehearsal's own copies
    if (text === 'none') return { kind: 'none' };
    throw new BaseError('PROOF_REPOS: the rehearsal resets its own bare copies; set it to none to skip that, or leave it unset');
  }
  if (text === '') throw new BaseError('PROOF_REPOS is not set: a real run starts from its clean base (docs/v2/proof-clean-base.md), so it names a clone of each proof repository');
  if (text === 'none') throw new BaseError('PROOF_REPOS=none is for the rehearsal only: a real run always starts from its clean base');
  return { kind: 'reset', settings: readBaseSettings(env) };
}

// The settings from the environment, or undefined when PROOF_REPOS is unset.
export function readBaseSettings(env: NodeJS.ProcessEnv): BaseSettings | undefined {
  const text = env.PROOF_REPOS?.trim();
  if (!text) return undefined;
  const repos = text.split(',').map((pair) => pair.trim()).filter(Boolean).map((pair) => {
    const at = pair.indexOf('=');
    const service = pair.slice(0, at).trim();
    const clone = pair.slice(at + 1).trim();
    if (at < 1 || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(service) || !clone.startsWith('/')) throw new BaseError(`PROOF_REPOS: "${pair}" is not service=<absolute path of a clone>`);
    return { service, clone };
  });
  if (new Set(repos.map((r) => r.service)).size !== repos.length) throw new BaseError('PROOF_REPOS names a service twice');
  const minutes = Number(env.PROOF_DEPLOY_MINUTES ?? 10);
  if (!Number.isFinite(minutes) || minutes <= 0) throw new BaseError('PROOF_DEPLOY_MINUTES must be a positive number');
  const remote = env.PROOF_REMOTE?.trim() || 'origin';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new BaseError(`PROOF_REMOTE is not a remote name: "${remote}"`);
  return { frozen: env.PROOF_BASE_BRANCH?.trim() || FROZEN_BRANCH, run: env.PROOF_RUN_BRANCH?.trim() || RUN_BRANCH, remote, repos, deployMs: minutes * 60_000 };
}

// Why the run branch may not be recreated, or undefined when it may.
// `defaults` holds each repository's default branch, as its remote says
// (null when it could not be read: refused); `bases` each service's base,
// as the workspace says (GET /api/workspace).
export function refusal(settings: Pick<BaseSettings, 'frozen' | 'run' | 'repos'>, bases: Readonly<Record<string, string>>, defaults: Readonly<Record<string, string | null>>): string | undefined {
  const { frozen, run } = settings;
  for (const [what, name] of [['the run branch', run], ['the frozen branch', frozen]] as const)
    if (!BRANCH.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) return `${what} is not a branch name: "${name}"`;
  if (NEVER.has(run)) return `the run branch is ${run}: a run never writes main or master`;
  if (!runName(run)) return `the run branch is ${run}: a run branch is always ${RUN_PREFIX}<something>`;
  if (run === frozen) return `the run branch and the frozen branch are both ${run}: the frozen branch is only ever read`;
  const services = Object.keys(bases);
  const onMain = services.filter((s) => NEVER.has(bases[s] as string));
  if (onMain.length > 0) return `the workspace's base of ${onMain.map((s) => `${s} is ${bases[s]}`).join(', ')}: the proof's tickets would merge into it; point the workspace at ${run} (docs/v2/proof-clean-base.md)`;
  if (settings.repos.length === 0) return 'no proof repository is named';
  const missing = services.filter((s) => !settings.repos.some((r) => r.service === s));
  if (missing.length > 0) return `no clone is named for ${missing.join(', ')}: every service of the workspace starts from its frozen branch`;
  for (const repo of settings.repos) {
    const base = bases[repo.service];
    if (base === undefined) return `${repo.service} is not a service of the workspace`;
    if (base !== run) return `the workspace's base of ${repo.service} is ${base}, not ${run}: the run would not merge into the branch it recreates`;
    const fallback = defaults[repo.service];
    if (fallback === undefined || fallback === null) return `the default branch of ${repo.service}'s repository could not be read: the run branch is not recreated without knowing it`;
    if (fallback === run) return `${run} is the default branch of ${repo.service}'s repository: a run never recreates it`;
  }
  return undefined;
}

// The provoked failure of ticket 2 (examples/guestbook/src/config.ts):
// the guestbook's /health answers 503 once its config turns it on.
export function breaksHealth(configText: string): boolean {
  return /^export const PROOF_BREAK_HEALTH: boolean = true;/m.test(configText);
}

// What the frozen commit of a service already holds of the proof's
// tickets, read through `read` (a file at that commit, or undefined).
export async function ticketChangesIn(service: string, read: (path: string) => Promise<string | undefined>): Promise<string[]> {
  const found: string[] = [];
  if (service === 'filter-api') {
    const contract = await read('contract/openapi.yaml') ?? '';
    for (const word of ['severity', 'positions']) if (new RegExp(`\\b${word}\\b`).test(contract)) found.push(`contract/openapi.yaml already has ${word}`);
    if (/^casino$/im.test(await read('words.txt') ?? '')) found.push('words.txt already has casino');
  }
  if (service === 'guestbook') {
    if (breaksHealth(await read('src/config.ts') ?? '')) found.push('src/config.ts already turns PROOF_BREAK_HEALTH on');
    if (/\bseverity\b/.test(await read('src/filter.ts') ?? '')) found.push('src/filter.ts already reads severity');
  }
  return found;
}

// ---- git and gh, without a shell ---------------------------------------------

export type Run = (command: 'git' | 'gh', args: readonly string[], cwd: string) => Promise<string>;

export const runCommand: Run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GH_PROMPT_DISABLED: '1' } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      // The first line of stderr only: it names what failed, never a token.
      else reject(new Error(`${command} ${args[0]} exited with ${code}: ${Buffer.concat(err).toString('utf8').split('\n')[0] ?? ''}`));
    });
  });

// The repository's default branch, as `git ls-remote --symref <remote> HEAD` says it.
export function defaultBranchOf(lsRemote: string): string | null {
  return /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(lsRemote)?.[1] ?? null;
}

// The frozen commit of each repository, read without changing anything.
export async function frozenCommits(run: Run, settings: BaseSettings): Promise<{ readonly commits: Record<string, string>; readonly defaults: Record<string, string | null> }> {
  const commits: Record<string, string> = {};
  const defaults: Record<string, string | null> = {};
  for (const repo of settings.repos) {
    const git = (...args: string[]) => run('git', args, repo.clone);
    defaults[repo.service] = defaultBranchOf(await git('ls-remote', '--symref', settings.remote, 'HEAD'));
    await git('fetch', '--quiet', '--no-tags', settings.remote, `+refs/heads/${settings.frozen}:refs/remotes/${settings.remote}/${settings.frozen}`);
    const commit = (await git('rev-parse', '--verify', '--quiet', `refs/remotes/${settings.remote}/${settings.frozen}^{commit}`)).trim();
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new BaseError(`${repo.service}: the frozen branch ${settings.frozen} is not a commit`);
    commits[repo.service] = commit;
  }
  return { commits, defaults };
}

// Reads a file of a commit in a clone; undefined when the commit has none.
export const reader = (run: Run, clone: string, commit: string) => async (path: string): Promise<string | undefined> =>
  await run('git', ['show', `${commit}:${path}`], clone).catch(() => undefined);

// The open pull requests into the run branch, closed: none of them survives
// the recreation of the branch it was opened against.
export async function closeStale(run: Run, repo: ProofRepo, branch: string): Promise<number[]> {
  const listed = JSON.parse(await run('gh', ['pr', 'list', '--base', branch, '--state', 'open', '--limit', '100', '--json', 'number,baseRefName'], repo.clone)) as { number: number; baseRefName: string }[];
  const stale = listed.filter((pr) => pr.baseRefName === branch && Number.isInteger(pr.number)).map((pr) => pr.number);
  for (const pr of stale) await run('gh', ['pr', 'close', String(pr)], repo.clone);
  return stale;
}

// The run branch recreated at the frozen commit: the only push a run makes,
// to refs/heads/<run>, named in full. The guards are checked again here.
export async function recreate(run: Run, repo: ProofRepo, settings: BaseSettings, commit: string, defaultBranch: string | null): Promise<void> {
  if (defaultBranch === null) throw new BaseError(`${repo.service}: the default branch could not be read, so nothing is pushed`);
  if (NEVER.has(settings.run) || !runName(settings.run) || settings.run === settings.frozen || settings.run === defaultBranch) throw new BaseError(`${repo.service}: ${settings.run} is never pushed by a run`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new BaseError(`${repo.service}: not a commit: ${commit}`);
  await run('git', ['push', '--quiet', '--force', settings.remote, `${commit}:refs/heads/${settings.run}`], repo.clone);
}
