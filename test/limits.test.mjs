import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConf, parseConf, ORCH_HOME } from '../lib/conf.mjs';
import { route } from '../lib/route.mjs';
import { openLedger, runStart, runEnd, addEvent, costEur } from '../lib/ledger.mjs';
import { conf, scratch, fixtureProject, sandbox, runLane, laneWithRemote, flowBox, reviewedPull, task, first } from './support.mjs';

test('the lane limit refuses one lane too many and writes it down; an open lane is not opened twice', () => {
  const box = sandbox({ maxLanes: 1 });
  box.git('worktree', 'add', '-q', '-b', 'dev/X-1', join(box.home, 'lanes', 'dev-X-1'), 'main');
  const spawn = (ticket) => spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', ticket, '--comment-on', 'none'], { env: box.env, encoding: 'utf8' });
  const twice = spawn('X-1');
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /already open/);
  const over = spawn('X-2');
  assert.equal(over.status, 3, over.stderr);
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual(db.prepare('select kind, ticket, value from events').all().map((row) => ({ ...row })), [{ kind: 'lane_limit_reached', ticket: 'X-2', value: 1 }]);
  db.close();
});


test('a lane of a role that is not counted does not take one of the three places', () => {
  const box = sandbox({ maxLanes: 1 });
  box.git('worktree', 'add', '-q', '-b', 'release/X-9', join(box.home, 'lanes', 'release-X-9'), 'main');
  const run = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-2', '--comment-on', 'none'], { env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  // And it is not refused a place it does not take: the one place is held by X-2, a lane of a role that reads opens all the same.
  assert.equal(spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-3', '--comment-on', 'none'], { env: box.env, encoding: 'utf8' }).status, 3, 'a second lane that takes a place is refused');
  const reads = spawnSync(join(box.home, 'spawn-lane.sh'), ['review', 'X-4', '--comment-on', 'none', '--author-model', 'a'], { env: box.env, encoding: 'utf8' });
  assert.equal(reads.status, 0, reads.stderr);
  // A role is counted by its exact name: « dev-x » is not « dev ».
  const confPath = join(box.home, 'agents.conf');
  const conf = readFileSync(confPath, 'utf8');
  writeFileSync(confPath, conf.replace('[roles]\ndev = a\n', '[roles]\ndev = a\ndev-x = a\n').replace('push_roles = dev talk', 'push_roles = dev talk dev-x'));
  writeFileSync(join(box.home, 'prompts', 'dev-x.md'), readFileSync(join(box.home, 'prompts', 'dev.md'), 'utf8'));
  const near = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev-x', 'X-6', '--comment-on', 'none'], { env: box.env, encoding: 'utf8' });
  assert.equal(near.status, 0, near.stderr);
  // And « dev » is not counted because a counted role has that word in its name.
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('counted_roles = dev\n', 'counted_roles = dev-x\n'));
  const plain = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-8', '--comment-on', 'none'], { env: box.env, encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  // A project that names no counted role counts every role, here as in the count itself: the limit is never lost.
  writeFileSync(confPath, conf.replace('counted_roles = dev\n', ''));
  const none = spawnSync(join(box.home, 'spawn-lane.sh'), ['review', 'X-7', '--comment-on', 'none', '--author-model', 'a'], { env: box.env, encoding: 'utf8' });
  assert.equal(none.status, 3, none.stderr);
});


