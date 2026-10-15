import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseConf } from '../lib/conf.mjs';
import {
  RULE_REASONS, assertService, commandWords, decide, decideLane, fastSettings, globMatcher, judgeDiff, lanesMedian, measureTicket,
  median, openingLane, pathFormOk, targetedArgv,
} from '../lib/fast-lane.mjs';
import { route } from '../lib/route.mjs';
import { addEvent, openLedger } from '../lib/ledger.mjs';
import { activeRelease } from '../lib/release.mjs';
import { finishedReviews } from '../lib/reviews.mjs';
import { flowBox, reviewedPull, scratch, task } from './support.mjs';

// ---- A project with a base and a branch, and the settings of its main checkout ----

const confOf = (fast, extra = '') => parseConf(`[lanes]\nbase = main\n[merge]\nguarded_paths = ops/cleared/, compose\n[release]\nmigration_paths = db/schema\n[fast_lane]\n${fast}\n${extra}`);
// What the project declares safe: its texts, its translations, its styles.
const CONF = confOf('enabled = yes\nlabels = Quick\nprojects = Wording\nsafe_paths = docs/, web/locales/*.json, **/*.css\nnever_paths = docs/security/\nmax_lines = 10\nmax_files = 5\ntests_command = node --test {files}');
// Everything declared safe: only the rules no setting can widen are left.
const WIDE = confOf('enabled = yes\nsafe_paths = **\nmax_lines = 400\nmax_files = 50');
const write = (dir, files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};
function project(files = { 'docs/guide.md': 'Hello\n', 'api/server.js': 'export const x = 1;\n', 'package.json': '{}\n', 'web/locales/en.json': '{"title": "Hello"}\n' }) {
  const dir = scratch('fast-lane-repo-');
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  write(dir, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'dev/X-1');
  // One commit of the team: what `change` leaves in the worktree, as it is.
  const commit = (change) => {
    if (change({ write: (more) => write(dir, more), git, dir }) !== 'staged') git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'fast-lane: yes, this is a tiny safe change');
    return git('rev-parse', 'HEAD').trim();
  };
  return { dir, git, commit };
}
const OPENED = { fast_lane: { opening: 'fast', state: 'fast' } };
const judge = (p, head, conf = CONF, record = OPENED) => decideLane({ conf, repo: p.dir, base: 'main', commit: head, record });

test('the rules: a small text change in the safe paths stays on the fast lane; a path outside them, a migration or a dependency sends it to the full circuit', () => {
  const p = project();
  const safe = p.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello, world\n', 'web/locales/en.json': '{"title": "Hello there"}\n', 'web/app.css': 'h1 { color: red; }\n' }));
  assert.deepEqual({ state: judge(p, safe).state, reasons: judge(p, safe).reasons }, { state: 'fast', reasons: [] });
  const outside = p.commit(({ write: w }) => w({ 'api/server.js': 'export const x = 2;\n' }));
  assert.equal(judge(p, outside).state, 'full');
  assert.deepEqual(judge(p, outside).reasons, ['outside_safe']);
  assert.equal(judge(p, outside).offending.outside_safe, 'api/server.js');
  // With everything declared safe, a migration and a dependency still never are.
  const migrations = project();
  const sql = migrations.commit(({ write: w }) => w({ 'db/migrations/0042_add_column.sql': 'ALTER TABLE t ADD c int;\n' }));
  assert.deepEqual(judge(migrations, sql, WIDE).reasons, ['migration']);
  const declared = project();
  const schema = declared.commit(({ write: w }) => w({ 'db/schema/users.txt': 'users\n' }));
  assert.deepEqual(judge(declared, schema, WIDE).reasons, ['migration'], '[release] migration_paths count too');
  for (const file of ['package.json', 'web/package-lock.json', 'web/yarn.lock', 'requirements-dev.txt', 'Cargo.lock', 'go.sum', '.npmrc']) {
    const deps = project();
    const head = deps.commit(({ write: w }) => w({ [file]: '{"dependencies": {"left-pad": "1.0.0"}}\n' }));
    assert.deepEqual(judge(deps, head, WIDE).reasons, ['dependency'], file);
  }
  const extra = project();
  const pinned = extra.commit(({ write: w }) => w({ 'tools/versions.txt': 'node 24\n' }));
  assert.deepEqual(judge(extra, pinned, confOf('enabled = yes\nsafe_paths = **\ndependency_files = tools/versions.txt')).reasons, ['dependency']);
  // And the project's own never list wins over its safe list.
  const never = project();
  const secured = never.commit(({ write: w }) => w({ 'docs/security/policy.md': 'all open\n' }));
  assert.deepEqual(judge(never, secured).reasons, ['protected']);
});

