// What the proofs do with the inbox items that wait, as the owner would.
// Step 6 of the milestone 1 proof (scripts/proof-j1.ts): the request the
// message asked for may come after another request of the same session,
// which pauses it: the owner answers that one from the inbox too, then waits
// for the next. The morning of the milestone 2 proof (scripts/proof-j2.ts):
// the permissions the night left, then the session plans' Go, then the
// plan, then the releases.
import { RECOMMENDED } from '../app/web/components/choices/model.ts';
import type { Question } from '../src/session/events.ts';

// Work inside the checkout is allowed once; anything else is denied (issue
// 157, item 4: the proof allowed once almost every request). The proof
// answers alone through a whole night, so when the rule is unsure it denies.
// The session's checkout is /workspace in its container
// (session/adapters/claude-code/map.ts).
//
// Its limit (review 1 of PR 181, F1): `npm test`, `npm run <script>` and
// `node --test <file>` run the project's own code, which can reach whatever
// the session's network allows. That is the work a ticket asks for, and the
// egress proxy and the policy, not this rule, are what bound it. The rule
// only keeps the proof from allowing a command that starts another program
// itself.
const CHECKOUT = '/workspace';
// The programs that read or change files of the checkout and start nothing.
const LOCAL = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'echo', 'printf',
  'mkdir', 'touch', 'rm', 'mv', 'cp', 'true', 'test', 'cd', 'pwd']);
const NPM = new Set(['test', 'run', 'ci', 't']);
const GIT = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'rm', 'mv', 'restore', 'branch']);
// Variables a command may set before it: none that changes what runs.
const VARIABLES = new Set(['NODE_ENV', 'CI', 'TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR', 'DEBUG']);
// What the first rule denied anywhere in the text, kept as a second check:
// the names of programs that install, fetch or reach another machine.
const NETWORK = /\b(apt-get|apt|apk|brew|sudo|su|pip3?|pipx|curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet|ftp|npx|pnpm|yarn|bunx?|deno|docker|podman|kubectl|gh|python3?|perl|ruby|php|embedded-postgres)\b|\bnpm\s+(i|install|add|view|exec|x|publish|login|adduser|dlx|create|init)\b/;

// Each program's words beyond the ones above: what is safe to pass.
function argumentsInside(program: string, words: readonly string[]): boolean {
  // node runs a test file of the checkout, and nothing given on the line.
  if (program === 'node') return words[0] === '--test' && words.slice(1).every((w) => !w.startsWith('-'));
  // sed only prints lines: -n and a range such as 1,40p.
  if (program === 'sed') return words.every((w) => w === '-n' || /^\d+(,\d+)?p$/.test(w) || (!w.startsWith('-') && !/^\d/.test(w)))
    && words.includes('-n') && words.some((w) => /^\d+(,\d+)?p$/.test(w));
  // find without the options that run a program or delete.
  if (program === 'find') return !words.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)/.test(w));
  return true;
}

// One simple command: its words, and where it reads or writes.
function simpleInside(command: string): boolean {
  const words = command.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/^['"]|['"]$/g, ''));
  while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    if (!VARIABLES.has(words[0].slice(0, words[0].indexOf('=')))) return false;
    words.shift();
  }
  const [program, sub] = words;
  if (program === undefined) return false;
  const known = LOCAL.has(program) || program === 'node' || program === 'sed' || program === 'find'
    || (program === 'npm' && sub !== undefined && NPM.has(sub)) || (program === 'git' && sub !== undefined && GIT.has(sub));
  if (!known || !argumentsInside(program, words.slice(1))) return false;
  // Every path it names stays in the checkout: no absolute path elsewhere
  // (/dev/null aside), no way up, no home.
  return words.every((word) => {
    const path = word.replace(/^\d*[<>]+/, '');
    if (path === '' || /^\d+$/.test(path) || path === '/dev/null') return true;
    if (path.startsWith('~')) return false;
    if (path.split('/').includes('..')) return false;
    if (path.startsWith('/')) return path === CHECKOUT || path.startsWith(`${CHECKOUT}/`);
    return true;
  });
}

