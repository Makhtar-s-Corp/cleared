import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConf, parseConf, ORCH_HOME } from '../lib/conf.ts';
import { route } from '../lib/route.ts';
import { openLedger } from '../lib/ledger.ts';

type Task = Parameters<typeof route>[1];

export const conf = loadConf(join(ORCH_HOME, 'agents.example.conf'));

// Every folder a test makes is removed once the file is done. The temporary
// folder of the host has a limit on the number of files, shared with the CI
// and the lanes: on 2026-10-08 the folders these tests left behind, run after
// run, filled it, and nothing could write there any more.
const scratchDirs: string[] = [];
export const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
};
// A copy of this tool for the tests that run its installer: the listening ports are the test's own (its fake ss), not the
// host's kernel tables, so the copy's lib/ports.ts reads an empty /proc (its HOST, where the installer takes it).
export function toolCopy(home: string): string {
  const tool = join(home, 'copy-of-tool');
  mkdirSync(tool, { recursive: true });
  execFileSync('sh', ['-c', 'tar --exclude=.git --exclude=node_modules -cf - . | tar -xf - -C "$1"', '_', tool], { cwd: ORCH_HOME });
  const proc = join(home, 'proc');
  mkdirSync(proc, { recursive: true });
  const ports = join(tool, 'lib', 'ports.ts');
  writeFileSync(ports, readFileSync(ports, 'utf8').replace("export const HOST: PortsHost = { proc: '/proc',", `export const HOST: PortsHost = { proc: ${JSON.stringify(proc)},`));
  return tool;
}
// (the dependencies a lane is handed are read-only: made writable again before they go)
after(() => { for (const dir of scratchDirs) { try { execFileSync('chmod', ['-R', 'u+w', dir]); } catch { /* gone already */ } rmSync(dir, { recursive: true, force: true }); } });
// A project for the tests that run the real scripts with the example settings: a repository that carries, where
// those settings name them, the lists the guard reads (invented private terms, as fingerprints).
let fixtureProjectDir: string | null = null;
export function fixtureProject(): string {
  if (fixtureProjectDir) return fixtureProjectDir;
  const dir = scratch('orch-project-');
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  git('init', '-q', '-b', 'main');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, '.cleared'), { recursive: true });
  writeFileSync(join(dir, '.cleared', 'agents.conf'), readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8'));
  for (const file of ['codex-guard-allow.json', 'private-terms.json']) execFileSync('cp', [join(ORCH_HOME, 'test', 'fixtures', 'guard', file), join(dir, 'scripts', file)]);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  fixtureProjectDir = dir;
  return dir;
}
// Whether the git in use refuses a repository as another user's under GIT_TEST_ASSUME_DIFFERENT_OWNER. Some
// configurations do not: a global safe.directory (for instance '*', as some CI runners set) makes git accept the
// repository, and then a test that needs the refusal would fail for an environmental reason. Probed once; the tests
// that need the refusal are skipped with FOREIGN_SKIP when it does not refuse, and keep running where it does.
export const FOREIGN_SKIP = 'git does not honour GIT_TEST_ASSUME_DIFFERENT_OWNER here';
let foreignRefusal: boolean | undefined;
export function refusesAsForeign(): boolean {
  if (foreignRefusal === undefined) {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: '1' };
    for (const name of Object.keys(env)) if (name.startsWith('GIT_CONFIG_')) delete env[name];
    const dir = mkdtempSync(join(tmpdir(), 'orch-foreign-probe-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      const probe = spawnSync('git', ['-C', dir, 'ls-files'], { encoding: 'utf8', env });
      foreignRefusal = probe.status === 128 && /dubious ownership/.test(probe.stderr);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return foreignRefusal;
}
// A test that needs the refusal: skipped, with the reason, where git does not refuse.
export const foreignTest = (name: string, fn: (t: TestContext) => void | Promise<void>) => test(name, (t) => (refusesAsForeign() ? fn(t) : t.skip(FOREIGN_SKIP)));

// These tests are about the files of this checkout and about nothing of the machine they run on: the guard is the
// one of the working tree (not the one of the branch the tool follows), and no project is named for the machine.
process.env.ORCH_GUARD_TOOL_REF = '';
process.env.XDG_CONFIG_HOME = scratch('orch-config-');
// A task for the router. Its lane is left out, as it always was here: undefined, not null.
export const task = (over: Partial<Task>): Task => ({ role: 'dev', labels: [], project: null, paths: [], prLines: null, authorModel: null, forced: null, ...over }) as Task;
export const first = (over: Partial<Task>) => route(conf, task(over)).chain[0]!.alias;

// What the stand-ins of the sandbox share: Node scripts (the running Node, by its path), whose answers are files of
// the sandbox. cat(file) prints a file or says why it cannot, as cat does; quiet(file) prints it and says nothing
// when it is not there (cat 2>/dev/null); text(file) is its content, or null.
const STAND_IN = `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');
const childProcess = process.getBuiltinModule('node:child_process');
const env = process.env;
const args = process.argv.slice(2);
const [a1 = '', a2 = '', a3 = '', a4 = ''] = args;
const out = (data) => process.stdout.write(data);
const err = (data) => process.stderr.write(data);
const reasons = { ENOENT: 'No such file or directory', EISDIR: 'Is a directory', EACCES: 'Permission denied', ENOTDIR: 'Not a directory' };
const bytes = (file) => fs.readFileSync(file === '-' ? 0 : file);
const cat = (file) => { try { out(bytes(file)); return true; } catch (error) { err('cat: ' + file + ': ' + (reasons[error.code] ?? error.message) + '\\n'); return false; } };
const quiet = (file) => { try { out(bytes(file)); return true; } catch { return false; } };
const text = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const append = (file, data) => fs.appendFileSync(file, data);
// The value after the last occurrence of a flag ('' when there is none).
const after = (flag) => { let value = ''; let previous = ''; for (const arg of args) { if (previous === flag) value = arg; previous = arg; } return value; };
// " $* ": the arguments joined by spaces, between spaces, to look for a word in them.
const all = ' ' + args.join(' ') + ' ';
`;

// The tracker as the test has it now (lib/script.ts runs <home>/tracker.ts): each subcommand answers from the files
// of the sandbox, a FAKE_TRACKER_* variable makes it fail.
function fakeTracker(home: string) {
  return `${STAND_IN}const home = ${JSON.stringify(home)};
// exit "$(...)": the number modulo 256, or 2 (and why) when it is none.
const exitWith = (value) => {
  const number = value.replace(/\\n+$/, '');
  if (/^[ \\t]*[+-]?[0-9]+[ \\t]*$/.test(number)) return Number(((BigInt(number.trim()) % 256n) + 256n) % 256n);
  err(process.argv[1] + ': exit: ' + number + ': numeric argument required\\n');
  return 2;
};
function main() {
  if (a1 === 'ticket-prefix') { out('X\\n'); return 0; }
  if (a1 === 'legacy-line-allowed') return 0;
  if (a1 === 'changes') return cat(home + '/tracker-now.json') ? 0 : 1;
  if (a1 === 'comment') {
    if (env.FAKE_TRACKER_DOWN) return 1;
    if (env.FAKE_TRACKER_FULL) return 4;
    let posted;
    try { posted = bytes(a3); } catch (error) { posted = Buffer.alloc(0); err('cat: ' + a3 + ': ' + (reasons[error.code] ?? error.message) + '\\n'); }
    fs.writeFileSync(home + '/tracker-posted', Buffer.concat([Buffer.from(a2 + ' from=' + a4 + '\\n'), posted]));
    append(home + '/tracker-posted-log', a2 + '\\n');
    out('https://example.test/comment\\n');
    return 0;
  }
  if (a1 === 'waiting') { out('[{"identifier":"X-7","title":"Un écran à valider","url":"u","since":"2026-01-02T10:00:00Z"}]\\n'); return 0; }
  if (a1 === 'comments') {
    if (env.FAKE_TRACKER_COMMENTS_DOWN) return 1;
    if (!quiet(home + '/tracker-comments.json')) out('[{"id":"c1","createdAt":"2026-01-02T10:00:00Z","body":"Un commentaire du ticket de suivi."}]\\n');
    return 0;
  }
  if (a1 === 'moved-by-owner') {
    append(home + '/tracker-moved-asked', a2 + ' ' + a3 + ' ' + a4 + '\\n');
    return exitWith(text(home + '/tracker-moved-' + a2) ?? text(home + '/tracker-moved') ?? '5');
  }
  if (a1 === 'list') { if (!quiet(home + '/tracker-list-' + a2 + '.json')) out('[]\\n'); return 0; }
  if (a1 === 'label-actors') return quiet(home + '/tracker-label-actors-' + a2 + '.json') ? 0 : 1;
  if (a1 === 'identity') { if (!quiet(home + '/tracker-identity')) out('app\\n'); return 0; }
  if (a1 === 'move') {
    if (env.FAKE_TRACKER_MOVE_DOWN) return 1;
    append(home + '/tracker-moves', a2 + ' -> ' + a3 + '\\n');
    fs.writeFileSync(home + '/tracker-state', a3 + '\\n');
    return 0;
  }
  if (a1 === 'upload') {
    if (a2.endsWith('.png')) { out('https://uploads.example.test/' + path.basename(a2) + '\\n'); return 0; }
    err('not an image\\n');
    return 1;
  }
  if (a1 === 'state') {
    if (!quiet(home + '/tracker-state-' + a2) && !quiet(home + '/tracker-state')) out('In Review\\n');
    return 0;
  }
  if (a1 === 'issue') {
    // The ticket as jq -c printed it: these keys in this order, compact, DEL escaped as jq escapes it.
    const title = text(home + '/tracker-title-' + a2)?.replace(/\\n+$/, '') ?? 'Titre de ' + a2;
    let labels;
    try { labels = JSON.parse((text(home + '/tracker-labels-' + a2 + '.json') ?? '[]').replace(/\\n+$/, '')); }
    catch { err('jq: invalid JSON text passed to --argjson\\nUse jq --help for help with command-line options,\\nor see the jq manpage, or online docs  at https://jqlang.github.io/jq\\n'); return 2; }
    const description = text(home + '/tracker-description-' + a2) ?? '';
    out(JSON.stringify({ identifier: a2, title, url: 'u', project: null, labels, description }).replace(/\\x7f/g, '\\\\u007f') + '\\n');
    return 0;
  }
  out('{"identifier":"X-1","title":"t","url":"u","project":null,"labels":[]}\\n');
  return 0;
}
process.exitCode = main();
`;
}

// gh as the test has it now: what GitHub lists and shows is read from files of the sandbox, what is asked of it
// (a pull request opened, merged, closed, a run rerun) is written down there; a FAKE_GH_* variable makes it fail.
function fakeGh(home: string) {
  return `${STAND_IN}const home = ${JSON.stringify(home)};
const pair = a1 + ' ' + a2;
const lines = (list) => list.map((arg) => arg + '\\n').join('');
function main() {
  if (pair === 'pr list') {
    if (env.FAKE_GH_LIST_DOWN) return 1;
    const head = after('--head');
    if (head) { if (!quiet(home + '/pr-head-' + head.replaceAll('/', '-') + '.json')) out('[]\\n'); return 0; }
    return cat(home + '/pulls-now.json') ? 0 : 1;
  }
  if (pair === 'pr create') {
    if (env.FAKE_GH_DOWN) return 1;
    fs.writeFileSync(home + '/pr-create-args', lines(args));
    let previous = '';
    for (const arg of args) {
      if (previous === '--body-file') {
        try { fs.copyFileSync(arg, home + '/pr-create-body.md'); } catch (error) { err("cp: cannot stat '" + arg + "': " + (reasons[error.code] ?? error.message) + '\\n'); }
      }
      previous = arg;
    }
    out('https://example.test/pull/41\\n');
    return 0;
  }
  if (pair === 'pr ready') { append(home + '/pr-ready', a3 + ' ' + a4 + '\\n'); return 0; }
  if (pair === 'run view') {
    if (all.includes(' --json jobs ')) { if (!quiet(home + '/run-jobs.json')) out('{"jobs":[]}\\n'); return 0; }
    append(home + '/run-viewed', a3 + '\\n');
    quiet(home + '/run-log.txt');
    return 0;
  }
  if (pair === 'run rerun') {
    if (env.FAKE_GH_RERUN_DOWN) return 1;
    if (env.FAKE_GH_RERUN_FORBIDDEN) { err('HTTP 403: Resource not accessible by integration (https://api.github.com/repos/o/r/actions/runs/77/rerun-failed-jobs)\\n'); return 1; }
    append(home + '/run-rerun', a3 + ' ' + a4 + '\\n');
    return 0;
  }
  if (pair === 'pr close') {
    if (env.FAKE_GH_CLOSE_DOWN) return 1;
    append(home + '/pr-closed', a3 + '\\n');
    return 0;
  }
  if (pair === 'pr merge') { fs.writeFileSync(home + '/pr-merged', lines(args)); return 0; }
  if (pair === 'pr view') {
    if ((env.FAKE_GH_VIEW_DOWN ?? '') === a3) return 1;
    if (quiet(home + '/pr-view-' + a3 + '.json')) return 0;
    return cat(home + '/pr-view.json') ? 0 : 1;
  }
  if (pair === 'run list') {
    if (all.includes(' --event schedule ')) { if (!quiet(home + '/night-runs.json')) out('[]\\n'); return 0; }
    if (all.includes(' --event workflow_dispatch ')) { if (!quiet(home + '/night-runs-by-hand.json')) out('[]\\n'); return 0; }
    if (all.includes(' --branch ')) {
      const runs = home + '/runs-of-branch.json';
      let isFile = false;
      try { isFile = fs.statSync(runs).isFile(); } catch { /* not there */ }
      if (!isFile) { out('77\\n'); return 0; }
      // The filter gh would apply (--jq), applied by jq itself.
      const jq = childProcess.spawnSync('jq', ['-r', after('--jq'), runs], { stdio: 'inherit' });
      if (jq.error) { err('jq: command not found\\n'); return 127; }
      return jq.status ?? 1;
    }
    out((env.FAKE_GH_RUNS || '[]') + '\\n');
    return 0;
  }
  if (a1 === 'api') { out('2020-01-01T00:00:00Z\\n'); return 0; }
  out('0\\n');
  return 0;
}
process.exitCode = main();
`;
}

export function sandbox({ policy = 'fallback', maxLanes = 3 }: { policy?: string; maxLanes?: number } = {}) {
  const home = scratch('orch-home-');
  const state = join(home, 'state');
  const repo = join(home, 'repo');
  execFileSync('cp', ['-r', join(ORCH_HOME, 'lib'), join(ORCH_HOME, 'wake.ts'), join(ORCH_HOME, 'merge-pr.ts'), join(ORCH_HOME, 'ask-validation.ts'), join(ORCH_HOME, 'package.json'), home]);
  execFileSync('mkdir', ['-p', repo, join(home, 'lanes')]);
  execFileSync('cp', ['-r', join(ORCH_HOME, 'prompts'), home]);
  // tracker and GitHub as files the test writes: what they "say now".
  writeFileSync(join(home, 'tracker.ts'), fakeTracker(home), { mode: 0o755 });
  writeFileSync(join(home, 'tracker-now.json'), '[]');
  // What GitHub says of itself: all is well, unless a test writes otherwise. No test asks the real page.
  writeFileSync(join(home, 'github-status.json'), JSON.stringify({ components: ['Git Operations', 'Pull Requests', 'Actions', 'API Requests', 'Webhooks'].map((name) => ({ name, status: 'operational' })) }));
  writeFileSync(join(home, 'pulls-now.json'), '[]');
  writeFileSync(join(home, 'prompts', 'dev.md'), 'prompt\n');
  writeFileSync(join(home, 'prompts', 'release.md'), 'lead prompt\n');
  writeFileSync(join(home, 'prompts', 'handover.md'), 'handover prompt\n');
  writeFileSync(join(home, 'prompts', 'release-live.md'), 'acting lead prompt\n');
  writeFileSync(join(home, 'prompts', 'review.md'), 'review prompt\n');
  writeFileSync(join(home, 'prompts', 'talk.md'), 'talk prompt, decisions in @DECISIONS@, default ticket @REPORT_ON@\n');
  writeFileSync(join(home, 'agents.conf'), `[models]\na = first:m1\nb = second:m2\n[fallbacks]\na = b\nb = a\n[roles]\ndev = a\nrelease = a\ntalk = a\nreview = a\n[review]\ndiffers_from_author = yes\nwhen_same = b\nauthor_role = dev\nper_hour = 3\n[talk]\nrole = talk\n[permissions.talk]\nmode = read-only\nallow = only-for-the-talk\ndeny = never\n[policy]\nguard_refusal = ${policy}\n[limits]\nmax_lanes = ${maxLanes}\ncounted_roles = dev\n[lanes]\nroot = ${join(home, 'lanes')}\nbase = main\npush_roles = dev talk\n[tracker]\nadapter = local\nteam = X\nowner_name = the user\nprogress_state = In Progress\nreview_state = In Review\ntodo_state = Todo\nvalidate_state = À valider\ngo_state = Go MEP\ndone_state = Done\nwriteup_role =\n[lead]\nrole = release\nlive = no\nmax_minutes = 20\nname = chef de projet\nreport_on = X-100\nreport_hours = 6\nmessages_per_lane_per_hour = 2\n[permissions.release-live]\nmode = read-only\nallow = only-for-the-acting-lead\ndeny = never\n[currency]\nusd_eur = 1\n[rules]\n[security]\nallow_shared_uid = true\n`);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  git('init', '-q', '-b', 'main');
  // What the guard must know of the project (its private terms, as fingerprints, and the values it allows) is the
  // project's, read from its trusted ref: here, invented ones.
  execFileSync('mkdir', ['-p', join(repo, 'scripts')]);
  for (const file of ['codex-guard-allow.json', 'private-terms.json']) execFileSync('cp', [join(ORCH_HOME, 'test', 'fixtures', 'guard', file), join(repo, 'scripts', file)]);
  mkdirSync(join(repo, '.cleared'), { recursive: true });
  writeFileSync(join(repo, '.cleared', 'agents.conf'), '[guard]\nsalt = cleared-example-only\nterms = scripts/private-terms.json\nallowed = scripts/codex-guard-allow.json\n');
  writeFileSync(join(home, 'agents.conf'), `${readFileSync(join(home, 'agents.conf'), 'utf8')}\n[guard]\nsalt = cleared-example-only\nterms = scripts/private-terms.json\nallowed = scripts/codex-guard-allow.json\n`);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  execFileSync('mkdir', ['-p', join(home, 'bin')]);
  writeFileSync(join(home, 'bin', 'gh'), fakeGh(home), { mode: 0o755 });
  writeFileSync(join(home, 'bin', 'docker'), `#!${process.execPath}\n`, { mode: 0o755 });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'release-broker.secret'), 'fixture-broker-secret', { mode: 0o600 });
  const env = { ...process.env, PATH: `${join(home, 'bin')}:${process.env.PATH}`, ORCH_REPO: repo, ORCH_STATE_DIR: state, ORCH_CONF: join(home, 'agents.conf'), ORCH_BROKER_SECRET: 'fixture-broker-secret', ORCH_GUARD_REF: 'main', ORCH_GITHUB_STATUS: `file://${join(home, 'github-status.json')}` };
  return { home, state, repo, env: env as NodeJS.ProcessEnv & typeof env, git };
}