test('adversarial: a pull request that widens its own safe paths in .cleared/agents.conf is never fast, and the settings are those of the main checkout', () => {
  const p = project({ 'docs/guide.md': 'Hello\n', '.cleared/agents.conf': '[fast_lane]\nenabled = yes\nsafe_paths = docs/\n' });
  const head = p.commit(({ write: w }) => w({ '.cleared/agents.conf': '[fast_lane]\nenabled = yes\nsafe_paths = **\nmax_lines = 9999\n', 'docs/guide.md': 'Hi\n' }));
  // The main checkout's settings say docs/ only: the branch's own file widens nothing.
  const judged = judge(p, head);
  assert.equal(judged.state, 'full');
  assert.ok(judged.reasons.includes('protected'));
  // Even a main checkout that declared everything safe keeps Cleared's settings, CI, agent rules and git files apart.
  for (const file of ['.cleared/agents.conf', '.cleared/prompts/dev.md', '.github/workflows/ci.yml', '.Cleared/agents.conf', 'sub/.cleared/x', 'CLAUDE.md', 'docs/AGENTS.md',
    '.gitattributes', 'docs/.gitmodules', '.husky/pre-commit', 'ops/cleared/merge-pr.sh', 'OPS/Cleared/merge-pr.sh', 'compose.yaml', 'Dockerfile', 'CODEOWNERS',
    'deploy/Dockerfile.web', 'deploy/docker-compose.prod.yml', 'deploy/compose.staging.yaml', 'web/app.dockerfile']) {
    const one = project();
    const changed = one.commit(({ write: w }) => w({ [file]: 'changed\n' }));
    assert.deepEqual(judge(one, changed, WIDE).reasons, ['protected'], file);
  }
});

test('adversarial: path tricks (unicode, look-alikes, case, option-like and spaced names) take the full circuit', () => {
  for (const file of ['docs/café.md', 'docs/café.md', 'docs/guіde.md', 'docs/-rf.md', 'docs/a b.md', 'docs/semi;colon.md', 'docs/$(touch x).md']) {
    const p = project();
    const head = p.commit(({ write: w }) => w({ [file]: 'text\n' }));
    assert.deepEqual(judge(p, head).reasons, ['path_form'], JSON.stringify(file));
  }
  const twins = project();
  const both = twins.commit(({ write: w }) => w({ 'docs/Read.md': 'one\n', 'docs/read.md': 'two\n' }));
  assert.deepEqual(judge(twins, both).reasons, ['path_form']);
  // A safe list is matched as written: another case is outside it.
  const upper = project();
  const shouted = upper.commit(({ write: w }) => w({ 'DOCS/guide.md': 'text\n' }));
  assert.deepEqual(judge(upper, shouted).reasons, ['outside_safe']);
  for (const bad of ['', '/abs', 'a//b', './a', 'a/./b', 'a/../b', '..', 'a\\b', 'a\nb', '-x', 'a/-x']) assert.equal(pathFormOk(bad), false, JSON.stringify(bad));
  assert.equal(pathFormOk('docs/.well-known/x.md'), true);
});

test('adversarial: a rename, a deletion, a symbolic link, an executable, a binary file, a submodule or a file deleted and recreated as something else is not judged fast', () => {
  const cases = {
    rename: ({ git }) => git('mv', 'docs/guide.md', 'docs/manual.md'),
    deletion: ({ git }) => git('rm', '-q', 'docs/guide.md'),
    symlink: ({ dir }) => symlinkSync('../api/server.js', join(dir, 'docs', 'link.md')),
    executable: ({ dir }) => chmodSync(join(dir, 'docs', 'guide.md'), 0o755),
    binary: ({ write: w }) => w({ 'docs/data.md': 'a\0b\0c' }),
    submodule: ({ git }) => { git('update-index', '--add', '--cacheinfo', `160000,${git('rev-parse', 'HEAD').trim()},docs/sub`); return 'staged'; },
  };
  for (const [name, change] of Object.entries(cases)) {
    const p = project();
    const head = p.commit(change);
    const judged = judge(p, head);
    assert.equal(judged.state, 'full', name);
    assert.ok(judged.reasons.includes(name === 'binary' ? 'binary' : 'unusual_change'), `${name}: ${judged.reasons}`);
  }
  // Deleted in one commit, recreated as a link in the next: the diff of the branch is a change of type.
  const p = project();
  p.commit(({ git }) => git('rm', '-q', 'docs/guide.md'));
  const head = p.commit(({ dir }) => { mkdirSync(join(dir, 'docs'), { recursive: true }); symlinkSync('../api/server.js', join(dir, 'docs', 'guide.md')); });
  assert.ok(judge(p, head).reasons.includes('unusual_change'));
  // A change git cannot read is never fast.
  assert.deepEqual(judge(p, 'no-such-commit').reasons, ['unreadable']);
  assert.deepEqual(judge(p, '--output=/tmp/x').reasons, ['unreadable']);
});

test('the line threshold is inclusive; more files, a larger file, or an empty change take the full circuit', () => {
  const ten = project();
  const exactly = ten.commit(({ write: w }) => w({ 'docs/new.md': `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')}\n` }));
  assert.equal(judge(ten, exactly).state, 'fast');
  assert.equal(judge(ten, exactly).lines, 10);
  const eleven = project();
  const over = eleven.commit(({ write: w }) => w({ 'docs/new.md': `${Array.from({ length: 11 }, (_, i) => `line ${i}`).join('\n')}\n` }));
  assert.deepEqual(judge(eleven, over).reasons, ['too_many_lines']);
  // Removed lines count too: one changed line is one removed and one added.
  const both = project();
  const changed = both.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello, world\n' }));
  assert.equal(judge(both, changed).lines, 2);
  const many = project();
  const six = many.commit(({ write: w }) => w(Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`docs/f${i}.md`, 'x\n']))));
  assert.deepEqual(judge(many, six).reasons, ['too_many_files']);
  const big = project();
  const large = big.commit(({ write: w }) => w({ 'docs/long.md': `${'x'.repeat(100001)}` }));
  assert.deepEqual(judge(big, large, confOf('enabled = yes\nsafe_paths = docs/')).reasons, ['too_large']);
  const empty = project();
  assert.deepEqual(judge(empty, empty.commit(() => {})).reasons, ['empty']);
});

