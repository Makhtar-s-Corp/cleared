import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConf, parseConf, ORCH_HOME } from '../lib/conf.mjs';
import { route } from '../lib/route.mjs';
import { openLedger, runStart, runEnd, addEvent, costEur } from '../lib/ledger.mjs';
import { conf, scratch, fixtureProject, sandbox } from './support.mjs';

test('the pre-check of the project lead: what the user and the outside world did is an event, what agents wrote is not', async () => {
  const { changes, checksOf } = await import('../lib/wake.mjs');
  const issue = (over) => ({ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments: [], ...over });
  const comment = (id, body, createdAt = '2026-01-02T10:01:00Z') => ({ id, body, createdAt, url: `u#${id}` });
  const pull = (over) => ({ number: 7, title: 't', headRefName: 'b', isDraft: true, state: 'OPEN', updatedAt: '2026-01-02T10:00:00Z', statusCheckRollup: [], ...over });

  // The very first wake only takes note: nothing that already exists is an event.
  const first = changes(null, [issue({ comments: [comment('c0', 'déjà là')] })], [pull({})], new Set(), '2026-01-02T10:00:00Z');
  assert.deepEqual(first.events, []);
  assert.deepEqual(first.next.pulls, { 7: { state: 'draft', checks: 'none' } });

  const tickets = [
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
  const second = changes(first.next, tickets, [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] }), pull({ number: 8, state: 'MERGED' })], new Set(['c3']), '2026-01-02T10:05:00Z');
  assert.deepEqual(second.events.map((event) => [event.kind, event.ticket ?? event.pr]), [['pr_ready', 7], ['comment', 'X-1'], ['ticket_new', 'X-2']]);
  assert.equal(second.events[1].text, 'OK A');

  // Nothing new: nothing. Then the checks turn red: one event, once.
  const pulls = [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })];
  const third = changes(second.next, tickets, pulls, new Set(['c3']));
  assert.deepEqual(third.events, []);
  const red = [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }] })];
  const fourth = changes(third.next, tickets, red, new Set(['c3']));
  assert.deepEqual(fourth.events.map((event) => [event.kind, event.checks]), [['pr_checks', 'failure']]);
  assert.deepEqual(changes(fourth.next, tickets, red, new Set(['c3'])).events, []);
  // Merged: said once, then forgotten.
  const merged = changes(fourth.next, tickets, [pull({ state: 'MERGED' })], new Set(['c3']));
  assert.deepEqual(merged.events.map((event) => event.kind), ['pr_merged']);
  assert.deepEqual(merged.next.pulls, {});
  assert.equal(checksOf([{ status: 'IN_PROGRESS' }, { conclusion: 'SUCCESS' }]), 'pending');
  assert.equal(checksOf([{ conclusion: 'SKIPPED' }]), 'none');
});