export type Sandbox = ReturnType<typeof sandbox>;

export function laneWithRemote(branch: string, message: string | null = 'feat: the work of the lane') {
  const box = sandbox();
  const remote = join(box.home, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  box.git('remote', 'add', 'origin', remote);
  box.git('push', '-q', 'origin', 'main');
  const path = join(box.home, 'lanes', branch.replace('/', '-'));
  box.git('worktree', 'add', '-q', '-b', branch, path, 'main');
  if (message) execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', message]);
  const onRemote = () => execFileSync('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname:short) %(objectname:short)', 'refs/heads'], { encoding: 'utf8' }).trim().split('\n');
  const created = () => { try { return readFileSync(join(box.home, 'pr-create-args'), 'utf8').trim().split('\n'); } catch { return null; } };
  const body = () => { try { return readFileSync(join(box.home, 'pr-create-body.md'), 'utf8'); } catch { return null; } };
  return { box, remote, path, onRemote, created, body };
}

export type Lane = ReturnType<typeof laneWithRemote>;
type PullOptions = {
  answer?: string;
  prepare?: ((made: { box: Sandbox; lane: Lane; git: (...args: string[]) => string }) => void) | null;
  ticket?: string;
  table?: { tooling_paths?: string; guarded_paths?: string };
};