test('the subscription is watched from what each session says of it: its share used, what the day took and the pace; no lane opens once a window is at the stop, the lead is told once, and lanes open again when the window starts over', async () => {
  const { summary } = await import('../lib/limits.mjs');
  // The day and the pace, from the readings kept.
  const at = (hour) => `2026-10-09T${String(hour).padStart(2, '0')}:00:00Z`;
  const week = { resets_at: '2026-10-13T09:00:00.000Z' };
  const history = [
    { at: '2026-10-08T20:00:00Z', windows: { seven_day: { used: 56, ...week } } },
    { at: at(5), windows: { seven_day: { used: 57, ...week } } },
    { at: at(9), windows: { seven_day: { used: 62, ...week } } },
    { at: at(11), windows: { seven_day: { used: 65, ...week } } },
    { at: at(12), windows: { seven_day: { used: 68, ...week } } },
  ];
  const dayStart = Date.parse('2026-10-08T22:00:00Z');
  const seen = summary(history, Date.parse(at(12)), 80, dayStart).seven_day;
  assert.deepEqual([seen.used, seen.today, seen.pace, seen.hours_to_stop, seen.hours_to_full, seen.stopped], [68, 12, 2, 6, 16, false]);
  assert.equal(summary([...history, { at: at(13), windows: { seven_day: { used: 81, ...week } } }], Date.parse(at(13)), 80, dayStart).seven_day.stopped, true);
  // Once the window has started over, what was read before says nothing of it.
  assert.deepEqual(summary(history, Date.parse('2026-10-13T10:00:00Z'), 80, Date.parse('2026-10-12T22:00:00Z')), {});
  // No pace from one reading; no stop when the project names none.
  assert.equal(summary(history.slice(-1), Date.parse(at(12)), 80, dayStart).seven_day.pace, null);
  assert.equal(summary([{ at: at(12), windows: { seven_day: { used: 99, ...week } } }], Date.parse(at(12)), null, dayStart).seven_day.stopped, false);

  // In the flow of the lanes.
  const { flow, todo, by, there, record, session, box, env } = flowBox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[limits]\n', '[limits]\nsubscription_stop = 80\n'));
  const soon = new Date(Date.now() + 3600e3).toISOString();
  const told = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare("select detail from events where kind = 'subscription_stop' order by rowid").all().map((row) => row.detail); db.close(); return rows; };
  todo(['X-5', 'X-7']);
  by('X-5', 0);
  by('X-7', 0);
  // A lane opens, and its session says where the subscription is: kept with the state, for the backend it ran on.
  flow();
  assert.equal(there('X-5'), true);
  assert.equal(session('X-5', { commit: 'fix: the work' }).run.status, 0);
  const kept = () => readFileSync(join(box.state, 'limits', 'first.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.throws(kept, /ENOENT/, 'a session that says nothing leaves nothing');
  flow();
  const lane = record('X-7');
  const run = spawnSync(join(box.home, 'lane-run.sh'), [join(box.state, 'runs', lane.runs.at(-1).run)], { cwd: lane.worktree, env: { ...env, ANSWER: 'Fait.\n\nQuestions pour the user : aucune.', FAKE_LIMITS: JSON.stringify({ windows: { seven_day: { used: 81, resets_at: soon } }, beyond: 'rejected' }) }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(kept().map((line) => line.windows.seven_day.used), [81]);
  // At the stop: nothing opens, not a new ticket, not a lane to open again. Said once to the lead, with the figures.
  todo(['X-8']);
  by('X-8', 0);
  const stopped = flow();
  assert.match(stopped.stdout, /X-8: put in « Todo » by the user: the subscription is at its stop \(81 % of the seven_day window\), it waits/);
  assert.equal(there('X-8'), false);
  assert.equal(told().length, 1);
  assert.match(told()[0], /81 %[\s\S]*80 %/);
  flow();
  assert.equal(told().length, 1, 'said once for a window');
  const heard = JSON.parse(spawnSync('node', ['--no-warnings', join(box.home, 'lib', 'reviews.mjs'), 'done', '6'], { env, encoding: 'utf8' }).stdout).filter((event) => event.outcome === 'subscription_stop');
  assert.equal(heard.length, 1, 'the lead hears of it at its next wake');
  // A review does not open either: it waits in its queue like one that found no place.
  const refused = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-9', '--comment-on', 'none'], { env, encoding: 'utf8' });
  assert.equal(refused.status, 4);
  assert.match(refused.stderr, /the subscription is at its stop/);
  // The window starts over: what was read no longer holds, lanes open again.
  writeFileSync(join(box.state, 'limits', 'first.jsonl'), `${JSON.stringify({ at: new Date(Date.now() - 7200e3).toISOString(), windows: { seven_day: { used: 81, resets_at: new Date(Date.now() - 60e3).toISOString() } } })}\n`);
  assert.match(flow().stdout, /X-8: put in « Todo » by the user: its lane is opened/);
  // A project that names no stop is never stopped by this.
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('subscription_stop = 80\n', 'subscription_stop = 0\n'));
  writeFileSync(join(box.state, 'limits', 'first.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), windows: { seven_day: { used: 99, resets_at: soon } } })}\n`);
  assert.equal(spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-9', '--comment-on', 'none', '--dry-run'], { env, encoding: 'utf8' }).status, 0);
});


test('the adapter of a provider that says where the subscription is hands it over with the usage of the session', () => {
  const dir = scratch('orch-limits-');
  const stream = [
    { type: 'system', subtype: 'init', model: 'm' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'rejected', unifiedWindows: { five_hour: { utilization: 0.2, resetsAt: 1791554400 }, seven_day: { utilization: 0.5, resetsAt: 1791882000 } } } },
    { type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'ok' }] } },
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'rejected', unifiedWindows: { five_hour: { utilization: 0.21, resetsAt: 1791554400 }, seven_day: { utilization: 0.68, resetsAt: 1791882000 } } } },
    { type: 'result', subtype: 'success', is_error: false, result: '## Compte rendu\n\nFait.\n\n## Fichiers modifiés\n\nAucun.', total_cost_usd: 0.01, modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } } },
  ].map((line) => JSON.stringify(line)).join('\n');
  writeFileSync(join(dir, 'stream.jsonl'), `${stream}\n`);
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\ncat "${join(dir, 'stream.jsonl')}"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'prompt.md'), 'prompt\n');
  const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'report.md'), '--usage', join(dir, 'usage.json')], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ORCH_REPO: fixtureProject(), ORCH_STATE_DIR: join(dir, 'state'), ORCH_RUN_ID: 'r1' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const usage = JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8'));
  assert.deepEqual(usage.limits, { windows: { five_hour: { used: 21, resets_at: '2026-10-09T14:00:00Z' }, seven_day: { used: 68, resets_at: '2026-10-13T09:00:00Z' } }, beyond: 'rejected' }, 'the last word of the session, not the first');
});