test('the decision is bound to the commit: a later push is judged again, a ticket sent back stays in the full circuit, and the lead is told', () => {
  const p = project();
  const state = scratch('fast-lane-state-');
  mkdirSync(join(state, 'lanes'), { recursive: true });
  const saved = { state: process.env.ORCH_STATE_DIR, ledger: process.env.ORCH_LEDGER };
  process.env.ORCH_STATE_DIR = state;
  process.env.ORCH_LEDGER = join(state, 'ledger.db');
  try {
    writeFileSync(join(state, 'lanes', 'X-1.json'), JSON.stringify({ ticket: 'X-1', pr: 41, ...OPENED }));
    const record = () => JSON.parse(readFileSync(join(state, 'lanes', 'X-1.json'), 'utf8')).fast_lane;
    const events = () => { const db = openLedger(); const rows = db.prepare("SELECT kind, detail FROM events WHERE kind LIKE 'fast_lane_%' ORDER BY event_id").all(); db.close(); return rows; };
    const first = p.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello, world\n' }));
    assert.equal(decide('X-1', first, { conf: CONF, repo: p.dir }).state, 'fast');
    assert.equal(record().head, first);
    assert.deepEqual(events().map((e) => e.kind), ['fast_lane_kept']);
    // The same commit again: nothing new to say.
    decide('X-1', first, { conf: CONF, repo: p.dir });
    assert.equal(events().length, 1);
    // Eligible at one commit, extended at the next: judged again, and sent back.
    const extended = p.commit(({ write: w }) => w({ 'api/server.js': 'export const x = 2;\n' }));
    assert.equal(decide('X-1', extended, { conf: CONF, repo: p.dir }).state, 'full');
    assert.deepEqual({ state: record().state, head: record().head, reasons: record().reasons }, { state: 'full', head: extended, reasons: ['outside_safe'] });
    const fallback = events().at(-1);
    assert.equal(fallback.kind, 'fast_lane_fallback');
    assert.match(JSON.parse(fallback.detail).first, /outside_safe: api\/server\.js/);
    // Taking the unsafe file back out does not bring it back to the fast lane, and neither does the first commit.
    const undone = p.commit(({ git }) => git('checkout', '-q', 'main', '--', 'api/server.js'));
    assert.equal(decide('X-1', undone, { conf: CONF, repo: p.dir }).state, 'full');
    assert.equal(decide('X-1', first, { conf: CONF, repo: p.dir }).state, 'full');
    assert.equal(events().filter((e) => e.kind === 'fast_lane_fallback').length, 1, 'said once');
    // A git that cannot answer now gives the full circuit for that call, and sends nothing back for good.
    writeFileSync(join(state, 'lanes', 'X-2.json'), JSON.stringify({ ticket: 'X-2', ...OPENED }));
    assert.equal(decide('X-2', 'no-such-commit', { conf: CONF, repo: p.dir }).state, 'full');
    assert.equal(JSON.parse(readFileSync(join(state, 'lanes', 'X-2.json'), 'utf8')).fast_lane.state, 'fast');
  } finally {
    if (saved.state === undefined) delete process.env.ORCH_STATE_DIR; else process.env.ORCH_STATE_DIR = saved.state;
    if (saved.ledger === undefined) delete process.env.ORCH_LEDGER; else process.env.ORCH_LEDGER = saved.ledger;
  }
});

test('adversarial: the flag cannot be forged: another account cannot decide, a forged record buys nothing, and nothing an agent writes is read', () => {
  assert.throws(() => assertService({ uid: 1001, owner: 1000 }), /only the service account/);
  assert.doesNotThrow(() => assertService({ uid: 1000, owner: 1000 }));
  const p = project();
  // A record that says fast, at a commit whose diff is not: the rules read the diff again.
  const unsafe = p.commit(({ write: w }) => w({ 'api/server.js': 'export const x = 2;\n' }));
  assert.equal(judge(p, unsafe, CONF, { fast_lane: { opening: 'fast', state: 'fast', head: unsafe, reasons: [] } }).state, 'full');
  // A safe diff, a commit message, a report or a file that claims the fast lane: without the opening the rules wrote, no.
  const claimed = project();
  const head = claimed.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello, world\n', 'docs/FAST_LANE': 'state: fast\n' }));
  for (const record of [null, {}, { fast_lane: { state: 'fast' } }, { fast_lane: { opening: 'full', state: 'fast' } }]) {
    assert.equal(judge(claimed, head, CONF, record).state, 'full', JSON.stringify(record));
  }
  // The command line refuses an account other than the owner of the state before it reads anything.
  const state = scratch('fast-lane-owner-');
  const as = spawnSync(process.execPath, ['-e', `import('${join(import.meta.dirname, '..', 'lib', 'fast-lane.mjs')}').then((m) => { try { m.assertService({ uid: process.getuid() + 1 }); } catch (e) { console.log(e.message); } })`],
    { env: { ...process.env, ORCH_STATE_DIR: state }, encoding: 'utf8' });
  assert.match(as.stdout, /only the service account decides/);
});

