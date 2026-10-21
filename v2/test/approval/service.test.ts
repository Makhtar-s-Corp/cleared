// The whole service, started as `node src/main.ts` on a state directory with
// the lane's settings and key: the modules are wired, the proof file is read,
// the route answers. Nothing here waits for the grace; support.ts steps that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { SqliteUsers, USERS_TABLE, PROOF_FILE } from '../../src/modules/users.ts';
import { LocalTicketStore, TICKET_TABLES } from '../../src/tickets/local-store.ts';
import { applyTables } from '../../src/store/db.ts';
import { OWNER, lockBox } from './harness.ts';
import { head } from './support.ts';

const main = new URL('../../src/main.ts', import.meta.url).pathname;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function start(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcessWithoutNullStreams; base: string; stderr: () => string }> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [main], { env: { ...env, CLEARED_V2_PORT: String(port), CLEARED_V2_HOST: '127.0.0.1' } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const started = await Promise.race([once(child.stdout, 'data').then(([chunk]) => String(chunk)), once(child, 'exit').then(() => undefined)]);
    if (started !== undefined) return { child, base: `http://127.0.0.1:${port}`, stderr: () => stderr };
    if (attempt === 3 || !/is already in use/.test(stderr)) throw new Error(`the service did not start: ${stderr}`);
  }
}

async function prepare(options: { withKey: boolean }) {
  const box = lockBox();
  const db = new DatabaseSync(join(box.state, 'ledger.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  applyTables(db, [USERS_TABLE, ...TICKET_TABLES]);
  const users = new SqliteUsers(db, { params: { algorithm: 'argon2id', memory: 64, passes: 1, parallelism: 1, saltLength: 16, tagLength: 32 } });
  const owner = await users.add(OWNER, 'a long passphrase for the owner');
  const store = new LocalTicketStore(db, { stateDir: box.state });
  const ticket = await store.create({ title: 'Newest entry first', project: 'guestbook' }, { kind: 'agents', id: 'cleared-v2' });
  await store.move(ticket.id, 'Needs Approval', { kind: 'agents', id: 'cleared-v2' });
  db.close();
  mkdirSync(join(box.state, 'validations'), { recursive: true });
  const at = '2026-10-21T09:59:00.123456789Z';
  writeFileSync(join(box.state, 'validations', 'LOCAL-1.json'), JSON.stringify({ ticket: 'LOCAL-1', at, pulls: [{ pr: 7, head: head('a') }] }));
  const proof = 'c'.repeat(64);
  writeFileSync(join(box.state, PROOF_FILE), `${proof}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...box.env, ...(options.withKey ? { CLEARED_V2_APPROVAL_KEY: box.keyFile } : { CLEARED_V2_APPROVAL_KEY: join(box.dir, 'no-such-key') }) };
  delete env.CLEARED_RELEASE_SOCKET;
  return { box, env, owner, proof, body: JSON.stringify({ requestedAt: at, heads: [{ pr: 7, head: head('a') }] }) };
}

test('the started service accepts the owner\'s approval from the app, holds it, and lets Undo cancel it', async () => {
  const p = await prepare({ withKey: true });
  const { child, base } = await start(p.env);
  try {
    const call = (path: string, headers: Record<string, string>) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: p.body });
    assert.equal((await call('/api/tickets/LOCAL-1/approve', {})).status, 401, 'a session: no proof');
    assert.equal((await call('/api/tickets/LOCAL-1/approve', { [SERVICE_PROOF_HEADER]: 'd'.repeat(64), [SERVICE_USER_HEADER]: p.owner.id })).status, 401);
    const accepted = await call('/api/tickets/LOCAL-1/approve', { [SERVICE_PROOF_HEADER]: p.proof, [SERVICE_USER_HEADER]: p.owner.id });
    assert.equal(accepted.status, 202);
    const answer = await accepted.json() as { accepted: boolean; by: string; dueAt: string };
    assert.deepEqual([answer.accepted, answer.by], [true, p.owner.id]);
    assert.ok(Date.parse(answer.dueAt) - Date.now() > 50_000, 'written a minute from now, not at once');
    const undone = await call('/api/tickets/LOCAL-1/approve/undo', { [SERVICE_PROOF_HEADER]: p.proof, [SERVICE_USER_HEADER]: p.owner.id });
    assert.equal(undone.status, 200);
    assert.equal(p.box.tracker('state', 'LOCAL-1').stdout.trim(), 'Needs Approval');
    assert.equal(p.box.tracker('identity').stdout.trim(), 'app');
    const events = new DatabaseSync(join(p.box.state, 'ledger.db'), { readOnly: true });
    assert.deepEqual((events.prepare("SELECT detail FROM events WHERE kind = 'app_gesture' ORDER BY event_id").all() as { detail: string }[]).map((r) => (JSON.parse(r.detail) as { result: string }).result), ['started', 'undone']);
    events.close();
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  }
});

test('a started service with no signing key answers 503 and says what to run, and writes nothing', async () => {
  const p = await prepare({ withKey: false });
  const { child, base, stderr } = await start(p.env);
  try {
    const response = await fetch(`${base}/api/tickets/LOCAL-1/approve`, { method: 'POST', headers: { 'content-type': 'application/json', [SERVICE_PROOF_HEADER]: p.proof, [SERVICE_USER_HEADER]: p.owner.id }, body: p.body });
    assert.equal(response.status, 503);
    assert.match(String((await response.json() as { error: string }).error), /npm run setup/);
    assert.match(stderr(), /npm run setup/);
    assert.equal(p.box.tracker('state', 'LOCAL-1').stdout.trim(), 'Needs Approval');
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  }
  assert.ok(readFileSync(join(p.box.state, PROOF_FILE), 'utf8').trim() === p.proof, 'the existing proof was left as it was');
});
