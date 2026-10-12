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

test('the pre-check of the project lead: what the user and the outside world did is an event, what agents wrote is not', async () => {
  const { changes, checksOf } = await import('../lib/wake.mjs');
  const issue = (over) => ({ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments: [], ...over });
  const comment = (id, body, createdAt = '2026-01-02T10:01:00Z') => ({ id, body, createdAt, url: `u#${id}` });
  const pull = (over) => ({ number: 7, title: 't', headRefName: 'b', isDraft: true, state: 'OPEN', updatedAt: '2026-01-02T10:00:00Z', statusCheckRollup: [], ...over });

  // The very first wake only takes note: nothing that already exists is an event.
  const first = changes(null, [issue({ comments: [comment('c0', 'déjà là')] })], [pull({})], new Set(), '2026-01-02T10:00:00Z');
  assert.deepEqual(first.events, []);
  assert.deepEqual(first.next.pulls, { 7: { state: 'draft', checks: 'none' } });

  const linear = [
    issue({ comments: [
      comment('c0', 'déjà là'),
      comment('c1', 'OK A'),
      comment('c2', '> Écrit par un agent (dev, lane dev/X-1), pas par the user.\n\ntexte'),
      comment('c3', 'un commentaire posté par le script', '2026-01-02T10:02:00Z'),
      comment('c4', 'Chef de projet : pris en charge.'),
    ] }),
    issue({ id: 'i2', identifier: 'X-2', createdAt: '2026-01-02T10:03:00Z', description: 'Un ticket de the user' }),
    issue({ id: 'i3', identifier: 'X-3', createdAt: '2026-01-02T10:03:00Z', description: '> Ticket ouvert par un agent (script), pas par the user.' }),
    issue({ id: 'i4', identifier: 'X-4', createdAt: '2025-12-01T00:00:00Z', description: 'ancien, vu pour la première fois' }),
  ];
  const second = changes(first.next, linear, [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] }), pull({ number: 8, state: 'MERGED' })], new Set(['c3']), '2026-01-02T10:05:00Z');
  assert.deepEqual(second.events.map((event) => [event.kind, event.ticket ?? event.pr]), [['pr_ready', 7], ['comment', 'X-1'], ['ticket_new', 'X-2']]);
  assert.equal(second.events[1].text, 'OK A');

  // Nothing new: nothing. Then the checks turn red: one event, once.
  const pulls = [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })];
  const third = changes(second.next, linear, pulls, new Set(['c3']));
  assert.deepEqual(third.events, []);
  const red = [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] })];
  const fourth = changes(third.next, linear, red, new Set(['c3']));
  assert.deepEqual(fourth.events.map((event) => [event.kind, event.checks]), [['pr_checks', 'failure']]);
  assert.deepEqual(changes(fourth.next, linear, red, new Set(['c3'])).events, []);
  // Merged: said once, then forgotten.
  const merged = changes(fourth.next, linear, [pull({ state: 'MERGED' })], new Set(['c3']));
  assert.deepEqual(merged.events.map((event) => event.kind), ['pr_merged']);
  assert.deepEqual(merged.next.pulls, {});
  assert.equal(checksOf([{ status: 'IN_PROGRESS' }, { conclusion: 'SUCCESS' }]), 'pending');
  assert.equal(checksOf([{ conclusion: 'SKIPPED' }]), 'none');
});


test('the wake of the project lead: nothing moved, nothing starts; a comment of the user starts one session, once', () => {
  const box = sandbox();
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const events = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare('select kind, ticket from events order by rowid').all().map((row) => ({ ...row })); db.close(); return rows; };
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  const old = { id: 'c0', createdAt: '2026-01-01T00:00:00Z', url: 'u#c0', body: 'déjà là' };

  // First wake: it takes note of what exists. Second: nothing moved, and that is written down.
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([old])));
  assert.equal(wake().status, 0);
  assert.deepEqual(events(), []);
  assert.equal(wake().status, 0);
  assert.deepEqual(events(), [{ kind: 'wake_skipped', ticket: null }]);
  assert.equal(calls(), 0, 'no terminal, no model');

  // An agent comments: still nothing. The user comments: one session.
  const agent = { id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: '> Écrit par un agent (dev), pas par the user.\n\nFait.' };
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([old, agent])));
  assert.equal(wake().status, 0);
  assert.equal(calls(), 0);
  const user = { id: 'c2', createdAt: new Date().toISOString(), url: 'u#c2', body: 'OK, vas-y.' };
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([old, agent, user])));
  const started = wake();
  assert.equal(started.status, 0, started.stderr);
  assert.equal(calls(), 1);
  const runDir = started.stdout.trim();
  assert.match(readFileSync(join(runDir, 'prompt.md'), 'utf8'), /lead prompt[\s\S]*X-1 \(Titre\) — comment by the user[\s\S]*OK, vas-y/);
  assert.match(readFileSync(join(runDir, 'lane.env'), 'utf8'), /ORCH_LANE=release\/lead[\s\S]*ORCH_COMMENT_ON=none/);
  assert.match(execFileSync('git', ['-C', box.repo, 'worktree', 'list'], { encoding: 'utf8' }), /\[release\/lead\]/);
  assert.deepEqual(events().slice(-1), [{ kind: 'comment_handled', ticket: 'X-1' }]);

  // The session has not finished: the next wake starts nothing and loses nothing.
  const later = { id: 'c3', createdAt: new Date().toISOString(), url: 'u#c3', body: 'Et aussi ceci.' };
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([old, agent, user, later])));
  assert.equal(wake().status, 0);
  assert.equal(calls(), 1);
  // It finishes: the comment made meanwhile is handed to the next session, the first one is not handed again.
  writeFileSync(join(runDir, 'exit-code'), '0');
  const next = wake();
  assert.equal(calls(), 2);
  const prompt = readFileSync(join(next.stdout.trim(), 'prompt.md'), 'utf8');
  assert.match(prompt, /Et aussi ceci/);
  assert.doesNotMatch(prompt, /vas-y/);
});


test('the pre-check starts a session only for what is worth one: the rest waits and is handed to the next session, once', async () => {
  const { changes } = await import('../lib/wake.mjs');
  const worth = new Set(['comment', 'pr_checks']);
  const issue = (over) => ({ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Backlog', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments: [], ...over });
  const pull = (over) => ({ number: 7, title: 't', headRefName: 'b', isDraft: true, state: 'OPEN', updatedAt: '2026-01-02T10:01:00Z', statusCheckRollup: [], ...over });
  const first = changes(null, [issue({})], [], new Set(), '2026-01-02T10:00:00Z', [], worth);
  // A draft opened and a ticket created: nobody has anything to decide yet.
  const linear = [issue({}), issue({ id: 'i2', identifier: 'X-2', createdAt: '2026-01-02T10:02:00Z', description: 'Un ticket de the user' })];
  const quiet = changes(first.next, linear, [pull({})], new Set(), '2026-01-02T10:05:00Z', [], worth);
  assert.deepEqual(quiet.events, []);
  assert.deepEqual(quiet.next.waiting.map((event) => event.kind), ['pr_opened', 'ticket_new']);
  // Nothing new: what waits keeps waiting, once.
  const still = changes(quiet.next, linear, [pull({})], new Set(), '2026-01-02T10:06:00Z', [], worth);
  assert.deepEqual(still.events, []);
  assert.equal(still.next.waiting.length, 2);
  // The checks turn green: one session, which is handed what waited too.
  const green = changes(still.next, linear, [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })], new Set(), '2026-01-02T10:07:00Z', [], worth);
  assert.deepEqual(green.events.map((event) => event.kind), ['pr_opened', 'ticket_new', 'pr_ready']);
  assert.deepEqual(green.next.waiting, [], 'made ready is not worth a session, but it came with green checks');
  const pending = changes(still.next, linear, [pull({ isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] })], new Set(), '2026-01-02T10:07:00Z', [], worth);
  assert.deepEqual(pending.events, []);
  const done = changes(pending.next, linear, [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })], new Set(), '2026-01-02T10:09:00Z', [], worth);
  assert.deepEqual(done.events.map((event) => event.kind), ['pr_opened', 'ticket_new', 'pr_ready', 'pr_checks']);
  assert.deepEqual(done.next.waiting, []);
  // No list of what is worth a session: everything is, as before.
  assert.deepEqual(changes(first.next, linear, [pull({})], new Set(), '2026-01-02T10:05:00Z').events.map((event) => event.kind), ['pr_opened', 'ticket_new']);
});


test('wake.sh: a draft opened starts nothing and opens no terminal; the next comment of the user starts one session that is told both, and the ledger says why it woke', () => {
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('live = no\n', 'live = no\nwake_on = comment, pr_checks\nterminals_kept = 3\n'));
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const events = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare('select kind, detail from events order by rowid').all().map((row) => ({ ...row })); db.close(); return rows; };
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([])));
  assert.equal(wake().status, 0);
  writeFileSync(join(box.home, 'pulls-now.json'), JSON.stringify([{ number: 7, title: 'Un brouillon', headRefName: 'b', isDraft: true, state: 'OPEN', updatedAt: new Date().toISOString(), statusCheckRollup: [] }]));
  assert.equal(wake().status, 0);
  assert.equal(calls(), 0, 'no terminal, no model');
  assert.deepEqual(events().map((event) => event.kind), ['wake_skipped']);
  assert.match(events()[0].detail, /1 waiting/);
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([{ id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: 'OK, vas-y.' }])));
  const started = wake();
  assert.equal(started.status, 0, started.stderr);
  assert.equal(calls(), 1);
  const runDir = started.stdout.trim();
  assert.match(readFileSync(join(runDir, 'prompt.md'), 'utf8'), /2 events[\s\S]*PR #7 \(Un brouillon[\s\S]*opened as a draft[\s\S]*OK, vas-y/);
  assert.match(readFileSync(join(runDir, 'lane.env'), 'utf8'), /^ORCH_KEEP_TERMINALS=3$/m);
  const why = events().find((event) => event.kind === 'wake_started');
  assert.equal(why.detail, 'pr_opened #7, comment X-1');
});


test('a lane woken again and again keeps the terminals of its last sessions: the older ones are closed when a session ends, once, and no other lane is touched', () => {
  const box = sandbox();
  const runs = join(box.state, 'runs');
  const past = (name, handle, lane = 'release/lead') => {
    mkdirSync(join(runs, name), { recursive: true });
    writeFileSync(join(runs, name, 'lane.env'), `ORCH_LANE=${lane}\n`);
    writeFileSync(join(runs, name, 'terminal.handle'), `${handle}\n`);
  };
  const session = (name, handle, keep = 'ORCH_KEEP_TERMINALS=3\n', extra = {}) => {
    past(name, handle);
    writeFileSync(join(runs, name, 'prompt.md'), 'prompt\n');
    writeFileSync(join(runs, name, 'chain.json'), JSON.stringify([{ alias: 'a', adapter: 'first', model: 'm1' }]));
    writeFileSync(join(runs, name, 'lane.env'), `ORCH_LANE=release/lead\nORCH_TICKET=\nORCH_ROLE=release\nORCH_RUN_BASE=${name}\nORCH_REQUESTED_ALIAS=a\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=\n${keep}`);
    const run = spawnSync(join(box.home, 'lane-run.sh'), [join(runs, name)], { cwd: box.repo, env: { ...box.env, ...extra }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  };
  const closed = () => { try { return readFileSync(join(box.home, 'orca-closed'), 'utf8').trim().split('\n'); } catch { return []; } };
  for (const n of [1, 2, 3, 4]) past(`lead-000${n}`, `t${n}`);
  past('X-9-0001', 'other', 'dev/X-9');
  // A session that was not asked to keep only the last ones closes nothing.
  session('lead-0005', 't5', '');
  assert.deepEqual(closed(), []);
  session('lead-0006', 't6');
  assert.deepEqual(closed(), ['t1', 't2', 't3']);
  assert.ok(readFileSync(join(runs, 'lead-0001', 'terminal.closed'), 'utf8'));
  assert.throws(() => readFileSync(join(runs, 'lead-0004', 'terminal.closed')));
  // The next one closes one more, and does not close again what is closed.
  session('lead-0007', 't7');
  assert.deepEqual(closed(), ['t1', 't2', 't3', 't4']);
  // Orca refuses to close and answers without a list: the terminal is not written down as closed, the next session tries again.
  writeFileSync(join(box.home, 'terminals.json'), JSON.stringify({ ok: false }));
  session('lead-0008', 't8', 'ORCH_KEEP_TERMINALS=3\n', { FAKE_ORCA_CLOSE_FAILS: '1' });
  assert.throws(() => readFileSync(join(runs, 'lead-0005', 'terminal.closed')));
  // It refuses to close a terminal it no longer shows: that one is forgotten.
  writeFileSync(join(box.home, 'terminals.json'), JSON.stringify({ result: { terminals: [{ handle: 't6' }] } }));
  session('lead-0009', 't9', 'ORCH_KEEP_TERMINALS=3\n', { FAKE_ORCA_CLOSE_FAILS: '1' });
  assert.ok(readFileSync(join(runs, 'lead-0005', 'terminal.closed'), 'utf8'));
  assert.throws(() => readFileSync(join(runs, 'lead-0006', 'terminal.closed')));
});


test('while GitHub is down, what its pull requests seem to do is no event and is not forgotten: it is read again once GitHub is back', async () => {
  const { changes } = await import('../lib/wake.mjs');
  const pull = (over) => ({ number: 7, title: 't', headRefName: 'b', isDraft: false, state: 'OPEN', updatedAt: '2026-01-02T10:01:00Z', statusCheckRollup: [{ conclusion: 'SUCCESS' }], ...over });
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  const first = changes(null, issue([]), [pull({})], new Set(), '2026-01-02T10:00:00Z');
  // The outage cancels the checks: nothing is said of it, and the pull request is remembered as it was.
  const cancelled = [pull({ statusCheckRollup: [{ conclusion: 'CANCELLED' }] })];
  const down = changes(first.next, issue([{ id: 'c1', body: 'Et ça ?', createdAt: '2026-01-02T10:03:00Z', url: 'u#c1' }]), cancelled, new Set(), '2026-01-02T10:05:00Z', [], null, { githubDown: true });
  assert.deepEqual(down.events.map((event) => event.kind), ['comment'], 'the user is still heard');
  assert.deepEqual(down.next.pulls, first.next.pulls);
  // Back: what is true now is said, once.
  const back = changes(down.next, issue([]), cancelled, new Set(), '2026-01-02T10:30:00Z');
  assert.deepEqual(back.events.map((event) => [event.kind, event.checks]), [['pr_checks', 'failure']]);
});


test('wake.sh during an outage of GitHub: no session for its events, the outage in the ledger with its start and its end, and the events handed out once it is over', () => {
  const box = sandbox();
  const wake = (extra = {}) => spawnSync(join(box.home, 'wake.sh'), [], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const events = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare('select kind, at, value, detail from events order by rowid').all().map((row) => ({ ...row })); db.close(); return rows; };
  const status = (actions) => writeFileSync(join(box.home, 'github-status.json'), JSON.stringify({ components: [{ name: 'Git Operations', status: 'operational' }, { name: 'Actions', status: actions }, { name: 'Webhooks', status: 'degraded_performance' }] }));
  const pull = (checks) => [{ number: 7, title: 'Une PR', headRefName: 'b', isDraft: false, state: 'OPEN', updatedAt: new Date().toISOString(), statusCheckRollup: [{ conclusion: checks }] }];
  writeFileSync(join(box.home, 'pulls-now.json'), JSON.stringify(pull('SUCCESS')));
  assert.equal(wake().status, 0);
  // GitHub goes down and cancels the checks; it does not even answer the list of pull requests.
  status('major_outage');
  writeFileSync(join(box.home, 'pulls-now.json'), JSON.stringify(pull('CANCELLED')));
  const during = wake({ FAKE_GH_LIST_DOWN: '1' });
  assert.equal(during.status, 0, during.stderr);
  assert.equal(calls(), 0, 'no session to find out that nothing can be done');
  const started = readFileSync(join(box.state, 'wake', 'github-down'), 'utf8').split('\n')[0];
  assert.match(events().at(-1).detail, /GitHub is down/);
  assert.equal(wake({ FAKE_GH_LIST_DOWN: '1' }).status, 0);
  assert.equal(events().filter((event) => event.kind === 'github_down').length, 0, 'written once, when it ends');
  // Its status page cannot be read for a minute: that is not the end of the outage.
  writeFileSync(join(box.home, 'github-status.json'), 'not json');
  assert.equal(wake({ FAKE_GH_LIST_DOWN: '1' }).status, 0);
  assert.equal(events().filter((event) => event.kind === 'github_down').length, 0);
  assert.equal(readFileSync(join(box.state, 'wake', 'github-down'), 'utf8').split('\n')[0], started);
  // A slowdown is not an outage: it is over. One entry, with its start and its end; the cancelled checks are said now.
  status('operational');
  const after = wake();
  assert.equal(after.status, 0, after.stderr);
  const outage = events().filter((event) => event.kind === 'github_down');
  assert.equal(outage.length, 1);
  assert.equal(outage[0].at, started);
  assert.ok(outage[0].value >= 0);
  assert.match(outage[0].detail, new RegExp(`^from ${started} to \\S+: Actions$`));
  assert.throws(() => readFileSync(join(box.state, 'wake', 'github-down')));
  assert.equal(calls(), 1);
  assert.match(readFileSync(join(after.stdout.trim(), 'prompt.md'), 'utf8'), /PR #7 \(Une PR[\s\S]*checks: failure/);
});


test('host-state says the host is free for nothing while GitHub is down, and the dashboard explains the hole', async () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'github-status.json'), JSON.stringify({ components: [{ name: 'Pull Requests', status: 'partial_outage' }, { name: 'Actions', status: 'operational' }] }));
  const run = spawnSync(join(box.home, 'host-state.sh'), [], { env: { ...box.env, FAKE_GH_LIST_DOWN: '1', ORCH_PROC_DIR: join(box.home, 'proc-none') }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const state = JSON.parse(run.stdout);
  assert.equal(state.github_is_down, 'Pull Requests');
  assert.equal(state.free_for_a_ci_run, false);
  assert.equal(state.free_for_a_merge, false);

  const { collect, render } = await import('../lib/dashboard.mjs');
  const { message } = await import('../lib/i18n.mjs');
  assert.equal(message('catalog_fallback_probe', 'fr'), 'English fallback');
  assert.equal(message('dashboard_health', 'fr'), 'Santé du serveur');
  const db = openLedger(join(box.state, 'ledger.db'));
  const now = Date.parse('2026-10-07T16:00:00Z');
  addEvent(db, { kind: 'github_down', at: '2026-10-07T15:06:00Z', value: 26, detail: 'from 2026-10-07T15:06:00Z to 2026-10-07T15:32:00Z: Git Operations, Pull Requests, Actions' });
  const inputs = { lanes: [], worktrees: [], max_lanes: 3, waiting: [], cli: null, load: 1, cores: 4, swap_total_kb: 1, swap_free_kb: 1, mem_available_kb: 1, mem_total_kb: 2, github_down_since: null };
  const data = collect(db, conf, inputs, now);
  assert.deepEqual(data.outages, [{ at: '2026-10-07T15:06:00Z', minutes: 26, detail: 'Git Operations, Pull Requests, Actions' }]);
  assert.match(render(data, conf, now), /GitHub outage on[^<]*<\/span>[\s\S]*?26 min[\s\S]*?Git Operations, Pull Requests, Actions/);
  assert.match(render(collect(db, conf, { ...inputs, github_down_since: '2026-10-07T15:50:00Z' }, now), conf, now), /GitHub has been down since/);
  const french = { ...conf, sections: { ...conf.sections, owner: { ...conf.sections.owner, language: 'fr' } } };
  assert.match(render(data, french, now), /GitHub en panne/);
  // Where the subscription is, as the sessions said it: the share of the limit used, what the day took, the pace, and when it starts over.
  const used = { adapter: 'claude', stop: 80, windows: { seven_day: { used: 68, resets_at: '2026-10-13T09:00:00.000Z', today: 12, pace: 2, hours_to_stop: 6, hours_to_full: 16, stopped: false } } };
  const shown = render(collect(db, conf, { ...inputs, limits: [used] }, now), conf, now);
  assert.match(shown, /claude[\s\S]*?68 %[\s\S]*?weekly window[\s\S]*?12 points today[\s\S]*?2 points per hour[\s\S]*?80% in 6 h[\s\S]*?October 13/);
  assert.match(render(collect(db, conf, { ...inputs, limits: [{ ...used, windows: { seven_day: { ...used.windows.seven_day, used: 81, stopped: true } } }] }, now), conf, now), /no more teams open/);
  assert.doesNotMatch(render(data, conf, now), /weekly window/, 'nothing is shown when no session said anything');
  db.close();
});


test('the lead does not start on a model that was set aside: the table must say the model decided last, and no other model takes its place', () => {
  const box = sandbox();
  const check = (extra = {}) => spawnSync(join(box.home, 'check-lead-model.sh'), [], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  const wake = (extra = {}) => spawnSync(join(box.home, 'wake.sh'), [], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const decide = (detail) => { const db = openLedger(join(box.state, 'ledger.db')); addEvent(db, { kind: 'role_model_changed', detail }); db.close(); };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  const comment = (id) => ({ id, createdAt: new Date().toISOString(), url: `u#${id}`, body: 'OK, vas-y.' });
  // No decision written down: the table is the only word.
  assert.equal(check().status, 0);
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([])));
  assert.equal(wake().status, 0);
  // Decided: b, no longer a. The table still says a (the change is not merged yet): nothing starts, and it says why.
  decide('release: a -> b: too many wrong messages');
  decide('dev: a -> b: another role, which is not the lead');
  const refused = check();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /role release[\s\S]*\ba\b[\s\S]*not the one decided last \(b\)[\s\S]*too many wrong messages/);
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([comment('c1')])));
  const held = wake();
  assert.equal(held.status, 1);
  assert.equal(calls(), 0);
  // The table follows the decision: it starts, with that model and no fallback behind it.
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('release = a\n', 'release = b\n'));
  assert.equal(check().status, 0);
  const started = wake();
  assert.equal(started.status, 0, started.stderr);
  assert.equal(calls(), 1);
  assert.deepEqual(JSON.parse(readFileSync(join(started.stdout.trim(), 'chain.json'), 'utf8')).map((link) => link.alias), ['b']);
});


