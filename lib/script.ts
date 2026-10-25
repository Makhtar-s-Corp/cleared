// What the Node commands of the core share, as lib/common.sh did for the
// bash scripts it replaces (docs/v2/milestone-4-plan.md, step b): where the
// project, its settings and its state are, the settings read as conf_get
// read them, the catalog, the ledger, gh and git with the forge credential,
// what GitHub's status page says, the locks and the guard.
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultValue, requiredValue } from './conf.mjs';
import { forgeEnv, forgeGhEnv, ForgeError } from './forge.mjs';
import { message } from './i18n.mjs';
import { addEvent, openLedger } from './ledger.mjs';

export const ORCH_HOME: string = join(dirname(fileURLToPath(import.meta.url)), '..');

// The name a message starts with: the command that was run.
export const scriptName = (): string => basename(process.argv[1] ?? 'cleared');

// An end with an exit code, thrown so that what is held (a temporary folder,
// a lock) is let go on the way out; `main` turns it into the exit code.
export class ScriptExit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

export function say(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function die(text: string): never {
  say(`${scriptName()}: ${text}`);
  throw new ScriptExit(1);
}

// Runs a command's body and exits with its code: 0 when it returns, the code
// it threw, else 1 with the error's message.
export async function main(body: () => void | number | Promise<void | number>): Promise<void> {
  let code = 0;
  try {
    code = (await body()) ?? 0;
  } catch (error) {
    if (error instanceof ScriptExit) code = error.code;
    else {
      say(`${scriptName()}: ${error instanceof Error ? error.message : String(error)}`);
      code = 1;
    }
  }
  process.exitCode = code;
}

// ---- The project, its settings and its state --------------------------

export type ProjectEnv = { readonly home: string; readonly repo: string; readonly conf: string; readonly state: string };

let project: ProjectEnv | undefined;

// The project these commands work on, by its main checkout: said by whoever
// runs them (CLEARED_REPO, ORCH_REPO), else once for the machine (first line
// of ~/.config/cleared/project), else the repository the tool sits in. Its
// settings are the tracked .cleared/agents.conf of that checkout; its state
// one folder per project, outside the repositories. Said in the environment
// for every command these start, as lib/common.sh exported them.
export function projectEnv(): ProjectEnv {
  if (project) return project;
  const env = process.env;
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('CLEARED_') && value !== undefined) env[`ORCH_${name.slice(8)}`] = value;
  }
  const named = join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cleared', 'project');
  let repo = env.CLEARED_REPO || env.ORCH_REPO || '';
  if (!repo) {
    try { repo = (readFileSync(named, 'utf8').split('\n')[0] ?? '').trim(); } catch { repo = ''; }
  }
  if (!repo) {
    try {
      repo = execFileSync('git', ['-C', ORCH_HOME, 'worktree', 'list', '--porcelain' /* git-env: the tool's own checkout, as lib/common.sh read it */], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
        .split('\n')[0]?.replace(/^worktree /, '') ?? '';
    } catch { repo = ''; }
  }
  if (!repo) {
    say(`${scriptName()}: no project is named (ORCH_REPO, or the first line of ${named})`);
    throw new ScriptExit(1);
  }
  let conf = env.CLEARED_CONF || env.ORCH_CONF || '';
  if (!conf) {
    const current = join(repo, '.cleared', 'agents.conf');
    conf = current;
    if (existsSync(current)) {
      const tracked = spawnSync('git', ['-C', repo, 'ls-files', '--error-unmatch', '--', '.cleared/agents.conf' /* git-env: the service account on its own checkout, as lib/common.sh read it */], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
      if (tracked.status !== 0) {
        conf = join(repo, '.cleared', 'tracked-agents.conf-missing');
        if (tracked.status === 1) env.CLEARED_IGNORED_UNTRACKED_CONF = current;
        else say(`cleared: git refused or could not read ${repo}: ${(tracked.stderr ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? ''}`);
      }
    }
  }
  const state = env.CLEARED_STATE_DIR || env.ORCH_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'cleared', basename(repo));
  Object.assign(env, { ORCH_HOME, ORCH_REPO: repo, ORCH_CONF: conf, ORCH_STATE_DIR: state, CLEARED_REPO: repo, CLEARED_CONF: conf, CLEARED_STATE_DIR: state });
  project = { home: ORCH_HOME, repo, conf, state };
  return project;
}

