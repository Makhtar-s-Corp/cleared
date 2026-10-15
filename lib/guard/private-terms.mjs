// Detects the owner's private terms (names, places, amounts) by SHA-256
// fingerprint, so the repository never stores them in clear text.
//   node lib/guard/private-terms.mjs hash < terms.txt > scripts/private-terms.json
//   node lib/guard/private-terms.mjs scan file…
//   node lib/guard/private-terms.mjs allow <public term>   (fingerprint for codex-guard-allow.json)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

// The read environment of lib/git-checkout.mjs for each git command of this
// file on the project checkout (see there why). Written out here, not
// imported: lib/common.sh copies this file on its own, from a git ref, next
// to codex-guard.mjs.
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

function trustedProjectConfig() {
  const project = process.env.CLEARED_REPO || process.env.ORCH_REPO || process.cwd();
  let ref = process.env.ORCH_GUARD_REF;
  if (!ref) {
    try { ref = execFileSync('git', ['-C', project, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { encoding: 'utf8', env: checkoutReadEnv(project) }).trim(); }
    catch { ref = 'origin/main'; }
  }
  let source = '';
  try { source = execFileSync('git', ['-C', project, 'show', `${ref}:.cleared/agents.conf`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: checkoutReadEnv(project) }); }
  catch { /* this path is not committed at the trusted ref */ }
  return { project, ref, source };
}
const trusted = trustedProjectConfig();
export function guardValue(key) {
  let guard = false;
  for (const line of trusted.source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) guard = trimmed === '[guard]';
    else if (guard && trimmed.slice(0, trimmed.indexOf('=')).trim() === key) return trimmed.slice(trimmed.indexOf('=') + 1).trim();
  }
  return '';
}
const SALT = guardValue('salt');
const MAX_WORDS = 4;
const WRONG_SALT = 'These fingerprints were made with another salt. Set [guard] salt to the salt that made them, or rebuild the list.';
export const saltId = (salt = SALT) => createHash('sha256').update(salt).digest('hex').slice(0, 12);

export const fingerprint = (term) => {
  if (!SALT) throw new Error('Missing [guard] salt');
  return createHash('sha256').update(SALT + term).digest('hex');
};

/** Lowercase, accent-free words; digit groups ("12 345", "1_234_567") are joined. */
export function normalizeWords(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/(\d)[\s_\u00a0\u202f.,](?=\d{3}(?!\d))/g, "$1")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Every run of one to four consecutive words, as the text would be fingerprinted. */
export function* candidates(text) {
  const words = normalizeWords(text);
  for (let start = 0; start < words.length; start++)
    for (let size = 1; size <= MAX_WORDS && start + size <= words.length; size++)
      yield words.slice(start, start + size).join(" ");
}

// A listed term that is public after all (a country, a city) is allowed by
// adding its fingerprint to codex-guard-allow.json
// (`node lib/guard/private-terms.mjs allow <term>`): the guard and every scan
// then skip it, and the term never appears in clear in the repository.
export const loadFingerprints = (
  path = new URL("./private-terms.json", import.meta.url),
  allowPath = new URL("./codex-guard-allow.json", import.meta.url),
) => {
  if (!trusted.source) throw new Error(`The committed project configuration (.cleared/agents.conf at ${trusted.ref}) could not be read.`);
  const readList = (file) => {
    let source;
    if (existsSync(file)) source = readFileSync(file, 'utf8');
    else {
      const key = String(file).includes('codex-guard-allow') ? 'allowed' : 'terms';
      const name = guardValue(key);
      if (!name || name === 'none') source = '{"disabled":true,"hashes":[]}';
      else source = execFileSync('git', ['-C', trusted.project, 'show', `${trusted.ref}:${name}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: checkoutReadEnv(trusted.project) });
    }
    const data = JSON.parse(source);
    if (data && !Array.isArray(data) && data.disabled === true && Array.isArray(data.hashes) && data.hashes.length === 0) return [];
    const hashes = Array.isArray(data) ? data : data?.hashes;
    if (!Array.isArray(hashes) || !hashes.every((hash) => typeof hash === 'string')) throw new Error(`Invalid fingerprint list: ${file}`);
    if (!SALT) throw new Error('Missing committed [guard] salt: add [guard] salt = <random value> to the project agents.conf and commit it.');
    if (Array.isArray(data) || data.salt_id !== saltId()) throw new Error(WRONG_SALT);
    return hashes;
  };
  const allowed = new Set(readList(allowPath));
  return new Set(readList(path).filter((hash) => !allowed.has(hash)));
};

/** Returns the distinct candidates of `text` whose fingerprint is listed. */
export function findPrivateTerms(text, fingerprints = loadFingerprints()) {
  const found = new Set();
  if (fingerprints.size === 0) return [];
  for (const candidate of candidates(text))
    if (fingerprints.has(fingerprint(candidate))) found.add(candidate);
  return [...found];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...files] = process.argv.slice(2);
  if (command === "hash") {
    const terms = readFileSync(0, "utf8")
      .split("\n")
      .map((line) => normalizeWords(line).join(" "))
      .filter(Boolean);
    process.stdout.write(
      JSON.stringify({ salt_id: saltId(), hashes: [...new Set(terms.map(fingerprint))].sort() }, null, 2) + "\n",
    );
  } else if (command === "allow") {
    // Fingerprint to add to codex-guard-allow.json for a public term.
    for (const term of files) console.log(fingerprint(normalizeWords(term).join(" ")));
  } else if (command === "scan") {
    let failed = false;
    for (const file of files) {
      const found = findPrivateTerms(readFileSync(file, "utf8"));
      if (found.length) {
        failed = true;
        console.log(`${file}: ${found.join(", ")}`);
      }
    }
    process.exitCode = failed ? 1 : 0;
  } else {
    console.error("Usage: node lib/guard/private-terms.mjs hash|allow|scan …");
    process.exitCode = 2;
  }
}
