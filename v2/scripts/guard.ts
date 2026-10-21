// Runs the repository's guard (lib/guard/codex-guard.mjs, the private terms
// and secrets check that v1 applies before sending anything out) on every
// v2 file and the v2 workflow, as a tree (names and contents), and, with
// --base <ref>, on the lines changed since that ref, as a lane's diff is
// checked (--strict). Prints only position and category, never a value.
//   node scripts/guard.ts [--base origin/v2]
//
// The guard reads its private-term lists from a project's committed
// .cleared/agents.conf ([guard] salt, terms, allowed), as v1's guard_text
// does (lib/common.sh). This repository commits none: unless CLEARED_REPO
// names a project (and ORCH_GUARD_REF, if needed, its ref), the private-term
// check has no list and only the secret patterns apply. It says so.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const DISABLED = '{"disabled":true,"hashes":[]}\n';
const SCOPE = ['v2', '.github/workflows/v2.yml'];

// git without hooks, fsmonitor, pager or prompt.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  });
}

const nulList = (text: string): string[] => text.split('\0').filter(Boolean);

function guardSetting(conf: string, key: string): string | undefined {
  let inGuard = false;
  for (const raw of conf.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) inGuard = line === '[guard]';
    else if (inGuard && !line.startsWith('#') && line.includes('=') && line.slice(0, line.indexOf('=')).trim() === key)
      return line.slice(line.indexOf('=') + 1).trim();
  }
  return undefined;
}

const args = process.argv.slice(2);
const baseAt = args.indexOf('--base');
const base = baseAt >= 0 ? args[baseAt + 1] : undefined;
if (args.length !== (baseAt >= 0 ? 2 : 0) || (baseAt >= 0 && !base)) {
  console.error('usage: node scripts/guard.ts [--base <ref>]');
  process.exit(64);
}

const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
const files = new Set(nulList(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SCOPE])));
const present = [...files].filter((file) => existsSync(join(root, file)) && !lstatSync(join(root, file)).isDirectory()).sort();
if (present.length === 0) {
  console.error('guard: no file to check');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'cleared-v2-guard-'));
let status = 1;
try {
  // The guard's code, with its lists beside it, as guard_text lays it out.
  const tool = join(work, 'guard');
  mkdirSync(tool);
  for (const name of ['codex-guard.mjs', 'private-terms.mjs']) copyFileSync(join(root, 'lib', 'guard', name), join(tool, name));

  const env: NodeJS.ProcessEnv = { ...process.env };
  const project = process.env.CLEARED_REPO;
  if (project) {
    let ref = process.env.ORCH_GUARD_REF;
    if (!ref) {
      try { ref = git(project, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).trim(); }
      catch { ref = 'origin/main'; }
    }
    const conf = git(project, ['show', `${ref}:.cleared/agents.conf`]);
    for (const [key, list] of [['terms', 'private-terms.json'], ['allowed', 'codex-guard-allow.json']] as const) {
      const value = guardSetting(conf, key);
      if (!value) throw new Error(`[guard] ${key} is not set in .cleared/agents.conf at ${ref} of ${project}: write a file path or none`);
      writeFileSync(join(tool, list), value.toLowerCase() === 'none' ? DISABLED : git(project, ['show', `${ref}:${value}`]));
    }
    env.ORCH_GUARD_REF = ref;
    console.log(`guard: private-term lists of ${project} at ${ref}`);
  } else {
    // A committed configuration that names no list, in a repository of its own.
    const stand = join(work, 'project');
    mkdirSync(join(stand, '.cleared'), { recursive: true });
    writeFileSync(join(stand, '.cleared', 'agents.conf'), '[guard]\nterms = none\nallowed = none\n');
    git(stand, ['init', '-q']);
    git(stand, ['add', '.cleared/agents.conf']);
    git(stand, ['-c', 'user.name=guard', '-c', 'user.email=guard@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '-q', '-m', 'guard settings']);
    writeFileSync(join(tool, 'private-terms.json'), DISABLED);
    writeFileSync(join(tool, 'codex-guard-allow.json'), DISABLED);
    env.CLEARED_REPO = stand;
    env.ORCH_GUARD_REF = 'HEAD';
    console.log('guard: no private-term list (CLEARED_REPO unset): checking secrets, private keys, IBANs, credentials in URLs, email addresses and phone numbers only');
  }

  // A snapshot of the files, checked as the guard checks a tree: names and contents.
  const snapshot = join(work, 'files');
  for (const file of present) {
    mkdirSync(dirname(join(snapshot, file)), { recursive: true });
    copyFileSync(join(root, file), join(snapshot, file));
  }
  const guard = (what: string, guardArgs: string[]): boolean => {
    try {
      execFileSync(process.execPath, [join(tool, 'codex-guard.mjs'), ...guardArgs], { env, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8' });
      console.log(`guard: ${what}: nothing refused`);
      return true;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      console.error(stderr.split(snapshot + '/').join('').trimEnd());
      console.error(`guard: ${what}: refused`);
      return false;
    }
  };
  let clean = guard(`${present.length} v2 files`, ['--tree', snapshot]);
  if (base) {
    // Added and removed lines only (no context): what this change brings, not the text around it.
    const changes = join(work, 'changes.diff');
    writeFileSync(changes, git(root, ['diff', '-U0', '--no-ext-diff', '--no-color', '--no-textconv', `${base}...HEAD`]));
    clean = guard(`the lines changed since ${base}`, ['--strict', changes]) && clean;
  }
  status = clean ? 0 : 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(status);
