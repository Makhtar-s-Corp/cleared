// The checkouts around a session (milestone 1 plan, lane 5, decision 12):
// the service's own checkout of the project, cloned once and fetched after,
// and one checkout per ticket on the ticket branch, made from the base. In a
// workspace of several services (milestone 2 plan, decision 20), a ticket
// has one checkout per service it touches, <workdirs>/<ticket>/<service>,
// each on the same branch; for a folder of a monorepo, the checkout is the
// whole repository and the session works in the folder (`cwd`). The
// ticket checkout is the session's workdir: a host folder mounted alone in
// the container, so it is a clone with a .git folder of its own (no linked
// worktree, no alternates, no hard links into the project checkout).
//
// Every git call here runs without hooks, fsmonitor, pager, editor or
// prompt. Once a session has run, its checkout is written by the session:
// what the host does in it afterwards is limited to reading files without
// git (see readHead) and to the safe write of ensureExcluded.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeSync, constants } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export class CheckoutError extends Error {
  override name = 'CheckoutError';
}

// Where the base the ticket branch started from is kept in the ticket
// checkout: the runner's hook diffs against it (images/session/runner/hooks.ts).
export const BASE_REF = 'refs/cleared/base';

// Generated or captured by Cleared, never part of the project's history.
export const EXCLUDED = ['/CLAUDE.md', '/HANDOVER.md', '/.cursor/'] as const;

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
  readonly path?: string;               // a folder of a monorepo: the service's folder in the repository
};

export type TicketCheckout = {
  readonly workdir: string;
  readonly branch: string;
  readonly reused: boolean;             // true when the checkout was already there, on its branch
  readonly cwd: string;                 // where the session works: the workdir, or the service's folder in it
};

// A folder inside the repository: relative, and never above it.
function checkFolder(path: string): void {
  if (!path || isAbsolute(path) || path.split('/').some((part) => part === '' || part === '.' || part === '..'))
    throw new CheckoutError(`"${path}" is not a folder inside the repository`);
}

// The service's folder in a checkout: every part a plain folder, never a
// link, since the session writes the checkout.
function folderIn(workdir: string, path: string | undefined): string {
  if (path === undefined) return workdir;
  let dir = workdir;
  for (const part of path.split('/')) {
    dir = join(dir, part);
    if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new CheckoutError(`${path} is not a folder of the checkout ${workdir}`);
  }
  return dir;
}

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
  if (input.path !== undefined) checkFolder(input.path);
  if (existsSync(input.workdir)) {
    if (!existsSync(join(input.workdir, '.git'))) throw new CheckoutError(`${input.workdir} exists and is not a ticket checkout`);
    const branch = readHead(input.workdir);
    if (branch !== input.branch) throw new CheckoutError(`${input.workdir} is on ${branch ?? 'no branch'}, not on ${input.branch}`);
    ensureExcluded(input.workdir);
    return { workdir: input.workdir, branch: input.branch, reused: true, cwd: folderIn(input.workdir, input.path) };
  }
  const url = (await git(input.project, ['remote', 'get-url', 'origin'])).trim();
  checkUrl(url);
  const base = `refs/remotes/origin/${input.base}`;
  await git(input.project, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  mkdirSync(dirname(input.workdir), { recursive: true });
  // Made in a sibling folder, then renamed: a checkout that fails half way
  // is removed, never left where the next call would take it for one to reuse.
  const partial = join(dirname(input.workdir), `.${basename(input.workdir)}.partial-${randomUUID()}`);
  try {
    // Cloned from the local project checkout: no network, no credential.
    // --no-local copies only what its branches reach, through git's own
    // transport: no hard link the session could write through, and no object
    // another ref holds there (a refused publish) reaches the session.
    await git(dirname(input.workdir), ['clone', '--quiet', '--no-local', '--no-checkout', '--origin', 'origin', '--no-recurse-submodules', '--', input.project, partial]);
    // The clone's origin/<base> is the project checkout's local branch; the
    // base is what the project checkout last fetched from the forge.
    await git(partial, ['fetch', '--quiet', '--no-tags', input.project, `+${base}:${base}`]);
    await git(partial, ['update-ref', BASE_REF, base]);
    await git(partial, ['checkout', '--quiet', '--no-track', '-b', input.branch, base]);
    await git(partial, ['remote', 'set-url', 'origin', url]);
    ensureExcluded(partial);
    renameSync(partial, input.workdir);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error instanceof CheckoutError ? error : new CheckoutError(`the ticket checkout ${input.workdir} could not be made: ${(error as Error).message}`);
  }
  return { workdir: input.workdir, branch: input.branch, reused: false, cwd: folderIn(input.workdir, input.path) };
}

export type BaseExport = {
  readonly dir: string;                 // <root>/<commit>
  readonly commit: string;
};

// The files of the base branch, as the service's checkout last fetched it,
// written once per commit under `root`, without .git: what a sibling's base
// layer is built from, its contract and the project's skills are read from
// (decisions 20 and 27). Landed code only: never the checkout's working
// tree, never a ticket checkout. With `only`, that folder of the repository
// alone, its content at the top; undefined when the base has no such folder.
export async function exportBase(input: { readonly project: string; readonly base: string; readonly root: string; readonly only?: string }): Promise<BaseExport | undefined> {
  checkPath(input.project, 'project checkout');
  checkPath(input.root, 'export folder');
  await checkBranchName(input.base, 'base branch');
  if (input.only !== undefined) checkFolder(input.only);
  const commit = (await git(input.project, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${input.base}^{commit}`])).trim();
  if (input.only !== undefined && !(await git(input.project, ['ls-tree', '-d', commit, '--', input.only])).trim()) return undefined;
  const dir = join(input.root, commit);
  if (existsSync(dir)) return { dir, commit };
  mkdirSync(input.root, { recursive: true });
  // Written in a sibling folder, then renamed, as a ticket checkout is.
  const partial = join(input.root, `.${commit}.partial-${randomUUID()}`);
  const archive = `${partial}.tar`;
  try {
    mkdirSync(partial);
    await git(input.project, ['archive', '--format=tar', '-o', archive, commit, ...(input.only === undefined ? [] : ['--', input.only])]);
    const strip = input.only === undefined ? [] : [`--strip-components=${input.only.split('/').length}`];
    await run('tar', ['-x', '--no-same-owner', '-f', archive, '-C', partial, ...strip]);
    renameSync(partial, dir);
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    if (existsSync(dir)) return { dir, commit };      // another start exported it first
    throw error instanceof CheckoutError ? error : new CheckoutError(`the base of ${input.project} could not be exported: ${(error as Error).message}`);
  } finally {
    rmSync(archive, { force: true });
  }
  return { dir, commit };
}
