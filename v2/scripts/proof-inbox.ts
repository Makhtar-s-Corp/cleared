// What the proofs do with the inbox items that wait, as the owner would.
// Step 6 of the milestone 1 proof (scripts/proof-j1.ts): the request the
// message asked for may come after another request of the same session,
// which pauses it: the owner answers that one from the inbox too, then waits
// for the next. The morning of the milestone 2 proof (scripts/proof-j2.ts):
// the permissions the night left, then the plan, then the releases.

// Work inside the checkout is allowed once; anything else is denied (issue
// 157, item 4: the proof allowed once almost every request). The session's
// checkout is /workspace in its container (session/adapters/claude-code/map.ts).
const CHECKOUT = '/workspace';
// The programs that read or change the checkout and reach nothing else.
const LOCAL = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'find', 'sed', 'awk', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'echo', 'printf',
  'mkdir', 'touch', 'rm', 'mv', 'cp', 'true', 'test', 'cd', 'pwd', 'node', 'tsc']);
const NPM = new Set(['test', 'run', 'ci', 't']);
const GIT = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'rm', 'mv', 'restore', 'branch']);

// One simple command: its words, and where it reads or writes.
function simpleInside(command: string): boolean {
  const words = command.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^['"]|['"]$/g, ''));
  while (words[0] !== undefined && /^[A-Z_][A-Z0-9_]*=/.test(words[0])) words.shift();   // NAME=value before the program
  const [program, sub] = words;
  if (program === undefined) return false;
  const known = LOCAL.has(program) || (program === 'npm' && sub !== undefined && NPM.has(sub)) || (program === 'npx' && sub === 'tsc') || (program === 'git' && sub !== undefined && GIT.has(sub));
  if (!known) return false;
  // Every path it names stays in the checkout: no absolute path elsewhere
  // (/dev/null aside), no way up, no home.
  return words.every((word) => {
    const path = word.replace(/^\d*[<>]+&?/, '');
    if (path === '' || /^\d+$/.test(path) || path === '/dev/null') return true;
    if (path.startsWith('~')) return false;
    if (path.split('/').includes('..')) return false;
    if (path.startsWith('/')) return path === CHECKOUT || path.startsWith(`${CHECKOUT}/`);
    return true;
  });
}

export function insideCheckout(command: string): boolean {
  // What the shell computes cannot be judged from the text.
  if (!command.trim() || /\$\(|`|\$\{/.test(command)) return false;
  return command.split(/&&|\|\||[;|]/).every(simpleInside);
}

export function answerFor(command: string): 'allow_once' | 'reject_once' {
  return insideCheckout(command) ? 'allow_once' : 'reject_once';
}

// ---- milestone 1, step 6 ----------------------------------------------------

export type InboxAction =
  | { readonly kind: 'target'; readonly index: number }
  | { readonly kind: 'other'; readonly index: number; readonly decision: 'allow_once' | 'reject_once' }
  | { readonly kind: 'wait' };

// `detail` is what the item's detail shows; `command`, when read, the
// command alone (the detail's code chip), which is what is judged.
export function inboxAction(items: readonly { readonly detail: string; readonly command?: string }[], target: string): InboxAction {
  const index = items.findIndex((item) => item.detail.includes(target));
  if (index >= 0) return { kind: 'target', index };
  const first = items[0];
  if (first === undefined) return { kind: 'wait' };
  return { kind: 'other', index: 0, decision: answerFor(first.command ?? first.detail) };
}

// ---- milestone 2, the morning ------------------------------------------------

// An inbox item as GET /api/inbox gives it, reduced to what decides.
export type InboxEntry = {
  readonly id: string;
  readonly kind: 'release' | 'permission' | 'question' | 'plan';
  readonly ticket: string;
  readonly command?: string;                                  // a permission to run a command
  readonly checks?: 'pending' | 'passed' | 'failed';         // a release's pull request checks
};

export type MorningAction =
  | { readonly kind: 'permission'; readonly id: string; readonly decision: 'allow_once' | 'reject_once' }
  | { readonly kind: 'plan'; readonly id: string }
  | { readonly kind: 'release'; readonly id: string }
  // Nothing to do now; `left` says what still waits and why.
  | { readonly kind: 'wait'; readonly left: readonly string[] };

// The next gesture on the waiting items, in the inbox's own order (oldest
// first): a permission pauses a session, so it comes first; the plan next;
// then a release once its checks passed (the lock queues one whose checks
// still run). `releases` and `plan` false leave those to the owner
// (PROOF_OWNER_APPROVES=1). A question is the owner's.
export function morningAction(entries: readonly InboxEntry[], options: { readonly releases: boolean; readonly plan: boolean }): MorningAction {
  const permission = entries.find((entry) => entry.kind === 'permission');
  // A permission that is not a command (an edit outside, a fetch) is denied.
  if (permission) return { kind: 'permission', id: permission.id, decision: permission.command === undefined ? 'reject_once' : answerFor(permission.command) };
  const plan = entries.find((entry) => entry.kind === 'plan');
  if (plan && options.plan) return { kind: 'plan', id: plan.id };
  const ready = entries.find((entry) => entry.kind === 'release' && entry.checks === 'passed');
  if (ready && options.releases) return { kind: 'release', id: ready.id };
  const why = (entry: InboxEntry): string => {
    if (entry.kind === 'question') return 'a question, for the owner';
    if (entry.kind === 'plan' || (entry.kind === 'release' && !options.releases)) return 'the owner approves';
    return `checks ${entry.checks ?? 'pending'}`;
  };
  return { kind: 'wait', left: entries.map((entry) => `${entry.id} (${why(entry)})`) };
}