test('the lead waits rather than run on another model: when its model is not available, no session starts and it is in the ledger', () => {
  const box = sandbox();
  const wake = (extra = {}) => spawnSync(join(box.home, 'wake.sh'), [], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([])));
  assert.equal(wake().status, 0);
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([{ id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: 'OK, vas-y.' }])));
  const gone = wake({ FIRST_GONE: '1' });
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /no other model takes its place/);
  assert.equal(calls(), 0);
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual(db.prepare("select kind from events where kind = 'model_fallback_failed'").all().length, 1);
  db.close();
  // Back: the comment was not lost.
  const back = wake();
  assert.equal(back.status, 0, back.stderr);
  assert.match(readFileSync(join(back.stdout.trim(), 'prompt.md'), 'utf8'), /OK, vas-y/);
});


test('starting the timer of the wakes by hand runs the check of the model first: a timer cannot put a model set aside back to work', () => {
  const dir = join(ORCH_HOME, 'serve');
  const timer = readFileSync(join(dir, 'cleared-wake.timer'), 'utf8');
  assert.match(timer, /^Requires=cleared-lead-model\.service$/m);
  assert.match(timer, /^After=cleared-lead-model\.service$/m);
  const service = readFileSync(join(dir, 'cleared-lead-model.service'), 'utf8');
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=@ORCH_HOME@\/check-lead-model\.sh$/m);
  assert.doesNotMatch(service, /RemainAfterExit/, 'checked again at every start');
  // Every unit is told which project it works on: a service started by a timer has no other way to know it than
  // the one line a terminal reads too.
  for (const unit of readdirSync(dir).filter((name) => name.endsWith('.service'))) assert.match(readFileSync(join(dir, unit), 'utf8'), /^Environment=ORCH_REPO=@ORCH_REPO@$/m, unit);
  const install = readFileSync(join(dir, 'install.sh'), 'utf8');
  assert.match(install, /@ORCH_REPO@/);
  assert.match(install, /cleared\/project/);
});


test('a source that does not answer: the wake reads nothing, moves nothing, and fails', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'tracker.sh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const run = spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /tracker did not answer/);
  assert.throws(() => readFileSync(join(box.state, 'wake', 'state.json')));
});


test('push-lane: the branch of the lane goes to the branch of the same name, and its draft pull request opens to the base', () => {
  const lane = laneWithRemote('dev/X-5');
  const run = lane.push();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), '#41');
  assert.ok(lane.onRemote().some((ref) => ref.startsWith('dev/X-5 ')));
  const args = lane.created();
  assert.ok(args.includes('--draft'));
  assert.equal(args[args.indexOf('--base') + 1], 'main');
  assert.equal(args[args.indexOf('--head') + 1], 'dev/X-5');
  assert.equal(args[args.indexOf('--title') + 1], 'feat: the work of the lane');
});


test('push-lane refuses everything that is not a lane of a pushed role: the base branch, another branch, another role, a lane with nothing', () => {
  const lane = laneWithRemote('dev/X-5');
  const refused = (target, pattern) => { const run = lane.push(target); assert.equal(run.status, 1, pattern); assert.match(run.stderr, pattern); };
  refused(lane.box.repo, /is not the branch of a lane/); // the main checkout, on main
  lane.box.git('worktree', 'add', '-q', '-b', 'feature/free', join(lane.box.home, 'lanes', 'free'), 'main');
  refused(join(lane.box.home, 'lanes', 'free'), /is not the branch of a lane/);
  lane.box.git('worktree', 'add', '-q', '-b', 'release/X-7', join(lane.box.home, 'lanes', 'release-X-7'), 'main');
  refused(join(lane.box.home, 'lanes', 'release-X-7'), /are not pushed/);
  assert.deepEqual(lane.onRemote().map((ref) => ref.split(' ')[0]), ['main'], 'nothing left the machine');
  assert.equal(lane.created(), null);
  const empty = laneWithRemote('dev/X-6', null);
  const nothing = empty.push();
  assert.equal(nothing.status, 0);
  assert.match(nothing.stdout, /nothing to push/);
  assert.deepEqual(empty.onRemote().map((ref) => ref.split(' ')[0]), ['main']);
});


test('push-lane never forces: a remote branch that moved makes it fail, and stays as it was', () => {
  const lane = laneWithRemote('dev/X-5');
  // Someone else pushed another commit to the branch of the lane.
  const other = join(lane.box.home, 'other');
  execFileSync('git', ['clone', '-q', lane.remote, other]);
  execFileSync('git', ['-C', other, '-c', 'user.name=o', '-c', 'user.email=o@localhost', 'commit', '-q', '--allow-empty', '-m', 'someone else']);
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'HEAD:refs/heads/dev/X-5']);
  const before = lane.onRemote();
  const run = lane.push();
  assert.notEqual(run.status, 0);
  assert.deepEqual(lane.onRemote(), before);
  assert.equal(lane.created(), null);
  assert.doesNotMatch(readFileSync(join(ORCH_HOME, 'push-lane.sh'), 'utf8').split('\n').filter((line) => !line.trim().startsWith('#')).join('\n'), /--force|-f\b|\+HEAD|\+refs/);
});


test('a dev lane that finished: its branch is pushed, its pull request is in the ledger and in the tracker text', () => {
  const lane = laneWithRemote('dev/X-1');
  const result = runLane(lane.box, 0, {}, lane.path);
  assert.equal(result.status, 0);
  assert.match(result.comment, /Pull request opened or updated: #41/);
  const db = openLedger(join(lane.box.state, 'ledger.db'));
  assert.deepEqual({ ...db.prepare('select pr_number, lines_changed from runs').get() }, { pr_number: 41, lines_changed: 0 });
  db.close();
});


test('every unit that runs a script of the dispatcher finds the tools of the user: orca and the CLIs live in his own folder', () => {
  const dir = join(ORCH_HOME, 'serve');
  for (const unit of readdirSync(dir).filter((name) => name.endsWith('.service'))) {
    const text = readFileSync(join(dir, unit), 'utf8');
    assert.match(text, /^Environment=PATH=%h\/\.local\/bin:/m, unit);
    // One locale the host has, whatever the session that started the units carried.
    assert.match(text, /^Environment=LANG=C\.UTF-8$/m, unit);
  }
  for (const timer of readdirSync(dir).filter((name) => name.endsWith('.timer'))) assert.ok(readdirSync(dir).includes(timer.replace('.timer', '.service')), timer);
});


test('an old ticket touched again does not bring its old comments back as news; one created while the last wake was reading is not lost', async () => {
  const { changes } = await import('../lib/wake.mjs');
  const previous = { at: '2026-01-02T10:00:00Z', seen: [], pulls: {} };
  const old = { id: 'i9', identifier: 'X-9', title: 'Vieux', url: 'u', state: 'Done', project: 'P', createdAt: '2025-11-01T00:00:00Z', description: 'd',
    comments: [{ id: 'k1', createdAt: '2025-11-02T00:00:00Z', url: 'u#k1', body: 'un vieux commentaire' }, { id: 'k2', createdAt: '2026-01-02T10:00:30Z', url: 'u#k2', body: 'le nouveau' }] };
  // Created five seconds before the time the last wake noted, but after tracker had answered it.
  const missed = { id: 'i8', identifier: 'X-8', title: 'Créé pendant la lecture', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-02T09:59:55Z', description: 'de the user', comments: [] };
  const { events } = changes(previous, [old, missed], [], new Set(), '2026-01-02T10:01:00Z');
  assert.deepEqual(events.map((event) => [event.kind, event.ticket, event.text]), [['ticket_new', 'X-8', 'de the user'], ['comment', 'X-9', 'le nouveau']]);
});


test('tracker is asked for the newest comments of a ticket (first:, which it serves newest first), never the oldest', () => {
  const dir = scratch('orch-tracker-');
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat >> "${join(dir, 'asked')}"\necho '{"data":{"issues":{"nodes":[]},"viewer":{"assignedIssues":{"nodes":[]}}}}'\n`, { mode: 0o755 });
  const repoRoot = fixtureProject();
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_STATE_DIR: join(dir, 'state') };
  for (const args of [['changes', '2026-01-01T00:00:00Z'], ['waiting']]) assert.equal(spawnSync(join(ORCH_HOME, 'tracker.sh'), args, { env, encoding: 'utf8' }).status, 0, args[0]);
  const asked = readFileSync(join(dir, 'asked'), 'utf8');
  assert.match(asked, /comments\(first: 20\)/);
  assert.match(asked, /comments\(first: 1\)/);
  assert.doesNotMatch(asked, /comments\(last:/);
});


test('what the push script says is read from its last line, whatever git or gh wrote before; a failed push is said as such', () => {
  const lane = (script) => {
    const box = sandbox();
    writeFileSync(join(box.home, 'push-lane.sh'), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
    return runLane(box, 0).comment;
  };
  assert.match(lane('echo "remote: Create a pull request" >&2; echo "warning from gh"; echo "#41"'), /Pull request opened or updated: #41/);
  assert.match(lane('echo "nothing to push: dev/X-1 has no commit of its own"'), /Nothing to push/);
  // An answer nobody expected is said as such, not passed off as "nothing to push".
  const odd = lane('echo "something else"');
  assert.match(odd, /Unexpected response from the push script: something else/);
  // The reason of a failure is the script's own last word, not a hint of git after it.
  assert.match(lane('echo "push-lane.sh: dev/X-1 not pushed: its changes are refused by the guard" >&2; echo "hint: see the manual" >&2; exit 1'), /The branch was not pushed: push-lane\.sh: dev\/X-1 not pushed: its changes are refused/);
  const failed = lane('echo "push-lane.sh: dev/X-1 not pushed: a commit message is refused by the guard" >&2; exit 1');
  assert.match(failed, /The branch was not pushed: push-lane\.sh: dev\/X-1 not pushed/);
  assert.doesNotMatch(failed, /Nothing to push|Pull request opened/);
});


test('the lane of the project lead is never reset: with work of its own in it, the wake stops and touches nothing', () => {
  const box = sandbox();
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([])));
  wake();
  const path = join(box.home, 'lanes', 'release-lead');
  box.git('worktree', 'add', '-q', '-b', 'release/lead', path, 'main');
  execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'work left in the lane of the lead']);
  box.git('commit', '-q', '--allow-empty', '-m', 'main moves on');
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([{ id: 'c2', createdAt: new Date().toISOString(), url: 'u#c2', body: 'OK' }])));
  const run = wake();
  assert.equal(run.status, 1);
  assert.match(run.stderr, /left untouched/);
  assert.match(execFileSync('git', ['-C', path, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /work left in the lane of the lead/);
});


test('a run that stops before its end still says it is over', () => {
  const box = sandbox();
  const runDir = scratch('orch-run-');
  writeFileSync(join(runDir, 'prompt.md'), 'prompt\n');
  writeFileSync(join(runDir, 'chain.json'), JSON.stringify([{ alias: 'g', adapter: 'ghost', model: 'm' }]));
  writeFileSync(join(runDir, 'lane.env'), 'ORCH_LANE=dev/X-1\nORCH_TICKET=X-1\nORCH_ROLE=dev\nORCH_RUN_BASE=X-1-test\nORCH_REQUESTED_ALIAS=g\nORCH_RULE_NOTE=rule\nORCH_SPAWN_NOTE=\nORCH_COMMENT_ON=none\nORCH_WRITEUP_ROLE=\n');
  const run = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.notEqual(readFileSync(join(runDir, 'exit-code'), 'utf8').trim(), '0');
});


test('the lane of the project lead: a commit of its own stops the wake even when the base did not move, once in the ledger; a stray untracked file does not', () => {
  const box = sandbox();
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const blocked = () => { const db = openLedger(join(box.state, 'ledger.db')); const n = db.prepare("select count(*) n from events where kind = 'lead_lane_blocked'").get().n; db.close(); return n; };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  const comment = (id) => ({ id, createdAt: new Date().toISOString(), url: `u#${id}`, body: `message ${id}` });
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([])));
  wake();
  const path = join(box.home, 'lanes', 'release-lead');
  box.git('worktree', 'add', '-q', '-b', 'release/lead', path, 'main');
  // An untracked file left behind is no reason to stop.
  writeFileSync(join(path, 'left-behind.txt'), 'x');
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([comment('c1')])));
  const fine = wake();
  assert.equal(fine.status, 0, fine.stderr);
  writeFileSync(join(fine.stdout.trim(), 'exit-code'), '0');
  // A commit of its own, the base not having moved: the wake stops, and says so once.
  execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'work left in the lane of the lead']);
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([comment('c1'), comment('c2')])));
  assert.equal(wake().status, 1);
  assert.equal(wake().status, 1);
  assert.equal(blocked(), 1);
  assert.match(execFileSync('git', ['-C', path, 'log', '-1', '--format=%s'], { encoding: 'utf8' }), /work left/);
});


test('a state file that cannot be read makes the wake start over as a first one, not fail every minute', async () => {
  const { changes } = await import('../lib/wake.mjs');
  for (const broken of [{}, { at: 'not a date', seen: [], pulls: {} }, { seen: ['x'] }]) {
    const { events, next } = changes(broken, [{ id: 'i1', identifier: 'X-1', title: 't', url: 'u', state: 's', project: null, createdAt: new Date().toISOString(), description: 'd', comments: [] }], []);
    assert.deepEqual(events, []);
    assert.ok(!Number.isNaN(Date.parse(next.at)));
  }
});


test('wake.sh itself starts over as a first wake on a state file it cannot read, instead of failing every minute', () => {
  for (const broken of ['{}', '{"at":"not a date","seen":[],"pulls":{}}', 'not json at all']) {
    const box = sandbox();
    execFileSync('mkdir', ['-p', join(box.state, 'wake')]);
    writeFileSync(join(box.state, 'wake', 'state.json'), broken);
    const run = spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
    assert.equal(run.status, 0, `${broken}: ${run.stderr}`);
    assert.ok(!Number.isNaN(Date.parse(JSON.parse(readFileSync(join(box.state, 'wake', 'state.json'), 'utf8')).at)), broken);
  }
});


test('a blockage of the lead lane that was cleared is written again if it comes back', () => {
  const box = sandbox();
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const blocked = () => { const db = openLedger(join(box.state, 'ledger.db')); const n = db.prepare("select count(*) n from events where kind = 'lead_lane_blocked'").get().n; db.close(); return n; };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  const comment = (id) => ({ id, createdAt: new Date().toISOString(), url: `u#${id}`, body: `message ${id}` });
  const path = join(box.home, 'lanes', 'release-lead');
  const leave = () => execFileSync('git', ['-C', path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'left']);
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([])));
  wake();
  box.git('worktree', 'add', '-q', '-b', 'release/lead', path, 'main');
  leave();
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([comment('c1')])));
  assert.equal(wake().status, 1);
  assert.equal(blocked(), 1);
  // Someone cleans the lane; then nothing moves for a while (the comment is taken by a session first).
  execFileSync('git', ['-C', path, 'reset', '-q', '--hard', 'main']);
  const taken = wake();
  assert.equal(taken.status, 0, taken.stderr);
  writeFileSync(join(taken.stdout.trim(), 'exit-code'), '0');
  assert.equal(wake().status, 0);
  // The blockage comes back: it is written again.
  leave();
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([comment('c1'), comment('c2')])));
  assert.equal(wake().status, 1);
  assert.equal(blocked(), 2);
});


