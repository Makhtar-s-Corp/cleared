// The git environment for a read of one checkout Cleared does not own (the
// project's main checkout, or the tool's own, read by the human's commands).
//
// Git refuses a repository owned by another user ("detected dubious
// ownership") because the owner can put commands in its .git/config and
// .git/hooks that git runs for whoever reads the repository: core.fsmonitor
// runs on `git ls-files` and `git status`, a hook on an index refresh, a
// pager, an external diff, a signature check on `git log`. With the
// three-account layout the project checkout belongs to the service account
// and the human's commands read it, so each read declares that one checkout
// safe AND overrides every setting of that kind that a read can reach. The
// overrides are command-scope entries (GIT_CONFIG_COUNT / KEY_n / VALUE_n),
// appended after the caller's: they come last, so they win over the
// repository's own values, included files (include.path, includeIf) too.
// Nothing is written to any git configuration file.
//
// What cannot be overridden by key (filter.<driver>.*, diff.<driver>.textconv
// and .command, merge.<driver>.driver, named by the repository's attributes)
// is left out by the commands themselves: only plumbing reads (rev-parse,
// ls-files, cat-file, show <rev>:<path>, show -s, log --format, worktree
// list, remote get-url, diff --name-only --no-ext-diff --no-textconv between
// two commits). Never status, add, checkout, a patch diff, fetch or push.
//
// Never call this with a path taken from untrusted data, and never pass the
// result to anything but one git command (not to a shell script: it would
// declare the checkout safe for every git it runs).
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// --- shared with lib/guard/private-terms.mjs (copied there word for word; test/git-checkout.test.mjs keeps them identical) ---
// Settings of the repository that run a program or write into it, and the
// value a read gives them instead.
export const READ_OVERRIDES = [
  ['core.fsmonitor', 'false'], // ls-files, status, diff with the worktree run the fsmonitor hook
  ['core.hooksPath', '/dev/null'], // no hook is found, .git/hooks included (post-index-change, reference-transaction)
  ['core.pager', 'cat'], // with GIT_PAGER below, which also wins over pager.<command>
  ['core.editor', 'false'], // with GIT_EDITOR below
  ['sequence.editor', 'false'],
  ['core.askPass', ''], // empty: no program asks
  ['credential.helper', ''], // empty resets the list of helpers
  ['core.sshCommand', 'false'],
  ['protocol.allow', 'never'], // no transport at all: remote.<name>.uploadpack, ext::, core.gitProxy, insteadOf
  ['diff.external', ''], // empty: a patch diff fails instead of running it (the reads also pass --no-ext-diff)
  ['log.showSignature', 'false'], // log and show -s would run gpg.program on a signed commit
  ['gpg.program', 'false'],
  ['gpg.ssh.program', 'false'],
  ['gpg.x509.program', 'false'],
];

// A checkout path that cannot be used: said as it is, not as a git refusal.
export class CheckoutPathError extends Error {}

// The top level of the working tree that holds `checkout`: the first
// directory, from it upwards, that contains `.git` (a directory, or the file
// of a linked worktree). Git compares safe.directory with that path, not
// with a subdirectory such as <repo>/.cleared. Found without running git on
// the repository. No `.git` anywhere above: the path itself (a bare
// repository, or not a repository: git says so).
export function checkoutTopLevel(checkout) {
  if (typeof checkout !== 'string' || !checkout) throw new CheckoutPathError('the checkout path is empty');
  if (checkout.startsWith('~')) throw new CheckoutPathError(`the checkout path ${checkout} starts with "~", which Cleared does not expand: give the absolute path`);
  let path;
  try { path = realpathSync(resolve(checkout)); }
  catch { throw new CheckoutPathError(`the checkout ${checkout} does not exist or cannot be reached`); }
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return path;
  }
}

// `env` plus, for one git command reading `checkout`: safe.directory for its
// top level only, the overrides above, no optional lock (a read never writes
// the index of the repository), no pager, no editor, no prompt.
export function checkoutReadEnv(checkout, env = process.env) {
  const entries = [['safe.directory', checkoutTopLevel(checkout)], ...READ_OVERRIDES];
  const count = Math.max(0, Number.parseInt(env.GIT_CONFIG_COUNT, 10) || 0);
  const out = { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_EDITOR: 'false', GIT_TERMINAL_PROMPT: '0' };
  entries.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${count + i}`] = key;
    out[`GIT_CONFIG_VALUE_${count + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(count + entries.length);
  return out;
}
// --- end of the shared part ---

// The first line of what git (or the spawn) said, for a message to a human.
export function gitFirstLine(error) {
  const text = String(error?.stderr || error?.message || '');
  return text.split('\n').map((line) => line.trim()).find(Boolean) || 'no message';
}

// The sentence that replaces a failed read of a checkout (a path that cannot
// be used keeps its own sentence).
// Not a repository is said as that, not as a refusal.
export const gitRefusal = (checkout, error) => {
  if (error instanceof CheckoutPathError) return error.message;
  const line = gitFirstLine(error);
  if (/not a git repository/.test(line)) return `${checkout} is not a git repository: ${line}`;
  return `git refused or could not read ${checkout}: ${line}`;
};
