// The checkouts around a session (milestone 1 plan, lane 5, decision 12):
// the service's own checkout of the project, cloned once and fetched after,
// and one checkout per ticket on the ticket branch, made from the base. The
// ticket checkout is the session's workdir: a host folder mounted alone in
// the container, so it is a clone with a .git folder of its own (no linked
// worktree, no alternates, no hard links into the project checkout).
//
// Every git call here runs without hooks, fsmonitor, pager, editor or
// prompt. Once a session has run, its checkout is written by the session:
// what the host does in it afterwards is limited to reading files without
// git (see readHead) and to the safe write of ensureExcluded.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeSync, constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class CheckoutError extends Error {
  override name = 'CheckoutError';
}

// Where the base the ticket branch started from is kept in the ticket
// checkout: the runner's hook diffs against it (images/session/runner/hooks.ts).
export const BASE_REF = 'refs/cleared/base';

// Generated or captured by Cleared, never part of the project's history.
export const EXCLUDED = ['/CLAUDE.md', '/HANDOVER.md'] as const;

// Settings that would run a program, written into the command line so they
// win over any configuration file of the repository.
const SAFE_CONFIG = ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'core.pager=cat', 'core.editor=false', 'core.askPass=', 'commit.gpgSign=false'];

export async function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const childEnv: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'false' };
  delete childEnv.GIT_CONFIG_PARAMETERS;
  try {
    const { stdout } = await run('git', ['-C', cwd, ...SAFE_CONFIG.flatMap((entry) => ['-c', entry]), ...args], { env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim().split('\n').slice(-3).join(' ');
    throw new CheckoutError(`git ${args[0]} failed in ${cwd}: ${stderr || (error as Error).message}`);
  }
}

// The branch of a ticket: cleared/<ticket id>. A ticket id is one word of
// letters, digits, - and _, so the branch is always one git accepts.
export function ticketBranch(ticket: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ticket)) throw new CheckoutError(`"${ticket}" is not a ticket id (letters, digits, - and _)`);
  return `cleared/${ticket}`;
}

export async function checkBranchName(name: string, what: string): Promise<void> {
  if (!name || name.startsWith('-')) throw new CheckoutError(`the ${what} "${name}" is not a branch name`);
  try { await run('git', ['check-ref-format', '--branch', name]); }
  catch { throw new CheckoutError(`the ${what} "${name}" is not a branch name`); }
}

function checkPath(path: string, what: string): void {
  if (!isAbsolute(path)) throw new CheckoutError(`the ${what} ${path} is not an absolute path`);
}

// A URL that carries a password would sit in .git/config of every checkout.
function checkUrl(url: string): void {
  if (!url || url.startsWith('-')) throw new CheckoutError(`"${url}" is not a repository address`);
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url)) throw new CheckoutError('the repository address carries a password: give the forge credential to the service instead');
}

export type ProjectCheckoutInput = {
  readonly url: string;                 // the project's repository on the forge
  readonly dir: string;                 // the service's checkout of it
  readonly base: string;                // the project's base branch
  readonly env?: NodeJS.ProcessEnv;     // the forge environment for clone and fetch
};

export type ProjectCheckout = {
  readonly dir: string;
  readonly base: string;                // the commit of origin/<base>
};

