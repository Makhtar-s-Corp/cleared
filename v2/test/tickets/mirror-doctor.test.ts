// The GitHub mirror's doctor section (issue #400, docs/v2/milestone-4-plan.md
// section 12): the token file read and never printed, each repository
// reached, its status labels, and the mirror's last pass, against the fake
// GitHub on loopback and a ledger in a temporary folder; English and French.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { githubMirrorChecks, type MirrorCheck } from '../../src/tickets/mirror-doctor.ts';
import { MIRROR_TABLES } from '../../src/tickets/mirror.ts';
import { tempDir } from '../workspace/git.ts';
import { FakeGitHub, type FakeAccount } from './fakes/github.ts';

const REPO = 'org/guestbook';
const OTHER = 'org/filter-api';
const BOT: FakeAccount = { login: 'cleared-bot', type: 'Bot' };
const TOKEN = randomBytes(20).toString('hex');
const STATUS_LABELS = ['Todo', 'In Progress', 'In Review', 'Needs Approval', 'Ready to Ship', 'Done'].map((s) => `status:${s}`);
const NOW = new Date('2026-10-25T15:00:00.000Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const fake = new FakeGitHub({ clock: () => NOW.toISOString(), accounts: { [TOKEN]: BOT }, repos: [REPO, OTHER] });
let api = '';

before(async () => { api = await fake.listen(); });
after(() => fake.close());

function reset(): void {
  for (const repo of [REPO, OTHER]) {
    const meta = fake.repoMeta(repo);
    meta.has_issues = true;
    meta.permissions = { admin: false, maintain: false, push: true, triage: true, pull: true };
    meta.labels = ['bug', ...STATUS_LABELS];
  }
  fake.requests.length = 0;
}

type Setup = { root: string; env: NodeJS.ProcessEnv; tokenFile: string; ledger: string };

// A one-service workspace on REPO, the token in a private file, the ledger's
// folder made, no ledger yet.
function setup(extra: NodeJS.ProcessEnv = {}): Setup {
  reset();
  const root = tempDir('mirror-doctor');
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  const tokenFile = join(root, 'github-token');
  writeFileSync(tokenFile, `${TOKEN}\n`);
  chmodSync(tokenFile, 0o600);
  const env: NodeJS.ProcessEnv = {
    HOME: root, CLEARED_STATE_DIR: state, CLEARED_V2_STATE_DIR: state,
    CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: join(root, 'checkout'),
    CLEARED_V2_REPO: REPO, CLEARED_V2_REPO_URL: `https://github.com/${REPO}.git`,
    CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: tokenFile, CLEARED_V2_MIRROR_GITHUB_API: api,
    CLEARED_V2_APP_LANGUAGE: 'en',
    ...extra,
  };
  return { root, env, tokenFile, ledger: join(state, 'ledger.db') };
}

function passes(ledger: string, rows: Record<string, string>): void {
  const db = new DatabaseSync(ledger);
  for (const table of MIRROR_TABLES) db.exec(table);
  for (const [tracker, readAt] of Object.entries(rows)) db.prepare('INSERT INTO mirror_trackers (tracker, started_at, read_at) VALUES (?, ?, ?)').run(tracker, ago(24 * 60), readAt);
  db.close();
}

// The lines with their non-breaking spaces made plain, for the regexps.
const plain = (checks: readonly MirrorCheck[]) => checks.map((c) => ({ level: c.level, text: c.text.replace(/ | /g, ' ') }));
const levels = (checks: readonly MirrorCheck[]) => checks.map((c) => c.level);
const run = (env: NodeJS.ProcessEnv, fetcher?: typeof fetch) => githubMirrorChecks({ env, now: NOW, ...(fetcher ? { fetch: fetcher } : {}) });

function noToken(checks: readonly MirrorCheck[]): void {
  for (const check of checks) assert.ok(!check.text.includes(TOKEN), `the token in: ${check.text}`);
  for (const request of fake.requests) {
    assert.equal(request.auth, `Bearer ${TOKEN}`);
    assert.ok(!request.path.includes(TOKEN));
  }
}

test('no token file named: the GitHub mirror is off, nothing is checked and nothing fails', async () => {
  const { env } = setup({ CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: '' });
  const checks = plain(await run(env));
  assert.deepEqual(levels(checks), ['off']);
  assert.match(checks[0]?.text ?? '', /GitHub mirror is off: CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE is not set/);
  assert.equal(fake.requests.length, 0);
});

test('all well: the token file read, the repository reached with its rights, every status label, a recent pass', async () => {
  const { env, ledger } = setup();
  passes(ledger, { [`github:${REPO}`]: ago(3) });
  const checks = plain(await run(env));
  assert.deepEqual(levels(checks), ['pass', 'pass', 'pass', 'pass'], JSON.stringify(checks));
  assert.match(checks[0]?.text ?? '', /CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE names can be read and is not empty \(its content is not shown\)/);
  assert.match(checks[1]?.text ?? '', /^org\/guestbook: GitHub answers, its issues are on, and the token's account can label and close them/);
  assert.match(checks[2]?.text ?? '', /^org\/guestbook: every status label a person picks on GitHub's page exists: status:In Progress, status:In Review, status:Needs Approval, status:Ready to Ship\.$/);
  assert.match(checks[3]?.text ?? '', /^org\/guestbook: the mirror's last full pass was 3 min ago/);
  noToken(checks);
  assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`), ['GET /repos/org/guestbook', 'GET /repos/org/guestbook/labels'], 'read only, nothing written');
});

test('in French, by default', async () => {
  const { env, ledger } = setup({ CLEARED_V2_APP_LANGUAGE: '' });
  passes(ledger, { [`github:${REPO}`]: ago(3) });
  fake.repoMeta(REPO).labels = ['status:Todo'];
  const checks = plain(await run(env));
  assert.deepEqual(levels(checks), ['pass', 'pass', 'fail', 'pass']);
  assert.match(checks[0]?.text ?? '', /peut être lu et n'est pas vide/);
  assert.match(checks[1]?.text ?? '', /^org\/guestbook : GitHub répond/);
  assert.match(checks[2]?.text ?? '', /^org\/guestbook : il manque les étiquettes de statut status:In Progress, status:In Review/);
  assert.match(checks[3]?.text ?? '', /^org\/guestbook : dernier passage complet du miroir : il y a 3 min\.$/);
});

test('the token file missing, or empty: one failure, no request, never the token', async () => {
  const missing = setup();
  const checks = plain(await run({ ...missing.env, CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: join(missing.root, 'nowhere') }));
  assert.deepEqual(levels(checks), ['fail']);
  assert.match(checks[0]?.text ?? '', /CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE names cannot be read/);
  const empty = setup();
  writeFileSync(empty.tokenFile, '  \n');
  const none = plain(await run(empty.env));
  assert.deepEqual(levels(none), ['fail']);
  assert.match(none[0]?.text ?? '', /holds nothing/);
  assert.equal(fake.requests.length, 0);
});

test('a token file other accounts can read, or a link to it: said as notices, the checks go on', async () => {
  const { root, env, tokenFile } = setup();
  chmodSync(tokenFile, 0o644);
  const link = join(root, 'token-link');
  symlinkSync(tokenFile, link);
  const checks = plain(await run({ ...env, CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: link }));
  assert.deepEqual(levels(checks).slice(0, 3), ['pass', 'notice', 'notice'], JSON.stringify(checks));
  assert.match(checks[1]?.text ?? '', /is a link/);
  assert.match(checks[2]?.text ?? '', /can be read by other accounts of this machine \(mode 644\): run chmod 600 on it/);
  assert.equal(checks.filter((c) => c.level === 'fail').length, 0);
  noToken(checks);
});

test('a setting the service refuses fails with the service\'s own line, and nothing is asked of GitHub', async () => {
  const { env } = setup({ CLEARED_V2_MIRROR_GITHUB_API: 'https://example.com' });
  const checks = plain(await run(env));
  assert.deepEqual(levels(checks), ['pass', 'fail']);
  assert.match(checks[1]?.text ?? '', /The service refuses the mirror's settings, so the mirror stays off: CLEARED_V2_MIRROR_GITHUB_API must be https:\/\/api\.github\.com or an address on loopback/);
  assert.equal(fake.requests.length, 0);
});

test('no project named: the mirror has no repository to check', async () => {
  const { env } = setup({ CLEARED_V2_PROJECT: '' });
  const checks = plain(await run(env));
  assert.deepEqual(levels(checks), ['pass', 'fail']);
  assert.match(checks[1]?.text ?? '', /needs the project the service runs \(CLEARED_V2_PROJECT or CLEARED_V2_WORKSPACE\)/);
});

test('GitHub refuses the token: 401 said, the labels not read, the token in no line', async () => {
  const { env, tokenFile } = setup();
  writeFileSync(tokenFile, randomBytes(20).toString('hex'));
  const checks = plain(await run(env));
  assert.deepEqual(levels(checks), ['pass', 'fail', 'notice'], JSON.stringify(checks));
  assert.match(checks[1]?.text ?? '', /^org\/guestbook: GitHub refuses the token \(401\): it is wrong, expired or revoked/);
  assert.deepEqual(fake.requests.map((r) => r.path.split('?')[0]), ['/repos/org/guestbook']);
  for (const check of checks) assert.ok(!check.text.includes(TOKEN));
});

test('a repository GitHub does not show, or one that does not answer', async () => {
  const unknown = setup({ CLEARED_V2_REPO: 'org/nowhere', CLEARED_V2_REPO_URL: 'https://github.com/org/nowhere.git' });
  const checks = plain(await run(unknown.env));
  assert.match(checks[1]?.text ?? '', /^org\/nowhere: GitHub answered 404: the repository does not exist, or the token cannot see it/);
  assert.equal(checks[1]?.level, 'fail');

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const silent = setup({ CLEARED_V2_MIRROR_GITHUB_API: `http://127.0.0.1:${port}` });
  const quiet = plain(await run(silent.env));
  assert.equal(quiet[1]?.level, 'fail');
  assert.match(quiet[1]?.text ?? '', new RegExp(`^org/guestbook: no answer from http://127\\.0\\.0\\.1:${port}`));

  const odd = setup();
  const teapot: typeof fetch = async () => new Response('{}', { status: 503 });
  const busy = plain(await run(odd.env, teapot));
  assert.match(busy[1]?.text ?? '', /^org\/guestbook: GitHub answered 503\./);
});

test('issues turned off, or an account that can only read them: each fails', async () => {
  const off = setup();
  fake.repoMeta(REPO).has_issues = false;
  const checks = plain(await run(off.env));
  assert.equal(checks[1]?.level, 'fail');
  assert.match(checks[1]?.text ?? '', /its issues are turned off in the repository's settings/);

  const reader = setup();
  fake.repoMeta(REPO).permissions = { admin: false, maintain: false, push: false, triage: false, pull: true };
  const read = plain(await run(reader.env));
  assert.equal(read[1]?.level, 'fail');
  assert.match(read[1]?.text ?? '', /can read its issues but not label or close them: it needs the triage role at least/);

  const unsaid = setup();
  delete fake.repoMeta(REPO).permissions;
  const silent = plain(await run(unsaid.env));
  assert.equal(silent[1]?.level, 'notice');
  assert.match(silent[1]?.text ?? '', /GitHub does not say what the token's account may do here/);
});

test('Todo and Done need no label: an open issue with none is in Todo, and Done is the issue closed', async () => {
  const { env } = setup();
  fake.repoMeta(REPO).labels = STATUS_LABELS.filter((label) => label !== 'status:Todo' && label !== 'status:Done');
  const checks = plain(await run(env));
  assert.equal(checks[2]?.level, 'pass', JSON.stringify(checks));
});

test('missing status labels are named and fail; labels are read on every page; the states the settings name are the ones looked for', async () => {
  const { env } = setup();
  fake.repoMeta(REPO).labels = [...Array.from({ length: 140 }, (_, i) => `area:${i}`), 'status:Todo', 'status:Done', 'Status:In Review', 'status:In Progress '];
  const checks = plain(await run(env));
  assert.equal(checks[2]?.level, 'fail');
  assert.match(checks[2]?.text ?? '', /^org\/guestbook: missing status labels: status:In Progress, status:In Review, status:Needs Approval, status:Ready to Ship\. /);
  assert.match(checks[2]?.text ?? '', /no one can pick that state on GitHub's page/);
  assert.ok(fake.requests.filter((r) => r.path.startsWith('/repos/org/guestbook/labels')).length >= 2, 'the second page is read');

  const named = setup();
  const conf = join(named.root, 'agents.conf');
  writeFileSync(conf, '[tracker]\nreview_state = Code Review\n');
  fake.repoMeta(REPO).labels = STATUS_LABELS;
  const custom = plain(await run({ ...named.env, CLEARED_CONF: conf }));
  assert.equal(custom[2]?.level, 'fail');
  assert.match(custom[2]?.text ?? '', /missing status labels: status:Code Review\./);
});

test('the last pass: none yet is a notice; older than the heartbeat\'s tracker limit fails, in a time a person reads', async () => {
  const fresh = setup();
  const none = plain(await run(fresh.env));
  assert.equal(none[3]?.level, 'notice');
  assert.match(none[3]?.text ?? '', /^org\/guestbook: the ledger holds no pass of the mirror yet/);

  const stale = setup();
  passes(stale.ledger, { [`github:${REPO}`]: ago(125) });
  const late = plain(await run(stale.env));
  assert.equal(late[3]?.level, 'fail');
  assert.match(late[3]?.text ?? '', /the mirror's last full pass was 2h ago, past the limit of 10 min \(CLEARED_V2_HEARTBEAT_TRACKER_MINUTES\): is the service running\?/);

  const tolerant = setup({ CLEARED_V2_HEARTBEAT_TRACKER_MINUTES: '180' });
  passes(tolerant.ledger, { [`github:${REPO}`]: ago(125) });
  assert.equal(plain(await run(tolerant.env))[3]?.level, 'pass');
});

test('the ledger is only read: no table is made in it, and none is made where there was no ledger', async () => {
  const { env, ledger } = setup();
  const db = new DatabaseSync(ledger);
  db.exec('CREATE TABLE other (x)');
  db.close();
  const checks = plain(await run(env));
  assert.equal(checks[3]?.level, 'notice');
  const after = new DatabaseSync(ledger, { readOnly: true });
  const tables = (after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  after.close();
  assert.deepEqual(tables, ['other']);
});

test('a workspace of several services: each repository once, a folder service sharing its repository\'s check', async () => {
  const { root, env, ledger } = setup();
  const file = join(root, 'workspace.conf');
  writeFileSync(file, [
    '[workspace]', 'id = guestbook', '',
    '[service guestbook]', 'kind = repository', `repository = ${REPO}`, `url = https://github.com/${REPO}.git`, '',
    '[service admin]', 'kind = folder', `repository = ${REPO}`, `url = https://github.com/${REPO}.git`, 'path = admin', '',
    '[service filter-api]', 'kind = repository', `repository = ${OTHER}`, `url = https://github.com/${OTHER}.git`, '',
  ].join('\n'));
  passes(ledger, { [`github:${REPO}`]: ago(2), [`github:${OTHER}`]: ago(4) });
  const checks = plain(await run({ ...env, CLEARED_V2_PROJECT: '', CLEARED_V2_WORKSPACE: file }));
  assert.deepEqual(levels(checks), ['pass', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass'], JSON.stringify(checks));
  assert.deepEqual(checks.slice(1).map((c) => c.text.split(':')[0]), [REPO, REPO, REPO, OTHER, OTHER, OTHER]);
  assert.match(checks[6]?.text ?? '', /4 min ago/);
});