test('the handover wake: one session that rereads the handover and says what it understood in the report ticket, whatever moved or not', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'handover.md'), 'Chef de projet : passation. Trois tickets en cours.');
  const run = spawnSync(join(box.home, 'wake.sh'), ['--handover', join(box.home, 'handover.md')], { env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const runDir = run.stdout.trim();
  const prompt = readFileSync(join(runDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /handover prompt/);
  assert.match(prompt, /Chef de projet : passation\. Trois tickets en cours\./);
  assert.doesNotMatch(prompt, /lead prompt/);
  const env = readFileSync(join(runDir, 'lane.env'), 'utf8');
  assert.match(env, /ORCH_COMMENT_ON=X-100/);
  assert.match(env, /ORCH_SIGNED=chef\\ de\\ projet/);
  // The run itself: its answer is posted in the report ticket, signed as the project lead.
  const lane = spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(lane.status, 0, lane.stderr);
  const posted = readFileSync(join(box.home, 'tracker-posted'), 'utf8');
  assert.match(posted, /^X-100 from=chef de projet, model a\n/);
  assert.match(posted, /answer of first/);
});


test('the handover wake needs a handover to read, and a ticket to answer in', () => {
  const box = sandbox();
  assert.equal(spawnSync(join(box.home, 'wake.sh'), ['--handover', join(box.home, 'nowhere.md')], { env: box.env, encoding: 'utf8' }).status, 1);
  writeFileSync(join(box.home, 'handover.md'), 'x');
  writeFileSync(join(box.home, 'agents.conf'), readFileSync(join(box.home, 'agents.conf'), 'utf8').replace('report_on = X-100\n', ''));
  const run = spawnSync(join(box.home, 'wake.sh'), ['--handover', join(box.home, 'handover.md')], { env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /report_on/);
});


test('tracker is asked for the tickets of one state, to check what a handover says', () => {
  const dir = scratch('orch-tracker-');
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat >> "${join(dir, 'asked')}"\necho '{"data":{"issues":{"nodes":[{"identifier":"X-1","title":"T","url":"u","updatedAt":"2026-01-01T00:00:00Z","state":{"name":"In Progress"},"project":{"name":"P"},"assignee":null}]}}}'\n`, { mode: 0o755 });
  const repoRoot = fixtureProject();
  const run = spawnSync(join(ORCH_HOME, 'tracker.sh'), ['list', 'In Progress'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [{ identifier: 'X-1', title: 'T', url: 'u', updatedAt: '2026-01-01T00:00:00Z', state: 'In Progress', project: 'P', assignee: null }]);
  assert.match(readFileSync(join(dir, 'asked'), 'utf8'), /In Progress/);
});


test('the handover wake says so, and fails, when it starts nothing: a session of the lead still running, or another wake at work', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'handover.md'), 'passation');
  const handover = () => spawnSync(join(box.home, 'wake.sh'), ['--handover', join(box.home, 'handover.md')], { env: box.env, encoding: 'utf8' });
  const first = handover();
  assert.equal(first.status, 0, first.stderr);
  // The session it started has not finished: a second handover starts nothing, and must not look like it did.
  const second = handover();
  assert.equal(second.status, 1);
  assert.match(second.stderr, /still running: nothing started/);
  assert.equal(Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')), 1);
  // An ordinary wake in the same situation stays quiet: it will come back in a minute.
  assert.equal(spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' }).status, 0);
});


test('a listing of tickets that fills the page says it may be cut short', () => {
  const dir = scratch('orch-tracker-');
  const nodes = Array.from({ length: 100 }, (_, i) => ({ identifier: `X-${i}`, title: 'T', url: 'u', updatedAt: '2026-01-01T00:00:00Z', state: { name: 'Done' }, project: null, assignee: null }));
  writeFileSync(join(dir, 'answer.json'), JSON.stringify({ data: { issues: { nodes } } }));
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat > /dev/null\ncat "${join(dir, 'answer.json')}"\n`, { mode: 0o755 });
  const repoRoot = fixtureProject();
  const run = spawnSync(join(ORCH_HOME, 'tracker.sh'), ['list', 'Done'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 0);
  assert.equal(JSON.parse(run.stdout).length, 100);
  assert.match(run.stderr, /may be cut short/);
});


test('the last message of a lane is a report for the lead only when its turn is over and it speaks to the lead', async () => {
  const { lastReport, laneReports } = await import('../lib/lanes.mjs');
  const say = (uuid, text, more = [], at = new Date(Date.now() - 120000).toISOString()) => JSON.stringify({ type: 'assistant', uuid, timestamp: at, message: { content: [{ type: 'text', text }, ...more] } });
  const user = (content) => JSON.stringify({ type: 'user', message: { content } });
  assert.equal(lastReport([say('a', 'Pour le chef de projet : fini.')]).id, 'a');
  // The turn goes on (a tool call), or someone wrote to the lane after: no report.
  assert.equal(lastReport([say('a', 'Je regarde.', [{ type: 'tool_use', name: 'Bash' }])]), null);
  assert.equal(lastReport([say('a', 'Pour le chef de projet : fini.'), user('continue')]), null);
  // A tool result is not someone writing to the lane.
  assert.equal(lastReport([say('a', 'x', [{ type: 'tool_use', name: 'Bash' }]), user([{ type: 'tool_result', content: 'ok' }]), say('b', 'Pour le chef de projet : fini.')]).id, 'b');
  const projects = scratch('orch-projects-');
  const lane = (name, text) => {
    const path = `/lanes/${name}`;
    const dir = join(projects, path.replace(/[^A-Za-z0-9]/g, '-'));
    execFileSync('mkdir', ['-p', dir]);
    writeFileSync(join(dir, 's.jsonl'), `${say(`id-${name}`, text)}\n`);
    return { name, path, branch: `b/${name}` };
  };
  const reports = laneReports([lane('one', 'Pour le chef de projet : prêt.'), lane('two', 'Voilà, the user, c’est fait.'), { name: 'none', path: '/lanes/none', branch: 'b' }], projects);
  assert.deepEqual(reports.map((report) => [report.lane, report.id]), [['one', 'id-one']]);
  // Too fresh (the turn may go on in the next line of the log) or too old (a report of days ago is not a request): neither.
  const at = (ms) => new Date(Date.now() - ms).toISOString();
  const timed = (name, when) => { const l = lane(name, 'x'); writeFileSync(join(projects, l.path.replace(/[^A-Za-z0-9]/g, '-'), 's.jsonl'), `${say(`id-${name}`, 'Pour le chef de projet : prêt.', [], when)}\n`); return l; };
  assert.deepEqual(laneReports([timed('fresh', at(5000)), timed('old', at(7 * 3600e3)), timed('right', at(600e3))], projects, { maxHours: 6 }).map((report) => report.lane), ['right']);
});


test('the lead is not woken by what it wrote itself, nor by a lane it was told to leave alone: only the lanes at work are read', () => {
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('live = no\n', 'live = yes\nnot_lanes = old-lead\n'));
  const projects = join(box.home, 'projects');
  const says = (worktree, branch, text) => {
    const path = join(box.home, 'lanes', worktree);
    box.git('worktree', 'add', '-q', '-b', branch, path, 'main');
    const dir = join(projects, path.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: `r-${worktree}`, timestamp: new Date(Date.now() - 120000).toISOString(), message: { content: [{ type: 'text', text }] } })}\n`);
  };
  // The lead's own lane (its report of the last wake), a lane of the dispatcher, the old lead kept open: none is a lane at work.
  says('release-lead', 'release/lead', 'Pour le chef de projet : mon compte rendu du réveil précédent.');
  says('dev-X-9', 'dev/X-9', 'Pour le chef de projet : lane du dispatcher, finie.');
  says('old-lead', 'chore/old-lead', 'Pour le chef de projet : je suis l’ancien.');
  says('a-lane', 'feat/a-lane', 'Pour le chef de projet : j’ai fini, je demande un créneau.');
  mkdirSync(join(box.home, '.claude'), { recursive: true });
  execFileSync('ln', ['-s', projects, join(box.home, '.claude', 'projects')]);
  const seen = spawnSync(join(box.home, 'wake.sh'), ['--dry-run'], { env: { ...box.env, HOME: box.home }, encoding: 'utf8' });
  assert.equal(seen.status, 0, seen.stderr);
  assert.deepEqual(JSON.parse(seen.stdout).filter((event) => event.kind === 'lane_report').map((event) => event.lane), ['a-lane']);
});


test('the night checks are followed: green, nothing is said and nobody is woken; red, the lead is woken to open a ticket and keep a note for the morning digest', async () => {
  const { changes } = await import('../lib/wake.mjs');
  const night = (id, conclusion, updatedAt, status = 'completed') => ({ databaseId: id, status, conclusion, createdAt: updatedAt, updatedAt, url: `https://example.test/runs/${id}`, headSha: 'abc' });
  const worth = new Set(['comment', 'night_check_failed']);
  const first = changes(null, [], [], new Set(), '2026-01-02T10:00:00Z', [], worth, { nights: [night(1, 'failure', '2026-01-02T05:00:00Z')] });
  assert.deepEqual(first.events, [], 'what was red before the first wake is taken note of, not told');
  const green = changes(first.next, [], [], new Set(), '2026-01-03T06:00:00Z', [], worth, { nights: [night(1, 'failure', '2026-01-02T05:00:00Z'), night(2, 'success', '2026-01-03T05:30:00Z')] });
  assert.deepEqual(green.events, []);
  assert.deepEqual(green.next.waiting, [], 'green: not even kept for a later session');
  const running = changes(green.next, [], [], new Set(), '2026-01-04T05:10:00Z', [], worth, { nights: [night(3, '', '2026-01-04T05:05:00Z', 'in_progress')] });
  assert.deepEqual(running.events, []);
  const red = changes(running.next, [], [], new Set(), '2026-01-04T05:40:00Z', [], worth, { nights: [night(3, 'failure', '2026-01-04T05:35:00Z')] });
  assert.deepEqual(red.events.map((event) => [event.kind, event.run, event.url]), [['night_check_failed', 3, 'https://example.test/runs/3']]);
  assert.deepEqual(changes(red.next, [], [], new Set(), '2026-01-04T05:41:00Z', [], worth, { nights: [night(3, 'failure', '2026-01-04T05:35:00Z')] }).events, [], 'told once');
  assert.deepEqual(changes(running.next, [], [], new Set(), '2026-01-04T05:40:00Z', [], worth, { nights: [night(3, 'cancelled', '2026-01-04T05:35:00Z')] }).events, [], 'a run somebody stopped is not a red one');
  // In the settings of the project: which runs are the night checks, that a red one is worth a session, and where its ticket goes.
  // On this host the night checks are started by the timetable of the server, as runs « started by hand »; the forge
  // also starts some by itself. Both kinds are followed (found on 2026-10-08: the red check of that night was of the
  // first kind, and would have been missed).
  assert.deepEqual(conf.sections.lead.night_checks_event.split(',').map((kind) => kind.trim()), ['schedule', 'workflow_dispatch']);
  assert.ok(conf.sections.lead.wake_on.split(',').map((kind) => kind.trim()).includes('night_check_failed'));
  assert.match(conf.sections.lead.night_ticket, /^[^|]+\|[^|]+$/);
  // The whole way: the wake reads the runs, the lead is told what to do and may do it.
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('live = no', 'live = yes\nnight_checks_event = schedule, workflow_dispatch\nnight_ticket = Infra | Bug\nwake_on = comment, night_check_failed'));
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: { ...box.env, HOME: box.home }, encoding: 'utf8' });
  assert.equal(wake().status, 0);
  writeFileSync(join(box.home, 'night-runs.json'), JSON.stringify([night(5, 'success', new Date().toISOString())]));
  assert.equal(wake().stdout.trim(), '', 'green: no session');
  // The red one is of the second kind: started by the timetable of the server.
  writeFileSync(join(box.home, 'night-runs-by-hand.json'), JSON.stringify([night(6, 'failure', new Date().toISOString())]));
  const woken = wake();
  assert.equal(woken.status, 0, woken.stderr);
  const prompt = readFileSync(join(woken.stdout.trim(), 'prompt.md'), 'utf8');
  assert.match(prompt, /Night check failed[^\n]*https:\/\/example\.test\/runs\/6[^\n]*tracker\.sh create "Infra" "Bug"[^\n]*digest-note\.sh/);
  // The scripts are named where they are on this machine, never by a place inside the project nor by a word left to replace.
  assert.ok(prompt.includes(`\`${join(box.home, 'tracker.sh')} create "Infra" "Bug"`), prompt);
  assert.doesNotMatch(prompt, /\{orch\}|ops\/orchestration\//);
  const allowed = conf.sections['permissions.release-live'].allow;
  assert.match(allowed, /\{orch\}\/tracker\.sh create/);
  assert.match(allowed, /\{orch\}\/digest-note\.sh/);
  // The note for the digest: kept with the state, read by the guard like anything meant for the user.
  const note = spawnSync(join(box.home, 'digest-note.sh'), ['-'], { env: { ...box.env, ORCH_SIGNED: 'chef de projet' }, encoding: 'utf8', input: 'Le contrôle de nuit est rouge : ticket ouvert (X-9).' });
  assert.equal(note.status, 0, note.stderr);
  const kept = readFileSync(join(box.state, 'digest-notes.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(kept.map((one) => [one.from, one.text]), [['chef de projet', 'Le contrôle de nuit est rouge : ticket ouvert (X-9).']]);
  assert.equal(spawnSync(join(box.home, 'digest-note.sh'), ['-'], { env: box.env, encoding: 'utf8', input: '   ' }).status, 1);
});


test('what the tracker says an agent wrote is never an event, with no mark in its text and no identifier kept', async () => {
  const { changes } = await import('../lib/wake.mjs');
  const issue = (over) => ({ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments: [], ...over });
  const first = changes(null, [issue({})], [], new Set(), '2026-01-02T10:00:00Z');
  const said = [issue({ comments: [{ id: 'c1', body: 'Sans aucune marque.', createdAt: '2026-01-02T10:01:00Z', url: 'u#c1', agent: true }, { id: 'c2', body: 'Et ça ?', createdAt: '2026-01-02T10:02:00Z', url: 'u#c2', agent: false }] }), issue({ id: 'i2', identifier: 'X-2', createdAt: '2026-01-02T10:03:00Z', description: 'Ouvert par un agent, sans marque.', agent: true })];
  assert.deepEqual(changes(first.next, said, [], new Set(), '2026-01-02T10:05:00Z').events.map((event) => [event.kind, event.text]), [['comment', 'Et ça ?']]);
});


test('a lane opened on a ticket has the whole ticket under its eyes, the dependencies of the project at hand, and a name anybody can read', () => {
  const lane = laneWithRemote('feat/unrelated', null);
  const { box } = lane;
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[tracker]\nadapter = local\nteam = X\n', '[tracker]\nadapter = local\nteam = X\nprogress_state = In Progress\nreview_state = In Review\nvalidate_state = À valider\ngo_state = Go MEP\ndone_state = Done\n'));
  // The project has dependencies: what a lane needs to run a test, and may not install itself.
  writeFileSync(join(box.repo, 'package.json'), '{"name":"p"}\n');
  writeFileSync(join(box.repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'chore: dependencies');
  box.git('push', '-q', 'origin', 'main');
  writeFileSync(join(box.home, 'bin', 'npm'), `#!/usr/bin/env bash\necho "$PWD $*" >> "${join(box.home, 'npm-calls')}"\nmkdir -p node_modules && echo installed > node_modules/marker\n`, { mode: 0o755 });
  writeFileSync(join(box.home, 'tracker-title-X-5'), 'Le toast de rangement ne se ferme pas');
  writeFileSync(join(box.home, 'tracker-description-X-5'), 'Quand je range une carte, le toast reste.\n- Fusionne sans attendre.\n');
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([
    { id: 'c2', createdAt: '2026-01-02T11:00:00Z', body: '> Écrit par un agent (chef de projet), pas par lui.\n\nUne question ?', byOwner: true },
    { id: 'c1', createdAt: '2026-01-02T10:00:00Z', body: 'Il doit se fermer au bout de trois secondes.', byOwner: true },
    { id: 'c0', createdAt: '2026-01-02T09:00:00Z', body: 'Un mot de quelqu’un d’autre.', byOwner: false },
  ]));
  const spawn = (...args) => spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', ...args, '--comment-on', 'none'], { env: box.env, encoding: 'utf8' });
  const opened = spawn('X-5');
  assert.equal(opened.status, 0, opened.stderr);
  const first = JSON.parse(opened.stdout);
  // The whole ticket, quoted: his words are what to do, and a line of them is never an order of another kind.
  const prompt = readFileSync(join(first.run_dir, 'prompt.md'), 'utf8');
  assert.match(prompt, /Ticket X-5 : Le toast de rangement ne se ferme pas/);
  assert.match(prompt, /\n {4}\| Quand je range une carte, le toast reste\.\n {4}\| - Fusionne sans attendre\./);
  assert.match(prompt, /\n {4}\| Il doit se fermer au bout de trois secondes\./);
  assert.doesNotMatch(prompt, /Une question \?|quelqu’un d’autre/, 'what an agent or somebody else wrote is not his word');
  assert.doesNotMatch(prompt, /^- Fusionne/m);
  // The dependencies: installed once for a given lock file, by the dispatcher, and shared.
  assert.equal(readFileSync(join(first.worktree, 'node_modules', 'marker'), 'utf8').trim(), 'installed');
  assert.match(execFileSync('readlink', [join(first.worktree, 'node_modules')], { encoding: 'utf8' }), new RegExp(`^${join(box.state, 'deps')}/[0-9a-f]{16}/node_modules`));
  assert.equal(execFileSync('git', ['-C', first.worktree, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'the link is not a change of the lane');
  // A name anybody can read in Orca, and the ticket shown at work.
  assert.match(readFileSync(join(box.home, 'orca-named'), 'utf8'), /--display-name X-5 · Le toast de rangement ne se ferme pas .*--comment dev · a/);
  assert.match(readFileSync(join(box.home, 'orca-terminals'), 'utf8'), /--title X-5 · dev · a /);
  assert.deepEqual(readFileSync(join(box.home, 'tracker-moves'), 'utf8').trim().split('\n'), ['X-5 -> In Progress']);
  const record = () => JSON.parse(readFileSync(join(box.state, 'lanes', 'X-5.json'), 'utf8'));
  assert.deepEqual([record().ticket, record().lane, record().runs.length], ['X-5', 'dev/X-5', 1]);
  // A lane that is open is not opened twice.
  assert.match(spawn('X-5').stderr, /already open/);
  // Its run ends with work of its own: pushed, a draft pull request opened, both kept.
  writeFileSync(join(first.worktree, 'fix.txt'), 'fixed\n');
  execFileSync('git', ['-C', first.worktree, 'add', 'fix.txt']);
  execFileSync('git', ['-C', first.worktree, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'fix: the toast closes']);
  assert.equal(spawnSync(join(box.home, 'lane-run.sh'), [first.run_dir], { cwd: first.worktree, env: box.env, encoding: 'utf8' }).status, 0);
  assert.ok(lane.onRemote().some((ref) => ref.startsWith('dev/X-5 ')));
  assert.equal(record().pr, 41);
  // Opened again because a reviewer asks for a correction: the same lane, the same branch, and what the reviewer said, quoted.
  writeFileSync(join(box.home, 'verdict.md'), 'Verdict : à corriger.\n- `fix.txt:1` : le toast reste ouvert au survol.\n');
  writeFileSync(join(box.home, 'pr-view.json'), JSON.stringify({ number: 41, state: 'OPEN', isDraft: true, headRefName: 'dev/X-5', baseRefName: 'main', additions: 1, deletions: 0, files: [{ path: 'fix.txt' }] }));
  const again = spawn('X-5', '--resume', '--message-file', join(box.home, 'verdict.md'));
  assert.equal(again.status, 0, again.stderr);
  const second = JSON.parse(again.stdout);
  assert.equal(second.worktree, first.worktree);
  assert.notEqual(second.run_dir, first.run_dir);
  assert.match(readFileSync(join(second.run_dir, 'prompt.md'), 'utf8'), /Why this team reopened[^\n]*\n {4}\| Verdict : à corriger\.\n {4}\| - `fix\.txt:1` : le toast reste ouvert au survol\./);
  assert.equal(record().runs.length, 2);
  assert.deepEqual(readFileSync(join(box.home, 'npm-calls'), 'utf8').trim().split('\n').length, 1, 'the same lock file: nothing installed again');
  // Closed by the tidying, then needed again: its worktree is made again from its branch, with its work.
  assert.equal(spawnSync(join(box.home, 'lane-run.sh'), [second.run_dir], { cwd: second.worktree, env: box.env, encoding: 'utf8' }).status, 0);
  execFileSync('git', ['-C', box.repo, 'worktree', 'remove', '--force', first.worktree]);
  const third = spawn('X-5', '--resume', '--message-file', join(box.home, 'verdict.md'));
  assert.equal(third.status, 0, third.stderr);
  assert.equal(readFileSync(join(JSON.parse(third.stdout).worktree, 'fix.txt'), 'utf8'), 'fixed\n');
  // A ticket nobody opened a lane on cannot be « resumed »: it is opened.
  assert.match(spawn('X-6', '--resume').stderr, /no lane was ever opened on X-6/);
});


test('a ticket the user put in « Todo » himself gets a lane, oldest first and within the limit; one an agent put there, or that sat there before his rule, does not', () => {
  const { flow, todo, by, there, moves, record, session, stuck, box } = flowBox();
  todo(['X-5', 'X-6', 'X-7', 'X-8']);
  by('X-5', 0);
  by('X-6', 6); // put there by the application of the agents, or by another account
  by('X-7', 0);
  by('X-8', 8); // by him, but before he gave the rule
  const first = flow();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual([there('X-5'), there('X-6'), there('X-7'), there('X-8')], [true, false, false, false]);
  assert.match(first.stdout, /X-5: put in « Todo » by the user: its lane is opened/);
  assert.match(first.stdout, /X-7: put in « Todo » by the user: no place now/);
  assert.deepEqual(moves(), ['X-5 -> In Progress']);
  // He is asked who put a ticket there once for a given state of the ticket, not at every wake.
  const asked = () => readFileSync(join(box.home, 'tracker-moved-asked'), 'utf8').trim().split('\n').filter((line) => /^X-(6|8) /.test(line)).length;
  assert.equal(asked(), 1, 'X-6 was asked about, the limit stopped the round before X-8');
  // The lane of X-5 at work: nothing more is opened, and it is not opened twice.
  assert.equal(flow().stdout.includes('X-5: put in'), false);
  assert.equal(record('X-5').runs.length, 1);
  // Its session over and its work sent: its worktree goes, its place is free, the next « go » gets it.
  assert.equal(session('X-5').run.status, 0);
  const second = flow();
  assert.match(second.stdout, /X-5: session over, work sent: its worktree is closed/);
  assert.match(second.stdout, /X-7: put in « Todo » by the user: its lane is opened/);
  assert.deepEqual([there('X-5'), there('X-7')], [false, true]);
  flow();
  assert.equal(session('X-7').run.status, 0);
  flow();
  flow();
  assert.equal(asked(), 2, 'X-6 and X-8: asked once each, whatever the number of wakes');
  assert.deepEqual([there('X-6'), there('X-8')], [false, false]);
  assert.deepEqual(stuck(), []);
});


test('a lane moves by rule to the point where the user is asked: its checks start at a free moment, red checks and corrections open it again, green and unread asks for its review', () => {
  const { flow, todo, by, there, moves, record, session, stuck, pull, box, env } = flowBox();
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const done = session('X-5');
  assert.equal(done.run.status, 0);
  assert.equal(record('X-5').pr, 41);
  const ready = () => { try { return readFileSync(join(box.home, 'pr-ready'), 'utf8').trim().split('\n'); } catch { return []; } };
  // Its draft pull request waits for a free host: a run of the checks is going on.
  pull({ headRefOid: done.head });
  flow({ FAKE_GH_RUNS: '[{"branch":"feat/other","event":"pull_request"}]' });
  assert.deepEqual(ready(), []);
  flow();
  assert.deepEqual(ready(), ['41']);
  assert.deepEqual(moves().slice(-1), ['X-5 -> In Review']);
  // Out of draft, its checks not listed yet: it is not taken out twice.
  pull({ headRefOid: done.head, isDraft: false });
  flow();
  assert.deepEqual(ready(), ['41'], 'once out of draft, left alone');
  // Checks running: nothing. Red: the lane is opened again with what they said, once for that version.
  pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  assert.equal(flow().stdout.trim(), '');
  pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }, { conclusion: 'SUCCESS' }] });
  // The forge lists runs that were skipped and runs of an older version: the one read is the one that failed on this version.
  // Not listed yet: asked again at the next wake, once, rather than a lane opened blind.
  const runsOf = (...runs) => writeFileSync(join(box.home, 'runs-of-branch.json'), JSON.stringify(runs));
  runsOf({ databaseId: 3, headSha: done.head, conclusion: 'skipped' }, { databaseId: 1, headSha: 'older', conclusion: 'failure' });
  writeFileSync(join(box.home, 'run-log.txt'), 'verify (1/2)\tUNKNOWN STEP\t2026-01-02T10:00:00.0000000Z ✖ the toast closes after three seconds (12ms)\nverify (1/2)\tUNKNOWN STEP\t2026-01-02T10:00:01.0000000Z unrelated line\n');
  assert.match(flow().stdout, /X-5: red at [0-9a-f]{8} and the run that failed is not listed yet: asked again at the next wake/);
  assert.equal(record('X-5').runs.length, 1);
  runsOf({ databaseId: 3, headSha: done.head, conclusion: 'skipped' }, { databaseId: 2, headSha: done.head, conclusion: 'failure' }, { databaseId: 1, headSha: 'older', conclusion: 'failure' });
  assert.match(flow().stdout, /X-5: opened again \(checks:/);
  assert.deepEqual(readFileSync(join(box.home, 'run-viewed'), 'utf8').trim().split('\n'), ['2']);
  rmSync(join(box.home, 'runs-of-branch.json'));
  assert.equal(there('X-5'), true);
  assert.equal(record('X-5').runs.length, 2);
  assert.deepEqual(moves().slice(-1), ['X-5 -> In Progress']);
  flow();
  assert.equal(record('X-5').runs.length, 2, 'not while its session runs');
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  const fixed = session('X-5', { commit: 'fix: the toast closes' });
  assert.match(fixed.prompt, /Why this team reopened[\s\S]*\| Automated checks failed[\s\S]*\|.*✖ the toast closes after three seconds/);
  assert.doesNotMatch(fixed.prompt, /unrelated line/);
  // Its pull request went back to draft before the push: a push to one that is ready starts the checks whatever the host does.
  assert.deepEqual(ready().slice(-1), ['41 --undo']);
  // Green, and read by nobody at this version: its review is asked for, once.
  pull({ headRefOid: fixed.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  assert.match(flow().stdout, /#41 is green[\s\S]*its review is asked for/);
  const reviewDir = () => { const db = openLedger(join(box.state, 'ledger.db')); db.close(); return readdirSync(join(box.state, 'runs')).filter((name) => name.startsWith('X-5-')).sort().at(-1); };
  const review = (answer) => {
    const lanes = execFileSync('git', ['-C', box.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    const path = /worktree (.*review-X-5)\n/.exec(lanes)[1];
    const runDir = join(box.state, 'runs', readdirSync(join(box.state, 'runs')).filter((name) => { try { return /ORCH_ROLE=review/.test(readFileSync(join(box.state, 'runs', name, 'lane.env'), 'utf8')); } catch { return false; } }).sort().at(-1));
    assert.equal(spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: path, env: { ...env, ANSWER: answer }, encoding: 'utf8' }).status, 0);
  };
  assert.equal(flow().stdout.includes('its review is asked for'), false, 'asked once');
  // The reviewer asks for corrections: the lane is opened again with what he wrote.
  review('Verdict : à corriger avant fusion.\n\n- `fix.txt:1` : le toast reste ouvert au survol.');
  assert.match(flow().stdout, /X-5: opened again \(verdict:/);
  const corrected = session('X-5', { commit: 'fix: the toast closes on hover too' });
  assert.match(corrected.prompt, /\| An independent reviewer[\s\S]*\| - `fix\.txt:1` : le toast reste ouvert au survol\./);
  // Green again, read again, nothing blocking: the rules stop there, the request for his agreement is the lead's.
  pull({ headRefOid: corrected.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  assert.match(flow().stdout, /its review is asked for/);
  review('Verdict : rien de bloquant.');
  // A session that had nothing to change (a word of the lead it answered) pushes nothing: its pull request stays
  // out of draft. Sent back to draft for nothing, its checks would have to run again for the same version.
  const undone = () => ready().filter((line) => line === '41 --undo').length;
  const before = undone();
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  const nothing = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-5', '--resume', '--comment-on', 'none'], { env, encoding: 'utf8' });
  assert.equal(nothing.status, 0, nothing.stderr);
  assert.equal(session('X-5', { commit: null }).head, corrected.head);
  assert.equal(undone(), before, 'nothing to push: not put back to draft');
  // One that was put back to draft all the same, at a version whose checks were started once: taken out again.
  pull({ headRefOid: corrected.head, isDraft: true, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  execFileSync('touch', ['-d', '3 minutes ago', join(box.state, 'checks-starting')]);
  const again = ready().length;
  assert.match(flow().stdout, /#41 is taken out of draft/);
  assert.equal(ready().length, again + 1);
  pull({ headRefOid: corrected.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  const last = flow();
  assert.match(last.stdout, /reviewed and green[\s\S]*the request for the agreement is the lead's/);
  assert.equal(flow().stdout.trim(), '', 'said once');
  assert.equal(record('X-5').runs.length, 4);
  assert.deepEqual(stuck(), []);
  // Live: nothing more to do on it.
  pull({ headRefOid: corrected.head, state: 'MERGED', isDraft: false });
  assert.match(flow().stdout, /#41 is MERGED/);
  assert.ok(record('X-5').closed);
  assert.equal(flow().stdout.trim(), '');
});


test('what the rules cannot settle is said, not left: a session that stopped short, a question for the user, his answer, a base that moved, a lane opened too many times', () => {
  const { flow, todo, by, there, record, session, stuck, pull, box } = flowBox();
  todo(['X-5']);
  by('X-5', 0);
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'c1', createdAt: '2020-01-01T10:00:00Z', body: 'Un mot d’avant.', byOwner: true }]));
  flow();
  // A session that stopped short is run again, once for that session.
  assert.notEqual(session('X-5', { commit: null, exit: 1 }).run.status, 0);
  assert.match(flow().stdout, /X-5: opened again \(stopped:/);
  assert.equal(record('X-5').runs.length, 2);
  // It ends on a question for the user: the lead is told, and nothing is guessed.
  const asking = session('X-5', { answer: 'Fait : la moitié.\n\nQuestions pour the user :\n- Le toast se cleared-t-il aussi au clic ? Recommandation : oui.' });
  assert.match(asking.prompt, /\| Your previous session stopped before finishing/);
  pull({ headRefOid: asking.head, statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  assert.match(flow().stdout, /X-5: its session ends on a question for the user/);
  assert.deepEqual(stuck(), ['lane_asks X-5']);
  assert.equal(flow().stdout.includes('question'), false, 'told once');
  // He answers on the ticket: the lane is opened again with his words, by rule.
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([
    { id: 'c9', createdAt: '2099-01-01T10:00:00Z', body: 'Oui, au clic aussi.', byOwner: true },
    { id: 'c8', createdAt: '2099-01-01T09:00:00Z', body: '> Écrit par un agent (chef de projet), pas par lui.\n\nLa question.', byOwner: true },
    { id: 'c1', createdAt: '2020-01-01T10:00:00Z', body: 'Un mot d’avant.', byOwner: true },
  ]));
  const said = flow();
  assert.match(said.stdout, /X-5: opened again \(said:c9\)/);
  assert.doesNotMatch(said.stdout, /could not be opened/, said.stdout);
  const answered = session('X-5', { commit: 'fix: closes on click too' });
  assert.match(answered.prompt, /Why this team reopened[\s\S]*\| The user wrote on the ticket[\s\S]*Oui, au clic aussi\./);
  assert.doesNotMatch(answered.prompt.split('Why this team reopened')[1], /La question\.|Un mot d’avant/);
  assert.equal(flow().stdout.includes('said:'), false, 'his answer is handed once');
  // The base moved on code the branch lacks: it brings it in before anything else.
  mkdirSync(join(box.repo, 'server'), { recursive: true });
  writeFileSync(join(box.repo, 'server', 'core.mjs'), 'export const x = 1;\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'feat: code on the base');
  box.git('push', '-q', 'origin', 'main');
  pull({ headRefOid: answered.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  assert.match(flow().stdout, /X-5: opened again \(base:/);
  // Its session ends without having brought it in: opened again for that already, and the reason still holds. Said, once.
  assert.match(session('X-5', { commit: null }).prompt, /\| The base branch advanced on code/);
  assert.equal(record('X-5').runs.length, 4);
  assert.match(flow().stdout, /X-5: opened again for this already and nothing changed \(base:/);
  assert.deepEqual(stuck(), ['lane_asks X-5', 'lane_stuck X-5']);
  assert.equal(flow().stdout.includes('nothing changed'), false);
  // Four runs in a day is the limit here: one more reason to open it again is said too, and the lane is left.
  mkdirSync(join(box.home, 'elsewhere'), { recursive: true });
  execFileSync('git', ['clone', '-q', join(box.home, 'remote.git'), join(box.home, 'elsewhere', 'clone')]);
  const elsewhere = (...args) => execFileSync('git', ['-C', join(box.home, 'elsewhere', 'clone'), '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  elsewhere('checkout', '-q', 'dev/X-5');
  elsewhere('merge', '-q', '--no-edit', 'origin/main');
  elsewhere('push', '-q', 'origin', 'dev/X-5');
  pull({ headRefOid: elsewhere('rev-parse', 'HEAD').trim(), isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  assert.match(flow().stdout, /X-5: opened 4 times in a day, not opened again/);
  assert.equal(record('X-5').runs.length, 4);
  assert.deepEqual(stuck(), ['lane_asks X-5', 'lane_stuck X-5', 'lane_stuck X-5']);
  flow();
  assert.deepEqual(stuck(), ['lane_asks X-5', 'lane_stuck X-5', 'lane_stuck X-5'], 'said once a day');
  assert.equal(there('X-5'), false);
});


test('what a first real round showed: a session that ended without its push is sent by the rules, a status the tracker moved back is put again, the base brought in under his agreement keeps it, and a rehearsal says what the real round does', () => {
  const { flow, todo, by, there, record, session, stuck, pull, box, moves, env } = flowBox();
  todo(['X-5', 'X-7']);
  by('X-5', 0);
  by('X-7', 0);
  const ready = () => { try { return readFileSync(join(box.home, 'pr-ready'), 'utf8').trim().split('\n'); } catch { return []; } };
  const rehearse = () => spawnSync(join(box.home, 'flow-lanes.sh'), ['--dry-run'], { env, encoding: 'utf8' });
  // A rehearsal opens nothing and does not say it did.
  assert.match(rehearse().stdout, /X-5: put in « Todo » by the user: its lane would be opened/);
  assert.equal(there('X-5'), false);
  // One place: the second ticket is not said opened, it waits.
  const first = flow();
  assert.match(first.stdout, /X-5: put in « Todo » by the user: its lane is opened/);
  assert.match(first.stdout, /X-7: put in « Todo » by the user: no place now/);
  assert.doesNotMatch(first.stdout, /X-7: [^\n]*its lane is opened/);
  todo([]);
  const runDir = () => join(box.state, 'runs', record('X-5').runs.at(-1).run);
  const git = (...args) => execFileSync('git', ['-C', record('X-5').worktree, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  // No terminal wrote which process it is, yet its session is there: at work, not « never started ».
  const kept = record('X-5');
  kept.runs.at(-1).at = new Date(Date.now() - 11 * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  writeFileSync(join(box.state, 'lanes', 'X-5.json'), JSON.stringify(kept));
  const atWork = spawn('bash', ['-c', 'sleep 60; true', `lane-run.sh ${runDir()}`], { stdio: 'ignore' });
  assert.equal(flow().stdout.includes('X-5'), false, 'a session at work is left alone');
  atWork.kill();
  // Its session ended, its commits made, but what ran it stopped before the push: the rules send its work, as the
  // session would have, and nothing is lost nor left to be looked at.
  git('commit', '-q', '--allow-empty', '-m', 'fix: the work');
  writeFileSync(join(runDir(), 'exit-code'), '0\n');
  const sent = flow();
  assert.match(sent.stdout, /X-5: its session ended without sending its work: sent now \(#41\)/);
  assert.equal(record('X-5').pr, 41);
  assert.deepEqual(stuck(), []);
  // Files left uncommitted: only the lane knows what they are. Opened again for that, once for a given commit.
  assert.equal(there('X-5'), true);
  pull({ headRefOid: git('rev-parse', 'HEAD').trim() });
  writeFileSync(join(record('X-5').worktree, 'left.txt'), 'left behind\n');
  const reopened = flow();
  assert.match(reopened.stdout, /X-5: opened again \(unsent:/);
  assert.doesNotMatch(reopened.stdout, /could not be opened/, reopened.stdout);
  const tidied = session('X-5', { commit: null });
  assert.match(tidied.prompt, /\| Your previous session left uncommitted files/);
  assert.match(flow().stdout, /X-5: opened again for this already and nothing changed \(unsent:/);
  assert.deepEqual(stuck(), ['lane_stuck X-5']);
  git('add', 'left.txt');
  const done = session('X-5', { commit: 'fix: what was left' });
  // A rehearsal takes one pull request out of draft a round, like the real one, and does not do it.
  pull({ headRefOid: done.head });
  assert.match(rehearse().stdout, /X-5: #41 would be taken out of draft/);
  assert.deepEqual(ready(), []);
  flow();
  assert.deepEqual(ready(), ['41']);
  assert.deepEqual(moves().slice(-1), ['X-5 -> In Review']);
  // The tracker has automations of its own on pull requests, and put the card back: the rule holds at each round.
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'In Progress\n');
  pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  const before = moves().length;
  flow();
  assert.deepEqual(moves().slice(before), ['X-5 -> In Review']);
  // Reviewed, green, asked, and he agreed. Then the base moves on code: the lane brings it in, and his card stays
  // where he put it (his rule: the base brought in as it is does not take his agreement back).
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'In Review\n');
  pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  assert.match(flow().stdout, /its review is asked for/);
  const reviewRun = join(box.state, 'runs', readdirSync(join(box.state, 'runs')).filter((name) => { try { return /ORCH_ROLE=review/.test(readFileSync(join(box.state, 'runs', name, 'lane.env'), 'utf8')); } catch { return false; } }).sort().at(-1));
  const reviewPath = /worktree (.*review-X-5)\n/.exec(execFileSync('git', ['-C', box.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }))[1];
  assert.equal(spawnSync(join(box.home, 'lane-run.sh'), [reviewRun], { cwd: reviewPath, env: { ...env, ANSWER: 'Verdict : rien de bloquant.' }, encoding: 'utf8' }).status, 0);
  assert.match(flow().stdout, /reviewed and green[\s\S]*the request for the agreement is the lead's/);
  mkdirSync(join(box.state, 'validations'), { recursive: true });
  writeFileSync(join(box.state, 'validations', 'X-5.json'), JSON.stringify({ ticket: 'X-5', at: '2026-01-03T10:00:00Z', pulls: [{ pr: 41, head: done.head }] }));
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'Go MEP\n');
  mkdirSync(join(box.repo, 'server'), { recursive: true });
  writeFileSync(join(box.repo, 'server', 'core.mjs'), 'export const x = 1;\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'feat: code on the base');
  box.git('push', '-q', 'origin', 'main');
  const agreed = moves().length;
  assert.match(flow().stdout, /X-5: opened again \(base:/);
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  const brought = session('X-5', { commit: null, bringBase: true });
  assert.notEqual(brought.head, done.head);
  pull({ headRefOid: brought.head });
  // Checks started less than two minutes ago hold the next pull request back: not yet.
  flow();
  assert.deepEqual(ready().slice(-1), ['41 --undo']);
  execFileSync('touch', ['-d', '3 minutes ago', join(box.state, 'checks-starting')]);
  flow();
  assert.deepEqual(ready().slice(-2), ['41 --undo', '41']);
  pull({ headRefOid: brought.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  const green = flow();
  assert.doesNotMatch(green.stdout, /its review is asked for|the request for the agreement/, 'read and agreed already: the base alone asks nobody anything');
  assert.deepEqual(moves().slice(agreed), [], 'his card never left « Go MEP »');
  assert.deepEqual(stuck(), ['lane_stuck X-5']);
  // The tracker took the card out of his status when the pull request left draft: back where it asks him, and said.
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'In Review\n');
  assert.match(flow().stdout, /X-5: left « Go MEP » without him and with nothing new: back in « À valider »/);
  assert.deepEqual(moves().slice(agreed), ['X-5 -> À valider']);
  assert.deepEqual(stuck(), ['lane_stuck X-5', 'lane_stuck X-5']);
});


test('what its first review asked: the dependencies come from the base and run no script of a package, a screen test at work holds the checks back, the rules never take his agreement back themselves, a question is only what stands under its title, and no word of his falls between two readings', () => {
  const { flow, todo, by, there, record, session, stuck, pull, box, moves, env } = flowBox();
  writeFileSync(join(box.home, 'agents.conf'), readFileSync(join(box.home, 'agents.conf'), 'utf8').replace('runs_per_day = 4', 'runs_per_day = 9'));
  writeFileSync(join(box.repo, 'package.json'), '{"name":"p"}\n');
  writeFileSync(join(box.repo, 'package-lock.json'), '{"lockfileVersion":3}\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'chore: dependencies');
  box.git('push', '-q', 'origin', 'main');
  writeFileSync(join(box.home, 'bin', 'npm'), `#!/usr/bin/env bash\necho "$*" >> "${join(box.home, 'npm-calls')}"\nmkdir -p node_modules/pkg && echo installed > node_modules/pkg/index.js\n`, { mode: 0o755 });
  const installs = () => { try { return readFileSync(join(box.home, 'npm-calls'), 'utf8').trim().split('\n'); } catch { return []; } };
  const ready = () => { try { return readFileSync(join(box.home, 'pr-ready'), 'utf8').trim().split('\n'); } catch { return []; } };
  // A word of his that is on the ticket when the lane opens is handed to it; it never opens the lane again.
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'c1', createdAt: '2026-01-02T10:00:00Z', body: 'Il doit se fermer au clic.', byOwner: true }]));
  todo(['X-5']);
  by('X-5', 0);
  // Under the key of a person, a ticket an agent opened in « Todo » would count as his « go »: nothing opens.
  writeFileSync(join(box.home, 'tracker-identity'), 'shared\n');
  assert.match(flow().stdout, /cannot tell the user from an agent: no lane is opened from « Todo »/);
  assert.equal(there('X-5'), false);
  writeFileSync(join(box.home, 'tracker-identity'), 'app\n');
  flow();
  assert.equal(there('X-5'), true);
  // The dependencies: those of the base, installed with no script of a package run, and nobody writes in them
  // but for the scratch folders a build needs.
  assert.deepEqual(installs().map((line) => /^ci\b.*--ignore-scripts/.test(line)), [true]);
  const deps = execFileSync('readlink', ['-f', join(record('X-5').worktree, 'node_modules')], { encoding: 'utf8' }).trim();
  assert.throws(() => writeFileSync(join(deps, 'pkg', 'index.js'), 'changed\n'), /EACCES/);
  assert.throws(() => writeFileSync(join(deps, 'new.js'), 'added\n'), /EACCES/);
  writeFileSync(join(deps, '.vite-temp', 'scratch'), 'fine\n');
  // A lane that rewrites the lock file gets nothing installed from it: what it wrote is not run by the dispatcher.
  const git = (...args) => execFileSync('git', ['-C', record('X-5').worktree, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  writeFileSync(join(record('X-5').worktree, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/evil":{"hasInstallScript":true}}}\n');
  git('add', 'package-lock.json');
  // Its report names « questions pour » in passing, and has none: nothing is carried to the user.
  const first = session('X-5', { commit: 'chore: the lock file', answer: 'Fait : les questions pour plus tard sont notées dans le ticket.\n\nReste à faire : rien.\n\nQuestions pour the user : aucune.' });
  assert.equal(first.run.status, 0);
  pull({ headRefOid: first.head });
  // A screen test of somebody is at work, or the door of the heavy commands is held: its checks wait.
  const proc = join(box.home, 'proc-screens');
  mkdirSync(join(proc, '201'), { recursive: true });
  writeFileSync(join(proc, '201', 'cmdline'), 'npm\0run\0test:ui\0');
  flow({ ORCH_PROC_DIR: proc });
  assert.deepEqual(ready(), [], 'a screen test runs');
  assert.equal(spawnSync('bash', ['-c', 'exec 9> "$1"; flock 9; "$2"', '_', join(box.state, 'heavy.lock'), join(box.home, 'flow-lanes.sh')], { env, encoding: 'utf8' }).status, 0);
  assert.deepEqual(ready(), [], 'the door is held');
  flow();
  assert.deepEqual(ready(), ['41']);
  assert.ok(Date.now() - statSync(join(box.state, 'checks-starting')).mtimeMs < 60000, 'the door of the heavy commands is told that checks start');
  assert.deepEqual(stuck(), [], 'no question was carried');
  // The word he had written before the lane opened is not news, and one written since is.
  assert.equal(flow().stdout.includes('said:'), false);
  // Opened again: the lock file of the lane differs from the one of the base. Nothing is installed, and it is told.
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([
    { id: 'c2', createdAt: '2026-01-01T09:00:00Z', body: 'Et au survol aussi.', byOwner: true },
    { id: 'c1', createdAt: '2026-01-02T10:00:00Z', body: 'Il doit se fermer au clic.', byOwner: true },
  ]));
  pull({ headRefOid: first.head, isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  // (its date says « before the session »: only what the session was handed tells what is new)
  // Dependencies of a lock file no worktree uses any more do not pile up: gone at the next opening of a lane.
  // (one just installed and not linked yet is another lane being opened: left alone)
  const stale = join(box.state, 'deps', '0000000000000000');
  const fresh = join(box.state, 'deps', '1111111111111111');
  mkdirSync(join(stale, 'node_modules', 'old'), { recursive: true });
  mkdirSync(join(fresh, 'node_modules', 'new'), { recursive: true });
  execFileSync('chmod', ['-R', 'a-w', join(stale, 'node_modules')]);
  execFileSync('touch', ['-d', '3 hours ago', stale]);
  assert.match(flow().stdout, /X-5: opened again \(said:c2\)/);
  assert.equal(installs().length, 1);
  assert.deepEqual(readdirSync(join(box.state, 'deps')).filter((name) => /^[0-9a-f]{16}$/.test(name)).filter((name) => name !== '1111111111111111').length, 1, 'of the old ones, only the one in use is kept');
  assert.deepEqual(readdirSync(join(fresh, 'node_modules')), ['new']);
  assert.equal(readFileSync(join(record('X-5').worktree, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'installed\n');
  const second = session('X-5', { commit: null, answer: 'Fait.\n\n**Questions pour the user**\n\n1. Le toast se cleared-t-il aussi au survol ? Recommandation : oui.' });
  assert.match(second.prompt, /Installed dependencies come from the base branch/);
  assert.doesNotMatch(second.prompt.split('Why this team reopened')[1], /au clic/);
  flow();
  assert.deepEqual(stuck(), ['lane_asks X-5'], 'a title in bold is a title');
  // Checks that never ran (all skipped) leave the lane waiting for nothing: said after a while, once.
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'In Review\n');
  pull({ headRefOid: second.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SKIPPED' }] });
  assert.equal(flow().stdout.trim(), '');
  const kept = record('X-5');
  // (counted from when it left draft)
  assert.ok(kept.done[`ready:${second.head}`]);
  kept.done[`ready:${second.head}`] = new Date(Date.now() - 31 * 60000).toISOString();
  writeFileSync(join(box.state, 'lanes', 'X-5.json'), JSON.stringify(kept));
  assert.match(flow().stdout, /X-5: #41 is out of draft and none of its checks ran/);
  assert.equal(flow().stdout.trim(), '');
  assert.deepEqual(stuck(), ['lane_asks X-5', 'lane_stuck X-5']);
  // Reviewed, green, asked. He answers with a word, the lane has nothing to change: his card goes back where it
  // asks him, and nobody is told the tracker did anything.
  pull({ headRefOid: second.head, isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] });
  assert.match(flow().stdout, /its review is asked for/);
  const reviewRun = join(box.state, 'runs', readdirSync(join(box.state, 'runs')).filter((name) => { try { return /ORCH_ROLE=review/.test(readFileSync(join(box.state, 'runs', name, 'lane.env'), 'utf8')); } catch { return false; } }).sort().at(-1));
  const reviewPath = /worktree (.*review-X-5)\n/.exec(execFileSync('git', ['-C', box.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }))[1];
  assert.equal(spawnSync(join(box.home, 'lane-run.sh'), [reviewRun], { cwd: reviewPath, env: { ...env, ANSWER: 'Verdict : rien de bloquant.' }, encoding: 'utf8' }).status, 0);
  assert.match(flow().stdout, /the request for the agreement is the lead's/);
  mkdirSync(join(box.state, 'validations'), { recursive: true });
  writeFileSync(join(box.state, 'validations', 'X-5.json'), JSON.stringify({ ticket: 'X-5', at: '2026-01-03T10:00:00Z', pulls: [{ pr: 41, head: second.head }] }));
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'À valider\n');
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'c3', createdAt: '2099-01-01T10:00:00Z', body: 'C’est bien ce que je voulais ?', byOwner: true }, { id: 'c2', createdAt: '2026-01-01T09:00:00Z', body: 'x', byOwner: true }, { id: 'c1', createdAt: '2026-01-02T10:00:00Z', body: 'y', byOwner: true }]));
  assert.match(flow().stdout, /X-5: opened again \(said:c3\)/);
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'In Progress\n');
  session('X-5', { commit: null });
  const told = stuck().length;
  assert.match(flow().stdout, /X-5: asked for this version already: back in « À valider »/);
  assert.deepEqual(moves().slice(-1), ['X-5 -> À valider']);
  assert.equal(stuck().length, told, 'the rules moved it themselves: nothing to tell');
  // He agrees. The base moves on code, and the session that brings it in stops short: run again, and his card
  // never leaves « Go MEP » by the hand of the rules.
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'Go MEP\n');
  flow();
  mkdirSync(join(box.repo, 'server'), { recursive: true });
  writeFileSync(join(box.repo, 'server', 'core.mjs'), 'export const x = 1;\n');
  box.git('add', '.');
  box.git('commit', '-q', '-m', 'feat: code on the base');
  box.git('push', '-q', 'origin', 'main');
  const agreed = moves().length;
  assert.match(flow().stdout, /X-5: opened again \(base:/);
  assert.notEqual(session('X-5', { commit: null, exit: 1 }).run.status, 0);
  assert.match(flow().stdout, /X-5: opened again \(stopped:/);
  assert.deepEqual(moves().slice(agreed), [], 'his card stays in « Go MEP »');
});


test('the lead can say something to a lane of the dispatcher whose session is over: kept, and handed to it at a session the rules open for that', () => {
  const { flow, todo, by, there, record, session, stuck, pull, box, env } = flowBox();
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const tell = (lane, text) => spawnSync(join(box.home, 'tell-lane.sh'), [lane, '-'], { env, input: text, encoding: 'utf8' });
  // While its session runs, the word waits: nothing can be said into a session that reads no terminal.
  const kept = tell('X-5', 'Il manque la capture sur téléphone, prise sur les données de démonstration.');
  assert.equal(kept.status, 0, kept.stderr);
  const shown = () => readFileSync(join(box.home, 'tracker-moves'), 'utf8').trim().split('\n').length;
  const atWork = shown();
  assert.match(kept.stdout, /kept for the lane of X-5/);
  assert.equal(flow().stdout.includes('told:'), false);
  const first = session('X-5');
  pull({ headRefOid: first.head, statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  // Its session over: opened again with what the lead wrote, quoted, once. The ticket is shown at work.
  assert.match(flow().stdout, /X-5: opened again \(told:/);
  assert.equal(shown(), atWork + 1);
  // What it sets apart for the user (a capture) exists only in its worktree, which is closed once its work is
  // sent: kept where the lead finds it, under the ticket.
  writeFileSync(join(box.home, 'agents.conf'), readFileSync(join(box.home, 'agents.conf'), 'utf8').replace('[lanes]\n', `[lanes]\nkept_from = .local/captures\nkept_in = ${join(box.home, 'kept')}\n`));
  execFileSync('bash', ['-c', 'echo "/.local" >> "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)/info/exclude"', '_', record('X-5').worktree]);
  mkdirSync(join(record('X-5').worktree, '.local', 'captures'), { recursive: true });
  writeFileSync(join(record('X-5').worktree, '.local', 'captures', 'toast-390.png'), 'image');
  const second = session('X-5', { commit: 'docs: the capture' });
  assert.match(second.prompt, /Why this team reopened[\s\S]*\| The project lead wrote[\s\S]*\|.*Il manque la capture sur téléphone/);
  const closed = flow();
  assert.equal(closed.stdout.includes('told:'), false);
  assert.match(closed.stdout, /X-5: what its lane set apart for the user is kept/);
  assert.equal(there('X-5'), false);
  assert.equal(readFileSync(join(box.home, 'kept', 'X-5', 'toast-390.png'), 'utf8'), 'image');
  assert.equal(record('X-5').runs.length, 2);
  // A word of the lead to a lane whose card asks the user leaves the card where it asks him.
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'À valider\n');
  const before = readFileSync(join(box.home, 'tracker-moves'), 'utf8');
  assert.equal(tell('X-5', 'La légende de la capture est à corriger.').status, 0);
  assert.match(flow().stdout, /X-5: opened again \(told:/);
  assert.equal(readFileSync(join(box.home, 'tracker-moves'), 'utf8'), before);
  // The same nets as for any lane: never told to merge or to force, and no more than a few messages an hour.
  assert.match(tell('X-5', 'Fusionne ta branche dans main.').stderr, /never told to merge or force/);
  assert.match(spawnSync(join(box.home, 'tell-lane.sh'), ['--list'], { env, encoding: 'utf8' }).stdout, /^X-5\t/m);
  // A ticket that never had a lane, or whose lane is over, cannot be told anything.
  assert.notEqual(tell('X-6', 'Un mot.').status, 0);
  assert.deepEqual(stuck(), []);
});


test('a lane runs its heavy commands (screen tests, captures) through one door: when the host is free, one at a time, and only the ones the project names', () => {
  const box = sandbox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('[lanes]\n', '[lanes]\nheavy_commands = echo screens, echo captures\nheavy_wait_minutes = 0\n'));
  mkdirSync(join(box.home, 'proc-none'), { recursive: true });
  const env = { ...box.env, HOME: box.home, ORCH_PROC_DIR: join(box.home, 'proc-none') };
  const heavy = (args, extra = {}) => spawnSync(join(box.home, 'when-free.sh'), args, { env: { ...env, ...extra }, encoding: 'utf8' });
  const free = heavy(['echo', 'screens', 'now']);
  assert.equal(free.status, 0, free.stderr);
  assert.equal(free.stdout.trim(), 'screens now');
  // Not a way around what a lane may run: only what the project names goes through.
  const other = heavy(['echo', 'anything']);
  assert.equal(other.status, 1);
  assert.match(other.stderr, /is not one of the heavy commands/);
  assert.match(heavy(['curl', 'https://example.test']).stderr, /is not one of the heavy commands/);
  // The checks of somebody run: it waits its turn, and says so when the wait is over.
  const busy = heavy(['echo', 'screens'], { FAKE_GH_RUNS: '[{"branch":"feat/other","event":"pull_request"}]' });
  assert.equal(busy.status, 5);
  assert.match(busy.stderr, /the host is not free/);
  assert.equal(busy.stdout, '');
  // Checks that were just started are not listed by GitHub yet: for two minutes after the rules took a pull
  // request out of draft, the door stays shut, then opens again.
  writeFileSync(join(box.state, 'checks-starting'), '');
  const starting = heavy(['echo', 'screens']);
  assert.equal(starting.status, 5);
  assert.equal(starting.stdout, '');
  execFileSync('touch', ['-d', '3 minutes ago', join(box.state, 'checks-starting')]);
  assert.equal(heavy(['echo', 'screens']).stdout.trim(), 'screens');
  // One at a time: while another lane holds the door, this one waits too.
  const held = spawnSync('bash', ['-c', 'exec 9> "$1"; flock 9; shift; "$@"; code=$?; exit "$code"', '_', join(box.state, 'heavy.lock'), join(box.home, 'when-free.sh'), 'echo', 'screens'], { env, encoding: 'utf8' });
  assert.equal(held.status, 5);
  // The lanes of the project go through it, and may not start a screen test any other way. The door is the
  // dispatcher's own copy, wherever the lane works: a worktree made from a branch that never had the script (or
  // where the lane rewrote it) has no door of its own.
  const dev = conf.sections['permissions.dev'];
  assert.ok(dev.allow.split(',').map((item) => item.trim()).includes('{orch}/when-free.sh'), dev.allow);
  assert.match(readFileSync(join(ORCH_HOME, 'prompts', 'dev.md'), 'utf8'), /`\{orch\}\/when-free\.sh npm run test:ui`/);
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8')}\n[permissions.door]\nmode = accept-edits\nallow = npm test, {orch}/when-free.sh\ndeny = {orch}/merge-pr.sh\n`);
  const allowed = spawnSync('bash', ['-c', '. "$1/lib/common.sh"; permissions_env door; printf "%s\n%s\n" "$ORCH_ALLOW" "$ORCH_DENY"', '_', box.home], { env, encoding: 'utf8' });
  assert.equal(allowed.stdout, `npm test, ${box.home}/when-free.sh\n${box.home}/merge-pr.sh\n`, allowed.stderr);
  // And its prompt names that same copy.
  writeFileSync(join(box.home, 'door.md'), 'Lance les tests d’écran par `{orch}/when-free.sh npm run test:ui`.\n');
  const told = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-5', '--prompt-file', join(box.home, 'door.md'), '--comment-on', 'none'], { env, encoding: 'utf8' });
  assert.equal(told.status, 0, told.stderr);
  assert.match(readFileSync(join(JSON.parse(told.stdout).run_dir, 'prompt.md'), 'utf8'), new RegExp(`par \`${box.home}/when-free\\.sh npm run test:ui\``));
  assert.ok(dev.deny.split(',').map((item) => item.trim()).includes('npm run test:ui'));
  // The heavy commands of the project: its screen tests and captures, and the one task script of a backend whose whole session is one (it is named by its place, never by a pattern).
  for (const command of conf.sections.lanes.heavy_commands.split(',').map((item) => item.trim())) assert.ok(/^npm run (test:ui|capture:)/.test(command) || command === conf.sections['adapter.codex'].task_script, command);
});


test('no lane is left waiting in silence: a session that died, never started or runs too long is seen; a ticket taken out of the work pauses its lane; a word after his agreement does not take it back; one unreadable record stops nothing', () => {
  const { flow, todo, by, there, record, session, stuck, pull, box, moves } = flowBox({ maxLanes: 2 });
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('runs_per_day = 4', 'runs_per_day = 9\nsession_hours = 1'));
  todo(['X-5']);
  by('X-5', 0);
  // What is kept of another lane cannot be read: said, and the others go on.
  mkdirSync(join(box.state, 'lanes'), { recursive: true });
  writeFileSync(join(box.state, 'lanes', 'X-9.json'), '{ not json');
  const first = flow();
  assert.match(first.stdout, /X-9\.json: what is kept of this lane cannot be read/);
  assert.equal(there('X-5'), true);
  const runDir = () => join(box.state, 'runs', record('X-5').runs.at(-1).run);
  const openedAt = (minutesAgo) => { const kept = record('X-5'); kept.runs.at(-1).at = new Date(Date.now() - minutesAgo * 60000).toISOString().replace(/\.\d+Z$/, 'Z'); writeFileSync(join(box.state, 'lanes', 'X-5.json'), JSON.stringify(kept)); };
  // Just opened, no terminal ran it yet: it is given its time. Ten minutes later it never started: run again.
  assert.equal(flow().stdout.includes('X-5'), false);
  openedAt(11);
  assert.match(flow().stdout, /X-5: its session never started\nX-5: opened again \(stopped:/);
  assert.equal(record('X-5').runs.length, 2);
  // Its process is gone without a word (its terminal closed, the host restarted): seen, and run again.
  writeFileSync(join(runDir(), 'pid'), '999999\n');
  assert.match(flow().stdout, /X-5: its session died without a word\nX-5: opened again \(stopped:/);
  assert.equal(record('X-5').runs.length, 3);
  // A session that runs for longer than a session may is stopped, and counts as one that stopped short.
  const long = spawn('sleep', ['60'], { stdio: 'ignore' });
  writeFileSync(join(runDir(), 'pid'), `${long.pid}\n`);
  openedAt(30);
  assert.equal(flow().stdout.includes('X-5'), false, 'half an hour: at work');
  openedAt(61);
  const tooLong = runDir();
  assert.match(flow().stdout, /X-5: its session runs for more than 1 hours: stopped\nX-5: opened again \(stopped:/);
  assert.equal(readFileSync(join(tooLong, 'exit-code'), 'utf8').trim(), '124');
  long.kill();
  assert.equal(record('X-5').runs.length, 4);
  // The user takes the ticket out of the work: its lane waits, nothing is opened again. Back in the work: it goes on.
  assert.notEqual(session('X-5', { commit: null, exit: 1 }).run.status, 0);
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'Backlog\n');
  assert.equal(flow().stdout.includes('X-5'), false);
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'In Progress\n');
  // (the day after: a fourth session that stops in one day is a loop, and is said instead)
  { const aged = record('X-5'); for (const key of Object.keys(aged.done)) if (key.startsWith('stopped:')) aged.done[key] = new Date(Date.now() - 25 * 3600e3).toISOString(); writeFileSync(join(box.state, 'lanes', 'X-5.json'), JSON.stringify(aged)); }
  assert.match(flow().stdout, /X-5: opened again \(stopped:/);
  // « Aucune. » on a line of its own is no question for him.
  const done = session('X-5', { answer: 'Fait.\n\nQuestions pour the user\n\nAucune.' });
  assert.equal(done.run.status, 0);
  pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  flow();
  assert.deepEqual(stuck(), []);
  // He put the card in the status of his agreement before anything was asked of him, and the lead writes to
  // the lane: there is no agreement to keep yet, the word is handed over, and his card stays where he put it.
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'Go MEP\n');
  assert.equal(spawnSync(join(box.home, 'tell-lane.sh'), ['X-5', '-'], { env: box.env, input: 'Il manque la capture sur téléphone.', encoding: 'utf8' }).status, 0);
  const early = moves().length;
  assert.match(flow().stdout, /X-5: opened again \(told:/);
  assert.equal(moves().length, early, 'the card stays where he put it');
  const handed = session('X-5', { answer: 'Fait.\n\nQuestions pour the user : aucune.' });
  assert.match(handed.prompt, /\| The project lead wrote[\s\S]*Il manque la capture sur téléphone\./);
  pull({ headRefOid: handed.head, isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  flow();
  assert.deepEqual(stuck(), []);
  // He was asked, and has agreed, then writes a word on the ticket: read by the lead, it does not take his agreement back.
  mkdirSync(join(box.state, 'validations'), { recursive: true });
  writeFileSync(join(box.state, 'validations', 'X-5.json'), JSON.stringify({ ticket: 'X-5', at: '2026-01-03T10:00:00Z', pulls: [{ pr: 41, head: handed.head }] }));
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'c9', createdAt: '2099-01-01T10:00:00Z', body: 'Merci.', byOwner: true }]));
  const before = moves().length;
  assert.equal(flow().stdout.includes('said:'), false);
  assert.equal(moves().length, before, 'the card stays where he put it');
  // The same word while the card asks him: it is his answer, the lane is opened again with it.
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'À valider\n');
  assert.match(flow().stdout, /X-5: opened again \(said:c9\)/);
  // Done: nothing more is done on it, whatever comes next.
  session('X-5', { commit: null });
  writeFileSync(join(box.home, 'tracker-state-X-5'), 'Done\n');
  assert.match(flow().stdout, /X-5: its ticket is « Done »/);
  assert.equal(flow().stdout.includes('X-5:'), false);
});


test('a lane takes over a pull request somebody else began: it works on that branch, and sends its work to it', () => {
  const hand = laneWithRemote('feat/by-hand', 'feat: begun by hand');
  const { box } = hand;
  execFileSync('git', ['-C', hand.path, 'push', '-q', 'origin', 'feat/by-hand']);
  execFileSync('git', ['-C', box.repo, 'worktree', 'remove', '--force', hand.path]);
  writeFileSync(join(box.home, 'pr-view.json'), JSON.stringify({ number: 7, state: 'OPEN', isDraft: false, headRefName: 'feat/by-hand', baseRefName: 'main', additions: 1, deletions: 0, files: [] }));
  writeFileSync(join(box.home, 'pr-head-feat-by-hand.json'), JSON.stringify([{ number: 7, state: 'OPEN' }]));
  const opened = spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-7', '--pr', '7', '--comment-on', 'none'], { env: box.env, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr);
  const lane = JSON.parse(opened.stdout);
  assert.match(readFileSync(join(lane.run_dir, 'prompt.md'), 'utf8'), /PR #7, branch feat\/by-hand/);
  execFileSync('git', ['-C', lane.worktree, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '--allow-empty', '-m', 'fix: what the reviewer asked']);
  const head = execFileSync('git', ['-C', lane.worktree, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(spawnSync(join(box.home, 'lane-run.sh'), [lane.run_dir], { cwd: lane.worktree, env: box.env, encoding: 'utf8' }).status, 0);
  assert.ok(hand.onRemote().includes(`feat/by-hand ${head}`), 'its work is on the branch of the pull request');
  assert.ok(!hand.onRemote().some((ref) => ref.startsWith('dev/X-7 ')), 'and on no branch of its own');
  assert.equal(hand.created(), null, 'no second pull request');
  const record = JSON.parse(readFileSync(join(box.state, 'lanes', 'X-7.json'), 'utf8'));
  assert.deepEqual([record.pr, record.push_branch], [7, 'feat/by-hand']);
  // Never to the base, whatever a pull request says of its branch.
  writeFileSync(join(box.home, 'pr-view.json'), JSON.stringify({ number: 8, state: 'OPEN', isDraft: false, headRefName: 'main', baseRefName: 'main', additions: 1, deletions: 0, files: [] }));
  assert.match(spawnSync(join(box.home, 'spawn-lane.sh'), ['dev', 'X-8', '--pr', '8', '--comment-on', 'none'], { env: box.env, encoding: 'utf8' }).stderr, /is the base/);
});


test('the acting lead: a report of a lane wakes it, with the prompt and the permissions of the acting lead; while it observes, lanes are not read', () => {
  const box = sandbox();
  const projects = join(box.home, 'projects');
  const lanePath = join(box.home, 'lanes', 'old-lane');
  box.git('worktree', 'add', '-q', '-b', 'feat/old', lanePath, 'main');
  const dir = join(projects, lanePath.replace(/[^A-Za-z0-9]/g, '-'));
  execFileSync('mkdir', ['-p', dir]);
  writeFileSync(join(dir, 's.jsonl'), `${JSON.stringify({ type: 'assistant', uuid: 'r1', timestamp: new Date(Date.now() - 120000).toISOString(), message: { content: [{ type: 'text', text: 'Pour le chef de projet : main est réintégrée, je demande le créneau de CI.' }] } })}\n`);
  const env = { ...box.env, HOME: box.home };
  execFileSync('mkdir', ['-p', join(box.home, '.claude')]);
  execFileSync('ln', ['-s', projects, join(box.home, '.claude', 'projects')]);
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env, encoding: 'utf8' });
  // Observing: the first wake takes note, the second finds nothing: the lane is not read.
  wake();
  const observing = wake();
  assert.equal(observing.stdout.trim(), '');
  // Acting: the report is an event.
  writeFileSync(join(box.home, 'agents.conf'), readFileSync(join(box.home, 'agents.conf'), 'utf8').replace('live = no', 'live = yes'));
  const acting = wake();
  assert.equal(acting.status, 0, acting.stderr);
  const runDir = acting.stdout.trim();
  const prompt = readFileSync(join(runDir, 'prompt.md'), 'utf8');
  assert.match(prompt, /acting lead prompt/);
  assert.match(prompt, /Team old-lane \(branch feat\/old\) — its latest message[\s\S]*je demande le créneau de CI/);
  const laneEnv = readFileSync(join(runDir, 'lane.env'), 'utf8');
  assert.match(laneEnv, /ORCH_PERMISSIONS=release-live/);
  assert.match(laneEnv, /ORCH_COMMENT_ON=none/);
  // The run gets the permissions of the acting lead, not those of the role.
  spawnSync(join(box.home, 'lane-run.sh'), [runDir], { cwd: box.repo, env, encoding: 'utf8' });
  assert.equal(readFileSync(join(box.state, 'allowed-first'), 'utf8').trim(), 'read-only|only-for-the-acting-lead|never');
  // What it writes to the user says which model wrote it.
  assert.equal(readFileSync(join(box.state, 'signed-first'), 'utf8').trim(), 'chef de projet, model a');
  // Said once: the next wake does not hand the same report again.
  writeFileSync(join(runDir, 'exit-code'), '0');
  assert.equal(wake().stdout.trim(), '');
});


test('the acting lead may answer and read, nothing more: its permissions refuse the scripts that open, close, push or create', () => {
  const live = conf.sections['permissions.release-live'];
  const list = (text) => text.split(',').map((item) => item.trim());
  assert.equal(live.mode, 'read-only');
  assert.equal(live.read, '{kept}', 'it reads the captures the lanes set apart for the user, to show them to him');
  const scripts = list(live.allow).filter((item) => item.startsWith('{orch}/'));
  // It answers by two scripts; the rest only reads (what the user wrote in tracker, the state of the host).
  // Since 2026-10-08 it also opens a ticket, for one thing: a night check that came out red (rule of the user), and keeps a note for the digest.
  assert.deepEqual([...scripts].sort(), ['{orch}/tracker.sh create', '{orch}/digest-note.sh', '{orch}/tracker.sh comment', '{orch}/tracker.sh comments', '{orch}/tracker.sh issue', '{orch}/tracker.sh waiting', '{orch}/tell-lane.sh', '{orch}/host-state.sh', '{orch}/review-pr.sh', '{orch}/ask-validation.sh', '{orch}/merge-pr.sh'].sort());
  // It never changes a status itself: the one script that does only goes to the two statuses a script may set.
  assert.ok(list(live.deny).includes('{orch}/tracker.sh move'));
  for (const refused of ['{orch}/tidy-lanes.sh', '{orch}/spawn-lane.sh', '{orch}/kill-lane.sh', '{orch}/push-lane.sh', 'gh', 'orca', 'git push']) assert.ok(list(live.deny).includes(refused), refused);
});


test('tell-lane says it in the terminal written for that lane, and nowhere else', () => {
  const box = sandbox();
  execFileSync('mkdir', ['-p', box.state]);
  const worktree = join(box.home, 'lanes', 'old-lane');
  box.git('worktree', 'add', '-q', '-b', 'old-lane', worktree, 'main');
  writeFileSync(join(box.state, 'lanes.json'), JSON.stringify({ 'old-lane': 'term_1' }));
  const terminals = (list) => writeFileSync(join(box.home, 'terminals.json'), JSON.stringify({ result: { terminals: list } }));
  const tell = (lane, text, extra = {}) => spawnSync(join(box.home, 'tell-lane.sh'), [lane, '-'], { env: { ...box.env, ...extra }, encoding: 'utf8', input: text });
  const sent = () => { try { return readFileSync(join(box.home, 'orca-sent'), 'utf8'); } catch { return null; } };
  // An unknown lane, a terminal that is gone, one that is in another worktree: nothing is sent.
  terminals([{ handle: 'term_1', connected: true, worktreePath: worktree }]);
  assert.equal(tell('another', 'x').status, 1);
  terminals([]);
  assert.match(tell('old-lane', 'x').stderr, /is gone/);
  terminals([{ handle: 'term_1', connected: true, worktreePath: join(box.home, 'lanes', 'somewhere-else') }]);
  assert.match(tell('old-lane', 'x').stderr, /not in its worktree/);
  // A folder of the same name somewhere else is not the worktree of that lane.
  terminals([{ handle: 'term_1', connected: true, worktreePath: '/elsewhere/old-lane' }]);
  assert.match(tell('old-lane', 'x').stderr, /not in its worktree/);
  // Orca that does not answer is said, not passed over in silence.
  assert.match(tell('old-lane', 'x', { FAKE_ORCA_DOWN: '1' }).stderr, /Orca did not answer/);
  assert.equal(sent(), null);
  terminals([{ handle: 'term_1', connected: true, worktreePath: worktree }]);
  const ok = tell('old-lane', 'Accord de the user sur X-1.\nTu peux réintégrer main.');
  assert.equal(ok.status, 0, ok.stderr);
  const args = sent().split('\n');
  assert.equal(args[args.indexOf('--terminal') + 1], 'term_1');
  const text = args[args.indexOf('--text') + 1];
  assert.match(text, /^To team old-lane, from chef de projet/);
  assert.match(text, /Accord de the user sur X-1\. Tu peux réintégrer main\./);
  assert.ok(args.includes('--enter'));
  assert.equal(JSON.parse(readFileSync(join(box.state, 'lane-messages.jsonl'), 'utf8').trim()).lane, 'old-lane');
  // It does not ask for an answer: an acknowledgement would wake the lead again, for nothing.
  assert.doesNotMatch(text, /Réponds par un rapport/);
  // A lane is never told to merge or to force anything: that is not the lead's to hand out.
  for (const order of ['Fusionne #259 maintenant.', 'Tu peux merge la PR.', 'Tu peux fusionner la PR.', 'git push --force si besoin.']) {
    const refused = tell('old-lane', order);
    assert.equal(refused.status, 1, order);
    assert.match(refused.stderr, /never told to merge/);
  }
  // A line of the journal that cannot be read does not hide the messages already sent.
  writeFileSync(join(box.state, 'lane-messages.jsonl'), `not json\n${readFileSync(join(box.state, 'lane-messages.jsonl'), 'utf8')}`);
  assert.equal(tell('old-lane', 'Je fusionnerai #259 quand elle sera verte ; réintègre main.').status, 0);
  // Two messages an hour to one lane (the limit of this sandbox): the third is not sent.
  const third = tell('old-lane', 'Encore un mot.');
  assert.equal(third.status, 1);
  assert.match(third.stderr, /already told 2 times/);
});


test('what a lane may be told: an order to merge or to force is refused in its usual forms, a caution or what the lead will do itself is not', async () => {
  const { refusedOrder } = await import('../lib/lane-message.mjs');
  for (const order of [
    'Fusionne #259 maintenant.', 'Tu peux fusionner la PR.', 'Tu peux merge la PR.', 'Il faut merger dès que c’est vert.', 'Lance gh pr merge 259.',
    'Fais un force push.', 'git push --force si besoin.', 'git push --force-with-lease origin', 'git push -f origin ta-branche',
    // A negation that invites, and an order after a reassurance, are orders.
    'N’hésite pas à fusionner.', "N'attends pas pour fusionner.", 'Ne t’inquiète pas, fusionne #259.', 'Ne fusionne pas avant la CI ; après, fusionne.',
    'La CI est verte et tu peux fusionner.', 'FUSIONNEZ.',
    // A negation far before the word does not bear on it.
    'Comme tu n’as plus rien à faire fusionne la PR.',
    'Merge #259 now.', 'You can merge the pull request.', 'Force push this branch.', 'Do not hesitate to merge.',
  ]) assert.ok(refusedOrder(order), order);
  for (const said of [
    'Ne fusionne pas avant l’accord de the user.', 'Tu ne dois ni fusionner ni forcer.', 'Ne jamais fusionner sans son accord écrit.', 'Pas de merge de ton côté.',
    'Ne force rien : jamais de --force.', 'Sans force-push, donc.',
    'Je fusionnerai #259 quand elle sera verte ; réintègre main.', 'Je la fusionne à un moment sans test d’écran.', 'Le script fusionnera quand tout sera vert.',
    '#266 est fusionnée, réintègre main.', 'Une fois #259 fusionnée, c’est ton tour.', 'Après la fusion de #266, réintègre main.',
    'Réintègre main et pousse une seule fois.', 'Le conflit émerge dans server/core.mjs.',
    'Do not merge before approval.', 'Never force push.', 'I will merge after the checks pass.', '#266 was merged already.',
  ]) assert.equal(refusedOrder(said), null, said);
});


test('adopt-lane writes down the terminal of a lane only when Orca shows it in that worktree', () => {
  const box = sandbox();
  const worktree = join(box.home, 'lanes', 'old-lane');
  box.git('worktree', 'add', '-q', '-b', 'old-lane', worktree, 'main');
  const terminals = (answer) => writeFileSync(join(box.home, 'terminals.json'), JSON.stringify(answer));
  terminals({ result: { terminals: [{ handle: 'term_9', connected: true, worktreePath: worktree }, { handle: 'term_7', connected: true, worktreePath: '/elsewhere/old-lane' }] } });
  const adopt = (lane, handle, extra = {}) => spawnSync(join(box.home, 'adopt-lane.sh'), [lane, handle], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  assert.equal(adopt('old-lane', 'term_8').status, 1);
  assert.equal(adopt('another', 'term_9').status, 1);
  // A folder of the same name somewhere else is not the worktree of that lane.
  assert.match(adopt('old-lane', 'term_7').stderr, /not in the worktree/);
  // Orca that does not answer, or answers without a list, is said: no silent stop.
  const down = adopt('old-lane', 'term_9', { FAKE_ORCA_DOWN: '1' });
  assert.equal(down.status, 1);
  assert.match(down.stderr, /Orca did not answer/);
  terminals({ ok: false });
  const noList = adopt('old-lane', 'term_9');
  assert.equal(noList.status, 1);
  assert.match(noList.stderr, /no list of terminals/);
  assert.throws(() => readFileSync(join(box.state, 'lanes.json')));
  terminals({ result: { terminals: [{ handle: 'term_9', connected: true, worktreePath: worktree }] } });
  assert.equal(adopt('old-lane', 'term_9').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(box.state, 'lanes.json'), 'utf8')), { 'old-lane': 'term_9' });
});


test('host-state sees a screen test from the command that runs it, before any browser, and not from whoever only names one', async () => {
  const { screenProcesses } = await import('../lib/screens.mjs');
  const named = [
    ['claude', 'Lance npm run test:ui puis playwright, et lis scripts/run-ui-tests.mjs'],
    ['bash', '-c', 'pgrep -f "playwright|test:ui|capture-all|run-ui-tests"'],
    ['node', 'scripts/with-test-postgres.mjs', '--', 'node', '--test', 'test/orchestration.test.mjs'],
    ['vim', 'scripts/run-ui-tests.mjs'],
    // Installing the browsers is not a screen test.
    ['npx', 'playwright', 'install', 'chromium'],
  ];
  const running = [
    ['npm run test:ui'],
    ['node', 'scripts/with-test-postgres.mjs', '--', 'npm', 'run', 'test:ui:run'],
    ['node', '/somewhere/sample-app/scripts/run-ui-tests.mjs'],
    ['node', 'scripts/capture-all.mjs'],
    ['node', 'scripts/ui-shots.mjs', 'http://127.0.0.1:4173'],
    ['node', '/somewhere/node_modules/.bin/playwright', 'test'],
    ['npx', 'playwright', 'test', '--project=chromium'],
    ['/home/someone/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell', '--headless'],
    ['/opt/old/headless_shell', '--no-sandbox'],
  ];
  assert.equal(screenProcesses(named).length, 0);
  for (const argv of running) assert.equal(screenProcesses([argv]).length, 1, argv.join(' '));

  // The script itself, on a process table written by the test.
  const box = sandbox();
  const proc = join(box.home, 'proc');
  const process_ = (pid, argv) => { mkdirSync(join(proc, String(pid)), { recursive: true }); writeFileSync(join(proc, String(pid), 'cmdline'), `${argv.join('\0')}\0`); };
  mkdirSync(join(proc, 'self'), { recursive: true });
  named.forEach((argv, index) => process_(100 + index, argv));
  const state = () => {
    const run = spawnSync(join(box.home, 'host-state.sh'), [], { env: { ...box.env, ORCH_PROC_DIR: proc }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  const quiet = state();
  assert.equal(quiet.screen_tests_or_captures_running, 0);
  assert.equal(quiet.free_for_a_merge, true);
  // npm names its own process in one piece: no browser yet, and the host is already not free for a merge.
  writeFileSync(join(proc, '200'), ''); // a file that is not a process is passed over
  mkdirSync(join(proc, '201'));
  writeFileSync(join(proc, '201', 'cmdline'), 'npm run test:ui\0\0\0');
  const busy = state();
  assert.equal(busy.screen_tests_or_captures_running, 1);
  assert.equal(busy.free_for_a_merge, false);
});


test('the acting lead cannot write down a terminal itself, and a comment made of blanks is not posted', () => {
  const deny = conf.sections['permissions.release-live'].deny.split(',').map((item) => item.trim());
  assert.ok(deny.includes('{orch}/adopt-lane.sh'));
  const dir = scratch('orch-tracker-');
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ntouch "${join(dir, 'called')}"\necho '{}'\n`, { mode: 0o755 });
  const repoRoot = fixtureProject();
  const run = spawnSync(join(ORCH_HOME, 'tracker.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: '  \n \n', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 1);
  assert.throws(() => readFileSync(join(dir, 'called')));
});


test('a comment read on stdin is posted, signed by the one who runs', () => {
  const dir = scratch('orch-tracker-');
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat >> "${join(dir, 'asked')}"\necho '{"data":{"issue":{"id":"i"},"commentCreate":{"success":true,"comment":{"id":"c","url":"u"}}}}'\n`, { mode: 0o755 });
  const repoRoot = fixtureProject();
  const run = spawnSync(join(ORCH_HOME, 'tracker.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: 'Une question pour toi.', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state'), ORCH_SIGNED: 'chef de projet' } });
  assert.equal(run.status, 0, run.stderr);
  const asked = readFileSync(join(dir, 'asked'), 'utf8');
  // The tool carries no name of its own: with no [tracker] owner_name he is « l'utilisateur »; a project names him as it likes.
  assert.match(asked, /Written by an agent \(chef de projet\), not by the user\.\\n/);
  assert.match(asked, /Une question pour toi\./);
  const named = join(dir, 'named.conf');
  writeFileSync(named, readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8').replace(/^name =$/m, 'name = Ada'));
  rmSync(join(dir, 'asked'));
  assert.equal(spawnSync(join(ORCH_HOME, 'tracker.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: 'Une autre.', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state'), ORCH_SIGNED: 'chef de projet', ORCH_CONF: named } }).status, 0);
  assert.match(readFileSync(join(dir, 'asked'), 'utf8'), /Written by an agent \(chef de projet\), not by Ada\.\\n/);
  assert.equal(spawnSync(join(ORCH_HOME, 'tracker.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: '', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') } }).status, 1);
});


test('the user is not written more than a few times an hour by all the agents together: beyond, the comment is refused and is to be grouped', () => {
  const dir = scratch('orch-tracker-');
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat >> "${join(dir, 'asked')}"\necho '{"data":{"issue":{"id":"i"},"commentCreate":{"success":true,"comment":{"id":"c","url":"u"}}}}'\n`, { mode: 0o755 });
  const repoRoot = fixtureProject();
  const limit = Number(conf.sections.tracker.comments_per_hour);
  assert.equal(limit, 6);
  const post = (from) => spawnSync(join(ORCH_HOME, 'tracker.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: 'Un mot.', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state'), ORCH_SIGNED: from } });
  const entry = (minutesAgo, from) => JSON.stringify({ id: `c${minutesAgo}`, ticket: 'X-2', from, at: new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d+Z$/, 'Z') });
  mkdirSync(join(dir, 'state'));
  // Five in the last hour, by several agents, and older ones that no longer count: one more goes.
  writeFileSync(join(dir, 'state', 'tracker-comments.jsonl'), `${[entry(200, 'a'), entry(61, 'a'), entry(50, 'chef de projet'), entry(40, 'a'), entry(30, 'review'), entry(20, 'chef de projet'), entry(10, 'a')].join('\n')}\nnot json\n`);
  assert.equal(post('chef de projet').status, 0);
  // That made six: the next one is refused, whoever writes it, and nothing is sent.
  const asked = readFileSync(join(dir, 'asked'), 'utf8');
  const refused = post('another agent');
  assert.match(refused.stderr, /already written 6 times in the last hour[\s\S]*[Gg]roup/);
  assert.equal(readFileSync(join(dir, 'asked'), 'utf8'), asked);
  assert.equal(refused.status, 4, 'told apart from a failure: the caller keeps the text for a grouped comment');
  // The limit holds without its setting (a typing mistake must not switch the rule of the user off).
  const noKey = join(dir, 'agents.conf');
  writeFileSync(noKey, readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8').replace(/^comments_per_hour = .*$/m, 'coments_per_hour = 6'));
  assert.equal(spawnSync(join(ORCH_HOME, 'tracker.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: 'Un mot.', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state'), ORCH_CONF: noKey } }).status, 4);
  // Nor without a number in it.
  const notANumber = join(dir, 'agents-six.conf');
  writeFileSync(notANumber, readFileSync(join(ORCH_HOME, 'agents.example.conf'), 'utf8').replace(/^comments_per_hour = .*$/m, 'comments_per_hour = six'));
  assert.equal(spawnSync(join(ORCH_HOME, 'tracker.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: 'Un mot.', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state'), ORCH_CONF: notANumber } }).status, 4);
  // What the user confirms himself is his own word, not one more message of an agent: it is never held back.
  const pending = join(dir, 'state', 'decisions', 'pending', 'd1');
  mkdirSync(pending, { recursive: true });
  writeFileSync(join(pending, 'text.md'), 'Ma décision.\n');
  writeFileSync(join(pending, 'decision.json'), JSON.stringify({ ticket: 'X-1', adr: false, run: '', at: '2026-01-02T10:00:00Z' }));
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') };
  const own = spawnSync(join(ORCH_HOME, 'confirm-decision.sh'), [], { encoding: 'utf8', env });
  assert.equal(own.status, 0, own.stderr);
  assert.match(readFileSync(join(dir, 'asked'), 'utf8'), /Ma décision\./);
  // Only that script: a command that merely names it, or another script of that name, is an agent like the others.
  const before = readFileSync(join(dir, 'asked'), 'utf8');
  const impostor = join(dir, 'confirm-decision.sh');
  writeFileSync(impostor, `#!/usr/bin/env bash\n"${join(ORCH_HOME, 'tracker.sh')}" comment X-1 - "an agent" <<< "Un mot de plus."\n`, { mode: 0o755 });
  assert.equal(spawnSync(impostor, [], { encoding: 'utf8', env }).status, 4);
  assert.equal(spawnSync('bash', ['-c', `"${join(ORCH_HOME, 'tracker.sh')}" comment X-1 - "an agent" <<< "Je cite ${join(ORCH_HOME, 'confirm-decision.sh')}."`], { encoding: 'utf8', env }).status, 4);
  assert.equal(readFileSync(join(dir, 'asked'), 'utf8'), before);
});


test('the report of a lane that the hourly limit holds back is kept, and leaves later in one grouped comment', () => {
  const box = sandbox();
  const lane = runLane(box, 0, { FAKE_TRACKER_FULL: '1', ORCH_COMMENT_TEST: 'X-1' });
  assert.equal(lane.status, 0);
  const outbox = readdirSync(join(box.state, 'tracker-outbox'));
  assert.equal(outbox.length, 1);
  assert.match(outbox[0], /^X-1--/);
  // A second one waits too; the next wake that may write groups them in one comment on the ticket of the reports.
  writeFileSync(join(box.state, 'tracker-outbox', 'X-2--other.md'), 'Compte rendu de X-2.\n');
  writeFileSync(join(box.state, 'tracker-outbox', 'notes.txt'), 'not a report\n');
  const flush = (extra = {}) => spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; flush_outbox`], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  // A wake killed while it was sending left some aside: they are taken back, not forgotten.
  mkdirSync(join(box.state, 'tracker-outbox', 'sending.killed'));
  writeFileSync(join(box.state, 'tracker-outbox', 'sending.killed', 'X-3--left.md'), 'Compte rendu de X-3.\n');
  assert.equal(flush({ FAKE_TRACKER_FULL: '1' }).status, 0);
  execFileSync('mv', [join(box.state, 'tracker-outbox', 'X-3--left.md'), join(box.home, 'taken-back.md')]);
  assert.deepEqual(readdirSync(join(box.state, 'tracker-outbox')).sort(), [outbox[0], 'X-2--other.md', 'notes.txt'].sort(), 'still held: nothing is lost');
  assert.equal(flush().status, 0);
  const posted = readFileSync(join(box.home, 'tracker-posted'), 'utf8');
  assert.match(posted, /^X-100 from=/);
  assert.match(posted, /2 grouped reports[\s\S]*### X-1[\s\S]*answer of first[\s\S]*### X-2[\s\S]*Compte rendu de X-2\./);
  assert.deepEqual(readdirSync(join(box.state, 'tracker-outbox')), ['notes.txt'], 'only what was sent is removed');
});


test('the discussion has no right to act: its permissions name what it may read and the one script it proposes with, and refuse the rest', () => {
  const talk = conf.sections['permissions.talk'];
  const list = (text) => text.split(',').map((item) => item.trim());
  assert.equal(conf.sections.talk.role, 'talk');
  assert.ok(conf.models[conf.roles.talk], 'the model of the discussion comes from the table');
  assert.equal(talk.mode, 'read-only');
  assert.deepEqual(list(talk.allow), [
    '{orch}/decide.sh', '{orch}/tracker.sh issue', '{orch}/tracker.sh comments', '{orch}/tracker.sh list',
    '{orch}/tracker.sh waiting', '{orch}/host-state.sh', '{orch}/tell-lane.sh --list',
    'git status', 'git log', 'git show', 'git ls-files',
  ]);
  for (const refused of ['{orch}/confirm-decision.sh', '{orch}/tracker.sh comment', '{orch}/tracker.sh create', '{orch}/spawn-lane.sh', '{orch}/kill-lane.sh', '{orch}/push-lane.sh', '{orch}/adopt-lane.sh', 'gh', 'orca', 'git push', 'git commit']) assert.ok(list(talk.deny).includes(refused), refused);
  assert.ok(conf.sections.lanes.push_roles.split(/\s+/).includes('talk'), 'the file of the decisions leaves by the narrow push script');
  // Confirming a decision is the user's: no role may run it, whatever else it may do.
  for (const [name, section] of Object.entries(conf.sections).filter(([key]) => key.startsWith('permissions.'))) {
    assert.ok(list(section.deny).includes('{orch}/confirm-decision.sh'), name);
    assert.ok(!list(section.allow ?? '').some((item) => item.includes('confirm-decision')), name);
  }
  // A read command of git must not become a way to write a file, or to read one outside the repository.
  for (const role of ['talk', 'release-live', 'review']) {
    for (const option of ['*--output*', '*--no-index*']) assert.ok(list(conf.sections[`permissions.${role}`].deny).includes(option), `${role} ${option}`);
  }
});


test('the Claude adapter holds a conversation where nothing is asked for: reading stays in the folders it is given, one file may be edited, the rest is refused', () => {
  const dir = scratch('orch-claude-talk-');
  writeFileSync(join(dir, 'claude'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, 'args')}"\necho "key=\${ANTHROPIC_API_KEY:-none}" > "${join(dir, 'env')}"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'prompt.md'), 'the briefing');
  const call = (extra) => {
    const run = spawnSync(join(ORCH_HOME, 'adapters', 'claude.sh'), ['talk', '--model', 'm', '--prompt-file', join(dir, 'prompt.md'), '--session-id', 's-1'], {
      cwd: dir, encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ANTHROPIC_API_KEY: 'not-for-a-subscription', ORCH_PERMISSION_MODE: 'read-only', ORCH_ALLOW: 'ops/cleared/decide.sh, git log', ORCH_DENY: '*--output*, gh, git push', ADAPTER_CONNECTORS: 'none', ...extra },
    });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(dir, 'args'), 'utf8').trim().split('\n');
  };
  const args = call({ ORCH_EDIT_ONLY: '/somewhere/talk-X-100/docs/decisions.md', ORCH_READ_DIRS: '/somewhere/release-lead:/somewhere/talk-X-100' });
  assert.ok(!args.includes('-p'), 'a conversation, not a run without a screen');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allowed, ['Read(//somewhere/release-lead/**)', 'Read(//somewhere/talk-X-100/**)', 'Bash(ops/cleared/decide.sh)', 'Bash(ops/cleared/decide.sh *)', 'Bash(git log)', 'Bash(git log *)', 'Edit(//somewhere/talk-X-100/docs/decisions.md)']);
  // The search tools read anywhere once allowed: they are not offered. Files of secrets are refused wherever they are.
  for (const tool of ['Read', 'Grep', 'Glob']) assert.ok(!allowed.includes(tool), tool);
  for (const denied of ['Write', 'NotebookEdit', 'Read(//**/.env*)', 'Bash(*--output*)', 'Bash(gh)', 'Bash(git push *)']) assert.ok(args.includes(denied), denied);
  assert.equal(args[args.indexOf('--add-dir') + 1], '/somewhere/talk-X-100');
  assert.equal(args[args.indexOf('--session-id') + 1], 's-1');
  assert.equal(args.at(-1), 'the briefing');
  assert.equal(readFileSync(join(dir, 'env'), 'utf8').trim(), 'key=none', 'the conversation is on the subscription, never on an API key');
  // No file named: no edit at all; no folder named: the current one.
  const none = call({});
  assert.ok(none.slice(none.indexOf('--disallowedTools')).includes('Edit'));
  assert.ok(!none.some((arg) => arg.startsWith('Edit(')));
  assert.ok(none.includes(`Read(/${dir}/**)`));
  // The other backend has no conversation to offer: the next model of the chain takes it.
  assert.equal(spawnSync(join(ORCH_HOME, 'adapters', 'codex.sh'), ['talk', '--model', 'm', '--prompt-file', join(dir, 'prompt.md')], { encoding: 'utf8', env: { ...process.env, ADAPTER_RUNNER: 'container' } }).status, 2);
});


test('talk.sh opens one conversation in the lane of the lead, briefed by scripts; talk-run.sh holds it with the permissions of the discussion and writes it to the ledger as a discussion', () => {
  const box = sandbox();
  // Its prompt is not there: nothing starts, least of all a discussion with no instruction.
  execFileSync('mv', [join(box.home, 'prompts', 'talk.md'), join(box.home, 'prompts', 'talk.kept')]);
  const blind = spawnSync(join(box.home, 'talk.sh'), ['--dry-run'], { env: box.env, encoding: 'utf8' });
  assert.notEqual(blind.status, 0);
  assert.match(blind.stderr, /no prompt to read/);
  execFileSync('mv', [join(box.home, 'prompts', 'talk.kept'), join(box.home, 'prompts', 'talk.md')]);
  const brief = spawnSync(join(box.home, 'talk.sh'), ['--dry-run'], { env: box.env, encoding: 'utf8' });
  assert.equal(brief.status, 0, brief.stderr);
  assert.match(brief.stdout, /talk prompt, decisions in .*\/lanes\/talk-X-100\/docs\/decisions\.md, default ticket X-100/);
  assert.match(brief.stdout, /X-7 \(Un écran à valider\)/);
  assert.match(brief.stdout, /Un commentaire du ticket de suivi\./);
  assert.throws(() => readFileSync(join(box.home, 'orca-calls')), 'a dry run opens nothing');

  const opened = spawnSync(join(box.home, 'talk.sh'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')), 1);
  const runDir = opened.stdout.trim().split('\n').at(-1);
  const worktrees = execFileSync('git', ['-C', box.repo, 'worktree', 'list'], { encoding: 'utf8' });
  assert.match(worktrees, /\[release\/lead\]/);
  assert.match(worktrees, /\[talk\/X-100\]/);
  // A wake of the lead that ends does not close the terminal of a conversation: it is not one of its sessions.
  assert.throws(() => readFileSync(join(runDir, 'lane.env')));

  // The conversation itself (the terminal of the test runs nothing: it is run here).
  const lead = join(box.home, 'lanes', 'release-lead');
  const held = spawnSync(join(box.home, 'talk-run.sh'), [runDir], { cwd: lead, env: { ...box.env, FIRST_CANNOT_TALK: '1', ORCH_TTY: '/dev/null' }, encoding: 'utf8' });
  assert.equal(held.status, 0, held.stderr);
  const said = readFileSync(join(box.state, 'talked'), 'utf8').trim().split('\n');
  assert.equal(said[0], 'second', 'a backend that cannot talk hands over to the next of the chain');
  const decisions = join(box.home, 'lanes', 'talk-X-100');
  assert.ok(said.includes(`edit=${join(decisions, 'docs', 'decisions.md')}`));
  assert.ok(said.includes(`read=${lead}:${decisions}`));
  assert.ok(said.includes('mode=read-only') && said.includes('allow=only-for-the-talk'));
  // The session has no log here: its tokens are unknown in the ledger, not zero.
  assert.match(held.stdout, /token count remains unknown/);
  const db = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual({ ...db.prepare("select role, lane, source, model, outcome, tokens_total from runs where outcome = 'done'").get() }, { role: 'talk', lane: 'release/lead', source: 'discussion', model: 'm2', outcome: 'done', tokens_total: null });
  assert.deepEqual(db.prepare('select model, outcome from runs order by rowid').all().map((r) => ({ ...r })), [{ model: 'm1', outcome: 'refused' }, { model: 'm2', outcome: 'done' }]);
  db.close();
  // The conversation is over: its mark is gone.
  assert.throws(() => readFileSync(join(box.state, 'wake', 'talk')));
});


test('never two agents in the lane of the lead: an open discussion holds its short sessions back without losing what moves, and no discussion opens while one is at work', (t) => {
  const box = sandbox();
  const wake = () => spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  const calls = () => { try { return Number(readFileSync(join(box.home, 'orca-calls'), 'utf8')); } catch { return 0; } };
  const issue = (comments) => [{ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments }];
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([])));
  assert.equal(wake().status, 0);
  // A discussion is open: the mark holds the process of a conversation that lives.
  const conversation = spawn('bash', ['-c', 'exec -a talk-run.sh sleep 60'], { stdio: 'ignore' });
  t.after(() => conversation.kill());
  writeFileSync(join(box.state, 'wake', 'talk'), `${conversation.pid}\n`);
  writeFileSync(join(box.home, 'tracker-now.json'), JSON.stringify(issue([{ id: 'c1', createdAt: new Date().toISOString(), url: 'u#c1', body: 'OK, vas-y.' }])));
  assert.equal(wake().status, 0);
  assert.equal(calls(), 0, 'no session while the user talks with the lead');
  assert.match(spawnSync(join(box.home, 'talk.sh'), [], { env: box.env, encoding: 'utf8' }).stderr, /already open/);
  // So does a discussion that is being opened, for the time a terminal takes to open, and no longer.
  writeFileSync(join(box.state, 'wake', 'talk'), `opening ${Math.floor(Date.now() / 1000)}\n`);
  assert.equal(wake().status, 0);
  assert.equal(calls(), 0);
  // The mark of a conversation that died without saying so holds nothing back, even when its number now belongs to
  // another process (this one).
  writeFileSync(join(box.state, 'wake', 'talk'), `${process.pid}\n`);
  assert.equal(spawnSync('bash', ['-c', `. "${join(box.home, 'lib', 'common.sh')}"; talk_open`], { env: box.env }).status, 1);
  // Nor does an opening that never became a conversation; what moved meanwhile is handed out.
  writeFileSync(join(box.state, 'wake', 'talk'), `opening ${Math.floor(Date.now() / 1000) - 600}\n`);
  const started = wake();
  assert.equal(calls(), 1);
  assert.match(readFileSync(join(started.stdout.trim(), 'prompt.md'), 'utf8'), /OK, vas-y/);
  // That session is at work: no discussion opens in its folder.
  const refused = spawnSync(join(box.home, 'talk.sh'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /short session of the project lead is at work/);
  assert.equal(calls(), 1);
});


test('a decision is proposed by the discussion and leaves only when the user confirms it: tracker, the ledger with the source discussion, and docs/decisions.md by a draft pull request', () => {
  const lane = laneWithRemote('talk/X-100', null);
  const { box } = lane;
  const env = { ...box.env, ORCH_RUN_ID: 'talk-1-talk-a1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost' };
  const decide = (args, input) => spawnSync(join(box.home, 'decide.sh'), args, { env, encoding: 'utf8', input });
  const confirm = (args = [], extra = {}) => spawnSync(join(box.home, 'confirm-decision.sh'), args, { env: { ...env, ...extra }, encoding: 'utf8' });
  const decisions = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare("select kind, source, ticket, run_id, detail from events where kind = 'decision'").all().map((row) => ({ ...row })); db.close(); return rows; };
  const posted = () => { try { return readFileSync(join(box.home, 'tracker-posted'), 'utf8'); } catch { return null; } };
  const waiting = () => { try { return readdirSync(join(box.state, 'decisions', 'pending')); } catch { return []; } };

  // Refusals: no ticket, nothing to say, a file instead of what the session was told (a file could be anything on the disk).
  assert.equal(decide(['not-a-ticket', '-'], 'x').status, 1);
  assert.equal(decide(['X-5', '-'], ' \n').status, 1);
  assert.match(decide(['X-5', join(box.home, 'agents.conf')], '').stderr, /never a file/);
  assert.deepEqual(waiting(), []);

  // Proposed: kept, and nothing has left.
  const proposed = decide(['X-5', '-'], 'On garde le bouton\nsous la liste.');
  assert.equal(proposed.status, 0, proposed.stderr);
  assert.match(proposed.stdout, /nothing has been sent yet[\s\S]*! \S+\/confirm-decision\.sh/);
  assert.equal(waiting().length, 1);
  assert.equal(posted(), null);
  assert.deepEqual(decisions(), []);
  // tracker does not answer: the decision still waits, and a second try takes it.
  assert.match(confirm([], { FAKE_TRACKER_DOWN: '1' }).stderr, /still waits/);
  assert.deepEqual(decisions(), []);
  const done = confirm();
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Recorded: https:\/\/example\.test\/comment/);
  assert.match(posted(), /^X-5 from=chef de projet, en discussion\n\*\*Decision by the user, recorded during a discussion with the project lead and confirmed by the user\*\*[\s\S]*On garde le bouton\nsous la liste\./);
  assert.deepEqual(decisions(), [{ kind: 'decision', source: 'discussion', ticket: 'X-5', run_id: 'talk-1-talk-a1', detail: 'On garde le bouton sous la liste.' }]);
  assert.deepEqual(waiting(), []);
  // A decision the user drops never leaves.
  decide(['X-6', '-'], 'Finalement non.');
  assert.equal(confirm(['--drop', waiting()[0]]).status, 0);
  assert.equal(decisions().length, 1);
  assert.doesNotMatch(posted(), /Finalement non/);

  // --adr: only with a change to the file of the decisions, and to nothing else, in the worktree of the decisions.
  assert.match(decide(['X-5', '-', '--adr'], 'Une règle.').stderr, /needs a change to docs\/decisions\.md/);
  mkdirSync(join(lane.path, 'docs'), { recursive: true });
  writeFileSync(join(lane.path, 'docs', 'decisions.md'), 'first\n');
  execFileSync('git', ['-C', lane.path, 'add', '.']);
  execFileSync('git', ['-C', lane.path, '-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'docs: the file of the decisions']);
  execFileSync('git', ['-C', lane.path, 'push', '-q', 'origin', 'HEAD:main']);
  execFileSync('git', ['-C', box.repo, 'merge', '-q', '--ff-only', 'talk/X-100']);
  writeFileSync(join(lane.path, 'docs', 'decisions.md'), 'first\nUne règle qui dure.\n');
  writeFileSync(join(lane.path, 'other.md'), 'not for a discussion\n');
  assert.match(decide(['X-5', '-', '--adr'], 'Une règle.').stderr, /and to nothing else/);
  execFileSync('rm', [join(lane.path, 'other.md')]);
  assert.equal(decide(['X-5', '-', '--adr'], 'Une règle qui dure.').status, 0);
  assert.equal(execFileSync('git', ['-C', lane.path, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), 'M docs/decisions.md', 'proposing commits nothing');
  // One at a time: a second one is not prepared while the first waits.
  assert.match(decide(['X-6', '-'], 'Une autre.').stderr, /already waits for the user/);
  // The file is touched again after the proposal: what would leave is not what the user was shown. Nothing leaves.
  writeFileSync(join(lane.path, 'docs', 'decisions.md'), 'first\nUne règle qui dure.\nEt une ligne glissée après coup.\n');
  const touched = confirm();
  assert.equal(touched.status, 1);
  assert.match(touched.stderr, /changed since this decision was proposed/);
  assert.equal(execFileSync('git', ['-C', lane.path, 'log', '--format=%s', 'main..HEAD'], { encoding: 'utf8' }), '');
  assert.equal(confirm(['--drop', waiting()[0]]).status, 0);
  writeFileSync(join(lane.path, 'docs', 'decisions.md'), 'first\nUne règle qui dure.\n');
  assert.equal(decide(['X-5', '-', '--adr'], 'Une règle qui dure.').status, 0);
  // The push fails once (GitHub does not open the pull request): nothing is said to be decided, and the next try sends the commit already made.
  // The first run shows the whole change, removed lines included, and sends nothing; the second one sends.
  const shown = confirm([], { FAKE_GH_DOWN: '1' });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Changes to docs\/decisions\.md[\s\S]*\+Une règle qui dure\.[\s\S]*Nothing was sent/);
  assert.equal(execFileSync('git', ['-C', lane.path, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), 'M docs/decisions.md');
  const failed = confirm([], { FAKE_GH_DOWN: '1' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /nothing is transcribed yet/);
  assert.equal(decisions().length, 1);
  assert.doesNotMatch(posted(), /Une règle qui dure/);
  const adr = confirm();
  assert.equal(adr.status, 0, adr.stderr);
  assert.equal(decisions().length, 2);
  assert.match(posted(), /Une règle qui dure\.[\s\S]*Also recorded in `docs\/decisions\.md`/);
  assert.ok(lane.onRemote().some((ref) => ref.startsWith('talk/X-100 ')), 'the branch of the decisions left, to its namesake');
  assert.ok(lane.created().includes('--draft'));
  assert.equal(execFileSync('git', ['-C', lane.path, 'status', '--porcelain'], { encoding: 'utf8' }), '');
});


test('the decisions of a second discussion are written on top of the base as it is now, and a branch that holds decisions is never started over', () => {
  const lane = laneWithRemote('talk/X-100', 'docs: a decision of an earlier discussion');
  const { box } = lane;
  const head = () => execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const earlier = head();
  // The base moved on meanwhile.
  box.git('commit', '-q', '--allow-empty', '-m', 'chore: the base moves');
  const moved = execFileSync('git', ['-C', box.repo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const open = (extra = {}) => spawnSync(join(box.home, 'talk.sh'), [], { env: { ...box.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@localhost', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@localhost', ...extra }, encoding: 'utf8' });
  assert.equal(open().status, 0);
  const ancestors = execFileSync('git', ['-C', lane.path, 'rev-list', 'HEAD'], { encoding: 'utf8' });
  assert.ok(ancestors.includes(earlier), 'the earlier decision is still there');
  assert.ok(ancestors.includes(moved), 'the base was brought in');
  // That conversation ends (the terminal of the test ran nothing: its mark is taken away here). A second one is refused while the first is open.
  assert.match(open().stderr, /already open/);
  execFileSync('rm', [join(box.state, 'wake', 'talk')]);
  // Its folder disappears: the branch is taken back as it is.
  box.git('worktree', 'remove', '--force', lane.path);
  const kept = execFileSync('git', ['-C', box.repo, 'rev-parse', 'talk/X-100'], { encoding: 'utf8' }).trim();
  assert.equal(open().status, 0);
  assert.equal(head(), kept);
});


test('the import of the past takes back out the sessions of a worktree the dispatcher opened, and only those', () => {
  const box = sandbox();
  const home = scratch('orch-user-');
  const prefix = join(box.home, 'lanes').replace(/[^A-Za-z0-9]/g, '-');
  const session = (worktree, id) => {
    const dir = join(home, '.claude', 'projects', `${prefix}-${worktree}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello' } })}\n`);
  };
  session('release-lead', 'aaaaaaaa-1111');
  session('old-lane', 'bbbbbbbb-2222');
  const db = openLedger(join(box.state, 'ledger.db'));
  const row = (id, source) => db.prepare('INSERT INTO runs (run_id, role, started_at, source) VALUES (?, ?, ?, ?)').run(id, 'dev', '2020-01-01T00:00:00Z', source);
  row('legacy:aaaaaaaa:2020-01-01T00:00:00Z', 'legacy');
  row('legacy:bbbbbbbb:2020-01-01T00:00:00Z', 'legacy');
  row('lead-1-release-a1', 'dispatcher');
  db.close();
  const run = spawnSync('node', ['--no-warnings', join(ORCH_HOME, 'lib/tracker/adapters/import-legacy.mjs'), '--no-linear', '--days', '1'], { env: { ...box.env, HOME: home }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).removed, 1);
  const after = openLedger(join(box.state, 'ledger.db'));
  assert.deepEqual(after.prepare('select run_id from runs order by run_id').all().map((r) => r.run_id), ['lead-1-release-a1', 'legacy:bbbbbbbb:2020-01-01T00:00:00Z']);
  after.close();
});


test('the tokens of a conversation are counted from its own session log, each message once', async () => {
  const { sessionUsage } = await import('../lib/session-usage.mjs');
  const message = (id, usage, model = 'm-big') => JSON.stringify({ type: 'assistant', message: { id, model, usage } });
  const usage = sessionUsage([
    message('a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
    message('a', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
    message('b', { input_tokens: 1, output_tokens: 2 }),
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    'not json',
    message('c', { input_tokens: 999 }, '<synthetic>'),
  ], 'asked');
  assert.deepEqual(usage, { model: 'm-big', tokens_in: 11, tokens_out: 7, tokens_cache: 100, tokens_cache_write: 20, tokens_total: 138, cost_usd: null });
  assert.equal(sessionUsage([], 'asked').tokens_total, 0);
});


test('the sessions of a worktree the dispatcher opened are not the old way of working: the import of the past leaves them out', async () => {
  const { dispatcherWorktree } = await import('../lib/lanes.mjs');
  const roles = Object.keys(conf.roles);
  for (const name of ['release-lead', 'dev-EX-105', 'review-EX-112', 'talk-EX-112']) assert.equal(dispatcherWorktree(name, roles), true, name);
  for (const name of ['orrchestrator', 'app-rapide', 'release-notes', 'dev-something', 'fiche-enveloppe-projet']) assert.equal(dispatcherWorktree(name, roles), false, name);
});


test('a check the runner broke is started again once by rule, with no session of a model: only when every step that failed is one the project names, never twice for a version, and never when no step is named', () => {
  const { flow, todo, by, record, session, pull, box } = flowBox();
  const confPath = join(box.home, 'agents.conf');
  const conf = readFileSync(confPath, 'utf8').replace('runs_per_day = 4', 'runs_per_day = 30');
  writeFileSync(confPath, conf);
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const done = session('X-5');
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  const jobs = (...steps) => writeFileSync(join(box.home, 'run-jobs.json'), JSON.stringify({ jobs: [{ name: 'verify (2/2)', conclusion: 'failure', steps: [{ name: 'Checkout', conclusion: 'success' }, ...steps.map((name) => ({ name, conclusion: 'failure' }))] }, { name: 'verify (1/2)', conclusion: 'success', steps: [{ name: 'Unit tests', conclusion: 'success' }] }] }));
  const again = () => { try { return readFileSync(join(box.home, 'run-rerun'), 'utf8').trim().split('\n'); } catch { return []; } };
  writeFileSync(join(box.home, 'run-log.txt'), 'verify (2/2)\tUNKNOWN STEP\t2026-01-02T10:00:00.0000000Z npm error ETXTBSY\nverify (2/2)\tUNKNOWN STEP\t2026-01-02T10:00:01.0000000Z ##[error]Process completed with exit code 1.\n');
  pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }, { conclusion: 'SUCCESS' }] });
  jobs('Run npm ci');
  // The project names the install as the runner's: the checks are started again, and no session opens.
  writeFileSync(confPath, conf.replace('[lanes]\n', '[lanes]\nrerun_steps = Run npm ci, Set up job\n'));
  const first = flow();
  assert.match(first.stdout, /X-5: #41 is red at [0-9a-f]{8} on a step of the runner \(Run npm ci\): its checks are started again, once/);
  assert.doesNotMatch(first.stdout, /opened again/);
  assert.deepEqual(again(), ['77 --failed']);
  assert.equal(record('X-5').runs.length, 1);
  // The forge still shows the red of the first attempt for a while: nothing is read of it, the lane is not opened on it.
  assert.equal(flow().stdout.trim(), '');
  assert.equal(record('X-5').runs.length, 1);
  // Red again at the same version once that while has passed: not a second time, the lane reads it.
  { const aged = record('X-5'); for (const key of Object.keys(aged.done)) if (key.startsWith('rerun:')) aged.done[key] = new Date(Date.now() - 6 * 60e3).toISOString(); writeFileSync(join(box.state, 'lanes', 'X-5.json'), JSON.stringify(aged)); }
  assert.match(flow().stdout, /X-5: opened again \(checks:/);
  assert.deepEqual(again(), ['77 --failed']);
  const fixed = session('X-5', { commit: 'fix: something else' });
  assert.match(fixed.prompt, /\| npm error ETXTBSY/);
  // A test that failed beside the install is the lane's: nothing is started again.
  jobs('Run npm ci', 'Unit tests and coverage');
  pull({ headRefOid: fixed.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  assert.match(flow().stdout, /X-5: opened again \(checks:/);
  assert.deepEqual(again(), ['77 --failed']);
  // A job that failed with no step that says why (a runner lost) is not known to be the runner's install: nothing is started again.
  const third = session('X-5', { commit: 'fix: a third thing' });
  writeFileSync(join(box.home, 'run-jobs.json'), JSON.stringify({ jobs: [{ name: 'verify (2/2)', conclusion: 'failure', steps: [{ name: 'Run npm ci', conclusion: 'failure' }] }, { name: 'verify (1/2)', conclusion: 'failure', steps: [{ name: 'Unit tests', conclusion: 'cancelled' }] }] }));
  pull({ headRefOid: third.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  assert.match(flow().stdout, /X-5: opened again \(checks:/);
  assert.deepEqual(again(), ['77 --failed']);
});


test('a check the runner broke that the forge refuses to start again is read by the lane at once, and with no step named nothing is ever started again', () => {
  const { flow, todo, by, record, session, pull, box } = flowBox();
  const confPath = join(box.home, 'agents.conf');
  const conf = readFileSync(confPath, 'utf8').replace('runs_per_day = 4', 'runs_per_day = 30');
  writeFileSync(confPath, conf);
  todo(['X-5']);
  by('X-5', 0);
  flow();
  const done = session('X-5');
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  writeFileSync(join(box.home, 'run-jobs.json'), JSON.stringify({ jobs: [{ name: 'verify', conclusion: 'failure', steps: [{ name: 'Run npm ci', conclusion: 'failure' }] }] }));
  writeFileSync(join(box.home, 'run-log.txt'), 'verify\tUNKNOWN STEP\t2026-01-02T10:00:00.0000000Z npm error ETXTBSY\n');
  pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  // No step named: never, as before.
  assert.match(flow().stdout, /X-5: opened again \(checks:/);
  assert.throws(() => readFileSync(join(box.home, 'run-rerun')));
  const next = session('X-5', { commit: 'fix: something' });
  // A step named, and the forge refuses: said, and the lane is opened in the same pass.
  writeFileSync(confPath, conf.replace('[lanes]\n', '[lanes]\nrerun_steps = Run npm ci\n'));
  pull({ headRefOid: next.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  const refused = flow({ FAKE_GH_RERUN_DOWN: '1' });
  assert.match(refused.stdout, /X-5: #41 is red at [0-9a-f]{8} on a step of the runner, and its checks could not be started again: read by the lane/);
  assert.match(refused.stdout, /X-5: opened again \(checks:/);
  assert.equal(record('X-5').runs.length, 3);
});


test('a lane is not opened again for ever for one reason: three times in a day for the checks, a reviewer or a session that stops, then it is said; a word of the user is never a loop', () => {
  const { flow, todo, by, record, session, stuck, pull, box } = flowBox();
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8').replace('runs_per_day = 4', 'runs_per_day = 30'));
  todo(['X-5']);
  by('X-5', 0);
  flow();
  let last = session('X-5');
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: false }]));
  const red = () => { pull({ headRefOid: last.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] }); return flow().stdout; };
  // Red three times, each on a new version: opened again three times.
  for (let turn = 1; turn <= 3; turn += 1) {
    assert.match(red(), /X-5: opened again \(checks:/, `turn ${turn}`);
    last = session('X-5', { commit: `fix: attempt ${turn}` });
  }
  assert.equal(record('X-5').runs.length, 4);
  // Red a fourth time: not opened again, and the lead is told which reason, once.
  assert.match(red(), /X-5: opened again 3 times in a day for the same reason \(checks\): left as it is/);
  assert.equal(record('X-5').runs.length, 4);
  assert.deepEqual(stuck(), ['lane_stuck X-5']);
  red();
  assert.deepEqual(stuck(), ['lane_stuck X-5'], 'said once');
  // He writes on the ticket: that is no loop, the lane is opened with his words.
  writeFileSync(join(box.home, 'tracker-comments.json'), JSON.stringify([{ id: 'c9', createdAt: '2099-01-01T10:00:00Z', body: 'Laisse ce test de côté.', byOwner: true }]));
  assert.match(flow().stdout, /X-5: opened again \(said:c9\)/);
  assert.equal(record('X-5').runs.length, 5);
});
