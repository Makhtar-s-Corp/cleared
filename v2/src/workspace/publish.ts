// The publish step (milestone 1 plan, lane 5, decision 12): the ticket
// branch leaves the machine from the host, after the repository's guard,
// with the forge credential, as v1's push-lane.sh did it. Nothing from the
// session's container ever holds that credential.
//
// The ticket checkout was written by the session, its .git folder included
// (config, hooks, remotes), so no git command runs in it. The service's own
// project checkout fetches the branch out of it into a private ref, and
// every read, the guard and the push are done from there:
//   1. refuse the base branch, a git folder that points elsewhere, a branch
//      with no commit of its own, and a branch whose history carries
//      HANDOVER.md or CLAUDE.md;
//   2. run lib/guard/codex-guard.ts (--strict) on the commit messages and
//      on the lines each commit adds, with the private-term lists the
//      project commits at the base ([guard] terms and allowed); nothing
//      leaves when it refuses or when the project names no list;
//   3. push the branch to the branch of the same name, never forced;
//   4. reuse the open pull request of the branch, or open one on the
//      service's forge (src/forge/, GitHub through gh by default):
//      not a draft (merge-pr.ts refuses a draft), its body the session's
//      report as lib/pr-body.ts cleans it, left out when the guard refuses
//      it, then the commits; the proof receipt first (P210, flow/receipt.ts),
//      in the project's language ([owner] language at the base), guarded on
//      its own and left out when the guard refuses it. A reused pull
//      request gets the new receipt in place of the old one.
import { execFile, spawn } from 'node:child_process';
import { copyFileSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CheckoutError, checkBranchName, git, gitPath } from './checkout.ts';
import { renderReceipt, withReceipt, type ReceiptData } from '../flow/receipt.ts';
import { ForgeError, type Forge } from '../forge/contract.ts';
import { forgeFor } from '../forge/index.ts';

const run = promisify(execFile);

export type RefusalCode = 'base' | 'unsafe' | 'empty' | 'generated' | 'guard';

export class PublishRefused extends Error {
  override name = 'PublishRefused';
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class PublishError extends Error {
  override name = 'PublishError';
}

// The repository's root, which holds lib/.
const CLEARED_URL = new URL('../../../', import.meta.url);
const CLEARED = fileURLToPath(CLEARED_URL);
const DISABLED = '{"disabled":true,"hashes":[]}\n';

export type PublishInput = {
  readonly project: string;               // the service's project checkout (origin is the forge)
  readonly workdir: string;               // the ticket checkout the session worked in
  readonly base: string;
  readonly branch: string;
  readonly repo: string;                  // owner/name on the forge
  readonly ticket: string;
  readonly report?: string;               // the session's report for the body
  readonly receipt?: ReceiptData;         // the proof receipt's facts, first in the body
  readonly gitEnv?: NodeJS.ProcessEnv;    // forgeEnv of lib/forge.ts; read from it when absent
  readonly ghEnv?: NodeJS.ProcessEnv;     // forgeGhEnv of lib/forge.ts; read from it when absent
  readonly forge?: Forge;                 // GitHub in the project checkout with ghEnv when absent
};

export type Published = {
  readonly url: string;
  readonly number: number;
  readonly head: string;                  // the commit pushed
  readonly created: boolean;              // false when an open pull request was reused
};

// A child of this process, its stdout as text. Its stderr is only kept in
// the error, cut short: the guard prints positions and categories, never a
// value.
async function command(file: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  try {
    const { stdout } = await run(file, [...args], { ...options, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    throw new PublishError(`${file} ${args[0] ?? ''} failed: ${stderr.slice(-2000) || (error as Error).message}`);
  }
}

function confSetting(conf: string, section: string, key: string): string | undefined {
  let inSection = false;
  for (const raw of conf.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) inSection = line === `[${section}]`;
    else if (inSection && !line.startsWith('#') && line.includes('=') && line.slice(0, line.indexOf('=')).trim() === key)
      return line.slice(line.indexOf('=') + 1).trim();
  }
  return undefined;
}

// The repository's guard on `files`, in its --strict mode, with the
// project's lists read at `ref`, laid out as v1's guard_text lays them
// out (lib/common.sh). Undefined when it lets them out; else what it said.
export async function runGuard(project: string, ref: string, files: readonly string[]): Promise<string | undefined> {
  const tool = mkdtempSync(join(tmpdir(), 'cleared-v2-publish-guard-'));
  try {
    for (const name of ['codex-guard.ts', 'private-terms.ts']) copyFileSync(join(CLEARED, 'lib', 'guard', name), join(tool, name));
    let conf: string;
    try { conf = await git(project, ['show', `${ref}:.cleared/agents.conf`]); }
    catch { throw new PublishRefused('guard', `the project commits no .cleared/agents.conf at ${ref}: nothing leaves without the guard's lists`); }
    for (const [key, list] of [['terms', 'private-terms.json'], ['allowed', 'codex-guard-allow.json']] as const) {
      const value = confSetting(conf, 'guard', key);
      if (!value) throw new PublishRefused('guard', `the project names no list for [guard] ${key} at ${ref}: write the file path or none`);
      let text = DISABLED;
      if (value.toLowerCase() !== 'none') {
        try { text = await git(project, ['show', `${ref}:${value}`]); }
        catch { throw new PublishRefused('guard', `the list [guard] ${key} of the project (${value} at ${ref}) cannot be read`); }
      }
      writeFileSync(join(tool, list), text);
    }
    const env = { ...process.env, CLEARED_REPO: project, ORCH_REPO: project, ORCH_GUARD_REF: ref };
    try {
      await run(process.execPath, [join(tool, 'codex-guard.ts'), '--strict', ...files], { env, encoding: 'utf8' });
      return undefined;
    } catch (error) {
      return String((error as { stderr?: unknown }).stderr ?? '').trim() || 'the guard stopped without saying why';
    }
  } finally {
    rmSync(tool, { recursive: true, force: true });
  }
}

// What a diff adds, as v1's push-lane.sh handed it to the guard: the name
// of each file and the added lines; no removed line, and not the old text
// git quotes after the @@ of a hunk.
export function addedLines(diff: string): string {
  return diff.split('\n').filter((line) => !line.startsWith('-')).map((line) => line.replace(/^(@@ [^@]* @@).*/, '$1')).join('\n');
}

// The forge's environments, from lib/forge.ts in a child process (it
// reads the project's settings at import): the one git pushes with, which
// carries the credential helper and never the token, and the one gh runs
// with, which carries the token. With no app configured, both are the
// ambient environment.
export function forgeEnvironments(project: string, env: NodeJS.ProcessEnv = process.env): Promise<{ git: NodeJS.ProcessEnv; gh: NodeJS.ProcessEnv }> {
  const program = `
const { loadConf } = await import(${JSON.stringify(new URL('lib/conf.ts', CLEARED_URL).href)});
const { forgeEnv, forgeGhEnv } = await import(${JSON.stringify(new URL('lib/forge.ts', CLEARED_URL).href)});
try {
  const conf = loadConf();
  process.stdout.write(JSON.stringify({ git: forgeEnv(conf), gh: forgeGhEnv(conf) }));
} catch (error) { process.stderr.write(String(error && error.message || error)); process.exitCode = 1; }
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', program], { env: { ...env, CLEARED_REPO: project }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new PublishError(`forge: ${stderr.trim() || `exit ${code}`}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new PublishError('forge: the answer is not JSON')); }
    });
  });
}