// The service's checkout of the project: cloned when absent, fetched when
// present. A folder that holds another repository is refused.
export async function projectCheckout(input: ProjectCheckoutInput): Promise<ProjectCheckout> {
  checkUrl(input.url);
  checkPath(input.dir, 'project checkout');
  await checkBranchName(input.base, 'base branch');
  if (existsSync(input.dir)) {
    const origin = (await git(input.dir, ['remote', 'get-url', 'origin'], input.env)).trim();
    if (origin !== input.url) throw new CheckoutError(`the project checkout ${input.dir} is a clone of another repository`);
    await git(input.dir, ['fetch', '--quiet', '--prune', '--no-tags', '--no-recurse-submodules', 'origin'], input.env);
  } else {
    mkdirSync(dirname(input.dir), { recursive: true });
    await git(dirname(input.dir), ['clone', '--quiet', '--origin', 'origin', '--no-recurse-submodules', '--', input.url, input.dir], input.env);
  }
  const base = (await git(input.dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${input.base}^{commit}`], input.env)).trim();
  return { dir: input.dir, base };
}

export type TicketCheckoutInput = {
  readonly project: string;             // the service's project checkout
  readonly workdir: string;             // the ticket checkout, mounted in the session's container
  readonly base: string;
  readonly branch: string;              // ticketBranch(ticket)
};

export type TicketCheckout = {
  readonly workdir: string;
  readonly branch: string;
  readonly reused: boolean;             // true when the checkout was already there, on its branch
};

// A path inside the checkout's .git folder, refused when any part of it is
// a link or not the kind expected: the session can write that folder. The
// last part may be missing.
export function gitPath(workdir: string, parts: readonly string[], kind: 'file' | 'dir'): string {
  const names = ['.git', ...parts];
  let path = workdir;
  for (const [i, name] of names.entries()) {
    path = join(path, name);
    const last = i === names.length - 1;
    let stat;
    try { stat = lstatSync(path); }
    catch {
      if (last) return path;
      throw new CheckoutError(`${path} is missing from the checkout`);
    }
    const want = last ? kind : 'dir';
    if (stat.isSymbolicLink() || (want === 'file' ? !stat.isFile() : !stat.isDirectory()))
      throw new CheckoutError(`${path} is not a plain ${want === 'dir' ? 'folder' : 'file'} of the checkout`);
  }
  return path;
}

// The branch the checkout is on, read from .git/HEAD without running git.
function readHead(workdir: string): string | undefined {
  const path = gitPath(workdir, ['HEAD'], 'file');
  if (!existsSync(path)) return undefined;
  const head = readFileSync(path, 'utf8');
  return /^ref: refs\/heads\/(.+)\n?$/.exec(head)?.[1];
}

// /CLAUDE.md and /HANDOVER.md in .git/info/exclude, appended to what is
// there, never through a link.
export function ensureExcluded(workdir: string): void {
  gitPath(workdir, ['info'], 'dir');
  const info = join(workdir, '.git', 'info');
  if (!existsSync(info)) mkdirSync(info);
  const path = gitPath(workdir, ['info', 'exclude'], 'file');
  const present = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const missing = EXCLUDED.filter((line) => !present.split('\n').includes(line));
  if (missing.length === 0) return;
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  try { writeSync(fd, `${present && !present.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`); }
  finally { closeSync(fd); }
}

// The ticket checkout: a clone of the project checkout on the ticket branch,
// made from origin/<base>, with origin set to the project's forge address.
// Present and on its branch, it is reused as the session left it.
export async function ticketCheckout(input: TicketCheckoutInput): Promise<TicketCheckout> {
  checkPath(input.project, 'project checkout');
  checkPath(input.workdir, 'ticket checkout');
  await checkBranchName(input.base, 'base branch');
  await checkBranchName(input.branch, 'ticket branch');
  if (input.branch === input.base) throw new CheckoutError(`the base branch ${input.base} is never a ticket branch`);
  if (existsSync(input.workdir)) {
    if (!existsSync(join(input.workdir, '.git'))) throw new CheckoutError(`${input.workdir} exists and is not a ticket checkout`);
    const branch = readHead(input.workdir);
    if (branch !== input.branch) throw new CheckoutError(`${input.workdir} is on ${branch ?? 'no branch'}, not on ${input.branch}`);
    ensureExcluded(input.workdir);
    return { workdir: input.workdir, branch: input.branch, reused: true };
  }
  const url = (await git(input.project, ['remote', 'get-url', 'origin'])).trim();
  checkUrl(url);
  const base = `refs/remotes/origin/${input.base}`;
  await git(input.project, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  mkdirSync(dirname(input.workdir), { recursive: true });
  // Cloned from the local project checkout: no network, no credential.
  // --no-local copies only what its branches reach, through git's own
  // transport: no hard link the session could write through, and no object
  // another ref holds there (a refused publish) reaches the session.
  await git(dirname(input.workdir), ['clone', '--quiet', '--no-local', '--no-checkout', '--origin', 'origin', '--no-recurse-submodules', '--', input.project, input.workdir]);
  // The clone's origin/<base> is the project checkout's local branch; the
  // base is what the project checkout last fetched from the forge.
  await git(input.workdir, ['fetch', '--quiet', '--no-tags', input.project, `+${base}:${base}`]);
  await git(input.workdir, ['update-ref', BASE_REF, base]);
  await git(input.workdir, ['checkout', '--quiet', '--no-track', '-b', input.branch, base]);
  await git(input.workdir, ['remote', 'set-url', 'origin', url]);
  ensureExcluded(input.workdir);
  return { workdir: input.workdir, branch: input.branch, reused: false };
}