test('the terminal of a lane shows what the agent says, what it thinks and what each of its actions is about, not only the names of its tools', () => {
  const dir = scratch('orch-shown-');
  const stream = [
    { type: 'system', subtype: 'init', model: 'm' },
    { type: 'assistant', message: { model: 'm', content: [{ type: 'thinking', thinking: 'Le test échoue sur l’arrondi : je regarde d’abord le calcul.\nPuis je corrige.' }] } },
    { type: 'assistant', message: { model: 'm', content: [{ type: 'text', text: 'Je lance les tests de la charge fixe.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test -- --test-name-pattern "charge fixe"\necho done', description: 'Run the tests of the fixed charge' } }] } },
    { type: 'assistant', message: { model: 'm', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git status --short' } }, { type: 'tool_use', name: 'Read', input: { file_path: `${dir}/server/charges.mjs` } }, { type: 'tool_use', name: 'Edit', input: { file_path: `${dir}/server/charges.mjs`, old_string: 'a', new_string: 'b' } }, { type: 'tool_use', name: 'Grep', input: { pattern: 'arrondi', path: 'server' } }, { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }] } },
    { type: 'assistant', parent_tool_use_id: 'sub-1', message: { model: 'm', content: [{ type: 'text', text: 'Un assistant cherche.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '## Compte rendu\n\nFait.\n\n## Fichiers modifiés\n\nAucun.', total_cost_usd: 0.01, modelUsage: { m: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.01 } } },
  ].map((line) => JSON.stringify(line)).join('\n');
  writeFileSync(join(dir, 'stream.jsonl'), `${stream}\n`);
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\ncat > /dev/null\ncat "${join(dir, 'stream.jsonl')}"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'prompt.md'), 'prompt\n');
  const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'report.md'), '--usage', join(dir, 'usage.json')], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ORCH_REPO: fixtureProject(), ORCH_STATE_DIR: join(dir, 'state'), ORCH_RUN_ID: 'r1' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const shown = run.stdout;
  // What it says, whole.
  assert.match(shown, /^Je lance les tests de la charge fixe\.$/m);
  // What it thinks, marked as such, on one line.
  assert.match(shown, /^ {2}\(thinking\) Le test échoue sur l’arrondi : je regarde d’abord le calcul\. Puis je corrige\.$/m);
  // Each action with what it is about: the reason the agent gave, else the command; the file, from the folder it works in.
  assert.match(shown, /^ {2}> Bash : Run the tests of the fixed charge$/m);
  assert.match(shown, /^ {2}> Bash : git status --short$/m);
  assert.match(shown, /^ {2}> Read : server\/charges\.mjs$/m);
  assert.match(shown, /^ {2}> Edit : server\/charges\.mjs$/m);
  assert.match(shown, /^ {2}> Grep : arrondi \(server\)$/m);
  assert.match(shown, /^ {2}> TodoWrite$/m);
  assert.doesNotMatch(shown, /echo done/, 'one line for an action');
  // What a helper it called says is its own business.
  assert.doesNotMatch(shown, /Un assistant cherche/);
});


test('a lane that cannot be opened again is not left with its finished work unshown: what waits for a place does not hold back the checks, the review nor the request; his word and the lead\'s go to it together', () => {
  const { flow, todo, by, there, record, session, stuck, pull, box, env } = flowBox({ maxLanes: 1 });
  const ready = () => { try { return readFileSync(join(box.home, 'pr-ready'), 'utf8').trim().split('\n'); } catch { return []; } };
  const tell = (ticket, text) => spawnSync(join(box.home, 'tell-lane.sh'), [ticket, '-'], { env, input: text, encoding: 'utf8' });
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const done = session('X-5');
  pull({ headRefOid: done.head });
  // Its session is over, its pull request is a draft; another ticket takes the one place.
  flow({ FAKE_GH_RUNS: '[{"branch":"feat/other","event":"pull_request"}]' });
  assert.equal(there('X-5'), false);
  todo(['X-7']);
  by('X-7', 0);
  flow({ FAKE_GH_RUNS: '[{"branch":"feat/other","event":"pull_request"}]' });
  assert.equal(there('X-7'), true);
  // The lead leaves a word for the first lane: no place to open it again. Its pull request leaves draft all the same.
  assert.equal(tell('X-5', 'Il manque la capture sur téléphone.').status, 0);
  const waiting = flow();
  assert.doesNotMatch(waiting.stdout, /X-5: opened again/, 'nothing is said opened that was not');
  assert.match(waiting.stdout, /X-5: #41 is taken out of draft/);
  assert.deepEqual(ready(), ['41']);
  assert.equal(record('X-5').runs.length, 1);
  // The place frees, and meanwhile the user wrote on the ticket too: one session, with his word and the lead's.
  assert.equal(session('X-7', { commit: 'fix: the other work' }).run.status, 0);
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'c9', createdAt: '2099-01-01T10:00:00Z', body: 'Et vérifie aussi le mode sombre.', byOwner: true }]));
  pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  writeFileSync(join(box.home, 'pr-view-42.json'), JSON.stringify({ number: 42, state: 'OPEN', isDraft: true, headRefName: 'dev/X-7', baseRefName: 'main', title: 't', body: 'b', additions: 1, deletions: 0, files: [], statusCheckRollup: [] }));
  writeFileSync(join(box.home, 'agents.conf'), readFileSync(join(box.home, 'agents.conf'), 'utf8').replace(/max_lanes = \d+/, 'max_lanes = 3'));
  const together = flow();
  assert.match(together.stdout, /X-5: opened again \(said:c9\)/);
  assert.equal(record('X-5').runs.length, 2);
  const told = session('X-5', { commit: null });
  assert.match(told.prompt, /\| The user wrote on the ticket[\s\S]*Et vérifie aussi le mode sombre\./);
  assert.match(told.prompt, /\| The project lead wrote[\s\S]*Il manque la capture sur téléphone\./);
  flow();
  assert.equal(record('X-5').runs.length, 2, 'both were handed in that one session');
  assert.deepEqual(stuck(), []);
});


