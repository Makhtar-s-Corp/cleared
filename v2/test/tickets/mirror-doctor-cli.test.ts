// `node scripts/doctor.ts mirror` (issue #400): the section run by the doctor
// against the fake GitHub on loopback, port 0. Its exit code says whether a
// check failed, and the token is in no output on any path: only in the
// authorization header the fake records.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIRROR_TABLES } from '../../src/tickets/mirror.ts';
import { tempDir } from '../workspace/git.ts';
import { FakeGitHub } from './fakes/github.ts';

const DOCTOR = new URL('../../scripts/doctor.ts', import.meta.url).pathname;
const REPO = 'org/guestbook';
const TOKEN = randomBytes(20).toString('hex');
const STATUS_LABELS = ['Todo', 'In Progress', 'In Review', 'Needs Approval', 'Ready to Ship', 'Done'].map((s) => `status:${s}`);

const fake = new FakeGitHub({ clock: () => new Date().toISOString(), accounts: { [TOKEN]: { login: 'cleared-bot', type: 'Bot' } }, repos: [REPO] });
let api = '';
before(async () => { api = await fake.listen(); });
after(() => fake.close());

function setup(language = 'en') {
  const root = tempDir('mirror-doctor-cli');
  const state = join(root, 'state');
  mkdirSync(state, { recursive: true });
  const tokenFile = join(root, 'github-token');
  writeFileSync(tokenFile, TOKEN);
  chmodSync(tokenFile, 0o600);
  const db = new DatabaseSync(join(state, 'ledger.db'));
  for (const table of MIRROR_TABLES) db.exec(table);
  const at = new Date(Date.now() - 2 * 60_000).toISOString();
  db.prepare('INSERT INTO mirror_trackers (tracker, started_at, read_at) VALUES (?, ?, ?)').run(`github:${REPO}`, at, at);
  db.close();
  fake.repoMeta(REPO).labels = [...STATUS_LABELS];
  fake.repoMeta(REPO).has_issues = true;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: root, CLEARED_STATE_DIR: state, CLEARED_V2_STATE_DIR: state,
    CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: join(root, 'checkout'),
    CLEARED_V2_REPO: REPO, CLEARED_V2_REPO_URL: `https://github.com/${REPO}.git`,
    CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: tokenFile, CLEARED_V2_MIRROR_GITHUB_API: api, CLEARED_V2_APP_LANGUAGE: language,
  };
  return { root, env, tokenFile };
}

function doctor(env: NodeJS.ProcessEnv, args = ['mirror']): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DOCTOR, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.stderr.on('data', (chunk) => { err += String(chunk); });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const tokenless = (run: { out: string; err: string }) => {
  assert.ok(!run.out.includes(TOKEN) && !run.err.includes(TOKEN), 'the token is printed');
  for (const request of fake.requests) assert.ok(!request.path.includes(TOKEN));
};

test('all well: exit 0, four checks passed, the token printed nowhere and sent in the header only', async () => {
  fake.requests.length = 0;
  const { env } = setup();
  const run = await doctor(env);
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /^== mirror: the GitHub mirror \(milestone 4\)/m);
  assert.equal(run.out.match(/^PASS /gm)?.length, 4, run.out);
  assert.match(run.out, /^doctor: all checks passed$/m);
  tokenless(run);
  assert.ok(fake.requests.length > 0 && fake.requests.every((r) => r.auth === `Bearer ${TOKEN}`));
});

test('in French: the section\'s words follow CLEARED_V2_APP_LANGUAGE', async () => {
  const { env } = setup('fr');
  const run = await doctor(env);
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /^== mirror\s: le miroir GitHub \(jalon 4\)/m);
  assert.match(run.out, /^PASS org\/guestbook\s: GitHub répond/m);
});

test('each failing path exits 1 and prints the token nowhere', async () => {
  const unreadable = setup();
  const runs = [await doctor({ ...unreadable.env, CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: join(unreadable.root, 'nowhere') })];
  const refused = setup();
  writeFileSync(refused.tokenFile, `${TOKEN}x`);
  runs.push(await doctor(refused.env));
  const lost = setup();
  runs.push(await doctor({ ...lost.env, CLEARED_V2_REPO: 'org/nowhere', CLEARED_V2_REPO_URL: 'https://github.com/org/nowhere.git' }));
  const unlabelled = setup();
  fake.repoMeta(REPO).labels = ['status:Todo'];
  runs.push(await doctor(unlabelled.env));
  const offsite = setup();
  runs.push(await doctor({ ...offsite.env, CLEARED_V2_MIRROR_GITHUB_API: 'https://example.com' }));
  for (const run of runs) {
    assert.equal(run.code, 1, run.out + run.err);
    assert.match(run.out, /^FAIL /m, run.out);
    assert.match(run.out, /^doctor: \d+ check\(s\) failed$/m);
    tokenless(run);
  }
});

test('not configured: the section says so and does not fail', async () => {
  const { env } = setup();
  const run = await doctor({ ...env, CLEARED_V2_MIRROR_GITHUB_TOKEN_FILE: '' });
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /^NOT RUN The GitHub mirror is off/m);
});

test('the section is known to the doctor and runs only when named', async () => {
  const run = await doctor({ PATH: process.env.PATH }, ['nothing']);
  assert.equal(run.code, 64);
  assert.match(run.err, /\|mirror\b/);
});