export function insideCheckout(command: string): boolean {
  // What the shell computes, or runs beside the command, cannot be judged from the text.
  if (!command.trim() || /\$\(|`|\$\{|<\(|>\(|\$[A-Za-z_]/.test(command) || NETWORK.test(command)) return false;
  // A file descriptor copied (2>&1) and both outputs sent to a file (&>)
  // are not a command run in the background; every other & is.
  const plain = command.replace(/\d*>&\d+/g, ' ').replace(/&>>?/g, '>');
  return plain.split(/&&|\|\||[;|&\r\n]/).every(simpleInside);
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
  readonly kind: 'release' | 'permission' | 'question' | 'plan' | 'session_plan' | 'contract' | 'knowledge';
  readonly ticket: string;
  readonly command?: string;                                  // a permission to run a command
  readonly checks?: 'pending' | 'passed' | 'failed';         // a release's pull request checks
  readonly session?: string;                                  // a session plan's session
  readonly confidence?: 'low' | 'medium' | 'high';           // a session plan's confidence
};

export type MorningAction =
  | { readonly kind: 'permission'; readonly id: string; readonly decision: 'allow_once' | 'reject_once' }
  | { readonly kind: 'session_plan'; readonly id: string; readonly session: string }
  | { readonly kind: 'plan'; readonly id: string }
  | { readonly kind: 'release'; readonly id: string }
  // Nothing to do now; `left` says what still waits and why.
  | { readonly kind: 'wait'; readonly left: readonly string[] };

// The next gesture on the waiting items, in the inbox's own order (oldest
// first): a permission pauses a session, so it comes first; then a session
// plan's Go (lane 29: a medium or low confidence holds its ticket until the
// morning, and the plan would otherwise never end); the plan next; then a
// release once its checks passed (the lock queues one whose checks still
// run). `releases` and `plan` false leave those, and the Go, to the owner
// (PROOF_OWNER_APPROVES=1). A question is the owner's; so is a knowledge
// item, which the run counts (leftForOwner); a contract item is validated
// by the multi-service proof at its step 3 only, never here.
export function morningAction(entries: readonly InboxEntry[], options: { readonly releases: boolean; readonly plan: boolean }): MorningAction {
  const permission = entries.find((entry) => entry.kind === 'permission');
  // A permission that is not a command (an edit outside, a fetch) is denied.
  if (permission) return { kind: 'permission', id: permission.id, decision: permission.command === undefined ? 'reject_once' : answerFor(permission.command) };
  const held = entries.find((entry) => entry.kind === 'session_plan' && entry.session !== undefined);
  if (held && options.plan) return { kind: 'session_plan', id: held.id, session: held.session as string };
  const plan = entries.find((entry) => entry.kind === 'plan');
  if (plan && options.plan) return { kind: 'plan', id: plan.id };
  const ready = entries.find((entry) => entry.kind === 'release' && entry.checks === 'passed');
  if (ready && options.releases) return { kind: 'release', id: ready.id };
  const why = (entry: InboxEntry): string => {
    if (entry.kind === 'question') return 'a question, for the owner';
    if (entry.kind === 'knowledge') return 'knowledge, for the owner';
    if (entry.kind === 'contract') return 'a contract, validated in the multi-service proof only';
    if (entry.kind === 'plan' || entry.kind === 'session_plan' || (entry.kind === 'release' && !options.releases)) return 'the owner approves';
    return `checks ${entry.checks ?? 'pending'}`;
  };
  return { kind: 'wait', left: entries.map((entry) => `${entry.id} (${why(entry)})`) };
}

// What the morning leaves to the owner and the report counts.
export function leftForOwner(entries: readonly InboxEntry[]): { readonly knowledge: number; readonly contract: number } {
  return { knowledge: entries.filter((e) => e.kind === 'knowledge').length, contract: entries.filter((e) => e.kind === 'contract').length };
}

// ---- the multi-service proof, a session's permission -----------------------------

// Run 5 of the multi-service proof (step 10): the proof denied a reviewer's
// requests to run the service's tests, so the reviewer judged on the diff
// alone, asked for changes twice, and the ticket went back to Todo. An author
// or a reviewer that asks to run exactly one of the read-only checks its
// service declares (test, typecheck or lint among the scripts of its
// package.json, which the service's policy reads too) is allowed once;
// everything else keeps the rule above. A lead, a reader or a role the proof
// cannot read is not an author's or a reviewer's checkout: the rule above too.
export const CHECK_SCRIPTS: readonly string[] = ['test', 'typecheck', 'lint'];
const CHECKING_ROLES: ReadonlySet<string> = new Set(['author', 'reviewer']);

// The check commands of a package.json's text: none when it is absent or unreadable.
export function declaredChecks(packageJson: string | undefined): string[] {
  let scripts: unknown;
  try { scripts = (JSON.parse(packageJson ?? '') as { scripts?: unknown }).scripts; } catch { return []; }
  if (typeof scripts !== 'object' || scripts === null) return [];
  return CHECK_SCRIPTS.filter((name) => typeof (scripts as Record<string, unknown>)[name] === 'string')
    .map((name) => (name === 'test' ? 'npm test' : `npm run ${name}`));
}

export type PermissionRule = 'check' | 'checkout' | 'outside' | 'not_a_command';
export type PermissionAnswer = { readonly decision: 'allow_once' | 'reject_once'; readonly rule: PermissionRule };

// `command` is absent for a request that is not a command (an edit, a fetch),
// `role` when the proof could not read the session's.
export function permissionAnswer(request: { readonly role: string | undefined; readonly command: string | undefined; readonly checks: readonly string[] }): PermissionAnswer {
  const { role, command, checks } = request;
  if (command === undefined) return { decision: 'reject_once', rule: 'not_a_command' };
  const exact = command.trim().replace(/[ \t]+/g, ' ');
  if (role !== undefined && CHECKING_ROLES.has(role) && checks.includes(exact)) return { decision: 'allow_once', rule: 'check' };
  return answerFor(command) === 'allow_once' ? { decision: 'allow_once', rule: 'checkout' } : { decision: 'reject_once', rule: 'outside' };
}

// ---- the multi-service proof, a session's question -------------------------------

// A question a session of one of the proof's tickets asks (AskUserQuestion's
// shape, src/session/events.ts) is answered as the owner who trusts the
// team would: the option the asker marked "(Recommended)", else the first
// one; one option even for a multiple choice. A question with no option
// gets FREE_ANSWER, typed in its free field. The labels are the API's, so
// the choice does not depend on the language the page is shown in.
export const FREE_ANSWER = 'Go with what you judge best, and say in your report what you chose.';

export type QuestionChoice = {
  readonly question: string;
  readonly options: readonly string[];
  readonly answer: string;
  readonly how: 'recommended' | 'first' | 'free';
};

export function chooseAnswers(questions: readonly Question[]): QuestionChoice[] {
  return questions.map((q) => {
    const options = (q.options ?? []).map((o) => o.label);
    const recommended = options.find((label) => RECOMMENDED.test(label));
    if (recommended !== undefined) return { question: q.question, options, answer: recommended, how: 'recommended' };
    const [first] = options;
    if (first !== undefined) return { question: q.question, options, answer: first, how: 'first' };
    return { question: q.question, options, answer: FREE_ANSWER, how: 'free' };
  });
}