// The receipt in the project's language, or empty when the guard refuses
// it: it is made of structured fields only, so a refusal is a bug, and the
// pull request still opens without it.
async function receiptFor(input: PublishInput, base: string, file: string): Promise<string> {
  if (!input.receipt) return '';
  let conf = '';
  try { conf = await git(input.project, ['show', `${base}:.cleared/agents.conf`]); } catch { /* runGuard said so already */ }
  const language = confSetting(conf, 'owner', 'language')?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
  const receipt = renderReceipt(input.receipt, language);
  writeFileSync(file, receipt);
  if ((await runGuard(input.project, base, [file])) === undefined) return receipt;
  console.error(`cleared-v2: the proof receipt of ${input.ticket} was left out: the guard refuses it`);
  return '';
}

// The report as lib/pr-body.ts cleans it: no path of this machine, no
// token-shaped word, cut to its limits. Empty when there is none.
async function cleanReport(report: string, file: string, project: string): Promise<string> {
  if (!report.trim()) return '';
  writeFileSync(file, report, { mode: 0o600 });
  return (await command(process.execPath, ['--no-warnings', join(CLEARED, 'lib', 'pr-body.ts'), file], { cwd: project, env: { ...process.env, CLEARED_REPO: project } })).trim();
}

export async function publish(input: PublishInput): Promise<Published> {
  try {
    await checkBranchName(input.base, 'base branch');
    await checkBranchName(input.branch, 'ticket branch');
  } catch (error) {
    throw new PublishRefused('base', (error as Error).message);
  }
  if (input.branch === input.base) throw new PublishRefused('base', `the base branch ${input.base} is never published from a session`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo)) throw new PublishError(`"${input.repo}" is not owner/name`);

  // A real .git folder of its own: no gitdir file, no linked worktree, no
  // alternates that would serve another repository's objects.
  try {
    // gitPath accepts a missing last part; lstat does not.
    lstatSync(gitPath(input.workdir, [], 'dir'));
    for (const parts of [['commondir'], ['objects', 'info', 'alternates']]) {
      let present = true;
      try { lstatSync(join(input.workdir, '.git', ...parts)); }
      catch { present = false; }
      if (present) throw new CheckoutError(`.git/${parts.join('/')} is present`);
    }
  } catch (error) {
    throw new PublishRefused('unsafe', `the ticket checkout ${input.workdir} cannot be read safely: ${(error as Error).message}`);
  }

  const base = `refs/remotes/origin/${input.base}`;
  const ref = `refs/cleared/publish/${input.branch}`;
  try {
    // The session wrote these objects: each one is checked as it comes in.
    await git(input.project, ['-c', 'protocol.file.allow=always', '-c', 'transfer.fsckObjects=true', '-c', 'fetch.fsckObjects=true',
      'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head',
      join(input.workdir, '.git'), `+refs/heads/${input.branch}:${ref}`]);
  } catch (error) {
    const message = (error as Error).message;
    if (/fsck/.test(message)) throw new PublishRefused('unsafe', `the branch ${input.branch} carries an object git's checks refuse: ${message}`);
    throw new PublishRefused('empty', `the branch ${input.branch} cannot be read from the ticket checkout: ${message}`);
  }
  const head = (await git(input.project, ['rev-parse', '--verify', `${ref}^{commit}`])).trim();
  const range = `${base}..${ref}`;
  if ((await git(input.project, ['rev-list', '--count', range])).trim() === '0')
    throw new PublishRefused('empty', `${input.branch} has no commit of its own: nothing to publish`);
  if ((await git(input.project, ['log', '--full-history', '--format=', '--name-only', range, '--', 'HANDOVER.md', 'CLAUDE.md'])).trim())
    throw new PublishRefused('generated', `${input.branch} not published: HANDOVER.md or CLAUDE.md is in one of its commits; remove it from the branch history`);

  const work = mkdtempSync(join(tmpdir(), 'cleared-v2-publish-'));
  try {
    return await guardPushOpen(input, { base, ref, range, head, work });
  } finally {
    rmSync(work, { recursive: true, force: true });
    // The private ref goes, so a refused branch is not kept reachable here.
    await git(input.project, ['update-ref', '-d', ref]).catch(() => undefined);
  }
}

