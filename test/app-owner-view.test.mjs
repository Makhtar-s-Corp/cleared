// What the owner sees of a waiting item: the whole question and the team's
// recommendation, the team's report (never its handover), what changed, the
// captures or why there are none, and only the numbers that mean something.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardCollector, SHARE_MIN_TICKETS } from '../lib/board-collector.mjs';
import { questionsOf, reportSections } from '../lib/board-report.mjs';
import { prReport } from '../lib/pr-body.mjs';
import { changes } from '../lib/wake.mjs';
import { validBoard } from '../app/sources/live.mjs';
import { demoSource } from '../app/sources/demo.mjs';
import { createActions } from '../app/lib/actions.mjs';
import { laneWithRemote } from './support.mjs';

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// The shape a team really ended on (first flight, 2026-10-14): one numbered line, the question and its recommendation together.
const FRENCH = "1. Faut-il ajouter le titre « Entrées et sorties » au-dessus de la liste d'À venir, qui n'en a pas aujourd'hui ? Je recommande que non : le nom de la page, « À venir », le dit déjà, et un second titre ferait doublon sur un écran de téléphone (PR #314).";
const ENGLISH = '1. Should we add the heading “Comings and goings” above the Upcoming list, which has none today? I recommend no: the page name, “Upcoming”, already says it, and a second heading would repeat it on a phone screen (PR #314).';