test('a lane opened again on red checks is told what failed: the list of the test runner when it gives one, what came just before the step failed when it is no test, and that the log could not be read when it could not', () => {
  const { flow, todo, by, session, pull, box } = flowBox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('runs_per_day = 4', 'runs_per_day = 30'));
  todo(['X-5']);
  by('X-5', 0);
  flow();
  let last = session('X-5');
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  const log = (lines) => writeFileSync(join(box.home, 'run-log.txt'), lines.map((line, index) => `verify (2/2)\tUNKNOWN STEP\t${index === 0 ? '\uFEFF' : ''}2026-01-02T10:00:${String(index).padStart(2, '0')}.0000000Z ${line}\n`).join(''));
  const red = (turn) => {
    pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
    assert.match(flow().stdout, /X-5: opened again \(checks:/);
    last = session('X-5', { commit: `fix: attempt ${turn}` });
    return last.prompt;
  };
  // The test runner lists its failures at the end: that list, without the stack frames, and nothing of the thousand lines before.
  log(['Current runner version', '✖ an early line of the run (3ms)', '  Error: far above', 'ℹ tests 900', 'ℹ fail 1', '', '✖ failing tests:', '', 'test at test/toast.test.mjs:12:1', '✖ the toast closes after three seconds (12ms)', "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", '  3000 !== 5000', '      at TestContext.<anonymous> (file:///repo/test/toast.test.mjs:14:10)', '##[error]Process completed with exit code 1.', '##[group]Run echo "what the next step of the job prints"', 'Error: a line of the cleanup']);
  const listed = red(1);
  assert.match(listed, /\| ✖ failing tests:\n {4}\| test at test\/toast\.test\.mjs:12:1\n {4}\| ✖ the toast closes after three seconds \(12ms\)\n[\s\S]*\| {3}3000 !== 5000\n/);
  assert.doesNotMatch(listed, /an early line of the run|far above|at TestContext|2026-01-02T10|the next step of the job|a line of the cleanup/);
  // No test failed: the install did. What came before the step failed says so.
  log(['Current runner version', '##[group]Run npm ci', 'npm error Error: spawnSync /work/node_modules/esbuild/bin/esbuild ETXTBSY', 'npm error Node.js v24', '##[error]Process completed with exit code 1.', 'Post job cleanup.', 'LOG:  background worker exited with exit code 1']);
  const install = red(2);
  assert.match(install, /\| ##\[group\]Run npm ci\n {4}\| npm error Error: spawnSync [^\n]*ETXTBSY\n[\s\S]*\| ##\[error\]Process completed with exit code 1\./);
  assert.doesNotMatch(install, /Post job cleanup|background worker/);
  // The forge gives no log: the lane is told so rather than handed an empty extract.
  writeFileSync(join(box.home, 'run-log.txt'), '');
  assert.match(red(3), /\| \(the check log could not be read; rerun tests for touched files/);
});


test('a word written to a lane that stays at its cap is not lost in silence: the lead is told it was not handed over, once a day for his own words and once for those of the user, and red checks on a lane already said to be stopped tell him nothing new', () => {
  const { flow, todo, by, record, session, pull, box, env } = flowBox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[limits]\n', '[limits]\nticket_cost_usd = 1\n').replace('runs_per_day = 4', 'runs_per_day = 30'));
  const told = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare("select detail from events where kind = 'ticket_cost' order by rowid").all().map((row) => row.detail); db.close(); return rows; };
  const tell = (text) => assert.equal(spawnSync(join(box.home, 'tell-lane.sh'), ['X-5', '-'], { env, input: text, encoding: 'utf8' }).status, 0);
  todo(['X-5']);
  by('X-5', 0);
  flow();
  // Its first session costs more than the cap of the ticket: said once.
  const kept = record('X-5');
  execFileSync('git', ['-C', kept.worktree, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'fix: the work']);
  assert.equal(spawnSync(join(box.home, 'lane-run.sh'), [join(box.state, 'runs', kept.runs.at(-1).run)], { cwd: kept.worktree, env: { ...env, ANSWER: 'Fait.\n\nQuestions pour the user : aucune.', FAKE_COST: '1.1' }, encoding: 'utf8' }).status, 0);
  const head = execFileSync('git', ['-C', box.repo, 'rev-parse', 'dev/X-5'], { encoding: 'utf8' }).trim();
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  pull({ headRefOid: head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  assert.match(flow().stdout, /X-5: at its cap \(1\.10 \$ of 1 \$\): not opened again/);
  assert.equal(told().length, 1);
  // Red checks, again and again: the lead already knows it is stopped.
  flow();
  assert.equal(told().length, 1);
  // The lead writes to the lane all the same: the word cannot be handed over, and that is said instead of a silence.
  tell('Corrige aussi le survol.');
  const unheard = flow();
  assert.match(unheard.stdout, /X-5: at its cap \(1\.10 \$ of 1 \$\): not opened again \(told\)/);
  assert.doesNotMatch(unheard.stdout, /X-5: opened again \(/);
  assert.equal(told().length, 2);
  assert.match(told()[1], /already said to be at this cap\. Since its last session you wrote to the lane, and that word was not handed to it/);
  tell('Et le mode sombre.');
  flow();
  assert.equal(told().length, 2, 'once a day for the words of the lead');
  // The day after, the same words still wait: that is not news, and the lead is not woken for it again.
  { const aged = record('X-5'); for (const key of Object.keys(aged.done)) if (/^cost:1:told:\d{4}-/.test(key)) { aged.done['cost:1:told:2020-01-01'] = aged.done[key]; delete aged.done[key]; } writeFileSync(join(box.state, 'lanes', 'X-5.json'), JSON.stringify(aged)); }
  assert.doesNotMatch(flow().stdout, /at its cap/);
  assert.equal(told().length, 2);
  // The user writes on the ticket, without lifting the cap: his word is not handed over either, and that is said too.
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'c7', createdAt: '2099-01-01T10:00:00Z', body: 'Tu en es où ?', byOwner: true }]));
  assert.match(flow().stdout, /X-5: at its cap \(1\.10 \$ of 1 \$\): not opened again \(said\)/);
  assert.equal(told().length, 3);
  assert.match(told()[2], /Since its last session the user wrote on the ticket, and that word was not handed to it/);
  flow();
  assert.equal(told().length, 3, 'once a day for his words');
  assert.equal(record('X-5').runs.length, 1, 'nothing was opened at the cap');
  // He lifts the cap: the lane opens with every word that waited, and nothing more is said of the cap.
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'c7', createdAt: '2099-01-01T10:00:00Z', body: 'Tu en es où ?', byOwner: true }, { id: 'c8', createdAt: '2099-01-01T11:00:00Z', body: 'Plafond 5', byOwner: true }]));
  assert.match(flow().stdout, /X-5: opened again \(said:c7\)/);
  assert.equal(told().length, 3);
  const heard = session('X-5', { commit: null });

