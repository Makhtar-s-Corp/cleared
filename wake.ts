#!/usr/bin/env node
// The wake of Cleared's v1 services. Run every minute by a timer; no model.
//
//   1. Tries again what only waited: the comments the hourly limit held back,
//      the go-lives that waited for the host, the tickets a go-live could not
//      close.
//   2. Follows the release watch (lib/release.mjs reconcile) and notes an
//      outage of GitHub, with its start and its end, in the ledger.
//   3. Reads what moved in the tracker and on GitHub since the last wake
//      (lib/wake.mjs) and keeps it in its state, where the snapshot reads
//      each pull request's size and checks.
//   4. Writes the snapshot (lib/board-collector.mjs) and the heartbeat's wake
//      end (lib/heartbeat.mjs), then dispatches the notifications
//      (lib/notify.mjs).
//
//   wake.ts
//
// The port of wake.sh and of what it ran of lib/common.sh
// (docs/v2/milestone-4-plan.md, step c), with the same files, events and
// exit codes.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { closeTicketsLeftOpen, flushOutbox, openQueuedMerges } from './lib/queues.ts';
import { agoUtc, confSoft, die, gh, githubDown, idsOf, ledgerEvent, ledgerInit, lockFile, main, nowUtc, ORCH_HOME, projectEnv, readJson, ScriptExit, scratchDir, tracker, writeWhole } from './lib/script.ts';

const node = (file: string, args: readonly string[], options: { readonly stdout?: 'inherit' | 'ignore' | 'pipe'; readonly stderr?: 'inherit' | 'ignore' | 'pipe' } = {}) => {
  const run = spawnSync(process.execPath, ['--no-warnings', join(ORCH_HOME, file), ...args], { env: process.env, encoding: 'utf8', stdio: ['ignore', options.stdout ?? 'inherit', options.stderr ?? 'inherit'] });
  return { status: run.status ?? 1, stdout: run.stdout ?? '' };
};

