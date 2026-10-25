// The pull request of a closed ticket (issue #249, P114, owner decision of
// 2026-10-24 23:51): a Close also closes the ticket's pull request on the
// forge, with a comment that gives the reason, and never deletes the branch.
// Done on the host through the service's forge (src/forge/), where the
// forge's credential is, as the CI repair reads a pull request (P77,
// flow/ci-repair.ts). Only a pull request whose head is one of the
// ticket's own branches is closed (the ones Cleared pushes), never one on
// the base branch or on main; one already closed or merged is left alone,
// so a second Close does nothing.
import type { Forge } from '../forge/contract.ts';
import { forgeFor } from '../forge/index.ts';
import { onBase } from './ci-repair.ts';

export type PrClose = 'closed' | 'already_closed' | 'already_merged';

export type PrCloseInput = {
  readonly pr: number;
  readonly repo: string;                          // owner/name
  readonly dir: string;                           // the forge's calls run here
  readonly base: string;                          // the service's base branch
  readonly branches: readonly string[];           // the ticket's branches: the only heads that are closed
  readonly reason: string;
  readonly env: NodeJS.ProcessEnv;                // the forge's gh environment
  readonly forge?: Forge;                         // GitHub in `dir` with `env` when absent
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

export async function closePullRequest(input: PrCloseInput): Promise<PrClose> {
  if (!Number.isSafeInteger(input.pr) || input.pr < 1) throw new PrCloseRefused(`${input.pr} is not a pull request number`);
  const forge = input.forge ?? forgeFor('github', { dir: input.dir, env: input.env });
  const seen = await forge.pullRequest(input.repo, input.pr);
  if (seen.state === 'merged') return 'already_merged';
  if (seen.state === 'closed') return 'already_closed';
  const head = seen.head;
  if (onBase(head, input.base)) throw new PrCloseRefused(`pull request #${input.pr} is on ${head}, a base branch: it is never closed from here`);
  if (!input.branches.includes(head)) throw new PrCloseRefused(`pull request #${input.pr} is on ${head}, not on a branch Cleared opened for this ticket`);
  await forge.closePullRequest(input.repo, input.pr, closeComment(input.reason, head));
  return 'closed';
}