test('a session stopped at the cap of its ticket while a word waits for the lane is told to the lead once, with the word: not once for the cap and once more for the word', () => {
  const { flow, todo, by, record, box, env } = flowBox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[limits]\n', '[limits]\nticket_cost_usd = 1\n').replace('runs_per_day = 4', 'runs_per_day = 30'));
  const told = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare("select detail from events where kind = 'ticket_cost' order by rowid").all().map((row) => row.detail); db.close(); return rows; };
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const kept = record('X-5');
  execFileSync('git', ['-C', kept.worktree, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'fix: half of the work']);
  // The lead writes to the lane while its session runs; the session is then stopped by its budget, at the cap.
  assert.equal(spawnSync(join(box.home, 'tell-lane.sh'), ['X-5', '-'], { env, input: 'Corrige aussi le survol.', encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(join(box.home, 'lane-run.sh'), [join(box.state, 'runs', kept.runs.at(-1).run)], { cwd: kept.worktree, env: { ...env, ANSWER: 'Fait.\n\nQuestions pour the user : aucune.', FAKE_COST: '1.1', FIRST_EXIT: '5', SECOND_EXIT: '5' }, encoding: 'utf8' }).status, 5);
  const stopped = flow();
  assert.equal(stopped.stdout.match(/X-5: at its cap/g).length, 1, stopped.stdout);
  assert.match(stopped.stdout, /X-5: at its cap \(1\.10 \$ of 1 \$\): not opened again \(told\)/);
  assert.equal(told().length, 1);
  assert.match(told()[0], /on its branch\. Since its last session you wrote to the lane, and that word was not handed to it/);
  assert.doesNotMatch(told()[0], /already said/);
  flow();
  assert.equal(told().length, 1);
});
  assert.match(heard.prompt, /\| The user wrote on the ticket[\s\S]*Tu en es où \?/);
  assert.match(heard.prompt, /\| The project lead wrote[\s\S]*Corrige aussi le survol\.[\s\S]*Et le mode sombre\./);
});