export function reviewedPull(files: string[], { answer = 'Verdict : rien de bloquant.', prepare = null, ticket = 'X-5', table = { tooling_paths: 'ops/cleared/, docs/decisions.md', guarded_paths: '.github/, compose, Dockerfile, ops/cleared/merge-pr.sh' } }: PullOptions = {}) {
  const lane = laneWithRemote('feat/w', 'feat: the work of the lane');
  const { box } = lane;
  // What a pull request changes is read from git, not from what GitHub lists: the files are really in the branch.
  const laneGit = (...args: string[]) => execFileSync('git', ['-C', lane.path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  if (prepare) prepare({ box, lane, git: laneGit });
  for (const file of files) {
    mkdirSync(dirname(join(lane.path, file)), { recursive: true });
    writeFileSync(join(lane.path, file), `${file}\n`);
  }
  if (files.length) {
    laneGit('add', '-A');
    laneGit('commit', '-q', '-m', 'feat: the files of the pull request');
  }
  // The host of the sandbox is its own: no process of the real one (a CI running its screen tests) is read.
  mkdirSync(join(box.home, 'proc-none'), { recursive: true });
  const env = { ...box.env, HOME: box.home, ORCH_PROC_DIR: join(box.home, 'proc-none') };
  const headOf = () => execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const publish = (over: Record<string, unknown> = {}) => {
    execFileSync('git', ['-C', lane.path, 'push', '-q', 'origin', 'feat/w']);
    execFileSync('git', ['-C', box.repo, 'fetch', '-q', 'origin']);
    writeFileSync(join(box.home, 'pr-view.json'), JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, title: 't', body: 'b', headRefName: 'feat/w', baseRefName: 'main', headRefOid: headOf(), createdAt: '2026-01-01T00:00:00Z', additions: 1, deletions: 0, files: files.map((path) => ({ path })), statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SKIPPED' }], ...over }));
  };
  // The base of the sandbox is its local main: the scripts read it as origin/main once it is pushed.
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8').replace('base = main', 'base = origin/main')}[merge]\ntooling_paths = ${table.tooling_paths}\nguarded_paths = ${table.guarded_paths}\ncode_paths = server/, frontend/, shared/\nverdict = rien de bloquant\nlines_until = 2026-01-03T00:00:00Z\nqueue_hours = 24\n`);
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[tracker]\nadapter = local\nteam = X\n', '[tracker]\nadapter = local\nteam = X\nvalidate_state = À valider\ngo_state = Go MEP\ndone_state = Done\n'));
  publish();
  // The passing review of this version, where merge-pr.ts reads it: a runs row of the ledger and its report, as the
  // v2 service records it (v2/src/approval/review.ts).
  recordReview(box, { ticket, pr: 7, commit: headOf(), answer });
  const merge = (args: string[] = [], extra: NodeJS.ProcessEnv = {}, input: string | undefined = undefined) => spawnSync(join(box.home, 'merge-pr.ts'), ['7', ticket, ...args], { env: { ...env, ...extra }, encoding: 'utf8', input });
  const merged = () => { try { return readFileSync(join(box.home, 'pr-merged'), 'utf8').trim().split('\n'); } catch { return null; } };
  const moves = () => { try { return readFileSync(join(box.home, 'tracker-moves'), 'utf8').trim().split('\n'); } catch { return []; } };
  const ledgerKinds = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare("select kind from events where kind in ('merged_by_script', 'merge_refused') order by rowid").all().map((row) => row.kind); db.close(); return rows; };
  const hisLine = (body: string, over: Record<string, unknown> = {}) => writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'u1', body, byOwner: true, createdAt: '2026-01-02T10:00:00Z', editedAt: null, ...over }]));
  const ask = (input = '**Ce qui change.** Je la mets en ligne ?', extra: NodeJS.ProcessEnv = {}) => spawnSync(join(box.home, 'ask-validation.ts'), [ticket, '-', '--pr', '7'], { env: { ...env, ...extra }, encoding: 'utf8', input });
  return { lane, box, env, headOf, publish, merge, merged, moves, ledgerKinds, hisLine, ask, git: laneGit };
}