test('the targeted tests run with no shell: {files} becomes one argument per changed file, and no file name can inject anything', () => {
  assert.deepEqual(commandWords('npx --no-install vitest related --run {files}'), ['npx', '--no-install', 'vitest', 'related', '--run', '{files}']);
  assert.deepEqual(commandWords(`node "--test-name-pattern=a b" {files}`), ['node', '--test-name-pattern=a b', '{files}']);
  assert.deepEqual(targetedArgv('node --test {files}', ['docs/a.md', 'web/b.css']), ['node', '--test', 'docs/a.md', 'web/b.css']);
  for (const bad of ['npm test; curl x', 'npm test && rm -rf /', 'npm test | tee x', 'echo $(id) {files}', 'echo `id` {files}', 'cat < x {files}', 'npm test {files} {files}', 'npm test --files={files}', '{files}', 'npm test', 'npm "test {files}']) {
    assert.throws(() => commandWords(bad), /tests_command/, bad);
  }
  for (const file of ['-rf', 'docs/$(id).md', 'docs/a b.md', 'docs/;rm.md', '../x', '']) assert.throws(() => targetedArgv('node --test {files}', [file]), /cannot be handed/, file);
  // Run for real: the words go to the program as they are, nothing is interpreted.
  const out = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...targetedArgv('x {files}', ['docs/a.md']).slice(1)], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.stdout), ['docs/a.md']);
});

test('the settings: unreadable patterns or numbers make nothing fast; empty safe paths make nothing fast; off is off; the opening reads the ticket', () => {
  for (const bad of ['safe_paths = docs/{a,b}/', 'safe_paths = docs/[ab].md', 'safe_paths = !docs/', 'safe_paths = /etc/', 'safe_paths = docs/**x', 'safe_paths = ../x', 'max_lines = ten', 'max_lines = 0', 'tests_command = npm test; id']) {
    assert.throws(() => fastSettings(confOf(`enabled = yes\n${bad}`)), /\[fast_lane\]/, bad);
  }
  const p = project();
  const head = p.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello, world\n' }));
  assert.deepEqual(judge(p, head, confOf('enabled = yes\nsafe_paths = docs/{a,b}/')).reasons, ['settings']);
  assert.deepEqual(judge(p, head, confOf('enabled = yes')).reasons, ['outside_safe']);
  assert.deepEqual(judge(p, head, confOf('enabled = no\nsafe_paths = docs/')).reasons, ['disabled']);
  const settings = fastSettings(CONF);
  assert.equal(openingLane(settings, { labels: ['Bug', 'Quick'], project: null }), 'fast');
  assert.equal(openingLane(settings, { labels: [], project: 'Wording' }), 'fast');
  assert.equal(openingLane(settings, { labels: ['quick'], project: 'Other' }), 'full', 'a label is matched as the project writes it');
  assert.equal(openingLane(fastSettings(confOf('enabled = no\nlabels = Quick')), { labels: ['Quick'] }), 'full');
  const glob = globMatcher('web/**/*.css');
  assert.deepEqual(['web/a.css', 'web/x/y/a.css', 'web/a.scss', 'web/a.css/x', 'app/web/a.css'].map(glob), [true, true, false, false, false]);
  assert.deepEqual(['docs/a', 'docs/x/y', 'docs', 'docsx/a'].map(globMatcher('docs/')), [true, true, false, false]);
  assert.deepEqual(RULE_REASONS.includes('asked'), true);
});

test('routing: the fast lane picks the light author and a light reviewer that still differs from the author', () => {
  const conf = parseConf(`[models]\nheavy = claude:opus\nlight = claude:haiku\nmid = claude:sonnet\n[fallbacks]\n[roles]\ndev = heavy\nreview = heavy\n[rules]\ndev label=Bug -> heavy\n[review]\ndiffers_from_author = yes\nwhen_same = mid\n[fast_lane]\nauthor_model = light\nreview_model = light\n`);
  assert.equal(route(conf, task({ labels: ['Bug'] })).chain[0].alias, 'heavy');
  const fast = route(conf, task({ labels: ['Bug'], lane: 'fast' }));
  assert.equal(fast.chain[0].alias, 'light');
  assert.match(fast.rule, /fast lane: light author/);
  // A light reviewer that is the author's own model is replaced, as for any review.
  const review = route(conf, task({ role: 'review', lane: 'fast', authorModel: 'haiku' }));
  assert.equal(review.chain[0].alias, 'mid');
  assert.equal(route(conf, task({ role: 'review', lane: 'fast', authorModel: 'opus' })).chain[0].alias, 'light');
  // A model named at launch is not second-guessed; another role is not concerned.
  assert.equal(route(conf, task({ lane: 'fast', forced: 'heavy' })).chain[0].alias, 'heavy');
  assert.equal(route(conf, task({ role: 'review', authorModel: 'haiku' })).chain[0].alias, 'heavy');
});

test('measurement: working time is the union of the sessions, the human waits from the notification (else the card) to his gesture, the machine the rest; medians by lane', () => {
  const at = (minutes) => new Date(Date.UTC(2026, 9, 15, 10, minutes)).toISOString();
  const runs = [{ started_at: at(1), ended_at: at(5) }, { started_at: at(4), ended_at: at(6) }, { started_at: at(8), ended_at: at(9) }];
  assert.deepEqual(measureTicket({ todoAt: at(0), doneAt: at(15), runs, cardAt: at(9), notifiedAt: at(10), gestureAt: at(12) }),
    { total: 15, working: 6, humanWait: 2, machineWait: 7, humanFrom: 'notification' });
  assert.deepEqual(measureTicket({ todoAt: at(0), doneAt: at(15), runs, cardAt: at(9), notifiedAt: null, gestureAt: at(12) }),
    { total: 15, working: 6, humanWait: 3, machineWait: 6, humanFrom: 'card' });
  assert.equal(measureTicket({ todoAt: at(0), doneAt: at(15), runs, cardAt: at(9) }).humanWait, null, 'no gesture known: not guessed');
  assert.equal(measureTicket({ todoAt: at(10), doneAt: at(5) }), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([]), null);
  const db = openLedger(':memory:');
  const now = Date.parse('2026-10-15T12:00:00Z');
  for (const [lane, value, days] of [['fast', 14, 1], ['fast', 12, 2], ['fast', 30, 3], ['full', 329, 1], ['full', 100, 9]]) {
    addEvent(db, { kind: 'ticket_measured', ticket: 'X-1', value, at: new Date(now - days * 86400e3).toISOString(), detail: JSON.stringify({ lane }) });
  }
  assert.deepEqual(lanesMedian(db, { now }), { days: 7, fast: { minutes: 14, count: 3 }, full: { minutes: 329, count: 1 } });
  db.close();
});