test('the pre-check starts a session only for what is worth one: the rest waits and is handed to the next session, once', async () => {
  const { changes } = await import('../lib/wake.mjs');
  const worth = new Set(['comment', 'pr_checks']);
  const issue = (over) => ({ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Backlog', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments: [], ...over });
  const pull = (over) => ({ number: 7, title: 't', headRefName: 'b', isDraft: true, state: 'OPEN', updatedAt: '2026-01-02T10:01:00Z', statusCheckRollup: [], ...over });
  const first = changes(null, [issue({})], [], new Set(), '2026-01-02T10:00:00Z', [], worth);
  // A draft opened and a ticket created: nobody has anything to decide yet.
  const tickets = [issue({}), issue({ id: 'i2', identifier: 'X-2', createdAt: '2026-01-02T10:02:00Z', description: 'Un ticket de the user' })];
  const quiet = changes(first.next, tickets, [pull({})], new Set(), '2026-01-02T10:05:00Z', [], worth);
  assert.deepEqual(quiet.events, []);
  assert.deepEqual(quiet.next.waiting.map((event) => event.kind), ['pr_opened', 'ticket_new']);
  // Nothing new: what waits keeps waiting, once.
  const still = changes(quiet.next, tickets, [pull({})], new Set(), '2026-01-02T10:06:00Z', [], worth);
  assert.deepEqual(still.events, []);
  assert.equal(still.next.waiting.length, 2);
  // The checks turn green: one session, which is handed what waited too.
  const green = changes(still.next, tickets, [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })], new Set(), '2026-01-02T10:07:00Z', [], worth);
  assert.deepEqual(green.events.map((event) => event.kind), ['pr_opened', 'ticket_new', 'pr_ready']);
  assert.deepEqual(green.next.waiting, [], 'made ready is not worth a session, but it came with green checks');
  const pending = changes(still.next, tickets, [pull({ isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] })], new Set(), '2026-01-02T10:07:00Z', [], worth);
  assert.deepEqual(pending.events, []);
  const done = changes(pending.next, tickets, [pull({ isDraft: false, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })], new Set(), '2026-01-02T10:09:00Z', [], worth);
  assert.deepEqual(done.events.map((event) => event.kind), ['pr_opened', 'ticket_new', 'pr_ready', 'pr_checks']);
  assert.deepEqual(done.next.waiting, []);
  // No list of what is worth a session: everything is, as before.
  assert.deepEqual(changes(first.next, tickets, [pull({})], new Set(), '2026-01-02T10:05:00Z').events.map((event) => event.kind), ['pr_opened', 'ticket_new']);
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


test('wake.sh during an outage of GitHub: the outage in the ledger with its start and its end, and its pull requests read again once it is over', () => {
  const box = sandbox();
  const wake = (extra = {}) => spawnSync(join(box.home, 'wake.sh'), [], { env: { ...box.env, ...extra }, encoding: 'utf8' });
  const events = () => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare('select kind, at, value, detail from events order by rowid').all().filter((row) => !row.kind.startsWith('heartbeat_')).map((row) => ({ ...row })); db.close(); return rows; };
  const status = (actions) => writeFileSync(join(box.home, 'github-status.json'), JSON.stringify({ components: [{ name: 'Git Operations', status: 'operational' }, { name: 'Actions', status: actions }, { name: 'Webhooks', status: 'degraded_performance' }] }));
  const pull = (checks) => [{ number: 7, title: 'Une PR', headRefName: 'b', isDraft: false, state: 'OPEN', updatedAt: new Date().toISOString(), statusCheckRollup: [{ conclusion: checks }] }];
  const seen = () => JSON.parse(readFileSync(join(box.state, 'wake', 'state.json'), 'utf8')).pulls[7]?.checks;
  writeFileSync(join(box.home, 'pulls-now.json'), JSON.stringify(pull('SUCCESS')));
  assert.equal(wake().status, 0);
  assert.equal(seen(), 'success');
  // GitHub goes down and cancels the checks; it does not even answer the list of pull requests.
  status('major_outage');
  writeFileSync(join(box.home, 'pulls-now.json'), JSON.stringify(pull('CANCELLED')));
  const during = wake({ FAKE_GH_LIST_DOWN: '1' });
  assert.equal(during.status, 0, during.stderr);
  const started = readFileSync(join(box.state, 'wake', 'github-down'), 'utf8').split('\n')[0];
  assert.equal(seen(), 'success', 'what its pull requests seem to do is not read while it is down');
  assert.equal(wake({ FAKE_GH_LIST_DOWN: '1' }).status, 0);
  assert.equal(events().filter((event) => event.kind === 'github_down').length, 0, 'written once, when it ends');
  // Its status page cannot be read for a minute: that is not the end of the outage.
  writeFileSync(join(box.home, 'github-status.json'), 'not json');
  assert.equal(wake({ FAKE_GH_LIST_DOWN: '1' }).status, 0);
  assert.equal(events().filter((event) => event.kind === 'github_down').length, 0);
  assert.equal(readFileSync(join(box.state, 'wake', 'github-down'), 'utf8').split('\n')[0], started);
  // A slowdown is not an outage: it is over. One entry, with its start and its end; the cancelled checks are read now.
  status('operational');
  const after = wake();
  assert.equal(after.status, 0, after.stderr);
  const outage = events().filter((event) => event.kind === 'github_down');
  assert.equal(outage.length, 1);
  assert.equal(outage[0].at, started);
  assert.ok(outage[0].value >= 0);
  assert.match(outage[0].detail, new RegExp(`^from ${started} to \\S+: Actions$`));
  assert.throws(() => readFileSync(join(box.state, 'wake', 'github-down')));
  assert.equal(seen(), 'failure');
});


