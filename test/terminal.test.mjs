import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.mjs';
import { openLedger } from '../lib/ledger.mjs';
import { sandbox, scratch } from './support.mjs';

// The fields of a process after its name: [0] its state, [2] its process group, [3] its session, [19] its start.
const stat = (pid) => {
  try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'); return text.slice(text.lastIndexOf(') ') + 2).trim().split(' '); } catch { return null; }
};
const alive = (pid) => { const fields = stat(pid); return Boolean(fields) && fields[0] !== 'Z'; };
const argv = (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
const bootId = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const until = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((done) => setTimeout(done, 100)); }
  return check();
};
const stopGroup = (pid) => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } };

// A sandbox whose project runs its sessions with no terminal at all, on a host where Orca is not even installed.
// systemd-run answers as a host with no user manager, unless FAKE_SCOPE asks it to run the scope (it then only
// writes down how it was asked).
function noneBox({ adapter = 'none' } = {}) {
  const box = sandbox();
  rmSync(join(box.home, 'bin', 'orca'));
  writeFileSync(join(box.home, 'agents.conf'), `${readFileSync(join(box.home, 'agents.conf'), 'utf8')}\n[terminal]\nadapter = ${adapter}\n`);
  writeFileSync(join(box.home, 'bin', 'systemd-run'), `#!/usr/bin/env bash
[ -n "\${FAKE_SCOPE:-}" ] || exit 1
printf '%s\\n' "$*" >> "${join(box.home, 'systemd-run-calls')}"
while [ "$1" != -- ]; do shift; done
shift
exec "$@"
`, { mode: 0o755 });
  // Not in the sandbox, and in no folder of the PATH either: an Orca installed on the host is out of reach.
  const env = { ...box.env, PATH: [join(box.home, 'bin'), ...process.env.PATH.split(':').filter((dir) => dir && !existsSync(join(dir, 'orca')))].join(':') };
  delete env.INVOCATION_ID;
  assert.notEqual(spawnSync('bash', ['-c', 'command -v orca'], { env }).status, 0, 'no orca on the PATH');
  return { ...box, env };
}

// A run folder whose session holds on (its model "works" for 30 s), opened by a parent shell that holds a lock
// of its own (as a wake does) and ends at once.
function openHeld(box, extra = {}) {
  const runDir = scratch('orch-run-');
  writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
  writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }]));
  writeFileSync(join(runDir, 'lane.env'), 'ORCH_LANE=dev/X-1\nORCH_TICKET=X-1\nORCH_ROLE=dev\nORCH_RUN_BASE=X-1-held\nORCH_REQUESTED_ALIAS=a\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=\n');
  const lock = join(box.home, 'parent.lock');
  const opened = spawnSync('bash', ['-c', `exec 8> "${lock}"; flock 8; . "${join(box.home, 'lib', 'common.sh')}"; terminal open "$1" "X-1 · dev · a" "${join(box.home, 'lane-run.sh')} $2" "$2" X-1`, 'parent', box.repo, runDir],
    { env: { ...box.env, FAKE_LEAVES: 'sleep 30', ...extra }, encoding: 'utf8', timeout: 15000 });
  return { opened, runDir, lock, handle: opened.stdout.trim() };
}
const closeWith = (box, handle) => spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; terminal close "$1"`, 'close', handle], { env: box.env, encoding: 'utf8' });


test('[terminal] adapter is orca when the project says nothing, and a name with no adapter stops a spawn before anything is made', () => {
  const box = sandbox();
  const loaded = spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; conf_get terminal adapter; terminal_adapter; echo "$terminal_loaded"`], { env: box.env, encoding: 'utf8' });
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.deepEqual(loaded.stdout.trim().split('\n'), ['orca', 'orca']);

  const wrong = noneBox({ adapter: 'tmux' });
  const run = spawnSync(join(wrong.home, 'spawn-lane.sh'), ['dev', 'X-2', '--comment-on', 'none'], { env: wrong.env, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /unknown \[terminal\] adapter "tmux".*\(known: none orca\)/);
  assert.equal(existsSync(join(wrong.home, 'lanes', 'dev-X-2')), false, 'no worktree is made for a session that cannot start');
  assert.equal(existsSync(join(wrong.state, 'runs')), false);
});