test('a numbered question with its recommendation inline is one question, whole, with that recommendation (French and English)', () => {
  for (const [text, question, recommendation] of [
    [FRENCH, "Faut-il ajouter le titre « Entrées et sorties » au-dessus de la liste d'À venir, qui n'en a pas aujourd'hui ?", /^Je recommande que non : le nom de la page, « À venir », le dit déjà, et un second titre ferait doublon sur un écran de téléphone \(PR #314\)\.$/],
    [ENGLISH, 'Should we add the heading “Comings and goings” above the Upcoming list, which has none today?', /^I recommend no: the page name, “Upcoming”, already says it, and a second heading would repeat it on a phone screen \(PR #314\)\.$/],
  ]) {
    const found = questionsOf(text);
    assert.equal(found.length, 1, 'one question, not an option');
    assert.equal(found[0].text, question, 'not clipped');
    assert.match(found[0].recommendation, recommendation);
    assert.deepEqual(found[0].options, []);
  }
  assert.ok(FRENCH.length > 160, 'longer than the old 160-character cut');
});

test('choices are the short lines under a question; a numbered line that asks is a question; nothing is taken for a recommendation without the words', () => {
  const asked = questionsOf('Which colour for the button?\n- Blue\n1. Green\nA) Red\nB) Yellow\nC) Purple\nRecommendation: blue, like the other buttons.');
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].options, ['Blue', 'Green', 'Red', 'Yellow'], 'four at most');
  assert.equal(asked[0].recommendation, 'Recommendation: blue, like the other buttons.');
  const two = questionsOf('1. Rename the tab? I recommend yes.\n2. Move the button to the left?\n- Yes\n- No');
  assert.deepEqual(two.map((q) => [q.text, q.recommendation, q.options]), [['Rename the tab?', 'I recommend yes.', []], ['Move the button to the left?', null, ['Yes', 'No']]]);
  const plain = questionsOf('Faut-il garder le titre recommandé par la charte ?\n- Une longue explication qui dépasse largement quatre-vingts caractères et qui ne peut donc pas être un bouton de réponse.');
  assert.equal(plain[0].recommendation, null, 'a word inside the question is not a recommendation');
  assert.deepEqual(plain[0].options, [], 'a long line is context, not a button');
  assert.match(plain[0].text, /longue explication/);
  assert.deepEqual(questionsOf('None.'), []);
  assert.deepEqual(questionsOf('Aucune.'), []);
});

test('a block that opens with its recommendation keeps it as the recommendation, never as the question too', () => {
  const alone = 'Je conseille de garder le bouton (qui sait ?) tel quel.';
  assert.deepEqual(questionsOf(alone, { fallback: 'Renommer le bouton « Envoyer »' }),
    [{ text: 'Renommer le bouton « Envoyer »', recommendation: alone, options: [] }], 'the ticket title asks it');
  assert.deepEqual(questionsOf(alone), [{ text: alone, recommendation: null, options: [] }], 'without a title it is said once');
  assert.deepEqual(questionsOf(`${alone}\nFaut-il le renommer ?\n- Oui\n- Non`),
    [{ text: 'Faut-il le renommer ?', recommendation: alone, options: ['Oui', 'Non'] }], 'the next line is the question');
  const two = questionsOf(`1. Faut-il un titre ? Je recommande non.\n2. ${alone}\nFaut-il le déplacer ?`);
  assert.deepEqual(two.map((q) => [q.text, q.recommendation]), [['Faut-il un titre ?', 'Je recommande non.'], ['Faut-il le déplacer ?', alone]]);
  for (const q of [...questionsOf(alone, { fallback: 'x' }), ...two]) assert.notEqual(q.text, q.recommendation);
});

test('the report sections are read in either language and whatever their heading style', () => {
  const fr = reportSections("## Fait\n\n- Renommé le titre (PR #314).\n  Un test vérifie le nom.\n- Capture : ![avant](/home/x/a.png)\n\n## Reste à faire\n\nRien.\n\n## Questions pour l’utilisateur\n\nAucune.");
  assert.deepEqual(fr.done, ['Renommé le titre (PR #314). Un test vérifie le nom.', 'Capture :']);
  assert.deepEqual([fr.remaining, fr.questions], [[], []]);
  const en = reportSections('**Done**: renamed the label.\n**Remaining work:** add its test.\n**Questions for the user:** None.');
  assert.deepEqual([en.done, en.remaining, en.questions], [['renamed the label.'], ['add its test.'], []]);
});

// A project, a ledger and a tracker with one ticket, for the collector.
async function project({ status = 'In Progress', title = 'Rename the screen title', approval = false, keptIn = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-owner-')); dirs.push(dir);
  process.env.ORCH_LEDGER = join(dir, 'ledger.db'); process.env.CLEARED_STATE_DIR = dir; process.env.ORCH_STATE_DIR = dir;
  const { openLedger } = await import('../lib/ledger.mjs');
  const db = openLedger();
  db.exec('CREATE TABLE heartbeat_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE heartbeat_incidents (id TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT, active INTEGER);');
  db.exec(`CREATE TABLE memory_entries (id TEXT PRIMARY KEY, type TEXT NOT NULL, scope TEXT NOT NULL, content TEXT NOT NULL, source_who TEXT NOT NULL, source_where TEXT NOT NULL, source_when TEXT NOT NULL, status TEXT NOT NULL, links TEXT NOT NULL, supersedes TEXT, last_used_at TEXT)`);
  const ticket = { id: 'EX-7', identifier: 'EX-7', title, body: '', status };
  if (approval) {
    mkdirSync(join(dir, 'validations'), { recursive: true });
    writeFileSync(join(dir, 'validations', 'EX-7.json'), JSON.stringify({ ticket: 'EX-7', at: '2026-10-14T15:00:00.000Z', pulls: [{ pr: 314, head: 'a'.repeat(40) }] }));
  }
  const conf = { sections: { owner: { language: 'fr' }, heartbeat: { wake_interval_minutes: '1' }, lanes: keptIn ? { kept_in: keptIn } : {},
    tracker: { adapter: 'github', repository: 'owner/repo', progress_state: 'In Progress', review_state: 'In Review', validate_state: 'Needs Approval', go_state: 'Ready to Ship' } } };
  const trackerClient = { listTickets: ({ status: s }) => (s === ticket.status ? [ticket] : []), getTicket: () => ticket, comments: () => [] };
  const run = (id, over = {}) => db.prepare('INSERT INTO runs (run_id, ticket, role, model, provider, started_at, ended_at, outcome, tokens_total, pr_number, lines_changed) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, over.ticket ?? 'EX-7', over.role ?? 'dev', 'claude-opus-5-5', 'claude', over.started ?? new Date(Date.now() - 3600e3).toISOString(), over.ended === undefined ? new Date(Date.now() - 1800e3).toISOString() : over.ended, over.outcome ?? 'done', over.tokens ?? 1000, over.pr ?? null, over.lines ?? null);
  const collect = () => boardCollector({ conf, trackerClient, fuelReader: async () => [] });
  const report = (id, body) => { mkdirSync(join(dir, 'reports'), { recursive: true }); writeFileSync(join(dir, 'reports', `${id}.md`), `---\nformat: lane-report/1\noutcome: done\n---\n\n## Report\n\n${body}\n\n## Changed files\n\n- M shared/x.mjs\n`); };
  return { dir, db, ticket, run, collect, report, close: () => { db.close(); delete process.env.ORCH_LEDGER; delete process.env.CLEARED_STATE_DIR; delete process.env.ORCH_STATE_DIR; } };
}

test('the question card carries the whole question, the recommendation and the time it started waiting', async () => {
  const p = await project();
  try {
    p.run('r1-dev-a1', { pr: 314 });
    const { addEvent } = await import('../lib/ledger.mjs');
    addEvent(p.db, { kind: 'lane_asks', ticket: 'EX-7', detail: FRENCH, at: new Date(Date.now() - 600e3).toISOString() });
    const snap = await p.collect().snapshot();
    const card = snap.tickets[0];
    assert.equal(card.kind, 'question');
    assert.equal(card.column, 'awaiting');
    assert.equal(card.questions.length, 1);
    assert.match(card.questions[0].text, /qui n'en a pas aujourd'hui \?$/);
    assert.match(card.questions[0].recommendation, /^Je recommande que non/);
    assert.ok(card.since && Date.parse(card.since) < Date.now());
    assert.equal(card.title, 'Rename the screen title', 'the ticket title stays the title');
    assert.ok(validBoard(snap), 'the app accepts it');
  } finally { p.close(); }
});

test('Where we are comes from the team report to the user, never from its handover; without a report it says so', async () => {
  const p = await project();
  try {
    p.run('r1-dev-a1');
    p.db.prepare("INSERT INTO memory_entries VALUES ('m1','handover','ticket:EX-7','- Searched every occurrence of Departures in frontend/, server/, shared/.','dev','x',?,'active','[]',NULL,NULL)").run(new Date(Date.now() - 1700e3).toISOString());
    let snap = await p.collect().snapshot();
    assert.equal(snap.details['EX-7'].report, null, 'no report yet');
    assert.doesNotMatch(JSON.stringify(snap), /Searched every occurrence/, 'the handover is internal');
    assert.ok(snap.details['EX-7'].blackBox.some((e) => e.kind === 'handover'), 'the Black box says a handover exists');
    p.report('r1-dev-a1', '## Fait\n\n- Le titre de l’écran devient « À venir » (PR #314).\n\n## Reste à faire\n\n- Rien.\n\n## Questions pour l’utilisateur\n\nAucune.');
    snap = await p.collect().snapshot();
    const report = snap.details['EX-7'].report;
    assert.deepEqual(report.done, ['Le titre de l’écran devient « À venir » (PR #314).']);
    assert.deepEqual(report.remaining, []);
    assert.doesNotMatch(JSON.stringify(snap), /Searched every occurrence/);
    // The formatted report of the same run (the write-up) is the newer one: it wins.
    p.run('r1-writing-a1', { role: 'writing', started: new Date(Date.now() - 1700e3).toISOString(), ended: new Date(Date.now() - 1600e3).toISOString() });
    p.report('r1-writing-a1', '## Fait\n\n- Version mise en forme pour vous.');
    assert.deepEqual((await p.collect().snapshot()).details['EX-7'].report.done, ['Version mise en forme pour vous.']);
  } finally { p.close(); }
});

test('a ticket in the approval status without a request from Cleared is not ready to land, and cannot be cleared', async () => {
  const p = await project({ status: 'Needs Approval' });
  try {
    p.run('r1-dev-a1', { pr: 314 });
    const snap = await p.collect().snapshot();
    const card = snap.tickets[0];
    assert.deepEqual([card.kind, card.waiting, card.approval, card.column], ['tracker', false, null, 'awaiting']);
    assert.match(card.reason, /Cleared/);
    assert.ok(validBoard(snap));
    const actions = createActions({ source: { snapshot: async () => snap }, origin: 'https://cockpit.example', readPasskeys: () => [{ id: 'k' }], writePasskeys: () => {}, run: async () => ({ ok: true }) });
    await assert.rejects(actions.begin({ id: 's' }, { gesture: 'clear', ticket: 'EX-7', versions: [{ pr: 314, head: 'a'.repeat(40) }] }), (error) => error.code === 'not_waiting');
  } finally { p.close(); }
  const asked = await project({ status: 'Needs Approval', approval: true });
  try {
    asked.run('r1-dev-a1', { pr: 314 });
    const card = (await asked.collect().snapshot()).tickets[0];
    assert.deepEqual([card.kind, card.waiting], ['ready', true]);
    assert.equal(card.since, '2026-10-14T15:00:00.000Z', 'waiting since the request');
    assert.deepEqual(card.approval.versions, [{ pr: 314, head: 'a'.repeat(40) }]);
  } finally { asked.close(); }
});

test(`the share of the week's usage is shown only once ${SHARE_MIN_TICKETS} tickets ran this week`, async () => {
  const p = await project();
  try {
    p.run('r1-dev-a1', { tokens: 794 });
    p.run('o1-dev-a1', { ticket: 'EX-8', tokens: 206 });
    let snap = await p.collect().snapshot();
    assert.equal(snap.tickets[0].quotaShare, null, 'two tickets: 79.4 % would mean nothing');
    assert.equal(snap.details['EX-7'].quotaShare, null);
    for (let n = 9; n < 9 + SHARE_MIN_TICKETS - 2; n++) p.run(`o${n}-dev-a1`, { ticket: `EX-${n}`, tokens: 1000 });
    snap = await p.collect().snapshot();
    assert.ok(Number.isFinite(snap.tickets[0].quotaShare) && snap.tickets[0].quotaShare > 0);
    assert.ok(validBoard(snap));
  } finally { p.close(); }
});

test('What changed: the pull request, its size and its checks as the wake listed them; unknown stays unknown', async () => {
  const p = await project();
  try {
    p.run('r1-dev-a1', { pr: 314, lines: 4 });
    let change = (await p.collect().snapshot()).tickets[0].change;
    assert.deepEqual(change, { pr: { number: 314, url: 'https://github.com/owner/repo/pull/314' }, files: null, additions: null, deletions: null, lines: 4, checks: null, draft: null });
    mkdirSync(join(p.dir, 'wake'), { recursive: true });
    writeFileSync(join(p.dir, 'wake', 'state.json'), JSON.stringify({ at: new Date().toISOString(), pulls: { 314: { state: 'draft', checks: 'success', files: 2, additions: 3, deletions: 1 } } }));
    change = (await p.collect().snapshot()).details['EX-7'].change;
    assert.deepEqual([change.files, change.additions, change.deletions, change.lines, change.checks, change.draft], [2, 3, 1, 4, 'green', true]);
    for (const [checks, said] of [['failure', 'red'], ['pending', 'running'], ['none', 'none']]) {
      writeFileSync(join(p.dir, 'wake', 'state.json'), JSON.stringify({ pulls: { 314: { state: 'ready', checks } } }));
      assert.equal((await p.collect().snapshot()).tickets[0].change.checks, said);
    }
  } finally { p.close(); }
  // The wake keeps the size from the very listing it already makes (no other call).
  const pull = { number: 314, title: 't', headRefName: 'dev/EX-7', isDraft: true, state: 'OPEN', updatedAt: '2026-10-14T10:00:00Z', statusCheckRollup: [{ conclusion: 'SUCCESS' }], changedFiles: 2, additions: 3, deletions: 1 };
  assert.deepEqual(changes(null, [], [pull]).next.pulls, { 314: { state: 'draft', checks: 'success', files: 2, additions: 3, deletions: 1 } });
});

test('a screen ticket shows the captures the team kept, or says there is none and why', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
  const kept = mkdtempSync(join(tmpdir(), 'cleared-kept-')); dirs.push(kept);
  const p = await project({ title: 'Renommer le titre de l’écran', keptIn: kept });
  try {
    p.run('r1-dev-a1');
    let show = (await p.collect().snapshot()).details['EX-7'].show;
    assert.deepEqual([show.kind, show.before, show.after, show.missing], ['screen', [], [], 'none_kept'], 'a French screen ticket is a screen ticket');
    mkdirSync(join(kept, 'EX-7'), { recursive: true });
    writeFileSync(join(kept, 'EX-7', 'avant-a-venir.png'), png);
    writeFileSync(join(kept, 'EX-7', 'notes.txt'), 'not an image');
    writeFileSync(join(kept, 'EX-7', 'fake.png'), 'not a png either');
    const snap = await p.collect().snapshot();
    show = snap.details['EX-7'].show;
    assert.equal(show.missing, null);
    assert.deepEqual(show.before, [{ url: `/media/${createHash('sha256').update(png).digest('hex')}`, caption: 'avant a venir' }]);
    assert.deepEqual(show.after, []);
    assert.doesNotMatch(JSON.stringify(snap), new RegExp(kept.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the folder never reaches the snapshot');
    assert.ok(validBoard(snap));
  } finally { p.close(); }
  const nowhere = await project({ title: 'Move the button' });
  try {
    nowhere.run('r1-dev-a1');
    assert.equal((await nowhere.collect().snapshot()).details['EX-7'].show.missing, 'not_kept');
  } finally { nowhere.close(); }
});

test('the app refuses a question that is not of the expected shape, and the demo covers every owner case', async () => {
  const demo = demoSource();
  const snap = await demo.snapshot();
  const details = {};
  for (const t of snap.tickets) details[t.id] = await demo.ticket(t.id);
  const board = { ...snap, details };
  assert.ok(validBoard(board));
  const by = Object.fromEntries(snap.tickets.map((t) => [t.id, t]));
  assert.ok(by['EX-39'].questions[0].options.length && by['EX-39'].questions[0].recommendation, 'a question with choices and a recommendation');
  assert.ok(!by['EX-40'].questions[0].options.length, 'a question without choices');
  assert.ok(by['EX-31'].change.checks && by['EX-36'].change.checks === 'running', 'pull requests with checks');
  assert.ok(details['EX-31'].show.after.length && details['EX-40'].show.missing, 'a screen ticket with and without captures');
  assert.ok(by['EX-29'].kind === 'tracker' && !by['EX-29'].waiting, 'a ticket the tracker alone holds');
  assert.ok(Object.values(details).some((d) => d.report === null) && Object.values(details).some((d) => d.report), 'with and without a report');
  const broken = structuredClone(board);
  broken.tickets.find((t) => t.id === 'EX-39').questions[0].options = ['a', 'b', 'c', 'd', 'e'];
  assert.equal(validBoard(broken), false);
  const tooLong = structuredClone(board);
  tooLong.details['EX-40'].questions = [{ text: 'x'.repeat(1501), recommendation: null, options: [] }];
  assert.equal(validBoard(tooLong), false);
});

test('the pull request body keeps the routes of the application and hides only what names this machine', () => {
  const folders = ['/srv/cleared-service/state', '/opt/cleared'];
  const said = prReport([
    '## Done',
    '- The /invoices page and the route /api/users now answer in French; see https://github.com/o/r/pull/314.',
    '- Captures in /srv/cleared-service/state/captures/a.png, ~/work/x.png and /tmp/run/b.png; the tool sits in /opt/cleared.',
    '- Logs of /var/log/app and /home/agent/.cache, token ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.',
  ].join('\n'), { folders });
  assert.match(said, /The \/invoices page and the route \/api\/users now answer/, 'a route stays');
  assert.match(said, /https:\/\/github\.com\/o\/r\/pull\/314/, 'a link stays');
  assert.doesNotMatch(said, /\/srv\/|~\/work|\/tmp\/|\/opt\/cleared|\/var\/|\/home\/|ghp_/);
  assert.match(said, /Captures in \[path\], \[path\] and \[path\]; the tool sits in \[path\]\./);
  // The folders of this very checkout are found without being told.
  assert.equal(prReport(`See ${join(import.meta.dirname, '..', 'lib', 'x.mjs')} and /about.`), 'See [path] and /about.');
});

test('the pull request opens with the team report to the user, without a path of the machine; a refused report leaves it out', () => {
  assert.equal(prReport('---\noutcome: done\n---\n\n## Report\n\n## Done\n- Renamed (PR #314), see https://github.com/o/r/pull/314; capture at /home/svc/.local/a.png\n\n## Changed files\n\n- M a'),
    '## Done\n- Renamed (PR #314), see https://github.com/o/r/pull/314; capture at [path]');
  const lane = laneWithRemote('dev/X-5');
  mkdirSync(join(lane.box.state, 'reports'), { recursive: true });
  writeFileSync(join(lane.box.state, 'reports', 'run1-dev-a1.md'), '---\noutcome: done\n---\n\n## Report\n\n## Fait\n- Le titre devient « À venir ».\n\n## Reste à faire\nRien.\n\n## Questions pour l’utilisateur\n1. Faut-il un second titre ? Je recommande que non.\n\n## Changed files\n\n- M a\n');
  const run = lane.push();
  assert.equal(run.status, 0, run.stderr);
  // Without a run, the body is the bare one.
  assert.doesNotMatch(lane.body(), /Fait/);
  const again = laneWithRemote('dev/X-6');
  mkdirSync(join(again.box.state, 'reports'), { recursive: true });
  writeFileSync(join(again.box.state, 'reports', 'run1-dev-a1.md'), '## Report\n\n## Fait\n- Le titre devient « À venir ».\n\n## Questions pour l’utilisateur\n1. Faut-il un second titre ? Je recommande que non.\n\n## Changed files\n');
  const pushed = spawnLane(again, { ORCH_RUN_ID: 'run1-dev-a1' });
  assert.equal(pushed.status, 0, pushed.stderr);
  const body = again.body();
  assert.match(body, /^## Fait\n- Le titre devient « À venir »\.\n\n## Questions pour l’utilisateur\n1\. Faut-il un second titre \? Je recommande que non\.\n\n---\n\nOpened by the dispatcher for X-6/);
  assert.match(body, /Commits:\n- feat: the work of the lane/);
  const refused = laneWithRemote('dev/X-7');
  mkdirSync(join(refused.box.state, 'reports'), { recursive: true });
  writeFileSync(join(refused.box.state, 'reports', 'run1-dev-a1.md'), `## Report\n\n## Fait\n- le mot de ${'pass'}${'word'} = "${'x'.repeat(12)}"\n\n## Changed files\n`);
  const left = spawnLane(refused, { ORCH_RUN_ID: 'run1-dev-a1' });
  assert.equal(left.status, 0, left.stderr);
  assert.match(left.stderr, /report is left out of the pull request/);
  assert.doesNotMatch(refused.body(), /Fait/);
  assert.match(refused.body(), /^Opened by the dispatcher for X-7/);
});

function spawnLane(lane, env) {
  return spawnSync(join(lane.box.home, 'push-lane.sh'), [lane.path], { env: { ...lane.box.env, ...env }, encoding: 'utf8' });
}