test('the health watch of a fast-lane release holds no merge back; one of the full circuit, or a rollback at work, still does', () => {
  const db = openLedger(':memory:');
  activeRelease(db);
  const add = (id, status, lane) => db.prepare('INSERT INTO releases(id, ticket, pr, merge_sha, title, merged_at, status, lane) VALUES (?,?,?,?,?,?,?,?)').run(id, `X-${id}`, id, String(id).repeat(40).slice(0, 40), 't', '2026-10-15T10:00:00Z', status, lane);
  add(1, 'watching', 'fast');
  assert.equal(activeRelease(db), undefined);
  add(2, 'watching', null);
  assert.equal(activeRelease(db).id, 2, 'an older row without a lane counts as the full circuit');
  db.prepare("UPDATE releases SET status = 'complete' WHERE id = 2").run();
  db.prepare("UPDATE releases SET status = 'rolling_back' WHERE id = 1").run();
  assert.equal(activeRelease(db).id, 1, 'a rollback of a fast-lane release is at work: nothing goes live meanwhile');
  db.close();
});

// ---- The card and the app ----

async function board({ status = 'Needs Approval', checks = 'pending', approval = true } = {}) {
  const dir = scratch('fast-lane-board-');
  const saved = { ledger: process.env.ORCH_LEDGER, state: process.env.ORCH_STATE_DIR, cleared: process.env.CLEARED_STATE_DIR };
  process.env.ORCH_LEDGER = join(dir, 'ledger.db'); process.env.ORCH_STATE_DIR = dir; process.env.CLEARED_STATE_DIR = dir;
  const db = openLedger();
  db.exec('CREATE TABLE heartbeat_state (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE heartbeat_incidents (id TEXT PRIMARY KEY, first_seen TEXT, last_seen TEXT, active INTEGER);');
  const ticket = { id: 'EX-7', identifier: 'EX-7', title: 'Rename the settings title', body: '', status };
  if (approval) {
    mkdirSync(join(dir, 'validations'), { recursive: true });
    writeFileSync(join(dir, 'validations', 'EX-7.json'), JSON.stringify({ ticket: 'EX-7', at: new Date(Date.now() - 300e3).toISOString(), pulls: [{ pr: 314, head: 'a'.repeat(40) }] }));
  }
  mkdirSync(join(dir, 'wake'), { recursive: true });
  writeFileSync(join(dir, 'wake', 'state.json'), JSON.stringify({ pulls: { 314: { state: 'ready', checks, files: 1, additions: 1, deletions: 1 } } }));
  db.prepare('INSERT INTO runs (run_id, ticket, role, model, provider, started_at, ended_at, outcome, pr_number) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('r1-dev-a1', 'EX-7', 'dev', 'claude-haiku', 'claude', new Date(Date.now() - 900e3).toISOString(), new Date(Date.now() - 600e3).toISOString(), 'done', 314);
  const conf = { sections: { owner: { language: 'en' }, heartbeat: { wake_interval_minutes: '1' }, lanes: { push_roles: 'dev' },
    tracker: { adapter: 'github', repository: 'owner/repo', progress_state: 'In Progress', review_state: 'In Review', validate_state: 'Needs Approval', go_state: 'Ready to Ship' } } };
  const { boardCollector } = await import('../lib/board-collector.mjs');
  const trackerClient = { listTickets: ({ status: s }) => (s === ticket.status ? [ticket] : []), getTicket: () => ticket, comments: () => [] };
  const collect = () => boardCollector({ conf, trackerClient, fuelReader: async () => [] }).snapshot();
  const close = () => {
    db.close();
    for (const [name, value] of [['ORCH_LEDGER', saved.ledger], ['ORCH_STATE_DIR', saved.state], ['CLEARED_STATE_DIR', saved.cleared]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  };
  return { db, dir, collect, close };
}

test('the card: Ready to land appears while the full checks run and says so; a ticket sent back says why; the app shows the median by lane', async () => {
  const b = await board();
  try {
    addEvent(b.db, { kind: 'fast_lane_opened', ticket: 'EX-7', detail: 'dev/EX-7: opened on the fast lane' });
    let snap = await b.collect();
    let card = snap.tickets[0];
    assert.equal(card.kind, 'ready');
    assert.equal(card.lane, 'fast');
    assert.equal(card.statusLine, 'full checks running, landing when green');
    assert.equal(snap.details['EX-7'].lane, 'fast');
    // The checks turned green: the card is an ordinary Ready to land.
    writeFileSync(join(b.dir, 'wake', 'state.json'), JSON.stringify({ pulls: { 314: { state: 'ready', checks: 'success', files: 1, additions: 1, deletions: 1 } } }));
    snap = await b.collect();
    assert.notEqual(snap.tickets[0].statusLine, 'full checks running, landing when green');
    // Sent back by the rules: the card says it, with the reason in words and never the path.
    addEvent(b.db, { kind: 'fast_lane_fallback', ticket: 'EX-7', detail: JSON.stringify({ head: 'b'.repeat(40), reasons: ['outside_safe'], first: 'outside_safe: api/secret/server.js' }) });
    snap = await b.collect();
    card = snap.tickets[0];
    assert.equal(card.lane, 'full');
    assert.equal(card.statusLine, 'back to the full circuit: a file outside the safe list');
    assert.doesNotMatch(JSON.stringify(snap), /api\/secret/);
    // One line in the app: the median from Todo to Done over seven days, by lane; each landed ticket with its lane and times.
    addEvent(b.db, { kind: 'merged_by_script', ticket: 'EX-3', value: 12 });
    addEvent(b.db, { kind: 'ticket_measured', ticket: 'EX-3', value: 14.2, detail: JSON.stringify({ lane: 'fast', working_min: 6.1, human_wait_min: 3, machine_wait_min: 5.1 }) });
    snap = await b.collect();
    assert.deepEqual(snap.stats.lanes, { days: 7, fast: { minutes: 14.2, count: 1 }, full: { minutes: null, count: 0 } });
    assert.deepEqual((({ lane, totalMin, workingMin, humanWaitMin, machineWaitMin }) => ({ lane, totalMin, workingMin, humanWaitMin, machineWaitMin }))(snap.landed[0]),
      { lane: 'fast', totalMin: 14, workingMin: 6, humanWaitMin: 3, machineWaitMin: 5 });
    const { validBoard } = await import('../app/sources/live.mjs');
    assert.equal(validBoard(snap), true);
    assert.equal(validBoard({ ...snap, stats: { ...snap.stats, lanes: { fast: { minutes: 'x', count: 1 }, full: { minutes: null, count: 0 } } } }), false);
    const { message } = await import('../lib/i18n.mjs');
    for (const code of [...RULE_REASONS, 'other']) assert.notEqual(message(`app_srv_fast_reason_${code}`, 'fr'), message(`app_srv_fast_reason_${code}`, 'en'), code);
    assert.equal(message('app_srv_fast_landing_when_green', 'fr'), 'vérifications complètes en cours, mise en ligne dès qu’elles sont vertes');
    const app = readFileSync(join(import.meta.dirname, '..', 'app', 'public', 'app.js'), 'utf8');
    assert.match(app, /app_stat_median/);
  } finally { b.close(); }
});

// ---- The rules at work: flow-lanes.sh, lane-run.sh, merge-pr.sh ----

function fastFlow(extra = '') {
  const box = flowBox();
  const conf = join(box.box.home, 'agents.conf');
  writeFileSync(conf, `${readFileSync(conf, 'utf8')}\n[fast_lane]\nenabled = yes\nlabels = Quick\nauthor_model = b\nreview_model = a\nsafe_paths = docs/\ntests_command = true {files}\n${extra}`);
  writeFileSync(join(box.box.home, 'tracker-labels-X-5.json'), '["Quick"]');
  const events = (kind) => { const db = openLedger(join(box.box.state, 'ledger.db')); const rows = db.prepare('SELECT kind, value, detail FROM events WHERE kind = ? ORDER BY event_id').all(kind); db.close(); return rows; };
  const runDirOf = (role) => join(box.box.state, 'runs', readdirSync(join(box.box.state, 'runs')).filter((name) => { try { return new RegExp(`ORCH_ROLE=${role}\\n`).test(readFileSync(join(box.box.state, 'runs', name, 'lane.env'), 'utf8')); } catch { return false; } }).sort().at(-1));
  const review = (answer) => {
    const lanes = execFileSync('git', ['-C', box.box.repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
    const path = /worktree (.*review-X-5)\n/.exec(lanes)[1];
    assert.equal(spawnSync(join(box.box.home, 'lane-run.sh'), [runDirOf('review')], { cwd: path, env: { ...box.env, ANSWER: answer }, encoding: 'utf8' }).status, 0);
  };
  const stage = (files) => { const { worktree } = box.record('X-5'); write(worktree, files); execFileSync('git', ['-C', worktree, 'add', '-A']); };
  return { ...box, events, runDirOf, review, stage };
}

test('on the fast lane, end to end: a light author asks nothing, the review is asked at once, the card is prepared before the full checks end, and red checks send the ticket back to its team', () => {
  const f = fastFlow();
  f.todo(['X-5']);
  f.by('X-5', 0);
  f.flow();
  assert.deepEqual(f.record('X-5').fast_lane, { ...f.record('X-5').fast_lane, opening: 'fast', state: 'fast' });
  assert.deepEqual(f.events('fast_lane_opened').length, 1);
  const author = f.runDirOf('dev');
  assert.equal(JSON.parse(readFileSync(join(author, 'chain.json'), 'utf8'))[0].alias, 'b', 'the light author');
  assert.match(readFileSync(join(author, 'lane.env'), 'utf8'), /ORCH_FAST_LANE=fast/);
  // The team is told to ask nothing and to take the most prudent reading; the limits are the project's.
  f.stage({ 'docs/settings.md': 'Settings\n' });
  const done = f.session('X-5', { commit: 'docs: rename the settings title', answer: 'Done: renamed the title, as the ticket says.\n\nQuestions for the user: None.' });
  assert.equal(done.run.status, 0, done.run.stderr);
  assert.match(done.prompt, /## Fast lane[\s\S]*Ask the user nothing[\s\S]*most prudent interpretation[\s\S]*change only files under docs\//);
  assert.match(done.run.stdout, /Fast lane: targeted tests at [0-9a-f]{8}: passed/);
  assert.deepEqual((({ head, exit }) => ({ head, exit }))(f.record('X-5').fast_lane.tests), { head: done.head, exit: 0 });
  // An explicit ticket: no question reaches the user.
  f.pull({ headRefOid: done.head });
  const busy = { FAKE_GH_RUNS: '[{"branch":"feat/other","event":"pull_request","sha":"0000000000000000000000000000000000000000"}]' };
  const first = f.flow(busy);
  assert.deepEqual(f.stuck(), [], 'no lane_asks: nothing is asked of the user');
  // Still a draft (the host runs other checks): the review is asked for at once, by the light reviewer.
  assert.match(first.stdout, /#41 is on the fast lane at [0-9a-f]{8}: its review is asked for/);
  assert.doesNotMatch(first.stdout, /taken out of draft/);
  const reviewer = f.runDirOf('review');
  assert.equal(JSON.parse(readFileSync(join(reviewer, 'chain.json'), 'utf8'))[0].alias, 'a', 'the light reviewer, not the author');
  assert.match(readFileSync(join(reviewer, 'prompt.md'), 'utf8'), /## Fast lane[\s\S]*light review is still a review/);
  f.review('Verdict : rien de bloquant.');
  // Out of draft, the full checks run: the card for the user is prepared now, once, without waiting for them.
  f.pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  assert.match(f.flow().stdout, /#41 is on the fast lane, reviewed at [0-9a-f]{8} with its targeted tests and capture: the request is the lead's, the full checks run meanwhile/);
  assert.equal(f.events('fast_lane_ready').length, 1);
  assert.equal(f.events('fast_lane_ready')[0].value, 41);
  assert.equal(f.flow().stdout.trim(), '', 'said once');
  // The lead hears it as a finished review it must act on now.
  const told = finishedReviews(openLedger(join(f.box.state, 'ledger.db'), { readOnly: true }), join(f.box.state, 'reports')).filter((r) => r.outcome === 'fast_lane_ready');
  assert.equal(told.length, 1);
  // The full suite turns red: the ticket goes back to its team, as on the full circuit.
  f.pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ conclusion: 'FAILURE' }] });
  writeFileSync(join(f.box.home, 'runs-of-branch.json'), JSON.stringify([{ databaseId: 2, headSha: done.head, conclusion: 'failure' }]));
  writeFileSync(join(f.box.home, 'run-log.txt'), 'verify\tUNKNOWN STEP\t2026-01-02T10:00:00.0000000Z ✖ the title test fails\n');
  assert.match(f.flow().stdout, /X-5: opened again \(checks:/);
  assert.equal(f.record('X-5').runs.length, 2);
  assert.match(readFileSync(join(f.runDirOf('dev'), 'lane.env'), 'utf8'), /ORCH_FAST_LANE=fast/, 'reopened on the fast lane, with the light author');
  assert.equal(JSON.parse(readFileSync(join(f.runDirOf('dev'), 'chain.json'), 'utf8'))[0].alias, 'b');
});

test('after the author\'s work, a diff outside the safe paths sends the ticket back to the full circuit, says so, and runs no targeted test; a team that asks a question does too, and its question is relayed', () => {
  const f = fastFlow();
  f.todo(['X-5']);
  f.by('X-5', 0);
  f.flow();
  f.stage({ 'server/x.mjs': 'export const x = 1;\n' });
  const done = f.session('X-5', { commit: 'feat: more than asked' });
  assert.match(done.run.stdout, /Fast lane: the rules send X-5 to the full circuit/);
  assert.deepEqual((({ state, reasons }) => ({ state, reasons }))(f.record('X-5').fast_lane), { state: 'full', reasons: ['outside_safe'] });
  assert.equal(f.record('X-5').fast_lane.tests, undefined);
  assert.equal(f.events('fast_lane_fallback').length, 1);
  // The full circuit from here: its review waits for green checks again, and a reopened lane gets the usual author.
  f.pull({ headRefOid: done.head, isDraft: false, statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  assert.doesNotMatch(f.flow().stdout, /review is asked for|fast lane/);

  const asks = fastFlow();
  asks.todo(['X-5']);
  asks.by('X-5', 0);
  asks.flow();
  asks.stage({ 'docs/settings.md': 'Settings\n' });
  asks.session('X-5', { commit: 'docs: rename', answer: 'Done.\n\nQuestions for the user:\n- Should the title also change in the menu? I recommend yes.' });
  const said = asks.flow().stdout;
  assert.match(said, /a team on the fast lane asked a question: the ticket takes the full circuit/);
  assert.deepEqual((({ state, reasons }) => ({ state, reasons }))(asks.record('X-5').fast_lane), { state: 'full', reasons: ['asked'] });
  assert.deepEqual(asks.stuck(), ['lane_asks X-5'], 'the question is relayed on the full circuit');
});

test('merge on the fast lane: judged again at the very commit, it waits for its own checks and not for unrelated CI or a screen test; a forged flag buys nothing', () => {
  const pull = reviewedPull(['docs/guide.md']);
  const conf = join(pull.box.home, 'agents.conf');
  writeFileSync(conf, `${readFileSync(conf, 'utf8')}\n[fast_lane]\nenabled = yes\nsafe_paths = docs/\n`);
  mkdirSync(join(pull.box.state, 'lanes'), { recursive: true });
  const record = (over = {}) => writeFileSync(join(pull.box.state, 'lanes', 'X-5.json'), JSON.stringify({ ticket: 'X-5', pr: 7, fast_lane: { opening: 'fast', state: 'fast' }, ...over }));
  mkdirSync(join(pull.box.state, 'validations'), { recursive: true });
  writeFileSync(join(pull.box.state, 'validations', 'X-5.json'), JSON.stringify({ ticket: 'X-5', at: '2026-01-02T10:00:00Z', pulls: [{ pr: 7, head: pull.headOf() }] }));
  writeFileSync(join(pull.box.home, 'tracker-moved'), '0');
  const other = { FAKE_GH_RUNS: '[{"branch":"main","event":"push","sha":"1111111111111111111111111111111111111111"}]' };
  const dry = (extra) => pull.merge(['-', '--dry-run'], extra, 'Announcement.');
  // The full circuit waits for a host with no CI at all.
  assert.equal(dry(other).status, 3);
  // On the fast lane, the run of another commit is not its business.
  record();
  const fast = dry(other);
  assert.equal(fast.status, 0, fast.stderr);
  assert.equal(JSON.parse(fast.stdout).lane, 'fast');
  // A run of this very commit is: it waits.
  assert.equal(dry({ FAKE_GH_RUNS: JSON.stringify([{ branch: 'feat/w', event: 'pull_request', sha: pull.headOf() }]) }).status, 3);
  // Its own checks still running: kept in the queue, never merged before they are green; red: refused.
  pull.publish({ statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  assert.equal(dry(other).status, 3);
  pull.publish({ statusCheckRollup: [{ conclusion: 'FAILURE' }, { conclusion: 'SUCCESS' }] });
  assert.match(dry(other).stderr, /a check is not green/);
  pull.publish();
  // Merged for real while another commit's CI runs; its time is measured with its lane, and its watch holds no one back.
  const done = pull.merge(['-'], other, '**Live**: the settings title, see it on the settings screen.');
  assert.equal(done.status, 0, done.stderr);
  assert.ok(pull.merged());
  const db = openLedger(join(pull.box.state, 'ledger.db'));
  const measured = db.prepare("SELECT detail FROM events WHERE kind = 'ticket_measured'").all();
  const merged = db.prepare("SELECT detail FROM events WHERE kind = 'merged_by_script'").get();
  db.close();
  assert.equal(measured.length, 0, 'no Todo time known for a pull request opened outside the rules: nothing is guessed');
  assert.match(merged.detail, /fast lane$/);

  // A record forged to say fast, on a pull request that touches code: judged again, and it waits like any other.
  const forged = reviewedPull(['docs/guide.md', 'server/core.mjs']);
  const forgedConf = join(forged.box.home, 'agents.conf');
  writeFileSync(forgedConf, `${readFileSync(forgedConf, 'utf8')}\n[fast_lane]\nenabled = yes\nsafe_paths = docs/\n`);
  mkdirSync(join(forged.box.state, 'lanes'), { recursive: true });
  writeFileSync(join(forged.box.state, 'lanes', 'X-5.json'), JSON.stringify({ ticket: 'X-5', pr: 7, todo_at: '2026-01-01T00:00:00Z', fast_lane: { opening: 'fast', state: 'fast', head: forged.headOf() } }));
  mkdirSync(join(forged.box.state, 'validations'), { recursive: true });
  writeFileSync(join(forged.box.state, 'validations', 'X-5.json'), JSON.stringify({ ticket: 'X-5', at: '2026-01-02T10:00:00Z', pulls: [{ pr: 7, head: forged.headOf() }] }));
  writeFileSync(join(forged.box.home, 'tracker-moved'), '0');
  const kept = () => JSON.parse(readFileSync(join(forged.box.state, 'lanes', 'X-5.json'), 'utf8')).fast_lane.state;
  const waits = forged.merge(['-', '--dry-run'], other, 'Announcement.');
  assert.equal(waits.status, 3, waits.stderr);
  assert.equal(kept(), 'fast', 'a dry run writes nothing');
  assert.equal(forged.merge(['-'], other, 'Announcement.').status, 3);
  assert.equal(kept(), 'full', 'judged at the very commit, and sent back for good');
  rmSync(join(forged.box.state, 'merge-queue'), { recursive: true, force: true });
  // Merged once the host is free, on the full circuit, with its time measured from Todo.
  const live = forged.merge(['-'], {}, '**Live**: see it on the settings screen.');
  assert.equal(live.status, 0, live.stderr);
  const after = openLedger(join(forged.box.state, 'ledger.db'));
  const row = after.prepare("SELECT value, detail FROM events WHERE kind = 'ticket_measured'").get();
  after.close();
  assert.equal(JSON.parse(row.detail).lane, 'full');
  assert.ok(row.value > 0);
  rmSync(join(forged.box.state, 'lanes'), { recursive: true, force: true });
});

test('the example settings and the docs say every fast-lane key, and nothing fast is on by default', () => {
  const example = readFileSync(join(import.meta.dirname, '..', 'agents.example.conf'), 'utf8');
  assert.match(example, /\[fast_lane\]\nenabled = no\n/);
  const docs = readFileSync(join(import.meta.dirname, '..', 'docs', 'fast-lane.md'), 'utf8');
  assert.match(docs, /## Threat model: can a risky ticket take the fast lane\?/);
  assert.match(docs, /## What never qualifies/);
});
