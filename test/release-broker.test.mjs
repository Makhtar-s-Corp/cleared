import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { ORCH_HOME } from '../lib/conf.mjs';
import { openLedger } from '../lib/ledger.mjs';
import { reviewedPull } from './support.mjs';

async function fixture(t) {
  const pull = reviewedPull(['server/a.mjs']);
  const { home, state } = pull.box;
  chmodSync(state, 0o700);
  mkdirSync(join(home, 'serve'), { recursive: true });
  copyFileSync(join(ORCH_HOME, 'serve/release-broker.mjs'), join(home, 'serve/release-broker.mjs'));
  copyFileSync(join(ORCH_HOME, 'release-request.mjs'), join(home, 'release-request.mjs'));
  const socket = join(home, 'release.sock');
  const env = { ...pull.env, CLEARED_RELEASE_SOCKET: socket };
  const broker = spawn(process.execPath, [join(home, 'serve/release-broker.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  broker.stderr.on('data', (chunk) => errors += chunk);
  t.after(() => { broker.kill('SIGTERM'); });
  for (let i = 0; i < 100 && !existsSync(socket); i++) await pause(25);
  assert.ok(existsSync(socket), errors);
  const call = (args, input = '') => spawnSync(process.execPath, [join(home, 'release-request.mjs'), ...args], { env, input, encoding: 'utf8' });
  const events = () => {
    const db = openLedger(join(state, 'ledger.db'));
    try { return db.prepare("SELECT detail FROM events WHERE kind = 'release_request' ORDER BY event_id").all().map((r) => JSON.parse(r.detail)); }
    finally { db.close(); }
  };
  return { pull, call, events };
}

test('broker refuses an unapproved release, records the peer UID and commit, and alone can enter merge', async (t) => {
  const { pull, call, events } = await fixture(t);
  const direct = spawnSync(join(pull.box.home, 'merge-pr.sh'), ['7', 'X-5'], { env: { ...pull.env, ORCH_BROKER_SECRET: '' }, encoding: 'utf8' });
  assert.equal(direct.status, 6);
  assert.match(direct.stderr, /only the release broker/);
  mkdirSync(join(pull.box.state, 'validations'), { recursive: true });
  writeFileSync(join(pull.box.state, 'validations/X-5.json'), JSON.stringify({ ticket: 'X-5', at: '2026-01-01T00:00:00Z', pulls: [{ pr: 7, head: pull.headOf() }] }));
  const refused = call(['request_release', 'X-5', '7'], 'Announcement');
  assert.equal(refused.status, 6, refused.stderr);
  assert.match(refused.stderr, /not agreed/);
  assert.deepEqual(events().map((e) => [e.uid, e.accepted, e.commit]), [[process.getuid(), false, pull.headOf()]]);
});

test('broker refuses a socket directly in a sticky shared directory', () => {
  const pull = reviewedPull(['server/a.mjs']);
  const path = join('/tmp', `cleared-socket-rejected-${process.pid}.sock`);
  const broker = spawnSync(process.execPath, [join(ORCH_HOME, 'serve/release-broker.mjs')],
    { env: { ...pull.env, CLEARED_RELEASE_SOCKET: path }, encoding: 'utf8' });
  assert.notEqual(broker.status, 0);
  assert.match(broker.stderr, /socket parent must be service-owned/i);
  assert.equal(existsSync(path), false);
});

test('broker posts the request in service state and rejects approval before it or for another commit or PR', async (t) => {
  const { pull, call, events } = await fixture(t);
  const asked = call(['request_release', 'X-5', '7', '--ask'], 'Please approve this version.');
  assert.equal(asked.status, 0, asked.stderr + asked.stdout);
  const shown = JSON.parse(readFileSync(join(pull.box.state, 'validations/X-5.json'), 'utf8'));
  assert.equal(shown.pulls[0].head, pull.headOf());
  writeFileSync(join(pull.box.home, 'tracker-moved'), '8');
  assert.equal(call(['request_release', 'X-5', '7'], 'Announcement').status, 6);
  writeFileSync(join(pull.box.home, 'tracker-moved'), '0');
  assert.equal(call(['request_release', 'X-5', '8'], 'Announcement').status, 6);
  pull.git('commit', '-q', '--allow-empty', '-m', 'new version');
  pull.publish();
  assert.equal(call(['request_release', 'X-5', '7'], 'Announcement').status, 6);
  assert.equal(events().filter((e) => !e.accepted).length, 3);
});

test('broker accepts the shown, reviewed and approved commit and starts release monitoring', async (t) => {
  const { pull, call, events } = await fixture(t);
  const fakeGh = join(pull.box.home, 'bin/gh');
  const oldGh = readFileSync(fakeGh, 'utf8');
  const mergeCommand = `elif [ "$1 $2" = "pr merge" ]; then
  printf '%s\n' "$@" > "${join(pull.box.home, 'pr-merged')}"
  git -C "${pull.box.repo}" -c user.name=t -c user.email=t@localhost merge -q --no-ff --no-edit feat/w
  git -C "${pull.box.repo}" push -q origin main
  sha=$(git -C "${pull.box.repo}" rev-parse HEAD)
  jq --arg sha "$sha" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {mergeCommit:{oid:$sha},mergedAt:$at}' "${join(pull.box.home, 'pr-view.json')}" > "${join(pull.box.home, 'pr-view.next')}"
  mv "${join(pull.box.home, 'pr-view.next')}" "${join(pull.box.home, 'pr-view.json')}"`;
  writeFileSync(fakeGh, oldGh.replace(/elif \[ "\$1 \$2" = "pr merge" \]; then[^\n]*/, mergeCommand), { mode: 0o755 });
  const confPath = join(pull.box.home, 'agents.conf');
  writeFileSync(confPath, readFileSync(confPath, 'utf8') + '\n[release]\nhealth_command = true\nwatch_minutes = 1\ndeploy_grace_minutes = 0\n');
  assert.equal(call(['request_release', 'X-5', '7', '--ask'], 'Please approve this version.').status, 0);
  writeFileSync(join(pull.box.home, 'tracker-moved'), '0');
  const shipped = call(['request_release', 'X-5', '7'], 'What changed, where to see it, how to check.');
  assert.equal(shipped.status, 0, shipped.stderr + shipped.stdout);
  assert.ok(pull.merged());
  assert.equal(events().at(-1).accepted, true);
  const db = openLedger(join(pull.box.state, 'ledger.db'));
  try { assert.equal(db.prepare('SELECT status FROM releases WHERE ticket = ?').get('X-5').status, 'watching'); }
  finally { db.close(); }
});

test('broker refuses an empty announcement even after valid human approval', async (t) => {
  const { pull, call, events } = await fixture(t);
  assert.equal(call(['request_release', 'X-5', '7', '--ask'], 'Please approve this version.').status, 0);
  writeFileSync(join(pull.box.home, 'tracker-moved'), '0');
  const refused = call(['request_release', 'X-5', '7']);
  assert.equal(refused.status, 6, refused.stderr);
  assert.match(refused.stderr, /announcement is needed/);
  assert.equal(pull.merged(), null);
  assert.equal(events().at(-1).accepted, false);
});

test('manual rollback implementation refuses a direct call outside the broker', async (t) => {
  const { pull } = await fixture(t);
  const direct = spawnSync(process.execPath, [join(pull.box.home, 'lib/release.mjs'), 'rollback', 'X-5', '--yes'],
    { env: { ...pull.env, ORCH_BROKER_SECRET: '' }, encoding: 'utf8' });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /Only the release broker/);
});

test('lead action bridge exposes no merge or tracker move action', async (t) => {
  const { pull } = await fixture(t);
  const client = join(ORCH_HOME, 'lead-command.mjs');
  const env = { ...pull.env, ORCH_LEAD_LOCAL: '1' };
  const ping = spawnSync(process.execPath, [client, 'ping'], { env, encoding: 'utf8' });
  assert.equal(ping.status, 0, ping.stderr);
  for (const action of ['merge', 'move', 'write-validation']) {
    const refused = spawnSync(process.execPath, [client, action], { env, encoding: 'utf8' });
    assert.notEqual(refused.status, 0, action);
  }
  const forgedAuthor = spawnSync(process.execPath, [client, 'review', '7', 'X-5', 'forged-model'], { env, encoding: 'utf8' });
  assert.notEqual(forgedAuthor.status, 0);
});