async function guardPushOpen(input: PublishInput, at: { base: string; ref: string; range: string; head: string; work: string }): Promise<Published> {
  const { base, ref, range, head, work } = at;
  // 2. What leaves with the push and the pull request, checked first.
  const messages = join(work, 'messages.txt');
  const changes = join(work, 'changes.diff');
  writeFileSync(messages, await git(input.project, ['log', '--format=%B', range]));
  // Every commit's own diff, not the branch's net one: a secret one commit
  // adds and a later one removes is still in the history that is pushed. A
  // merge is read against its first parent.
  writeFileSync(changes, addedLines(await git(input.project, ['log', '--patch', '--unified=0', '--no-ext-diff', '--no-textconv', '--no-color', '--format=', '--diff-merges=first-parent', range])));
  const refused = await runGuard(input.project, base, [messages, changes]);
  if (refused !== undefined)
    throw new PublishRefused('guard', `${input.branch} not published: the guard refuses it (input no. 1 is the commit messages, no. 2 the changes)\n${refused}`);

  const environments = input.gitEnv && input.ghEnv ? { git: input.gitEnv, gh: input.ghEnv } : await forgeEnvironments(input.project);
  const gitEnv = input.gitEnv ?? environments.git;
  const ghEnv = input.ghEnv ?? environments.gh;

  // 3. The branch to the branch of the same name, and only that, never forced.
  await git(input.project, ['push', '--quiet', 'origin', `${ref}:refs/heads/${input.branch}`], gitEnv);

  // 4. The pull request.
  const forge = input.forge ?? forgeFor('github', { dir: input.project, env: ghEnv });
  const existing = await forge.openPullRequestOf(input.repo, input.branch).catch((error: unknown) => {
    throw error instanceof ForgeError ? new PublishError(error.message) : error;
  });
  const receipt = await receiptFor(input, base, join(work, 'receipt.md'));
  if (existing) {
    if (receipt) {
      // The branch is pushed: a receipt that cannot be put in place is said, and the pull request stays as it is.
      try {
        const seen = await forge.pullRequestBody(input.repo, existing.number);
        await forge.editPullRequestBody(input.repo, existing.number, withReceipt(seen, receipt));
      } catch (error) {
        console.error(`cleared-v2: the proof receipt of pull request ${existing.number} was not updated (${error instanceof Error ? error.name : typeof error})`);
      }
    }
    return { url: existing.url, number: existing.number, head, created: false };
  }

  const subjects = (await git(input.project, ['log', '--reverse', '--format=%s', range])).split('\n').filter(Boolean);
  const bare = `Opened by Cleared for ${input.ticket} (branch \`${input.branch}\`).\n\nCommits:\n${subjects.map((s) => `- ${s}`).join('\n')}\n`;
  const report = await cleanReport(input.report ?? '', join(work, 'report.md'), input.project);
  const file = join(work, 'body.md');
  const first = (text: string) => (receipt ? withReceipt(text, receipt) : text);
  let body = first(report ? `${report}\n\n---\n\n${bare}` : bare);
  writeFileSync(file, body);
  if (report && (await runGuard(input.project, base, [file])) !== undefined) body = first(bare);

  try {
    const opened = await forge.createPullRequest({ repo: input.repo, base: input.base, head: input.branch, title: subjects[0] ?? input.branch, body });
    return { url: opened.url, number: opened.number, head, created: true };
  } catch (error) {
    throw error instanceof ForgeError ? new PublishError(`${input.branch} is pushed, but ${error.message}`) : error;
  }
}