test('host-state says the host is free for nothing while GitHub is down', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'github-status.json'), JSON.stringify({ components: [{ name: 'Pull Requests', status: 'partial_outage' }, { name: 'Actions', status: 'operational' }] }));
  const run = spawnSync(join(box.home, 'host-state.sh'), [], { env: { ...box.env, FAKE_GH_LIST_DOWN: '1' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const state = JSON.parse(run.stdout);
  assert.equal(state.github_is_down, 'Pull Requests');
  assert.equal(state.free_for_a_ci_run, false);
  assert.equal(state.free_for_a_merge, false);
});


test('the catalog says a key in French when French has it, and falls back to English when it does not', async () => {
  const { message } = await import('../lib/i18n.mjs');
  assert.equal(message('catalog_fallback_probe', 'fr'), 'English fallback');
  assert.equal(message('notify_health_title', 'fr'), 'Problème de santé');
});


test('a source that does not answer: the wake reads nothing, moves nothing, and fails', () => {
  const box = sandbox();
  writeFileSync(join(box.home, 'tracker.sh'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });
  const run = spawnSync(join(box.home, 'wake.sh'), [], { env: box.env, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /tracker did not answer/);
  assert.throws(() => readFileSync(join(box.state, 'wake', 'state.json')));
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


test('[Linear adapter] tracker is asked for the newest comments of a ticket (first:, which it serves newest first), never the oldest', () => {
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


test('[Linear adapter] tracker is asked for the tickets of one state, to check what a handover says', () => {
  const dir = scratch('orch-tracker-');
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ncat >> "${join(dir, 'asked')}"\necho '{"data":{"issues":{"nodes":[{"id":"i1","identifier":"X-1","title":"T","description":"Body","url":"u","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z","state":{"name":"In Progress"},"project":{"name":"P"},"labels":{"nodes":[]},"assignee":null}]}}}'\n`, { mode: 0o755 });
  const repoRoot = fixtureProject();
  const run = spawnSync(join(ORCH_HOME, 'tracker.sh'), ['list', 'In Progress'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), [{ id: 'i1', identifier: 'X-1', title: 'T', description: 'Body', body: 'Body',
    url: 'u', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', state: 'In Progress',
    status: 'In Progress', project: 'P', labels: [], assignee: null }]);
  assert.match(readFileSync(join(dir, 'asked'), 'utf8'), /In Progress/);
});


test('[Linear adapter] a listing of tickets that fills the page says it may be cut short', () => {
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


test('the night checks are followed: green, nothing is said; red, it is an event, told once', async () => {
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
});


test('what the tracker says an agent wrote is never an event, with no mark in its text and no identifier kept', async () => {
  const { changes } = await import('../lib/wake.mjs');
  const issue = (over) => ({ id: 'i1', identifier: 'X-1', title: 'Titre', url: 'u', state: 'Todo', project: 'P', createdAt: '2026-01-01T00:00:00Z', description: 'd', comments: [], ...over });
  const first = changes(null, [issue({})], [], new Set(), '2026-01-02T10:00:00Z');
  const said = [issue({ comments: [{ id: 'c1', body: 'Sans aucune marque.', createdAt: '2026-01-02T10:01:00Z', url: 'u#c1', agent: true }, { id: 'c2', body: 'Et ça ?', createdAt: '2026-01-02T10:02:00Z', url: 'u#c2', agent: false }] }), issue({ id: 'i2', identifier: 'X-2', createdAt: '2026-01-02T10:03:00Z', description: 'Ouvert par un agent, sans marque.', agent: true })];
  assert.deepEqual(changes(first.next, said, [], new Set(), '2026-01-02T10:05:00Z').events.map((event) => [event.kind, event.text]), [['comment', 'Et ça ?']]);
});


test('[Linear adapter] a comment made of blanks is not posted', () => {
  const dir = scratch('orch-tracker-');
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\ntouch "${join(dir, 'called')}"\necho '{}'\n`, { mode: 0o755 });
  const repoRoot = fixtureProject();
  const run = spawnSync(join(ORCH_HOME, 'tracker.sh'), ['comment', 'X-1', '-'], { encoding: 'utf8', input: '  \n \n', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LINEAR_API_KEY: 'k', ORCH_REPO: repoRoot, ORCH_GUARD_REF: 'HEAD', ORCH_STATE_DIR: join(dir, 'state') } });
  assert.equal(run.status, 1);
  assert.throws(() => readFileSync(join(dir, 'called')));
});


test('[Linear adapter] a comment read on stdin is posted, signed by the one who runs', () => {
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


test('[Linear adapter] the user is not written more than a few times an hour by all the agents together: beyond, the comment is refused and is to be grouped', () => {
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
});


test('the reports the hourly limit holds back are kept, and leave later in one grouped comment', () => {
  const box = sandbox();
  mkdirSync(join(box.state, 'tracker-outbox'), { recursive: true });
  writeFileSync(join(box.state, 'tracker-outbox', 'X-1--report.md'), 'answer of first\n');
  const outbox = readdirSync(join(box.state, 'tracker-outbox'));
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