test('a ticket has a cap on what it may cost: a session is given what is left, a lane that reached it is not opened again and the lead is told once with the figures, and a line of the user raises it for that ticket', () => {
  const { flow, todo, by, there, record, session, pull, box, env } = flowBox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[limits]\n', '[limits]\nticket_cost_usd = 1\n').replace('runs_per_day = 4', 'runs_per_day = 30').replace('usd_eur = 1', 'usd_eur = 0.5'));
  const budget = () => readFileSync(join(box.state, 'budget-first'), 'utf8').trim();
  const told = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare("select detail from events where kind = 'ticket_cost' order by rowid").all().map((row) => row.detail); db.close(); return rows; };
  const run = (ticket, extra, options = {}) => {
    const kept = record(ticket);
    if (options.commit) execFileSync('git', ['-C', kept.worktree, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', options.commit]);
    const done = spawnSync(join(box.home, 'lane-run.sh'), [join(box.state, 'runs', kept.runs.at(-1).run)], { cwd: kept.worktree, env: { ...env, ANSWER: 'Fait.\n\nQuestions pour the user : aucune.', ...extra }, encoding: 'utf8' });
    return { done, head: execFileSync('git', ['-C', box.repo, 'rev-parse', `dev/${ticket}`], { encoding: 'utf8' }).trim() };
  };
  todo(['X-5']);
  by('X-5', 0);
  flow();
  // Its first session is given the whole cap, and costs 0.60 $.
  let last = run('X-5', { FAKE_COST: '0.6' }, { commit: 'fix: the work' });
  assert.equal(last.done.status, 0, last.done.stderr);
  assert.equal(budget(), 'budget=1');
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  // Red checks: opened again, with what is left of the cap.
  pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  assert.match(flow().stdout, /X-5: opened again \(checks:/);
  // That session reaches the cap while it works: it is stopped, and what it had committed is sent all the same.
  last = run('X-5', { FAKE_COST: '0.5', FIRST_EXIT: '5', SECOND_EXIT: '5' }, { commit: 'fix: half of the correction' });
  assert.equal(budget(), 'budget=0.4');
  assert.equal(last.done.status, 5);
  assert.equal(execFileSync('git', ['--git-dir', join(box.home, 'remote.git'), 'rev-parse', 'dev/X-5'], { encoding: 'utf8' }).trim(), last.head, 'nothing it committed is lost');
  // At the cap: not « a session that stopped short » to run again; nothing opens it, the lead is told once, with the figures.
  pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  const capped = flow();
  assert.doesNotMatch(capped.stdout, /X-5: opened again \(/);
  assert.match(capped.stdout, /X-5: at its cap \(1\.10 \$ of 1 \$\): not opened again/);
  assert.equal(record('X-5').runs.length, 2);
  assert.equal(told().length, 1);
  assert.match(told()[0], /1\.10 \$[\s\S]*1 \$/);
  flow();
  assert.equal(told().length, 1, 'said once for a cap');
  // A line an agent wrote does not raise it; a line of the user does, for this ticket.
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([
    { id: 'a1', createdAt: '2099-01-01T09:00:00Z', body: '> Écrit par un agent (chef de projet), pas par lui.\n\nPlafond : 50 $', byOwner: true },
  ]));
  assert.doesNotMatch(flow().stdout, /X-5: opened again \(/);
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([
    { id: 'c9', createdAt: '2099-01-01T10:00:00Z', body: 'Continue.\nPlafond : 3 $', byOwner: true },
    { id: 'a1', createdAt: '2099-01-01T09:00:00Z', body: '> Écrit par un agent (chef de projet), pas par lui.\n\nPlafond : 50 $', byOwner: true },
  ]));
  const raised = flow();
  assert.match(raised.stdout, /X-5: opened again \(said:c9\)/);
  assert.doesNotMatch(raised.stdout, /at its cap/, 'a cap he just raised is not a stop to tell');
  assert.equal(told().length, 1, 'the lead is not told of a cap that is no longer reached');
  last = run('X-5', { FAKE_COST: '0.1' }, { commit: 'fix: the rest' });
  assert.equal(budget(), 'budget=1.9');
  assert.equal(record('X-5').runs.length, 3);
  // The tracker does not answer: the cap he may have written cannot be read, and nothing is opened on a guess.
  pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  assert.match(flow({ FAKE_TRACKER_COMMENTS_DOWN: '1' }).stdout, /X-5: its cap or what it has cost cannot be read: not opened again \(checks:/);
  assert.equal(record('X-5').runs.length, 3);
  // Nor what it cost (here: a record whose date is no date).
  const path = join(box.state, 'lanes', 'X-5.json');
  const whole = record('X-5');
  writeFileSync(path, JSON.stringify({ ...whole, opened_at: "2026' or 1 --" }));
  pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  const blind = flow();
  assert.match(blind.stdout, /X-5: its cap or what it has cost cannot be read: not opened again \(checks:/);
  assert.equal(record('X-5').runs.length, 3);
  writeFileSync(path, JSON.stringify({ ...record('X-5'), opened_at: whole.opened_at }));
  assert.match(flow().stdout, /X-5: opened again \(checks:/);
  // That session is stopped by its budget though the ticket has something left (it cost less than it was given): no cap is told, it goes on.
  last = run('X-5', { FAKE_COST: '0.2', FIRST_EXIT: '5', SECOND_EXIT: '5' }, { commit: 'fix: more' });
  assert.equal(last.done.status, 5);
  pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  const more = flow();
  assert.match(more.stdout, /X-5: opened again \(budget:/);
  assert.doesNotMatch(more.stdout, /at its cap/);
  assert.equal(told().length, 1);
  assert.match(readFileSync(join(box.state, 'runs', record('X-5').runs.at(-1).run, 'prompt.md'), 'utf8'), /stopped at its budget limit/);
  // This one spends the cap he set: said once for that cap, and nothing opens the lane.
  last = run('X-5', { FAKE_COST: '1.7', FIRST_EXIT: '5', SECOND_EXIT: '5' }, { commit: 'fix: still more' });
  assert.equal(budget(), 'budget=1.6');
  pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  assert.match(flow().stdout, /X-5: at its cap \(3\.10 \$ of 3 \$\): not opened again/);
  assert.equal(told().length, 2);
  const atCap = record('X-5').runs.length;
  flow();
  assert.equal(told().length, 2);
  assert.equal(record('X-5').runs.length, atCap);
  // He lifts it the way he writes: « Plafond 4 », alone, without a colon. That comment is no word for the lane and is not shown to it;
  // a sentence about a share (« plafond 80 % ») sets no cap, and is a word like any other.
  const comments = (list) => writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify(list));
  const c9 = { id: 'c9', createdAt: '2099-01-01T10:00:00Z', body: 'Continue.\nPlafond : 3 $', byOwner: true };
  const c10 = { id: 'c10', createdAt: '2099-01-01T11:00:00Z', body: 'plafond 80 % de mon abonnement, on est bien d’accord', byOwner: true };
  const c11 = { id: 'c11', createdAt: '2099-01-01T12:00:00Z', body: 'Cap 4', byOwner: true };
  comments([c11, c9]);
  const lifted = flow();
  assert.match(lifted.stdout, /X-5: opened again \(budget:/);
  assert.doesNotMatch(lifted.stdout, /said:c11/);
  assert.equal(told().length, 2, 'a cap he lifted is not told as reached');
  assert.doesNotMatch(readFileSync(join(box.state, 'runs', record('X-5').runs.at(-1).run, 'comments.md'), 'utf8'), /Cap 4/);
  last = run('X-5', { FAKE_COST: '0.1' }, { commit: 'fix: finished' });
  assert.equal(budget(), 'budget=0.9');
  // A lane that was not stopped is not opened by a line that only sets the cap; it is by a sentence of his.
  const c12 = { id: 'c12', createdAt: '2099-01-01T13:00:00Z', body: 'Plafond : 9 $\r\n', byOwner: true };
  comments([c12, c11, c9]);
  pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  assert.doesNotMatch(flow().stdout, /X-5: opened again/);
  comments([c12, c11, { ...c10, createdAt: '2099-01-01T14:00:00Z' }, c9]);
  assert.match(flow().stdout, /X-5: opened again \(said:c10\)/);
  last = run('X-5', { FAKE_COST: '0.1' }, { commit: 'fix: answered' });
  assert.equal(budget(), 'budget=5.8', 'the cap is the 9 he wrote last, not 80');
  // What is left when its budget stops it would buy no session (0.20 $ of 9 $): the cap counts as spent, and is told.
  pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  assert.match(flow().stdout, /X-5: opened again \(checks:/);
  last = run('X-5', { FAKE_COST: '5.5', FIRST_EXIT: '5', SECOND_EXIT: '5' }, { commit: 'fix: nearly all of it' });
  assert.equal(budget(), 'budget=5.7');
  pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  const sliver = flow();
  assert.match(sliver.stdout, /X-5: at its cap \(8\.80 \$ of 9 \$\): not opened again/);
  assert.doesNotMatch(sliver.stdout, /opened again \(/);
  assert.equal(told().length, 3);
  comments([c9]);
  pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  // A ticket he puts in « Todo » while the tracker does not give its comments waits; it is opened once they are read, with the cap he wrote on it.
  todo(['X-6']);
  by('X-6', 0);
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace(/max_lanes = \d+/, 'max_lanes = 5'));
  const waits = flow({ FAKE_TRACKER_COMMENTS_DOWN: '1' });
  assert.match(waits.stdout, /X-6: put in « Todo » by the user: its cap or what it has cost cannot be read, it waits/);
  assert.throws(() => record('X-6'));
  assert.match(flow().stdout, /X-6: put in « Todo » by the user: its lane is opened/);
  run('X-6', { FAKE_COST: '0.1' }, { commit: 'fix: other work' });
  assert.equal(budget(), 'budget=3', 'the line he wrote, read before the first session');
});


test('a lane whose first session sent nothing (it ended on a question, with no commit) is opened again all the same: from the branch it left, or from the base when there is none', () => {
  const { flow, todo, by, there, record, session, box } = flowBox();
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const asked = session('X-5', { commit: null, answer: 'Rien de fait.\n\nQuestions pour the user :\n1. Quelle direction ?' });
  assert.equal(asked.run.status, 0, asked.run.stderr);
  assert.match(flow().stdout, /X-5: its session ends on a question for the user/);
  assert.equal(there('X-5'), false, 'its worktree is closed');
  assert.equal(spawnSync('git', ['--git-dir', join(box.home, 'remote.git'), 'rev-parse', '--verify', '--quiet', 'dev/X-5']).status, 1, 'nothing of it is on the remote');
  // He answers: the lane is opened again, though there is no branch on the remote to come back to.
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'c1', createdAt: '2099-01-01T10:00:00Z', body: 'Prends la première.', byOwner: true }]));
  const first = flow();
  assert.match(first.stdout, /X-5: opened again \(said:c1\)/);
  assert.equal(there('X-5'), true);
  // The same when even the local branch is gone: it starts again from the base.
  assert.equal(session('X-5', { commit: null, answer: 'Rien de fait.\n\nQuestions pour the user :\n1. Et la couleur ?' }).run.status, 0);
  flow();
  assert.equal(there('X-5'), false);
  box.git('branch', '-D', 'dev/X-5');
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'c2', createdAt: '2099-01-02T10:00:00Z', body: 'Bleu.', byOwner: true }, { id: 'c1', createdAt: '2099-01-01T10:00:00Z', body: 'Prends la première.', byOwner: true }]));
  assert.match(flow().stdout, /X-5: opened again \(said:c2\)/);
  assert.equal(execFileSync('git', ['-C', record('X-5').worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), execFileSync('git', ['-C', box.repo, 'rev-parse', 'origin/main'], { encoding: 'utf8' }));
  assert.match(session('X-5', { commit: 'fix: the first one, in blue' }).prompt, /Bleu\./);
  assert.equal(execFileSync('git', ['--git-dir', join(box.home, 'remote.git'), 'log', '-1', '--format=%s', 'dev/X-5'], { encoding: 'utf8' }).trim(), 'fix: the first one, in blue');
});


