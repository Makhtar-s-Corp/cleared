// Why a publication failed (issue #507): the words of git and of the forge read
// into a code, which the session screen says in the person's language, with what
// to do. The words themselves, cleaned, go with it for the screen's fold.
//
// Publish happens after the review passed, so the author and the reviewer are
// paid for by then, and the only trace used to be a comment on the ticket.
import { PublishRefused } from '../workspace/publish.ts';

export const PUBLISH_FAILURES = ['write_denied', 'branch_taken', 'guard', 'no_commit', 'generated', 'unsafe', 'network', 'pull_request', 'other'] as const;
export type PublishFailureCode = (typeof PUBLISH_FAILURES)[number];

const REFUSALS: Readonly<Record<string, PublishFailureCode>> = { guard: 'guard', empty: 'no_commit', generated: 'generated', unsafe: 'unsafe', base: 'unsafe' };

export function publishFailureCode(error: unknown): PublishFailureCode {
  if (error instanceof PublishRefused) return REFUSALS[error.code] ?? 'other';
  const said = error instanceof Error ? error.message : String(error);
  // The branch is out and the pull request is not, whatever the forge's reason.
  if (/is pushed, but/.test(said)) return 'pull_request';
  if (/Permission to .* denied|returned error: 40[13]|Authentication failed|could not read Username|Write access to repository not granted/i.test(said)) return 'write_denied';
  if (/non-fast-forward|\[rejected\]|fetch first|\[remote rejected\]/i.test(said)) return 'branch_taken';
  if (/Could not resolve host|Connection (?:timed out|refused|reset)|Operation timed out|unable to access|Failed to connect/i.test(said)) return 'network';
  return 'other';
}

// What the note on the ticket adds, which the Lead reads: the cause is the token
// and not the account, which may well be an admin of the repository (issue #506).
export function publishHint(code: PublishFailureCode): string {
  if (code === 'write_denied') return ' The refusal comes from the token Cleared was given, not from the account: the token needs Contents and Pull requests, read and write, on this repository.';
  if (code === 'branch_taken') return ' A branch of this name is on the repository with another history, and a push is never forced.';
  return '';
}
