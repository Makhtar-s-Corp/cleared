// What the proofs do with the inbox items that wait, as the owner would.
// Step 6 of the milestone 1 proof (scripts/proof-j1.ts): the request the
// message asked for may come after another request of the same session,
// which pauses it: the owner answers that one from the inbox too, then waits
// for the next. The morning of the milestone 2 proof (scripts/proof-j2.ts):
// the permissions the night left, then the session plans' Go, then the
// plan, then the releases.
import { RECOMMENDED } from '../app/web/components/choices/model.ts';
import type { Question } from '../src/session/events.ts';
import { parseList, type SimpleCommand } from '../src/session/policy.ts';

// Work inside the checkout is allowed once; anything else is denied (issue
// 157, item 4: the proof allowed once almost every request). The proof
// answers alone through a whole night, so when the rule is unsure it denies.
// The session's checkout is /workspace in its container
// (session/adapters/claude-code/map.ts).
//
// The command is read by the service's own shell parser (parseList,
// src/session/policy.ts), never split as a string: a list of simple commands
// joined by ;, &&, || or |, each read word for word, quotes understood, with
// its output redirections. Whatever the parser refuses is denied: a
// substitution, an expansion ($, a backquote), a here-document, an input
// redirection, a subshell, a newline, a lone &. Review 1 of PR 279: run 5's
// reviewer asked `npm test 2>&1 | tail -15; ...; git ls-files; grep -rn
// "a\|b" --include=* -r src README.md | ... | head`, read only, and the first
// version of this rule cut it at the \| inside the quotes.
//
// Its limit (review 1 of PR 181, F1): `npm test`, `npm run <script>`, `npx
// tsc` and `node --test <file>` run the project's own code or tools, which
// can reach whatever the session's network allows; `npx tsc`, when the
// checkout does not hold TypeScript, fetches a package from the registry, as
// `npm ci` does. That is the work a ticket asks for, and the egress proxy and
// the policy, not this rule, are what bound it. The rule only keeps the proof
// from allowing a command that starts another program itself, or names a
// path outside the checkout.
const CHECKOUT = '/workspace';
// The programs that read or add files of the checkout and have no option
// that starts another program. rm and mv are not among them (review 2 of PR
// 279): the proof answers alone, and what it allows once never deletes nor
// moves a file; the policy asks the owner for them. rg and sort have their
// own lists below.
const LOCAL = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'wc', 'uniq', 'cut', 'tr', 'diff', 'echo', 'printf',
  'mkdir', 'touch', 'cp', 'true', 'test', 'pwd']);
// git: the read-only subcommands only, each with its options from a list
// (review 2 of PR 279: no --output, --ext-diff, --textconv, -D, commit, push).
// A word that is not an option is a revision or a path, which pathInside reads.
const GIT_VIEW = ['--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--oneline', '-p', '--patch', '--no-patch', '-s',
  '--cached', '--staged', '--no-color', '--color=never', '--graph', '--decorate', '--no-decorate', '--reverse', '--follow', '-w',
  '--ignore-all-space', '--word-diff', '--first-parent', '--merges', '--no-merges', '--all', '--no-ext-diff', '--no-textconv', '--'];
const GIT_SUBCOMMANDS: ReadonlyMap<string, { readonly flags: ReadonlySet<string>; readonly values: RegExp | null; readonly operands: boolean }> = new Map([
  ['status', { flags: new Set(['-s', '--short', '-b', '--branch', '-sb', '-bs', '--porcelain', '--porcelain=v1', '--porcelain=v2', '-uno', '-unormal', '-uall', '--untracked-files=no', '--untracked-files=normal', '--untracked-files=all', '--']), values: null, operands: true }],
  ['diff', { flags: new Set(GIT_VIEW), values: /^(-U\d+|--unified=\d+|--stat=\d+(,\d+)?)$/, operands: true }],
  ['log', { flags: new Set(GIT_VIEW), values: /^(-\d+|-n\d+|--max-count=\d+|-U\d+|--(format|pretty|since|until|after|before|author|grep)=.*)$/, operands: true }],
  ['show', { flags: new Set(GIT_VIEW), values: /^(-U\d+|--unified=\d+|--(format|pretty)=.*)$/, operands: true }],
  ['ls-files', { flags: new Set(['-c', '--cached', '-m', '--modified', '-o', '--others', '-d', '--deleted', '--exclude-standard', '-s', '--stage', '--']), values: null, operands: true }],
  // branch lists only: a name would create a branch.
  ['branch', { flags: new Set(['--show-current', '-a', '--all', '-r', '--remotes', '--list', '-v', '-vv']), values: null, operands: false }],
]);
// rg: no --pre or --pre-glob (a program run on each file), no -z (decompressors).
const RG_REFUSED = /^(--pre(-glob)?(=.*)?|--search-zip|-[A-Za-z]*z[A-Za-z]*)$/;
// sort: its ordering options; no --compress-program, no --output, no temporary folder.
const SORT_FLAGS = new Set(['--numeric-sort', '--reverse', '--unique', '--human-numeric-sort', '--version-sort', '--ignore-case', '--general-numeric-sort',
  '--month-sort', '--stable', '--dictionary-order', '--ignore-leading-blanks', '--zero-terminated']);