test('the harness of a lane is chosen by what is left of each subscription: a role that names another one opens there when its own is tight or at its stop, never on a stopped one, and a model somebody named is not changed', async () => {
  const { standing } = await import('../lib/limits.mjs');
  const soon = new Date(Date.now() + 3600e3).toISOString();
  assert.equal(standing({}, 90, 80).state, 'free', 'a backend that never said anything is free');
  assert.equal(standing({ week: { used: 79, resets_at: soon } }, 90, 80).state, 'free');
  assert.equal(standing({ week: { used: 80, resets_at: soon }, five: { used: 10, resets_at: soon } }, 90, 80).state, 'tight');
  assert.equal(standing({ week: { used: 12, resets_at: soon }, five: { used: 90, resets_at: soon } }, 90, 80).state, 'stopped');
  assert.equal(standing({ week: { used: 99, resets_at: soon } }, null, null).state, 'free', 'a project that names neither is never switched nor stopped');

  const box = sandbox({ maxLanes: 9 });
  const confPath = join(box.home, 'agents.conf');
  const conf = readFileSync(confPath, 'utf8');
  writeFileSync(confPath, `${conf.replace('[limits]\n', '[limits]\nsubscription_stop = 90\nsubscription_switch = 80\n')}\n[harness]\ndev = b\n`);
  const said = (adapter, used) => {
    const file = join(box.home, `usage-${adapter}.json`);
    writeFileSync(file, JSON.stringify({ limits: { windows: { seven_day: { used, resets_at: soon } } } }));
    const noted = spawnSync('node', ['--no-warnings', join(box.home, 'lib', 'limits.mjs'), 'note', adapter, file], { env: box.env, encoding: 'utf8' });
    assert.equal(noted.status, 0, noted.stderr);
  };
  const open = (ticket, ...more) => spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', ticket, '--comment-on', 'none', ...more], { env: box.env, encoding: 'utf8' });
  const chain = (ticket) => { const lane = JSON.parse(readFileSync(join(box.state, 'lanes', `${ticket}.json`), 'utf8')); return JSON.parse(readFileSync(join(box.state, 'runs', lane.runs.at(-1).run, 'chain.json'), 'utf8')).map((one) => one.alias); };
  const events = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare("select detail from events where kind = 'model_fallback' order by rowid").all().map((row) => row.detail); db.close(); return rows; };
  // Nothing said yet: where the roles say, with its declared fallback behind.
  assert.equal(open('X-1').status, 0);
  assert.deepEqual(chain('X-1'), ['a', 'b']);
  // Its subscription is tight, the other's is not: the other harness first, its own behind.
  said('first', 85);
  const tight = open('X-2');
  assert.equal(tight.status, 0, tight.stderr);
  assert.deepEqual(chain('X-2'), ['b', 'a']);
  assert.match(events().at(-1), /the subscription of first is tight \(85 % of its seven_day window\): opened on b \(second\) instead of a/);
  // A model somebody named for this lane is not changed.
  assert.equal(open('X-3', '--model', 'a').status, 0);
  assert.equal(chain('X-3')[0], 'a');
  // A lane the limit of lanes refuses writes nothing of a switch it did not make, and a rehearsal neither.
  const before = events().length;
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace(/max_lanes = \d+/, 'max_lanes = 1'));
  assert.equal(open('X-30').status, 3);
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace(/max_lanes = \d+/, 'max_lanes = 9'));
  assert.equal(open('X-31', '--dry-run').status, 0);
  assert.equal(events().length, before);
  // At its stop: the other harness alone; a stopped subscription is no fallback.
  said('first', 95);
  assert.equal(open('X-4').status, 0);
  assert.deepEqual(chain('X-4'), ['b']);
  // Both tight: no better place, it stays where the roles say.
  said('first', 85);
  said('second', 85);
  assert.equal(open('X-5').status, 0);
  assert.equal(chain('X-5')[0], 'a');
  // Its own at the stop and the other only tight: the other all the same, alone.
  said('first', 95);
  assert.equal(open('X-6').status, 0);
  assert.deepEqual(chain('X-6'), ['b']);
  // Both at their stop: nothing opens, as before.
  said('second', 95);
  const none = open('X-7');
  assert.equal(none.status, 4);
  assert.match(none.stderr, /the subscription is at its stop/);
  // A role that names no other harness is never moved: at its stop it waits.
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[harness]\ndev = b\n', ''));
  said('second', 10);
  assert.equal(open('X-8').status, 4);
});


