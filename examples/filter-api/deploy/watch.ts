// Stands in for a deployment system: polls the base branch of the filter
// API's repository and, when its head moves (a merge, or the revert of a
// rollback), builds that exact commit into an image and replaces the app
// container, published on 127.0.0.1:8795 only. The filter API has no
// database: its word list is in the image.
//   node deploy/watch.ts --repo <clone> [--remote origin] [--branch main] [--interval 30] [--once]
//
// Every Docker object it creates carries both LABELS, and it only stops or
// removes an id that a listing filtered on both labels returned, so it never
// touches anything else on the machine, the guestbook's watcher included.
// git and docker run without a shell. One JSON line per tick goes to stdout.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

export const LABELS = ['cleared.dev=v2', 'cleared.example=filter-api'] as const;
const IMAGE = 'cleared-filter-api';
const APP_NAME = 'cleared-filter-api';
export const PORT = 8795;

export type Run = (command: 'git' | 'docker', args: readonly string[], input?: Buffer) => Promise<Buffer>;

export type WatchOptions = {
  readonly repo: string;
  readonly remote: string;
  readonly branch: string;
  readonly port: number;
  readonly run: Run;
  // Whether nothing listens on 127.0.0.1:port.
  readonly portFree: (port: number) => Promise<boolean>;
};

export type Outcome = {
  readonly kind: 'unchanged' | 'deployed' | 'build-failed' | 'run-failed' | 'skipped-failed' | 'port-busy';
  readonly commit: string;
};

const labelArgs = (...extra: string[]): string[] => [...LABELS, ...extra].flatMap((label) => ['--label', label]);
const filterArgs = (...extra: string[]): string[] => [...LABELS, ...extra].flatMap((label) => ['--filter', `label=${label}`]);
const lines = (output: Buffer): string[][] =>
  output.toString().split('\n').filter((line) => line.trim() !== '').map((line) => line.trim().split(/\s+/));

export function createWatcher(options: WatchOptions): { tick(): Promise<Outcome> } {
  const { repo, remote, branch, port, run } = options;
  const git = (...args: string[]): Promise<Buffer> => run('git', ['-C', repo, ...args]);
  const docker = (...args: string[]): Promise<Buffer> => run('docker', args);
  let failed: string | undefined;

  // Containers of one role: [id, state, commit label].
  const containers = async (role: string): Promise<string[][]> =>
    lines(await docker('ps', '-a', ...filterArgs(`cleared.role=${role}`), '--format', '{{.ID}} {{.State}} {{.Label "cleared.commit"}}'));

  async function removeOldImages(keep: string): Promise<void> {
    for (const [id, name] of lines(await docker('image', 'ls', ...filterArgs(), '--format', '{{.ID}} {{.Repository}}:{{.Tag}}'))) {
      if (id && name !== keep) await docker('image', 'rm', id).catch(() => undefined);
    }
  }

  return {
    async tick() {
      await git('fetch', '--quiet', remote, branch);
      const commit = (await git('rev-parse', '--verify', `refs/remotes/${remote}/${branch}^{commit}`)).toString().trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`the head of ${remote}/${branch} is not a commit id: ${commit}`);

      const apps = await containers('app');
      // An app of this commit that crash-loops (restarting) is deployed too:
      // rebuilding the same commit would not help, /health tells the release watch.
      if (apps.some(([, state, label]) => label === commit && (state === 'running' || state === 'restarting'))) return { kind: 'unchanged', commit };
      if (commit === failed) return { kind: 'skipped-failed', commit };
      if (apps.length === 0 && !(await options.portFree(port))) return { kind: 'port-busy', commit };

      // The exact commit, from git archive on stdin: never a working tree.
      const tag = `${IMAGE}:${commit.slice(0, 12)}`;
      try {
        const archive = await git('archive', '--format=tar', commit);
        await run('docker', ['build', '--quiet', ...labelArgs(`cleared.commit=${commit}`), '--tag', tag, '-'], archive);
      } catch {
        failed = commit;
        return { kind: 'build-failed', commit };
      }

      try {
        for (const [id] of apps) if (id) await docker('rm', '-f', id);
        await docker('run', '-d', '--name', APP_NAME, ...labelArgs('cleared.role=app', `cleared.commit=${commit}`),
          '-p', `127.0.0.1:${port}:${port}`, '-e', 'HOST=0.0.0.0', '-e', `PORT=${port}`,
          '--restart', 'unless-stopped', tag);
      } catch {
        failed = commit;
        return { kind: 'run-failed', commit };
      }
      failed = undefined;
      await removeOldImages(tag);
      return { kind: 'deployed', commit };
    },
  };
}

export type Args = {
  readonly repo: string;
  readonly remote: string;
  readonly branch: string;
  readonly intervalSeconds: number;
  readonly once: boolean;
};

export function parseArgs(argv: readonly string[]): Args {
  let repo: string | undefined;
  let remote = 'origin';
  let branch = 'main';
  let intervalSeconds = 30;
  let once = false;
  for (let at = 0; at < argv.length; at++) {
    const flag = argv[at];
    if (flag === '--once') {
      once = true;
      continue;
    }
    if (!['--repo', '--remote', '--branch', '--interval'].includes(flag ?? '')) throw new Error(`unknown option: ${flag}`);
    const value = argv[++at];
    // A value never starts with a dash, so it cannot become an option of git.
    if (value === undefined || value.startsWith('-')) throw new Error(`${flag} needs a value`);
    if (flag === '--repo') repo = value;
    else if (flag === '--remote') remote = value;
    else if (flag === '--branch') branch = value;
    else {
      intervalSeconds = Number(value);
      if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) throw new Error('--interval must be a whole number of seconds, at least 1');
    }
  }
  if (!repo) throw new Error('--repo <clone of the filter API repository> is required');
  return { repo, remote, branch, intervalSeconds, once };
}

// Runs git or docker without a shell; stdout comes back, stderr goes to ours.
export const runCommand: Run = (command, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`${command} ${args[0] === '-C' ? args[2] : args[0]} exited with ${code}`));
    });
    // A command that exits before reading all of its input (docker build on a
    // bad Dockerfile) makes the write fail: its exit code reports the failure.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

export const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const watcher = createWatcher({ ...args, port: PORT, run: runCommand, portFree });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; });
  // Stopping the watcher leaves the app running, as a deployment system would.
  while (!stopping) {
    try {
      console.log(JSON.stringify({ at: new Date().toISOString(), ...(await watcher.tick()) }));
    } catch (error) {
      console.log(JSON.stringify({ at: new Date().toISOString(), kind: 'error', message: (error as Error).message }));
    }
    if (args.once) return;
    await sleep(args.intervalSeconds * 1000);
  }
}

if (import.meta.main) await main();