// One value of a settings file, as lib/common.sh's conf_get_from read it:
// the first `key = value` of the section, blanks around both cut; a line
// that starts with # is no setting. Undefined when it is not there.
export function confGetFrom(sectionName: string, key: string, file: string): string | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return undefined; }
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('[')) { inside = line === `[${sectionName}]`; continue; }
    if (!inside || /^[ \t]*#/.test(line)) continue;
    const at = line.indexOf('=');
    if (at < 0) continue;
    if (line.slice(0, at).replace(/^[ \t]+|[ \t]+$/g, '') === key) return line.slice(at + 1).replace(/^[ \t]+|[ \t]+$/g, '');
  }
  return undefined;
}

// A setting of the project, else the tool's default; empty when neither has
// it. One the project must give, given empty or not at all, stops the
// command with exit 2, as conf_get did.
export function confGet(sectionName: string, key: string): string {
  const { conf } = projectEnv();
  const value = existsSync(conf) ? confGetFrom(sectionName, key, conf) : undefined;
  if (value !== undefined && (value !== '' || !requiredValue(sectionName, key))) return value;
  if (value === undefined) {
    const fallback = defaultValue(sectionName, key);
    if (fallback !== undefined) return fallback;
    if (!requiredValue(sectionName, key)) return '';
  }
  say(`Missing required [${sectionName}] ${key} in project agents.conf`);
  throw new ScriptExit(2);
}

// The same, where a missing setting is said and counts as empty.
export function confSoft(sectionName: string, key: string): string {
  try { return confGet(sectionName, key); } catch (error) {
    if (error instanceof ScriptExit) return '';
    throw error;
  }
}

// A sentence of the catalog, in the owner's language ([owner] language).
export function userMessage(key: string, values: Record<string, string> = {}): string {
  return message(key, confSoft('owner', 'language') || 'en', values);
}

// How the agents name the user in what they write: [owner] name, else
// [tracker] owner_name, else "the user".
export function ownerName(): string {
  return confSoft('owner', 'name') || confSoft('tracker', 'owner_name') || 'the user';
}

