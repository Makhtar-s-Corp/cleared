// A lock to run the real v1 scripts against: merge-pr.ts, ask-validation.ts,
// tracker.ts and the release broker, on a temporary state directory, a
// temporary repository with a bare origin, and a fake gh, docker and systemd
// first on the PATH. Nothing here reaches GitHub, Docker or the machine's own state.
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

export const CLEARED_HOME = fileURLToPath(new URL('../../../', import.meta.url));
export const EXAMPLE_CONF = join(CLEARED_HOME, 'examples/guestbook/.cleared/agents.conf');

const made: string[] = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

export function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// A directory whose path is short enough for a Unix socket (100 bytes).
export function shortScratch(prefix: string): string {
  const base = tmpdir().length < 40 ? tmpdir() : (process.env.XDG_RUNTIME_DIR || '/tmp');
  const dir = mkdtempSync(join(base, prefix));
  made.push(dir);
  return dir;
}

export const OWNER = 'demo';
export const TICKET = 'LOCAL-1';

export function keyPair(): { privatePem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'pem' }) as string).toString('base64'),
  };
}

// The example's committed settings, plus what the machine adds: the service's
// uid as the agents' account, the owner's name (never the service account's
// own), the public key, the service account as the broker's human account, and
// the keys v1 requires that the example does not carry.
export function lockConf(options: { publicKey: string; socket?: string }): string {
  const example = readFileSync(EXAMPLE_CONF, 'utf8');
  return `${example}
[tracker]
team = LOCAL
agents_uid = ${process.getuid?.()}
owner_id = ${OWNER}
human_public_key = ${options.publicKey}
[security]
human_user = ${userInfo().username}
${options.socket ? `socket_path = ${options.socket}\n` : ''}[lanes]
root = /nonexistent-lanes
base = origin/main
push_roles = dev
busy_states = In Progress
closed_states = Done
archives = none
[lead]
report_on = LOCAL-1
name = Cleared
`;
}

// The fake gh and docker of the lock's scripts, in Node (D11).
const FAKE_GH = [
  `#!${process.execPath}`,
  "const fs = process.getBuiltinModule('node:fs');",
  'const dir = process.env.FAKE_DIR;',
  'const args = process.argv.slice(2);',
  "const command = (args[0] ?? '') + ' ' + (args[1] ?? '');",
  "if (command === 'pr view') process.stdout.write(fs.readFileSync(dir + '/pr-view.json'));",
  "else if (command === 'pr merge') fs.writeFileSync(dir + '/pr-merged', args.map((arg) => arg + '\\n').join(''));",
  "else if (command === 'run list' || command === 'pr list') process.stdout.write('[]\\n');",
  "else if (command.startsWith('api ')) process.stdout.write('2020-01-01T00:00:00Z\\n');",
  "else process.stdout.write('0\\n');",
  '',
].join('\n');

// lib/release.ts starts its watch through the user's systemd, else as a detached
// process. Either would outlive a test: a detached one writes in the folder the
// hook above removes (ENOTEMPTY, seen on CI), and a transient unit restarts for
// as long as its machine runs, its folder gone. So the box's PATH answers both:
// the watch is asked for and written down, and nothing starts.
const FAKE_SYSTEMD_RUN = [
  `#!${process.execPath}`,
  "process.getBuiltinModule('node:fs').appendFileSync(process.env.FAKE_DIR + '/systemd-run.log', process.argv.slice(2).join(' ') + '\\n');",
  '',
].join('\n');
const FAKE_SYSTEMCTL = `#!${process.execPath}\nprocess.stdout.write('inactive\\n');\n`;

// The watches running from a box's folder, read from /proc: none, once the fakes above answer.
export function watchersIn(dir: string): string[] {
  return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((pid) => {
    try {
      const line = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      return /release\.ts watch /.test(line) && readlinkSync(`/proc/${pid}/cwd`).startsWith(dir) ? [line.trim()] : [];
    } catch {
      return [];   // It ended while it was read, or it is another account's.
    }
  });
}

export type Lock = ReturnType<typeof lockBox>;