test('[terminal] adapter = none starts the session detached: it outlives its parent, holds none of its locks, leads a session of its own, writes to the run log, and is the process cleared status checks', async (t) => {
  const box = noneBox();
  const { opened, runDir, lock, handle } = openHeld(box);
  assert.equal(opened.status, 0, opened.stderr);
  const [kind, pid, start, boot] = handle.split(':');
  t.after(() => stopGroup(Number(pid)));
  assert.equal(kind, 'none');
  assert.equal(start, stat(pid)[19], 'the handle holds the start of the process');
  assert.equal(boot, bootId());
  assert.deepEqual(readFileSync(join(runDir, 'terminal.none'), 'utf8').trim().split('\n'), [handle, box.repo]);
  // Its parent is gone; the session is not, and is the leader of its own session and process group.
  assert.ok(alive(pid));
  assert.equal(stat(pid)[3], pid);
  assert.equal(stat(pid)[2], pid);
  // The lock its parent held is not held by the session.
  assert.equal(spawnSync('flock', ['-n', lock, 'true']).status, 0);
  // What it prints lands in its run folder.
  assert.ok(await until(() => { try { return /── dev\/X-1 · dev · a \(first: m1\) ──/.test(readFileSync(join(runDir, 'terminal.log'), 'utf8')); } catch { return false; } }));
  // The process is the one cleared status looks for: the run script under bash, the number in the pid file.
  assert.ok(await until(() => existsSync(join(runDir, 'pid'))));
  assert.equal(readFileSync(join(runDir, 'pid'), 'utf8').trim(), pid);
  assert.deepEqual(argv(pid).slice(0, 3).map((word, index) => (index === 0 ? word.split('/').at(-1) : word)), ['bash', join(box.home, 'lane-run.sh'), runDir]);
  // Closed: the session and the harness it started (its process group) are stopped.
  let harness = 0;
  assert.ok(await until(() => (harness = Number(spawnSync('pgrep', ['-g', pid, '-x', 'sleep'], { encoding: 'utf8' }).stdout.trim())) > 0), 'the model of the session is in its process group');
  assert.equal(closeWith(box, handle).status, 0);
  assert.ok(await until(() => !alive(pid) && !alive(harness), 10000), 'the session and its harness are stopped');
});


test('[terminal] adapter = none signals only the process its handle names: another start, another boot, or a process that is no Cleared session is left alone', async (t) => {
  const box = noneBox();
  const { handle } = openHeld(box);
  const [, pid, start, boot] = handle.split(':');
  t.after(() => stopGroup(Number(pid)));
  // The same number with another start: the system gave it to another process.
  assert.equal(closeWith(box, `none:${pid}:${Number(start) + 1}:${boot}`).status, 0);
  assert.equal(closeWith(box, `none:${pid}:${start}:another-boot`).status, 0);
  assert.equal(closeWith(box, 'term_1').status, 0);
  await new Promise((done) => setTimeout(done, 300));
  assert.ok(alive(pid), 'nothing was signalled');
  // A process that started right, but is not a session of Cleared.
  const other = spawn('sleep', ['30'], { stdio: 'ignore' });
  t.after(() => other.kill('SIGKILL'));
  assert.ok(await until(() => argv(other.pid)[0] === 'sleep', 5000));
  assert.equal(closeWith(box, `none:${other.pid}:${stat(other.pid)[19]}:${bootId()}`).status, 0);
  await new Promise((done) => setTimeout(done, 300));
  assert.ok(alive(other.pid), 'a process that is no Cleared session is never signalled');
  // The right handle closes it.
  assert.equal(closeWith(box, handle).status, 0);
  assert.ok(await until(() => !alive(pid), 10000));
});


test('[terminal] adapter = none puts the session in a scope of the user\'s systemd manager when there is one: a wake that ends does not take it along', (t) => {
  const box = noneBox();
  const { opened, handle } = openHeld(box, { FAKE_SCOPE: '1' });
  assert.equal(opened.status, 0, opened.stderr);
  const pid = Number(handle.split(':')[1]);
  t.after(() => stopGroup(pid));
  assert.match(readFileSync(join(box.home, 'systemd-run-calls'), 'utf8'), /^--user --scope --collect --quiet --description=Cleared: X-1 · dev · a -- bash -c /m);
  assert.ok(alive(pid));
  assert.equal(stat(pid)[3], String(pid));
  // Started by a unit, with no scope to be had: the session still starts, and it is said that it may end with the unit.
  const unscoped = openHeld(box, { INVOCATION_ID: 'a-unit' });
  const other = Number(unscoped.handle.split(':')[1]);
  t.after(() => stopGroup(other));
  assert.match(unscoped.opened.stderr, /no scope of its own: it may end with the unit that started it/);
  assert.match(readFileSync(join(unscoped.runDir, 'terminal.log'), 'utf8'), /no scope of its own/);
  assert.ok(alive(other));
});