// The wake's own work; the snapshot, the heartbeat and the notifications
// follow it whatever its end.
function wake(state: string, wakeDir: string): number {
  node('lib/release.mjs', ['reconcile'], { stdout: 'ignore', stderr: 'ignore' });
  // What the hourly limit held back leaves now, grouped, if the user may be written.
  flushOutbox(state);
  // The go-lives that only waited for the host.
  openQueuedMerges(state);
  closeTicketsLeftOpen(state);

  // GitHub down, as its status page says: noted when it starts, written to
  // the ledger when it ends, with both times.
  const mark = join(wakeDir, 'github-down');
  const read = githubDown();
  let out = read.out;
  // Its page cannot be read: an outage already noted goes on, none begins.
  if (read.code !== 0) out = existsSync(mark) ? (readFileSync(mark, 'utf8').split('\n')[1] ?? '') : '';
  if (out) {
    if (!existsSync(mark)) writeFileSync(mark, `${nowUtc()}\n${out}\n`);
  } else if (existsSync(mark)) {
    const [began = '', what = ''] = readFileSync(mark, 'utf8').split('\n');
    const minutes = Math.trunc((Math.floor(Date.now() / 1000) - Math.floor(Date.parse(began) / 1000)) / 60);
    ledgerEvent({ kind: 'github_down', at: began, value: minutes, detail: `from ${began} to ${nowUtc()}: ${what}` });
    rmSync(mark, { force: true });
  }

  // What moved since the last wake, kept in the state the snapshot reads.
  const statePath = join(wakeDir, 'state.json');
  const work = scratchDir('cleared-wake-');
  try {
    // Taken before anything is read: it becomes the time of this wake.
    const readAt = new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
    // The tracker is asked for what was touched since the last wake, with
    // some overlap; what was already seen is told apart by its identifier. A
    // state file that cannot be read is no state: this wake starts over as a
    // first one (lib/wake.mjs does the same with it).
    const last = readJson<{ at?: unknown }>(statePath)?.at;
    const lastAt = typeof last === 'string' ? Date.parse(last) : Number.NaN;
    let since: string;
    if (Number.isFinite(lastAt)) since = new Date(lastAt - 12 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    else {
      since = agoUtc(3 * 3600_000);
      if (existsSync(statePath)) process.stderr.write(`wake.ts: ${statePath} cannot be read: starting over as a first wake\n`);
    }
    // A source that does not answer: this wake sees nothing and moves nothing.
    const changes = tracker(['changes', since]);
    if (changes.status !== 0) die('tracker did not answer: nothing read, nothing moved');
    writeFileSync(join(work.path, 'tracker.json'), changes.stdout);
    if (out) writeFileSync(join(work.path, 'pulls.json'), '[]\n');
    else {
      const pulls = gh(['pr', 'list', '--state', 'all', '--limit', '60', '--json', 'number,title,headRefName,isDraft,state,updatedAt,statusCheckRollup,changedFiles,additions,deletions']);
      if (pulls.stderr) process.stderr.write(pulls.stderr);
      if (pulls.status !== 0) die('GitHub did not answer: nothing read, nothing moved');
      writeFileSync(join(work.path, 'pulls.json'), pulls.stdout);
    }
    // What Cleared's commands posted themselves.
    writeFileSync(join(work.path, 'agent-ids.txt'), idsOf([join(state, 'tracker-comments.jsonl'), join(state, 'tracker-issues.jsonl')]));
    writeFileSync(join(work.path, 'none.json'), '[]\n');
    const none = join(work.path, 'none.json');
    const moved = node('lib/wake.mjs', [statePath, join(work.path, 'tracker.json'), join(work.path, 'pulls.json'), join(work.path, 'agent-ids.txt'), readAt, none,
      confSoft('lead', 'wake_on'), out ? 'down' : '', none, confSoft('tracker', 'go_state'), none], { stdout: 'pipe' });
    if (moved.status !== 0) throw new ScriptExit(moved.status);
    writeWhole(statePath, `${JSON.stringify((JSON.parse(moved.stdout) as { next?: unknown }).next ?? null, null, 2)}\n`);
  } finally {
    work.remove();
  }
  return 0;
}

await main(() => {
  if (process.argv.length > 2) die('usage: wake.ts');
  const { state } = projectEnv();
  const wakeDir = join(state, 'wake');
  mkdirSync(wakeDir, { recursive: true });
  ledgerInit();
  // What GitHub's status page says is read once a wake (lib/script.ts
  // githubDown), by the go-lives and by the outage note.
  process.env.CLEARED_GITHUB_DOWN_CACHE = join(wakeDir, 'github-status.read');
  rmSync(process.env.CLEARED_GITHUB_DOWN_CACHE, { force: true });
  // One wake at a time: one that finds another at work leaves quietly, it
  // comes back in a minute.
  const lock = lockFile(join(wakeDir, 'lock'), 0);
  if (!lock) return 0;
  try {
    let result: number;
    try { result = wake(state, wakeDir); } catch (error) {
      if (!(error instanceof ScriptExit)) process.stderr.write(`wake.ts: ${error instanceof Error ? error.message : String(error)}\n`);
      result = error instanceof ScriptExit ? error.code : 1;
    }
    if (result === 0 && node('lib/board-collector.mjs', [], { stdout: 'ignore' }).status !== 0) result = 1;
    node('lib/heartbeat.mjs', ['wake-end', String(result)], { stdout: 'ignore' });
    // What waits for the human, and what went wrong, told on his phone
    // (lib/notify.mjs, [notify]): last, once the snapshot and the health are
    // written. It never fails the wake, and never holds the wake's lock for
    // long: it gives up its own sends after CLEARED_NOTIFY_DEADLINE_SECONDS
    // (30 by default, 50 at most) and is stopped here after 60 seconds
    // whatever happens. The wake's lock is not handed to it: a sendmail child
    // that outlives the kill must not hold the lock.
    spawnSync('timeout', ['-k', '5', '60', process.execPath, '--no-warnings', join(ORCH_HOME, 'lib', 'notify.mjs'), 'dispatch'], { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] });
    return result;
  } finally {
    lock.release();
  }
});