export function lockBox(options: { socket?: boolean } = {}) {
  const dir = scratch('cleared-v2-lock-');
  const state = join(dir, 'state');
  const fake = join(dir, 'fake');
  const home = join(dir, 'home');
  const remote = join(dir, 'origin.git');
  const repo = join(dir, 'repo');
  for (const path of [state, fake, join(dir, 'bin'), home, join(dir, 'proc-none')]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'bin', 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(dir, 'bin', 'docker'), `#!${process.execPath}\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'bin', 'systemd-run'), FAKE_SYSTEMD_RUN, { mode: 0o755 });
  writeFileSync(join(dir, 'bin', 'systemctl'), FAKE_SYSTEMCTL, { mode: 0o755 });
  writeFileSync(join(fake, 'github-status.json'), JSON.stringify({ components: ['Git Operations', 'Pull Requests', 'Actions', 'API Requests', 'Webhooks'].map((name) => ({ name, status: 'operational' })) }));
  const keys = keyPair();
  const keyFile = join(dir, 'approval.key');
  writeFileSync(keyFile, keys.privatePem, { mode: 0o600 });
  const socketDir = options.socket ? shortScratch('cl-') : null;
  const socket = socketDir ? join(socketDir, 'r.sock') : undefined;
  const confFile = join(dir, 'agents.conf');
  writeFileSync(confFile, lockConf({ publicKey: keys.publicKey, ...(socket ? { socket } : {}) }));
  const secret = randomBytes(16).toString('hex');
  writeFileSync(join(state, 'release-broker.secret'), secret, { mode: 0o600 });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    HOME: home,
    FAKE_DIR: fake,
    ORCH_REPO: repo,
    CLEARED_REPO: repo,
    ORCH_STATE_DIR: state,
    CLEARED_STATE_DIR: state,
    ORCH_CONF: confFile,
    CLEARED_CONF: confFile,
    ORCH_BROKER_SECRET: secret,
    ORCH_GUARD_REF: 'main',
    ORCH_SIGNED: 'Cleared',
    ORCH_PROC_DIR: join(dir, 'proc-none'),
    ORCH_GITHUB_STATUS: `file://${join(fake, 'github-status.json')}`,
    ...(socket ? { CLEARED_RELEASE_SOCKET: socket } : {}),
  };
  delete env.ORCH_LEDGER;

  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, repo], { stdio: 'ignore' });
  git(repo, 'checkout', '-q', '-b', 'main');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'page.ts'), 'export const page = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', 'cleared/LOCAL-1');

  const head = () => git(repo, 'rev-parse', 'HEAD').trim();
  // Publishes the branch as it is and tells the fake gh what the pull request says.
  const publish = () => {
    git(repo, 'push', '-q', '-f', 'origin', 'cleared/LOCAL-1');
    git(repo, 'fetch', '-q', 'origin');
    writeFileSync(join(fake, 'pr-view.json'), JSON.stringify({
      number: 7, state: 'OPEN', isDraft: false, title: 'Newest entry first', body: 'b', headRefName: 'cleared/LOCAL-1', baseRefName: 'main',
      headRefOid: head(), createdAt: '2026-01-01T00:00:00Z', statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    }));
  };
  const commit = (file: string, text: string) => {
    mkdirSync(join(repo, file, '..'), { recursive: true });
    writeFileSync(join(repo, file), text);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', `change ${file}`);
  };
  const run = (script: string, args: string[], extra: NodeJS.ProcessEnv = {}, input?: string): SpawnSyncReturns<string> =>
    spawnSync(join(CLEARED_HOME, script), args, { env: { ...env, ...extra }, encoding: 'utf8', ...(input === undefined ? {} : { input }) });
  const tracker = (...args: string[]) => run('tracker.ts', args);
  const merged = () => { try { return readFileSync(join(fake, 'pr-merged'), 'utf8').trim().split('\n'); } catch { return null; } };
  return { dir, state, repo, env, keys, keyFile, confFile, secret, socket, fake, git, head, publish, commit, run, tracker, merged };
}