export const nowUtc = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// A time the way `date -u -d '<n> <unit> ago' +%Y-%m-%dT%H:%M:%SZ` wrote it.
export const agoUtc = (ms: number): string => new Date(Date.now() - ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ---- The ledger -----------------------------------------------------------

export type LedgerEvent = { readonly kind: string; readonly ticket?: string | null; readonly value?: number | null; readonly detail?: string | null; readonly at?: string; readonly runId?: string | null };

export function ledgerEvent(event: LedgerEvent): void {
  projectEnv();
  const db = openLedger();
  try { addEvent(db, { ...event, ticket: event.ticket ?? null, detail: event.detail ?? null, value: event.value ?? null, runId: event.runId ?? null }); } finally { db.close(); }
}

export function ledgerRows(sql: string, ...values: (string | number | null)[]): Record<string, unknown>[] {
  projectEnv();
  const db = openLedger(undefined, { readOnly: true });
  try { return db.prepare(sql).all(...values) as Record<string, unknown>[]; } finally { db.close(); }
}

export function ledgerInit(): void {
  projectEnv();
  openLedger().close();
}

// ---- gh and git -------------------------------------------------------------

export type Run = { readonly status: number; readonly stdout: string; readonly stderr: string };

const done = (run: SpawnSyncReturns<string>): Run => ({ status: run.status ?? 1, stdout: run.stdout ?? '', stderr: run.stderr ?? '' });

// gh in the project's checkout with the forge credential (lib/forge.mjs
// forgeGhEnv): the app's token when one is configured, the ambient one
// otherwise. A configured app that gives no token stops the call with the
// reason; the ambient credential is never used instead.
export function gh(args: readonly string[], options: { readonly input?: string } = {}): Run {
  const { repo, state } = projectEnv();
  let env: NodeJS.ProcessEnv;
  try {
    env = forgeGhEnv(undefined, { state });
  } catch (error) {
    const reason = error instanceof ForgeError ? error.message : `forge credential: ${error instanceof Error ? error.message : String(error)}`;
    return { status: 1, stdout: '', stderr: `${scriptName()}: ${reason}\n` };
  }
  return done(spawnSync('gh', [...args], { cwd: repo, env, encoding: 'utf8', input: options.input ?? '', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
}

// gh, whose error output goes where the command's goes, as a bash call did.
export function ghShown(args: readonly string[]): Run {
  const run = gh(args);
  if (run.stderr) process.stderr.write(run.stderr);
  return run;
}

// git on the project's checkout, with the forge's settings (lib/forge.mjs
// forgeEnv) as every git of the bash scripts had them.
let gitEnv: NodeJS.ProcessEnv | undefined;
export function git(args: readonly string[], options: { readonly cwd?: string } = {}): Run {
  const { repo } = projectEnv();
  gitEnv ??= forgeEnv();
  return done(spawnSync('git', ['-C', options.cwd ?? repo, ...args /* git-env: the service account on its own checkout, as the bash scripts ran it, with the forge's settings */], { env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
}

// A Node command of the tool (lib/release.mjs, lib/merge.mjs…), run as the
// bash scripts ran it, with the project's environment; its error output goes
// where the caller's goes unless `quiet`.
export function tool(file: string, args: readonly string[], options: { readonly input?: string; readonly env?: NodeJS.ProcessEnv; readonly quiet?: boolean } = {}): Run {
  projectEnv();
  const run = done(spawnSync(process.execPath, ['--no-warnings', join(ORCH_HOME, file), ...args], { env: { ...process.env, ...options.env }, encoding: 'utf8', input: options.input ?? '', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
  if (!options.quiet && run.stderr) process.stderr.write(run.stderr);
  return run;
}

// The tracker's entry point (tracker.ts), as the bash scripts ran tracker.sh:
// the file of the tool's folder, so that a test may put its own there.
export function tracker(args: readonly string[], options: { readonly input?: string; readonly quiet?: boolean } = {}): Run {
  projectEnv();
  const run = done(spawnSync(join(ORCH_HOME, 'tracker.ts'), [...args], { env: process.env, encoding: 'utf8', input: options.input ?? '', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }));
  if (!options.quiet && run.stderr) process.stderr.write(run.stderr);
  return run;
}

// ---- GitHub's status page -------------------------------------------------

// What GitHub says is down among the parts Cleared needs, as its public status
// page has it: an empty text when all is well, code 2 when the page cannot be
// read (which says nothing either way). A slowdown is not an outage. With
// CLEARED_GITHUB_DOWN_CACHE (set by the wake), the answer is kept in that file
// and read again for a minute: the page is asked once a wake.
export function githubDown(): { readonly code: 0 | 2; readonly out: string } {
  const cache = process.env.CLEARED_GITHUB_DOWN_CACHE || '';
  if (cache && existsSync(cache) && Date.now() - statSync(cache).mtimeMs < 60_000) {
    const [first = '', second = ''] = readFileSync(cache, 'utf8').split('\n');
    const code = first === '0' ? 0 : 2;
    return { code, out: code === 0 ? second : '' };
  }
  const page = spawnSync('curl', ['-fsS', '--max-time', '8', process.env.ORCH_GITHUB_STATUS || 'https://www.githubstatus.com/api/v2/components.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let code: 0 | 2 = 2;
  let out = '';
  if (page.status === 0) {
    try {
      const components = (JSON.parse(page.stdout) as { components?: unknown }).components;
      if (Array.isArray(components)) {
        code = 0;
        out = components.filter((part: { name?: unknown; status?: unknown }) => ['Git Operations', 'Pull Requests', 'Actions', 'API Requests'].includes(String(part?.name))
          && ['major_outage', 'partial_outage'].includes(String(part?.status))).map((part: { name?: unknown }) => String(part.name)).join(', ');
      }
    } catch { code = 2; }
  }
  if (cache) { try { writeFileSync(cache, `${code}\n${out}\n`); } catch { /* the next call asks the page again */ } }
  return { code, out: code === 0 ? out : '' };
}

// ---- Locks ------------------------------------------------------------------

// flock(1) on a descriptor of this process, as lib/notify/store.mjs takes its
// lock: the lock belongs to the open file, and stays held until `release`.
// The same locks as the bash scripts' `exec 9> file; flock`, so the two keep
// each other out. Null when it could not be had in time (or at once, with
// `wait: 0`).
export function lockFile(path: string, wait: number): { release(): void } | null {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT, 0o644);
  const held = spawnSync('flock', wait > 0 ? ['-x', '-w', String(wait), '3'] : ['-x', '-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
  if (held.status !== 0) { closeSync(fd); return null; }
  return { release: () => closeSync(fd) };
}

// ---- What a go-live reads of git ------------------------------------------

// The head holds that commit, and adds on top of it nothing but merges of the
// base that changed nothing by themselves. A commit of the branch itself would
// have been seen by nobody; nor would the branch of another, which brings
// commits of its own (of one parent, refused below) or a merge that changed
// something by itself (refused too).
export function onlyBaseMerges(commit: string, head: string): boolean {
  const base = confGet('lanes', 'base');
  if (commit === head) return true;
  if (git(['merge-base', '--is-ancestor', commit, head]).status !== 0) return false;
  const added = git(['rev-list', `${commit}..${head}`, '--not', base]);
  for (const one of added.stdout.split('\n').filter(Boolean)) {
    const parents = git(['rev-list', '--parents', '-n', '1', one]).stdout.trim().split(' ').slice(1);
    if (parents.length !== 2) return false;
    const auto = git(['merge-tree', '--write-tree', parents[0]!, parents[1]!]);
    if (auto.status !== 0) return false;
    if (auto.stdout.trim() !== git(['rev-parse', `${one}^{tree}`]).stdout.trim()) return false;
  }
  return true;
}

// Of the pull requests the user was shown on a ticket and that are not live,
// how many are still open and how many GitHub cannot be asked about. One
// GitHub says closed, or merged by another hand, no longer counts.
export function shownLeft(recordPath: string): { readonly open: number; readonly unknown: number } {
  let open = 0;
  let unknown = 0;
  const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { pulls?: { pr: number; merged_at?: string | null }[] };
  for (const pull of record.pulls ?? []) {
    if (pull.merged_at != null) continue;
    let state = '';
    const viewed = gh(['pr', 'view', String(pull.pr), '--json', 'state']);
    if (viewed.status === 0) { try { state = String((JSON.parse(viewed.stdout) as { state?: unknown }).state ?? ''); } catch { state = ''; } }
    if (state === 'OPEN') open += 1;
    else if (state !== 'CLOSED' && state !== 'MERGED') unknown += 1;
  }
  return { open, unknown };
}

// ---- Files ------------------------------------------------------------------

// Written under another name, then renamed: a reader never reads half of it.
export function writeWhole(path: string, text: string, mode?: number): void {
  const part = `${path}.part`;
  writeFileSync(part, text, mode === undefined ? {} : { mode });
  execFileSync('mv', [part, path]);
}

export function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

export function scratchDir(prefix = 'cleared-'): { readonly path: string; remove(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

export const hasText = (text: string): boolean => /[^\s]/.test(text);

// ---- The guard -------------------------------------------------------------

const DISABLED = '{"disabled":true,"hashes":[]}\n';

// Refuses, without showing any value, a text the guard of the repository
// would not let out (private terms, secrets, IBANs, addresses, phone
// numbers): for anything a command sends to an outside service, the tracker
// and GitHub. False when it is refused or cannot be checked, the reason said.
export function guardText(file: string): boolean {
  const { repo, state } = projectEnv();
  const dir = scratchDir('cleared-guard-');
  try {
    // 1. Its code is the tool's own (lib/guard/). When the tool is a checkout
    // that follows a branch ([update] base), it is the code of that branch,
    // not the files of the checkout: a copy edited by hand does not run an
    // edited guard. When that cannot be (the branch does not carry the guard
    // yet, the tool is a folder of a larger repository), the files are what
    // runs, and it is said each time. ORCH_GUARD_TOOL_REF= (empty) asks for
    // the files: the tests of a change to the guard itself.
    const toolRef = process.env.ORCH_GUARD_TOOL_REF !== undefined ? process.env.ORCH_GUARD_TOOL_REF : (confSoft('update', 'base') || 'origin/main');
    const top = spawnSync('git', ['-C', ORCH_HOME, 'rev-parse', '--show-toplevel' /* git-env: the tool's own checkout, as lib/common.sh read it */], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    let fromRef = false;
    if (toolRef && top.status === 0 && top.stdout.trim() === realpathSync(ORCH_HOME)
      && spawnSync('git', ['-C', ORCH_HOME, 'cat-file', '-e', `${toolRef}:lib/guard/codex-guard.mjs` /* git-env: the tool's own checkout, as lib/common.sh read it */], { stdio: 'ignore' }).status === 0) {
      for (const name of ['codex-guard.mjs', 'private-terms.mjs']) {
        const shown = spawnSync('git', ['-C', ORCH_HOME, 'show', `${toolRef}:lib/guard/${name}` /* git-env: the tool's own checkout, as lib/common.sh read it */], { stdio: ['ignore', 'pipe', 'ignore'] });
        if (shown.status === 0) writeFileSync(join(dir.path, name), shown.stdout);
      }
      fromRef = true;
    }
    if (!fromRef) {
      if (toolRef) say(`${scriptName()}: the guard runs from the files of this checkout (${ORCH_HOME} does not follow ${toolRef}, or that branch does not carry lib/guard/)`);
      for (const name of ['codex-guard.mjs', 'private-terms.mjs']) { try { cpSync(join(ORCH_HOME, 'lib', 'guard', name), join(dir.path, name)); } catch { /* said below */ } }
    }
    const present = (name: string) => { try { return statSync(join(dir.path, name)).size > 0; } catch { return false; } };
    if (!present('codex-guard.mjs') || !present('private-terms.mjs')) {
      say(`${scriptName()}: not sent, the guard of the tool (lib/guard/) could not be read`);
      return false;
    }
    // 2. What it must know of the project (the fingerprints of its private
    // terms, the values checked by hand as fictitious) is the project's, and
    // is read from what is committed on the default branch of its remote,
    // never from the files of a checkout (a session runs code there) and
    // never at a place a settings file names. Which files: [guard] terms and
    // allowed, as the project's committed settings say there. Each names a
    // file, or says « none »; a key left out or misspelt is a refusal, never
    // « no list ». ORCH_GUARD_REF names another ref: the tests, and a project
    // without a remote.
    let ref = process.env.ORCH_GUARD_REF || '';
    if (!ref) {
      const head = spawnSync('git', ['-C', repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD' /* git-env: the service account on its own checkout, as lib/common.sh read it */], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      ref = head.status === 0 ? head.stdout.trim() : '';
    }
    ref ||= 'origin/main';
    const settings = join(dir.path, 'settings.conf');
    const committed = spawnSync('git', ['-C', repo, 'show', `${ref}:.cleared/agents.conf` /* git-env: the service account on its own checkout, as lib/common.sh read it */], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (committed.status !== 0) {
      say(`${scriptName()}: not sent, the committed project configuration (.cleared/agents.conf at ${ref}) could not be read`);
      return false;
    }
    writeFileSync(settings, committed.stdout);
    let inside = false;
    for (const line of committed.stdout.split('\n')) {
      if (line.startsWith('[')) { inside = line === '[guard]'; continue; }
      if (!inside || /^\s*#/.test(line) || !line.includes('=')) continue;
      const key = line.slice(0, line.indexOf('=')).trim();
      if (!['salt', 'terms', 'allowed', 'token_patterns'].includes(key)) {
        say(`${scriptName()}: unknown [guard] key ${key} in committed project configuration`);
        return false;
      }
    }
    const terms = confGetFrom('guard', 'terms', settings) ?? '';
    const allowed = confGetFrom('guard', 'allowed', settings) ?? '';
    if ((terms === '' || terms === 'none') && (allowed === '' || allowed === 'none')) {
      writeFileSync(join(dir.path, 'private-terms.json'), DISABLED);
      writeFileSync(join(dir.path, 'codex-guard-allow.json'), DISABLED);
      mkdirSync(state, { recursive: true });
      const lock = lockFile(join(state, 'guard-disabled.lock'), 30);
      if (!lock) return false;
      try {
        ledgerInit();
        if (Number(ledgerRows("select count(*) as n from events where kind = 'private_terms_disabled'")[0]?.n ?? 0) === 0) {
          ledgerEvent({ kind: 'private_terms_disabled', detail: 'No committed private-term fingerprint lists are configured for this project' });
        }
      } catch { return false; } finally { lock.release(); }
    } else {
      if (!confGetFrom('guard', 'salt', settings)) {
        say('Missing committed [guard] salt: add [guard] salt = <random value> to the project agents.conf and commit it before using these fingerprint lists.');
        return false;
      }
      if (!guardList(dir.path, ref, settings, 'terms', 'private-terms.json', 'of private terms')
        || !guardList(dir.path, ref, settings, 'allowed', 'codex-guard-allow.json', 'of allowed values')) return false;
    }
    // (Its own report goes to the error output, as the bash scripts sent it.)
    const checked = spawnSync(process.execPath, [join(dir.path, 'codex-guard.mjs'), '--strict', file], { env: { ...process.env, ORCH_GUARD_REF: ref }, stdio: ['ignore', 2, 2] });
    if (checked.status !== 0) {
      say(`${scriptName()}: not sent, the guard refuses this text`);
      return false;
    }
    return true;
  } finally {
    dir.remove();
  }
}

// One list of the project put where the guard reads it, as its settings name it.
function guardList(dir: string, ref: string, settings: string, key: string, file: string, what: string): boolean {
  const value = confGetFrom('guard', key, settings) ?? '';
  if (value === '') {
    say(`${scriptName()}: not sent, the project names no list ${what} ([guard] ${key}): write the file path or 'none'`);
    return false;
  }
  if (value.toLowerCase() === 'none') { writeFileSync(join(dir, file), DISABLED); return true; }
  const shown = spawnSync('git', ['-C', projectEnv().repo, 'show', `${ref}:${value}` /* git-env: the service account on its own checkout, as lib/common.sh read it */], { stdio: ['ignore', 'pipe', 'ignore'] });
  if (shown.status !== 0) {
    say(`${scriptName()}: not sent, the list ${what} of the project (${value} on ${ref}) could not be read`);
    return false;
  }
  writeFileSync(join(dir, file), shown.stdout);
  return true;
}