test('the adapter hands a session its budget, and a session stopped by it ends with a code of its own', () => {
  const dir = scratch('orch-budget-');
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, 'args')}"\ncat > /dev/null\necho '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"total_cost_usd":0.41,"errors":["Reached maximum budget ($0.4)"],"modelUsage":{"m":{"inputTokens":1,"outputTokens":1,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.41}}}'\nexit 1\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'prompt.md'), 'prompt\n');
  const call = (extra) => spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['run', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--report', join(dir, 'report.md'), '--usage', join(dir, 'usage.json')], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ORCH_REPO: fixtureProject(), ORCH_STATE_DIR: join(dir, 'state'), ORCH_RUN_ID: 'r1', ...extra }, encoding: 'utf8' });
  const capped = call({ ORCH_BUDGET_USD: '0.4' });
  const args = readFileSync(join(dir, 'args'), 'utf8').split('\n');
  assert.equal(args[args.indexOf('--max-budget-usd') + 1], '0.4');
  assert.equal(capped.status, 5, capped.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'usage.json'), 'utf8')).cost_usd, 0.41, 'what it cost is still counted');
  // No budget given: none asked of the CLI.
  call({});
  assert.equal(readFileSync(join(dir, 'args'), 'utf8').split('\n').includes('--max-budget-usd'), false);
});