// npm's own options a check may carry before its `--`.
const NPM_OPTIONS = new Set(['-s', '--silent', '-q', '--quiet', '--if-present', '--no-audit', '--no-fund', '--prefer-offline']);
// What a check may pass its test runner after `--` (node --test, vitest):
// a name to match, or a built-in reporter by its name, never a module to load
// (--require, --import, a reporter given by its path: review 2 of PR 279).
const TEST_OPTIONS = new Set(['--test-name-pattern', '--test-skip-pattern', '--test-only', '--test-concurrency', '--test-timeout',
  '--grep', '-g', '-t', '--testNamePattern', '--run', '--bail']);
const REPORTER_OPTIONS = new Set(['--test-reporter', '--reporter']);
const REPORTERS = new Set(['spec', 'tap', 'dot', 'junit', 'lcov', 'default', 'verbose', 'basic', 'json', 'tap-flat', 'hanging-process']);
// `npx tsc` checks the types and writes nothing: --noEmit is required.
const TSC_OPTIONS = new Set(['--noEmit', '--pretty', '--skipLibCheck', '--strict']);
const TSC_VALUES = new Set(['-p', '--project']);
// Variables a command may set before it: none that changes what runs.
const VARIABLES = new Set(['NODE_ENV', 'CI', 'TZ', 'LANG', 'LC_ALL', 'FORCE_COLOR', 'NO_COLOR', 'DEBUG']);
// What the first rule denied anywhere in the text, kept as a second check:
// the names of programs that install, fetch or reach another machine.
const NETWORK = /\b(apt-get|apt|apk|brew|sudo|su|pip3?|pipx|curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet|ftp|pnpm|yarn|bunx?|deno|docker|podman|kubectl|gh|python3?|perl|ruby|php|embedded-postgres)\b|\bnpm\s+(i|install|add|view|exec|x|publish|login|adduser|dlx|create|init)\b/;

// A path a word names stays in the checkout: no absolute path elsewhere
// (/dev/null aside), no way up, no home. An option's value after its = is
// read too (--output=/tmp/x), and so is each piece of a quoted word that
// holds spaces, which a program may read as a script of its own (review 2 of
// PR 279: sed -n 'w /tmp/pwn').
function pathInside(word: string): boolean {
  return word.split(/\s+/).every(pieceInside);
}
function pieceInside(word: string): boolean {
  return [word, ...(word.includes('=') ? [word.slice(word.indexOf('=') + 1)] : [])].every((path) => {
    if (path === '' || /^\d+$/.test(path) || path === '/dev/null') return true;
    if (path.startsWith('~')) return false;
    if (path.split('/').includes('..')) return false;
    if (path.startsWith('/')) return path === CHECKOUT || path.startsWith(`${CHECKOUT}/`);
    return true;
  });
}

// npm test, npm t, npm ci or npm run <script>, npm's options from its list,
// then after `--` the test runner's options from its list and files.
function npmInside(words: readonly string[]): boolean {
  const [sub, ...rest] = words;
  let from = 0;
  if (sub === 'run' && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(rest[0] ?? '')) from = 1;
  else if (sub !== 'test' && sub !== 't' && sub !== 'ci') return false;
  const dash = rest.indexOf('--');
  if (!rest.slice(from, dash < 0 ? undefined : dash).every((word) => NPM_OPTIONS.has(word))) return false;
  if (dash < 0) return true;
  if (sub === 'ci') return false;
  return testArgumentsInside(rest.slice(dash + 1));
}

// The test runner's words: options from its list, a reporter by its name, files.
function testArgumentsInside(words: readonly string[]): boolean {
  for (let at = 0; at < words.length; at++) {
    const word = words[at] as string;
    const name = word.split('=')[0] as string;
    if (REPORTER_OPTIONS.has(name)) {
      const value = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[++at];
      if (value === undefined || !REPORTERS.has(value)) return false;
    } else if (word.startsWith('-') && !TEST_OPTIONS.has(name)) return false;
  }
  return true;
}

function gitInside(words: readonly string[]): boolean {
  const [sub, ...rest] = words;
  const spec = sub === undefined ? undefined : GIT_SUBCOMMANDS.get(sub);
  if (!spec) return false;
  let operands = false;
  for (const word of rest) {
    if (operands || !word.startsWith('-')) { if (!spec.operands) return false; continue; }
    if (word === '--') { operands = true; continue; }
    if (!spec.flags.has(word) && !spec.values?.test(word)) return false;
  }
  return true;
}

