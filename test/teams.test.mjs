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

test('a ticket the user gives to two teams (« Équipes : les deux ») gets a second team on the other harness, on a lane of its own; he is asked once, with both results, when both are reviewed and green; his line says which goes live, and its go-live closes the other', () => {
  const { flow, todo, by, record, session, box, env } = flowBox({ maxLanes: 3 });
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8').replace('runs_per_day = 4', 'runs_per_day = 30')}\n[harness]\ndev = b\n`);
  const comments = (...list) => writeFileSync(join(box.home, 'linear-comments.json'), JSON.stringify(list));
  const asked = { id: 'c1', createdAt: '2026-01-02T09:00:00Z', body: 'Équipes : les deux', byOwner: true };
  const events = (kind) => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare('select detail from events where kind = ? order by rowid').all(kind).map((row) => row.detail); db.close(); return rows; };
  const chain = (key) => JSON.parse(readFileSync(join(box.state, 'runs', record(key).runs.at(-1).run, 'chain.json'), 'utf8'));
  // A line an agent wrote under his account gives nothing to two teams; his own does.
  comments({ ...asked, body: '> Écrit par un agent (chef de projet), pas par lui.\n\nÉquipes : les deux' });
  todo(['X-5']);
  by('X-5', 0);
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: true }]));
  writeFileSync(join(box.home, 'pr-head-dev-X-5.2.json'), JSON.stringify([{ number: 42, state: 'OPEN', isDraft: true }]));
  const alone = flow();
  assert.match(alone.stdout, /X-5: put in « Todo » by the user: its lane is opened/);
  assert.doesNotMatch(alone.stdout, /two teams/);
  // He writes it once the first team is at work: the second opens beside it when the first has ended its session.
  comments(asked);
  const one = session('X-5');
  assert.doesNotMatch(one.prompt, /Équipes : les deux/, 'a line for the dispatcher is no word for a lane');
  const opened = flow();
  assert.match(opened.stdout, /X-5: given to two teams by the user: its second team is opened \(b, the first runs on first\)/);
  assert.doesNotMatch(opened.stdout, /X-5: opened again \(said:/, 'and it does not open the first again');
  assert.equal(record('X-5.2').lane, 'dev/X-5.2');
  assert.equal(record('X-5.2').ticket, 'X-5');
  assert.equal(record('X-5.2').team, '2');
  assert.match(record('X-5.2').worktree, /dev-X-5\.2$/);
  assert.equal(chain('X-5')[0].adapter, 'first');
  assert.equal(chain('X-5.2')[0].adapter, 'second');
  assert.equal(flow().stdout.includes('second team'), false, 'opened once');
  const two = session('X-5.2', { commit: 'fix: the work of the other team' });
  assert.match(two.prompt, /Team: dev\/X-5\.2 [\s\S]*This ticket has two independent teams; you are the second\./);
  assert.equal(record('X-5.2').pr, 42);
  assert.equal(record('X-5').pr, 41);
  assert.equal(execFileSync('git', ['--git-dir', join(box.home, 'remote.git'), 'rev-parse', 'dev/X-5.2'], { encoding: 'utf8' }).trim(), two.head, 'sent to a branch of its own');
  // Each is green and read by another model: the first that is ready waits for the other, and the lead is told once both are.
  const view = (pr, head, over = {}) => writeFileSync(join(box.home, `pr-view-${pr}.json`), JSON.stringify({ number: pr, state: 'OPEN', isDraft: false, headRefName: pr === 41 ? 'dev/X-5' : 'dev/X-5.2', headRefOid: head, baseRefName: 'main', title: 't', body: 'b', createdAt: '2026-01-01T00:00:00Z', additions: 1, deletions: 0, files: [], statusCheckRollup: [{ conclusion: 'SUCCESS' }], ...over }));
  const read = (pr, head) => {
    const id = `X-5-review-of-${pr}`;
    const db = openLedger(join(box.state, 'ledger.db'));
    db.prepare("insert into runs (run_id, ticket, role, model, provider, started_at, ended_at, outcome, pr_number, lane, source) values (?, 'X-5', 'review', 'c', 'second', '2026-01-03T09:00:00Z', '2026-01-03T09:05:00Z', 'done', ?, 'review/X-5', 'dispatcher')").run(id, pr);
    db.close();
    mkdirSync(join(box.state, 'reports'), { recursive: true });
    writeFileSync(join(box.state, 'reports', `${id}.md`), `commit: ${head}\n\n## Compte rendu\n\nVerdict : rien de bloquant.\n\n## Fichiers modifiés\n`);
  };
  view(41, one.head);
  view(42, two.head, { statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  read(41, one.head);
  const first = flow();
  assert.match(first.stdout, /X-5: #41 \(team 1\) is reviewed and green at [0-9a-f]{8}: the request waits for the other team of the ticket/);
  assert.deepEqual(events('teams_ready'), []);
  // The lead asks for the first alone all the same: refused, nothing is written to the user.
  const ask = (...pulls) => spawnSync(join(box.home, 'ask-validation.sh'), ['X-5', '-', ...pulls.flatMap((pr) => ['--pr', String(pr)])], { env, input: 'Deux pistes pour le même écran.', encoding: 'utf8' });
  const early = ask(41);
  assert.notEqual(early.status, 0);
  assert.match(early.stderr, /X-5 was given to two teams \(#41 and #42\): he is asked once, with both results side by side \(--pr 41 --pr 42\)/);
  view(42, two.head);
  read(42, two.head);
  const both = flow();
  assert.match(both.stdout, /X-5\.2: its two teams are reviewed and green \(#42 and #41\): one request with both results is the lead's/);
  assert.equal(events('teams_ready').length, 1);
  assert.match(events('teams_ready')[0], /#41 \(team 1\) and #42 \(team 2\)[\s\S]*ask-validation\.sh X-5 - --pr 41 --pr 42/);
  assert.equal(flow().stdout.trim(), '', 'said once');
  // One request, with both: it tells him how to choose, and keeps which team made which.
  const request = ask(41, 42);
  assert.equal(request.status, 0, request.stderr);
  const written = readFileSync(join(box.home, 'linear-posted'), 'utf8');
  assert.match(written, /Two teams worked on this ticket independently: team 1, PR 41; team 2, PR 42\. To choose, write a line ‘Team 1’ or ‘Team 2’ on the ticket, then move it to ‘Go MEP’/);
  const kept = () => JSON.parse(readFileSync(join(box.state, 'validations', 'X-5.json'), 'utf8'));
  assert.deepEqual(kept().teams, { 1: 41, 2: 42 });
  // He puts the card in his status of agreement and says nothing of which: neither goes live.
  writeFileSync(join(box.home, 'linear-state-X-5'), 'Go MEP\n');
  const live = (pr) => spawnSync(join(box.home, 'merge-pr.sh'), [String(pr), 'X-5', '-'], { env, input: 'Ce qui change, où le voir, comment le vérifier.', encoding: 'utf8' });
  const silent = live(41);
  assert.notEqual(silent.status, 0);
  assert.match(silent.stderr, /X-5 was given to two teams and the user has not said which one goes live: a Team 1 or Team 2 line/);
  // His line, written after the request, names the second team: the first is refused, the second goes live, and the first is closed.
  comments(asked, { id: 'c2', createdAt: '2099-01-01T10:00:00Z', body: 'Team 2', byOwner: true });
  const refused = live(41);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /the user chose the team 2 \(#42\): #41, of the team 1, is not put live/);
  assert.throws(() => readFileSync(join(box.home, 'pr-merged')));
  const chosen = live(42);
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.match(chosen.stdout, /merged: #42 \(X-5\)[\s\S]*closed: #41, the result of the team he did not choose/);
  assert.equal(readFileSync(join(box.home, 'pr-merged'), 'utf8').split('\n')[2], '42');
  assert.ok(record('X-5').closed, 'the lane of the team he did not choose is over');
  assert.equal(record('X-5.2').closed, undefined);
  // His choice is read by the go-live, and is no word for a lane.
  assert.doesNotMatch(flow().stdout, /opened again \(said:/);
});


test('two teams on a ticket, where it could go wrong: the line written once the first is ready, a team opened again stays on its harness, a word for one team only, a wait that lasts is said, his choice is read after the request and never guessed, and the result he did not choose never goes live', () => {
  const { flow, todo, by, record, session, stuck, moves, box, env } = flowBox({ maxLanes: 3 });
  const confPath = join(box.home, 'agents.conf');
  writeFileSync(confPath, `${readFileSync(confPath, 'utf8').replace('runs_per_day = 4', 'runs_per_day = 30')}\n[harness]\ndev = b\n`);
  const comments = (...list) => writeFileSync(join(box.home, 'linear-comments.json'), JSON.stringify(list));
  const asked = { id: 'c1', createdAt: '2026-01-02T09:00:00Z', body: 'Équipes : les deux', byOwner: true };
  const events = (kind) => { const db = openLedger(join(box.state, 'ledger.db')); const rows = db.prepare('select detail from events where kind = ? order by rowid').all(kind).map((row) => row.detail); db.close(); return rows; };
  const chain = (key) => JSON.parse(readFileSync(join(box.state, 'runs', record(key).runs.at(-1).run, 'chain.json'), 'utf8'));
  const view = (pr, head, over = {}) => writeFileSync(join(box.home, `pr-view-${pr}.json`), JSON.stringify({ number: pr, state: 'OPEN', isDraft: false, headRefName: pr === 41 ? 'dev/X-5' : 'dev/X-5.2', headRefOid: head, baseRefName: 'main', title: 't', body: 'b', createdAt: '2026-01-01T00:00:00Z', additions: 1, deletions: 0, files: [], statusCheckRollup: [{ conclusion: 'SUCCESS' }], ...over }));
  const read = (pr, head) => {
    const id = `X-5-review-of-${pr}`;
    const db = openLedger(join(box.state, 'ledger.db'));
    db.prepare("insert into runs (run_id, ticket, role, model, provider, started_at, ended_at, outcome, pr_number, lane, source) values (?, 'X-5', 'review', 'c', 'second', '2026-01-03T09:00:00Z', '2026-01-03T09:05:00Z', 'done', ?, 'review/X-5', 'dispatcher')").run(id, pr);
    db.close();
    mkdirSync(join(box.state, 'reports'), { recursive: true });
    writeFileSync(join(box.state, 'reports', `${id}.md`), `commit: ${head}\n\n## Compte rendu\n\nVerdict : rien de bloquant.\n\n## Fichiers modifiés\n`);
  };
  comments();
  todo(['X-5']);
  by('X-5', 0);
  writeFileSync(join(box.home, 'pr-head-dev-X-5.json'), JSON.stringify([{ number: 41, state: 'OPEN', isDraft: true }]));
  writeFileSync(join(box.home, 'pr-head-dev-X-5.2.json'), JSON.stringify([{ number: 42, state: 'OPEN', isDraft: true }]));
  flow();
  const one = session('X-5');
  // One team, reviewed and green: the request is the lead's, as for any ticket.
  view(41, one.head);
  read(41, one.head);
  assert.match(flow().stdout, /X-5: #41 is reviewed and green at [0-9a-f]{8}: the request for the agreement is the lead's/);
  // He gives the ticket to two teams only then, before anything was asked of him: the second opens, and the first waits for it.
  comments(asked);
  assert.match(flow().stdout, /X-5: given to two teams by the user: its second team is opened \(b, the first runs on first\)/);
  assert.equal(record('X-5').team_model, 'a', 'the first team is kept on what it runs on');
  assert.equal(record('X-5.2').team_model, 'b');
  // A wait that lasts is said to the lead, once: nothing is asked for one team behind his back, and nothing waits in silence.
  { const kept = record('X-5'); kept.ready.at = new Date(Date.now() - 5 * 3600e3).toISOString(); writeFileSync(join(box.state, 'lanes', 'X-5.json'), JSON.stringify(kept)); }
  assert.match(flow().stdout, /X-5: #41 \(team 1\) has waited 4 hours for the other team of the ticket: said to the lead/);
  flow();
  assert.deepEqual(stuck(), ['lane_stuck X-5']);
  assert.match(events('lane_stuck')[0], /wait for the other, or go on with this one alone[\s\S]*kill-lane\.sh <role>\/X-5\.2/);
  const two = session('X-5.2', { commit: 'fix: the work of the other team' });
  // A word of the lead for the second team only: it is opened again with it, on its own harness, and the first is not.
  const tell = (to, text) => spawnSync(join(box.home, 'tell-lane.sh'), [to, '-'], { env, input: text, encoding: 'utf8' });
  view(42, two.head, { isDraft: true, statusCheckRollup: [] });
  const said = tell('X-5.2', 'Pour la deuxième équipe : vérifie le mode sombre.');
  assert.equal(said.status, 0, said.stderr);
  assert.match(said.stdout, /kept for the lane of X-5 \(team 2\)/);
  const again = flow().stdout;
  assert.equal(again.match(/opened again \(told:/g).length, 1, again);
  assert.equal(record('X-5').runs.length, 1, 'the first team was not opened for a word that is not for it');
  assert.equal(chain('X-5.2')[0].adapter, 'second', 'opened again on the harness it was given');
  const told = session('X-5.2', { commit: null });
  assert.match(told.prompt, /\| The project lead wrote[\s\S]*Pour la deuxième équipe : vérifie le mode sombre\./);
  // The second is ready in its turn: the lead is told, though the first had been ready long before the ticket had two teams.
  view(42, two.head);
  read(42, two.head);
  assert.match(flow().stdout, /X-5\.2: its two teams are reviewed and green \(#42 and #41\): one request with both results is the lead's/);
  assert.equal(events('teams_ready').length, 1);
  assert.equal(flow().stdout.trim(), '', 'said once');
  assert.equal(events('teams_ready').length, 1);
  // The request, then his choice: a line from before the request, a line an agent wrote, or lines that name both teams choose nothing.
  const ask = spawnSync(join(box.home, 'ask-validation.sh'), ['X-5', '-', '--pr', '41', '--pr', '42'], { env, input: 'Deux pistes pour le même écran.', encoding: 'utf8' });
  assert.equal(ask.status, 0, ask.stderr);
  writeFileSync(join(box.home, 'linear-state-X-5'), 'Go MEP\n');
  const live = (pr, extra = {}) => spawnSync(join(box.home, 'merge-pr.sh'), [String(pr), 'X-5', '-'], { env: { ...env, ...extra }, input: 'Ce qui change, où le voir, comment le vérifier.', encoding: 'utf8' });
  const before = { id: 'c2', createdAt: '2026-01-02T09:30:00Z', body: 'Équipe 1', byOwner: true };
  const agent = { id: 'c3', createdAt: '2099-01-01T10:00:00Z', body: '> Écrit par un agent (chef de projet), pas par lui.\n\nÉquipe 2', byOwner: true };
  comments(asked, before, agent);
  assert.match(live(41).stderr, /the user has not said which one goes live/);
  assert.match(live(42).stderr, /the user has not said which one goes live/);
  comments(asked, { id: 'c4', createdAt: '2099-01-01T11:00:00Z', body: 'Équipe 1', byOwner: true }, { id: 'c5', createdAt: '2099-01-01T12:00:00Z', body: 'Équipe 2', byOwner: true });
  assert.match(live(41).stderr, /the user named both since the request/);
  assert.throws(() => readFileSync(join(box.home, 'pr-merged')));
  // He names the first. It goes live; GitHub does not close the other now: kept, told, and closed by the wake.
  comments(asked, { id: 'c4', createdAt: '2099-01-01T11:00:00Z', body: 'Équipe 1', byOwner: true });
  const chosen = live(41, { FAKE_GH_CLOSE_DOWN: '1' });
  assert.equal(chosen.status, 0, chosen.stderr);
  assert.match(chosen.stderr, /#41 is live, but #42, of the team he did not choose, could not be closed: the wake tries again/);
  const kept = () => JSON.parse(readFileSync(join(box.state, 'validations', 'X-5.json'), 'utf8'));
  assert.equal(kept().close, 42);
  assert.ok(record('X-5.2').closed && record('X-5.2').not_chosen, 'its lane is over at once');
  // The result he did not choose never goes live, whatever is asked later.
  const second = live(42);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /#42 is the result of the team the user did not choose for X-5/);
  assert.equal(readFileSync(join(box.home, 'pr-merged'), 'utf8').split('\n')[2], '41');
  // (And the other way round: once one is live, the other is never put live on top of it, even if nothing had marked it.)
  view(41, one.head, { state: 'MERGED' });
  { const lane = record('X-5.2'); delete lane.not_chosen; delete lane.closed; writeFileSync(join(box.state, 'lanes', 'X-5.2.json'), JSON.stringify(lane)); comments(asked, { id: 'c6', createdAt: '2099-01-01T13:00:00Z', body: 'Équipe 2', byOwner: true }); }
  assert.match(live(42).stderr, /#41, of the other team of X-5, is already live: #42 is not put live on top of it/);
  { const lane = record('X-5.2'); lane.not_chosen = true; lane.closed = 'x'; writeFileSync(join(box.state, 'lanes', 'X-5.2.json'), JSON.stringify(lane)); }
  const wake = spawnSync('bash', ['-c', '. "$0/lib/common.sh"; close_tickets_left_open', box.home], { env, encoding: 'utf8' });
  assert.equal(wake.status, 0, wake.stderr);
  assert.equal(readFileSync(join(box.home, 'pr-closed'), 'utf8').trim(), '42');
  assert.equal(kept().close, undefined);
  view(42, two.head, { state: 'CLOSED' });
  spawnSync('bash', ['-c', '. "$0/lib/common.sh"; close_tickets_left_open', box.home], { env, encoding: 'utf8' });
  assert.equal(kept().closing, undefined);
  assert.equal(moves().at(-1), 'X-5 -> Done');
});


test('a ticket given to two teams with no place for the second, or no second harness, is not stuck: the second waits for a place, and one team works when there is no other harness, said once', () => {
  const asked = JSON.stringify([{ id: 'c1', createdAt: '2026-01-02T09:00:00Z', body: 'Teams: both.', byOwner: true }]);
  // No other harness is named for the role: one team, and the lead is told once.
  {
    const { flow, todo, by, record, session, stuck, box } = flowBox();
    writeFileSync(join(box.home, 'linear-comments.json'), asked);
    todo(['X-5']);
    by('X-5', 0);
    const alone = flow();
    assert.match(alone.stdout, /X-5: put in « Todo » by the user: its lane is opened/);
    assert.match(alone.stdout, /X-5: given to two teams by the user, and no second harness can be opened now \(the first runs on first\): one team works on it/);
    assert.deepEqual(stuck(), ['lane_stuck X-5']);
    session('X-5');
    flow();
    assert.deepEqual(stuck(), ['lane_stuck X-5'], 'said once a day');
    assert.throws(() => record('X-5.2'));
  }
  // A harness is named, and the only place is taken by the first team at work: the second waits, and opens when there is one.
  {
    const { flow, todo, by, record, session, stuck, box } = flowBox({ maxLanes: 1 });
    const confPath = join(box.home, 'agents.conf');
    writeFileSync(confPath, `${readFileSync(confPath, 'utf8')}\n[harness]\ndev = b\n`);
    writeFileSync(join(box.home, 'linear-comments.json'), asked);
    todo(['X-5']);
    by('X-5', 0);
    assert.match(flow().stdout, /X-5: given to two teams by the user: no place now for the second \(the limit of lanes\), it waits/);
    assert.throws(() => record('X-5.2'));
    session('X-5');
    assert.match(flow().stdout, /X-5: given to two teams by the user: its second team is opened \(b, the first runs on first\)/);
    assert.equal(record('X-5.2').team, '2');
    assert.deepEqual(stuck(), []);
    // The second has nothing to show yet: the first is not asked for alone, until the lane of the second is closed by hand.
    const head = execFileSync('git', ['-C', box.repo, 'rev-parse', 'dev/X-5'], { encoding: 'utf8' }).trim();
    writeFileSync(join(box.home, 'pr-view-41.json'), JSON.stringify({ number: 41, state: 'OPEN', headRefOid: head }));
    const ask = () => spawnSync(join(box.home, 'ask-validation.sh'), ['X-5', '-', '--pr', '41'], { env: box.env, input: 'Une piste.', encoding: 'utf8' });
    const early = ask();
    assert.notEqual(early.status, 0);
    assert.match(early.stderr, /X-5 was given to two teams, and one of them has no pull request yet/);
    // (A lane that only waits, its worktree closed after its session, is closed the same way.)
    writeFileSync(join(box.home, 'pr-head-dev-X-5.2.json'), JSON.stringify([{ number: 42, state: 'OPEN', isDraft: true }]));
    writeFileSync(join(box.home, 'pr-view-42.json'), JSON.stringify({ number: 42, state: 'OPEN', isDraft: true, headRefName: 'dev/X-5.2', baseRefName: 'main', statusCheckRollup: [{ status: 'IN_PROGRESS' }] }));
    session('X-5.2', { commit: 'fix: half of the work of the other team' });
    assert.match(flow().stdout, /X-5\.2: session over, work sent: its worktree is closed/);
    const closed = spawnSync(join(box.home, 'kill-lane.sh'), ['dev/X-5.2'], { env: box.env, encoding: 'utf8' });
    assert.equal(closed.status, 0, closed.stderr);
    assert.match(closed.stdout, /closed: dev\/X-5\.2 \(it was waiting/);
    assert.ok(record('X-5.2').closed && record('X-5.2').given_up);
    assert.doesNotMatch(flow().stdout, /second team/, 'a team given up is not opened again');
    const alone = ask();
    assert.equal(alone.status, 0, alone.stderr);
    assert.equal(JSON.parse(readFileSync(join(box.state, 'validations', 'X-5.json'), 'utf8')).teams, undefined);
  }
});