test('with [terminal] adapter = none and no Orca on the host, spawn-lane, wake and kill-lane run their sessions; adopt-lane refuses, and tell-lane keeps the message for the next session', async () => {
  const box = noneBox();
  const spawned = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-2', '--comment-on', 'none', '--wait'], { env: box.env, encoding: 'utf8', timeout: 60000 });
  assert.equal(spawned.status, 0, spawned.stderr);
  const lane = JSON.parse(spawned.stdout);
  assert.match(lane.terminal, /^none:\d+:\d+:/);
  assert.equal(readFileSync(join(lane.run_dir, 'terminal.handle'), 'utf8').trim(), lane.terminal);
  assert.equal(readFileSync(join(lane.run_dir, 'exit-code'), 'utf8').trim(), '0');
  assert.match(readFileSync(join(lane.run_dir, 'terminal.log'), 'utf8'), /── dev\/X-2 · dev · a \(first: m1\) ──/);
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual(db.prepare("select lane, outcome from runs where lane = 'dev/X-2'").all().map((row) => ({ ...row })), [{ lane: 'dev/X-2', outcome: 'done' }]);
  db.close();

  // No terminal to write down, nor to type in; a lane of the dispatcher is still told by its ticket.
  const adopted = spawnSync(join(box.home, 'adopt-lane.sh'), ['dev-X-2', lane.terminal], { env: box.env, encoding: 'utf8' });
  assert.equal(adopted.status, 1);
  assert.match(adopted.stderr, /\[terminal\] adapter = none: sessions run without a terminal.*tell-lane\.sh <ticket>/);
  const told = spawnSync(join(box.home, 'tell-lane.sh'), ['X-2', '-'], { env: box.env, encoding: 'utf8', input: 'Pense aux tests.' });
  assert.equal(told.status, 0, told.stderr);
  assert.match(told.stdout, /handed to it at its next session/);

  const killed = spawnSync(join(box.home, 'kill-lane.sh'), ['dev/X-2', '--force'], { env: box.env, encoding: 'utf8' });
  assert.equal(killed.status, 0, killed.stderr);
  assert.equal(existsSync(lane.worktree), false);

  // The wake starts the session of the lead the same way, and is over before it.
  const issue = (comments) => writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify([{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }]));
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8', timeout: 60000 });
  issue([]);
  assert.equal(wake().status, 0);
  issue([{ id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: 'OK, vas-y.' }]);
  const woke = wake();
  assert.equal(woke.status, 0, woke.stderr);
  const runDir = woke.stdout.trim().split('\n').at(-1);
  assert.match(readFileSync(join(runDir, 'terminal.handle'), 'utf8'), /^none:\d+:\d+:/);
  assert.ok(await until(() => existsSync(join(runDir, 'exit-code'))), 'the session of the lead ran to its end');
  assert.match(readFileSync(join(runDir, 'terminal.log'), 'utf8'), /── release\/lead · release · a/);
  assert.equal(existsSync(join(box.home, 'orca-calls')), false);
});


test('with [terminal] adapter = none, talk.sh holds the conversation in the terminal it is run from, and refuses to start one from none', () => {
  const box = noneBox();
  // No terminal: nothing is held, the mark that keeps the wakes back is taken away, the way to run it is said.
  const blind = spawnSync(join(box.home, 'talk.sh'), [], { env: box.env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(blind.status, 1);
  assert.match(blind.stderr, /run it by hand in a terminal: cd .*release-lead && .*talk-run\.sh /);
  assert.equal(existsSync(join(box.state, 'wake', 'talk')), false);
  // From a terminal (here: the one the test names), the conversation is held there and talk.sh returns at its end.
  const held = spawnSync(join(box.home, 'talk.sh'), [], { env: { ...box.env, ORCH_TTY: '/dev/null' }, encoding: 'utf8' });
  assert.equal(held.status, 0, held.stderr);
  assert.equal(readFileSync(join(box.state, 'talked'), 'utf8').split('\n')[0], 'first');
  const runDir = held.stdout.trim().split('\n').at(-1);
  assert.equal(readFileSync(join(runDir, 'exit-code'), 'utf8').trim(), '0');
  assert.equal(existsSync(join(box.state, 'wake', 'talk')), false, 'the conversation is over: its mark is gone');
  assert.equal(existsSync(join(box.home, 'orca-calls')), false);
});


test('with [terminal] adapter = none, the harness still starts under [security] agent_user, through sudo -n', () => {
  const box = noneBox();
  const bin = join(box.home, 'bin');
  // The real adapter of a harness, the account of the agents, and a sudo that only writes down what it is asked.
  writeFileSync(join(box.home, 'adapters', 'claude.sh'), readFileSync(join(ORCH_HOME, 'adapters', 'claude.sh'), 'utf8'), { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(box.home, 'sudo-calls')}"
[ "$1 $2" = "-n -u" ] && [ "$4" = -- ] || exit 1
case "$5" in id) exec id -u "$3" ;; test) exit 0 ;; *) exit 1 ;; esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'bwrap'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8')
    .replace('a = first:m1', 'a = claude:m1')
    .replace('[security]\nallow_shared_uid = true\n', `[security]\nallow_shared_uid = true\nagent_user = nobody\nbwrap_path = ${join(bin, 'bwrap')}\n`));
  // The model was seen available a moment ago: no probe.
  mkdirSync(join(box.state, 'models'), { recursive: true });
  writeFileSync(join(box.state, 'models', 'claude.available'), `m1\t${Math.floor(Date.now() / 1000)}\n`);
  const spawned = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-3', '--comment-on', 'none', '--wait'], { env: box.env, encoding: 'utf8', timeout: 60000 });
  assert.match(spawned.stdout, /"terminal": "none:\d+:\d+:/, spawned.stderr);
  const calls = readFileSync(join(box.home, 'sudo-calls'), 'utf8').trim().split('\n');
  const harness = calls.find((line) => / claude -p --model m1 /.test(line));
  assert.ok(harness, calls.join('\n'));
  assert.match(harness, /^-n -u nobody -- env /);
});