export type Pull = ReturnType<typeof reviewedPull>;

// A review of a pull request at a commit, as the v2 service records it (v2/src/approval/review.ts): its run in the
// ledger and its report in the state.
export function recordReview(box: { state: string }, { ticket, pr, commit, answer, at = new Date().toISOString() }: { ticket: string; pr: number; commit: string; answer: string; at?: string }): string {
  const db = openLedger(join(box.state, 'ledger.db'));
  const runId = `${ticket}-pr${pr}-review-${Date.parse(at)}-${Math.random().toString(16).slice(2, 8)}`;
  try {
    db.prepare(`INSERT INTO runs (run_id, ticket, role, model, started_at, ended_at, outcome, pr_number, source)
      VALUES (?, ?, 'review', 'm2', ?, ?, 'done', ?, 'dispatcher')`).run(runId, ticket, at, at, pr);
  } finally { db.close(); }
  mkdirSync(join(box.state, 'reports'), { recursive: true });
  writeFileSync(join(box.state, 'reports', `${runId}.md`), `---\ncommit: ${commit}\noutcome: done\nended_at: ${at}\n---\n## Report\n${answer}\n`);
  return runId;
}

// A function of the tool's Node modules (lib/script.ts, lib/queues.ts…) of the copy at `home`, called in a process of
// its own with that environment, as the bash tests sourced lib/common.sh to call one. `expression` names the module m:
// what it gives is printed (false is exit code 1), and a ScriptExit is its exit code.
export function toolCall(home: string, module: string, expression: string, env: NodeJS.ProcessEnv = process.env) {
  const code = `const m = await import(${JSON.stringify(pathToFileURL(join(home, module)).href)});
try {
  const out = await (${expression});
  if (out === false) process.exitCode = 1;
  else if (out !== undefined && out !== null && out !== true) process.stdout.write(String(out) + '\\n');
} catch (error) {
  if (error?.constructor?.name !== 'ScriptExit') throw error;
  process.exitCode = error.code;
}`;
  return spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { env, encoding: 'utf8' });
}
