// The pull request of a closed ticket (issue #249, P114, owner decision of
// 2026-10-24 23:51): a Close also closes the ticket's pull request on the
// forge, with a comment that gives the reason, and never deletes the branch.
// Done on the host through gh, where the forge's credential is, as the CI
// repair reads a pull request (P77, flow/ci-repair.ts). Only a pull request
// whose head is one of the ticket's own branches is closed (the ones
// Cleared pushes), never one on the base branch or on main; one already
// closed or merged is left alone, so a second Close does nothing.
import { execFile } from 'node:child_process';
import { onBase } from './ci-repair.ts';

export type PrClose = 'closed' | 'already_closed' | 'already_merged';

export type PrCloseInput = {
  readonly pr: number;
  readonly repo: string;                          // owner/name
  readonly dir: string;                           // gh runs here
  readonly base: string;                          // the service's base branch
  readonly branches: readonly string[];           // the ticket's branches: the only heads that are closed
  readonly reason: string;
  readonly env: NodeJS.ProcessEnv;                // the forge's gh environment
};

// The pull request is not the ticket's, or its branch is a base branch.
export class PrCloseRefused extends Error {
  override readonly name = 'PrCloseRefused';
}

// What the pull request says. The reason is the owner's own words, written
// into the sentence so that it never starts like a flag.
export function closeComment(reason: string, branch: string): string {
  return `Closed from Cleared: ${reason.trim()}\n\nThe branch ${branch} is kept.`;
}

const gh = (args: readonly string[], input: PrCloseInput) => new Promise<string>((resolve, reject) => {
  execFile('gh', [...args], { cwd: input.dir, env: input.env, timeout: 30_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (!error) return resolve(stdout);
    reject(new Error(`gh pr ${args[1] ?? ''} failed: ${String(stderr).trim().slice(-300) || error.message}`));
  });
});

export async function closePullRequest(input: PrCloseInput): Promise<PrClose> {
  if (!Number.isSafeInteger(input.pr) || input.pr < 1) throw new PrCloseRefused(`${input.pr} is not a pull request number`);
  const seen = JSON.parse(await gh(['pr', 'view', String(input.pr), '--repo', input.repo, '--json', 'state,headRefName'], input)) as { state?: unknown; headRefName?: unknown };
  if (typeof seen.state !== 'string' || typeof seen.headRefName !== 'string') throw new Error('gh pr view gave no state and no branch');
  if (seen.state === 'MERGED') return 'already_merged';
  if (seen.state === 'CLOSED') return 'already_closed';
  if (seen.state !== 'OPEN') throw new Error(`gh pr view gave an unknown state (${seen.state.slice(0, 40)})`);
  const head = seen.headRefName;
  if (onBase(head, input.base)) throw new PrCloseRefused(`pull request #${input.pr} is on ${head}, a base branch: it is never closed from here`);
  if (!input.branches.includes(head)) throw new PrCloseRefused(`pull request #${input.pr} is on ${head}, not on a branch Cleared opened for this ticket`);
  await gh(['pr', 'close', String(input.pr), '--repo', input.repo, '--comment', closeComment(input.reason, head)], input);
  return 'closed';
}