// sed prints lines only: -n, then a script that is exactly one range such as
// 1,40p, then files. Any other script is refused, as sed reads the first word
// that is not an option as its script, whatever it holds (w writes a file, e
// runs a command: review 2 of PR 279).
function sedInside(words: readonly string[]): boolean {
  const options = words.filter((w) => w.startsWith('-'));
  const operands = words.filter((w) => !w.startsWith('-'));
  return options.length > 0 && options.every((w) => w === '-n') && operands.length >= 1 && /^\d+(,\d+)?p$/.test(operands[0] as string);
}

function sortInside(words: readonly string[]): boolean {
  for (let at = 0; at < words.length; at++) {
    const word = words[at] as string;
    if (!word.startsWith('-') || SORT_FLAGS.has(word) || /^-[bdfghinMRrsuVz]+$/.test(word) || /^(-k.+|-t.|--key=.+|--field-separator=.)$/.test(word)) continue;
    if ((word === '-k' || word === '-t') && words[at + 1] !== undefined) { at++; continue; }
    return false;
  }
  return true;
}

// npx tsc --noEmit, its options from its list, a project inside the checkout.
function npxInside(words: readonly string[]): boolean {
  const rest = words[0] === '--no-install' || words[0] === '--no' ? words.slice(1) : words;
  if (rest[0] !== 'tsc') return false;
  const args = rest.slice(1);
  return args.includes('--noEmit') && args.every((word, at) => TSC_OPTIONS.has(word) || TSC_VALUES.has(word)
    || (!word.startsWith('-') && TSC_VALUES.has(args[at - 1] ?? '')));
}

// Each program's words beyond its name: what is safe to pass.
function argumentsInside(program: string, words: readonly string[]): boolean {
  if (LOCAL.has(program)) return true;
  if (program === 'rg') return !words.some((w) => RG_REFUSED.test(w));
  if (program === 'sort') return sortInside(words);
  // cd into a folder of the checkout: one folder named; no cd alone (home) nor cd - (the folder before).
  if (program === 'cd') return words.length === 1 && words[0] !== '-';
  if (program === 'git') return gitInside(words);
  if (program === 'npm') return npmInside(words);
  if (program === 'npx') return npxInside(words);
  // node runs a test file of the checkout, and nothing given on the line.
  if (program === 'node') return words[0] === '--test' && words.slice(1).every((w) => !w.startsWith('-'));
  if (program === 'sed') return sedInside(words);
  // find without the options that run a program or delete.
  if (program === 'find') return !words.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)/.test(w));
  return false;
}

// One simple command, as the parser read it: its words, and the files its redirections write.
function simpleInside(command: SimpleCommand): boolean {
  const words = [...command.words];
  while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    if (!VARIABLES.has(words[0].slice(0, words[0].indexOf('=')))) return false;
    words.shift();
  }
  const [program, ...rest] = words;
  if (program === undefined || !argumentsInside(program, rest)) return false;
  return words.every(pathInside) && command.writes.every(pathInside);
}

export function insideCheckout(command: string): boolean {
  if (NETWORK.test(command)) return false;
  const list = parseList(command, { globs: true });
  return list !== undefined && list.length > 0 && list.every(simpleInside);
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
// or a reviewer that asks to run exactly one of the checks declared in its
// service's frozen base (test, typecheck or lint among the scripts of its
// package.json there, which the service's policy reads too) is allowed once
// under the rule `check`; everything else is answered by the rule above,
// which also reads the common forms of a check (review 1 of PR 279). The
// name is declared, not the script behind it: `npm test` runs the checkout's
// package.json, which the author may have changed (review 1 of PR 279,
// followup 2), as the rule above already allowed. A lead, a reader or a role
// the proof cannot read is not an author's or a reviewer's checkout: the rule
// above too.
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

export type PermissionRule = 'check' | 'checkout' | 'refused' | 'not_a_command';
export type PermissionAnswer = { readonly decision: 'allow_once' | 'reject_once'; readonly rule: PermissionRule };

// `command` is absent for a request that is not a command (an edit, a fetch),
// `role` when the proof could not read the session's.
export function permissionAnswer(request: { readonly role: string | undefined; readonly command: string | undefined; readonly checks: readonly string[] }): PermissionAnswer {
  const { role, command, checks } = request;
  if (command === undefined) return { decision: 'reject_once', rule: 'not_a_command' };
  const exact = command.trim().replace(/[ \t]+/g, ' ');
  if (role !== undefined && CHECKING_ROLES.has(role) && checks.includes(exact)) return { decision: 'allow_once', rule: 'check' };
  return answerFor(command) === 'allow_once' ? { decision: 'allow_once', rule: 'checkout' } : { decision: 'reject_once', rule: 'refused' };
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
