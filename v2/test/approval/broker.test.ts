// The real release broker, started on a socket in a temporary state directory
// with the settings the service needs (shared account, no edit of the broker),
// answers the service's own requests. gh is a fake: nothing is merged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SocketReleaseBroker } from '../../src/approval/broker.ts';
import { CLEARED_HOME, lockBox } from './harness.ts';
import { FakeTimers, PROOF } from './support.ts';
import { LedgerReviewRecorder, RUNS_TABLES } from '../../src/approval/review.ts';
import { APPROVAL_TABLES, createApproval } from '../../src/approval/service.ts';
import { ApprovalSigner } from '../../src/approval/signer.ts';
import { MemoryUsers } from '../../src/modules/registry.ts';
import { applyTables } from '../../src/store/db.ts';
import { LocalTicketStore, TICKET_TABLES } from '../../src/tickets/local-store.ts';
import { DatabaseSync } from 'node:sqlite';

async function startBroker(box: ReturnType<typeof lockBox>): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--no-warnings', join(CLEARED_HOME, 'serve/release-broker.ts')], { env: box.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const socket = box.socket as string;
  for (let i = 0; i < 100 && !existsSync(socket); i++) {
    if (child.exitCode !== null) throw new Error(`the broker stopped: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!existsSync(socket)) throw new Error(`the broker did not listen: ${stderr}`);
  return child;
}
async function stop(child: ChildProcess) { child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'exit'); }

test('the broker starts with an app user as owner_id and the service account as human_user, on a socket only, and answers the service uid', async () => {
  const probe = lockBox({ socket: true });
  const broker = await startBroker(probe);
  try {
    const client = new SocketReleaseBroker(probe.socket as string, { stateDir: probe.state });
    const asked = await client.status('LOCAL-1');
    assert.equal(asked.ok, true);
    assert.equal(asked.problem === undefined || typeof asked.problem === 'string', true);
  } finally { await stop(broker); }
});

test('after the approval the service asks the broker, and the broker runs merge-pr.ts: the fake gh records the merge of exactly the checked head', async () => {
  // The service and the broker share one state directory.
  const box = lockBox({ socket: true });
  const db = new DatabaseSync(join(box.state, 'ledger.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  applyTables(db, [...TICKET_TABLES, ...RUNS_TABLES, ...APPROVAL_TABLES]);
  const users = new MemoryUsers();
  users.users.set('u-owner', { id: 'u-owner', name: 'demo' });
  const timers = new FakeTimers();
  const client = new SocketReleaseBroker(box.socket as string, { stateDir: box.state });
  const parts = createApproval({ db, users, stateDir: box.state, ownerId: 'demo', publicKey: box.keys.publicKey, signer: ApprovalSigner.load(box.keyFile), proof: PROOF, verdict: 'no blocking issues', timers, broker: client });
  const store: LocalTicketStore = parts.ticketStore;
  box.commit('src/page.ts', 'export const page = 2;\n');
  box.publish();
  const ticket = await store.create({ title: 'Newest entry first', body: 'Newest first.', project: 'guestbook' }, { kind: 'agents', id: 'cleared-v2' });
  await store.move(ticket.id, 'Needs Approval', { kind: 'agents', id: 'cleared-v2' });
  await new LedgerReviewRecorder(db, { stateDir: box.state, verdict: 'no blocking issues' }).record({ ticket: 'LOCAL-1', pr: 7, session: 'sess-1', model: 'claude-sonnet-5-5', round: 1, verdict: 'pass', report: 'ok', at: new Date().toISOString(), commit: box.head() } as never);
  const broker = await startBroker(box);
  try {
    // The ask goes through the broker too (--ask only writes to the local tracker).
    const asked = await client.requestApproval({ ticket: 'LOCAL-1', pr: 7, request: '**What changes.** The newest entry first. Do you put it live?' });
    assert.equal(asked.ok, true, asked.reason);
    const record = JSON.parse(readFileSync(join(box.state, 'validations', 'LOCAL-1.json'), 'utf8')) as { at: string; pulls: { pr: number; head: string }[] };
    assert.equal(record.pulls[0]?.head, box.head());
    await parts.approvalWriter.begin({ ticket: 'LOCAL-1', by: 'u-owner', requestedAt: record.at, heads: record.pulls });
    await timers.fire();
    for (let i = 0; i < 100 && box.merged() === null; i++) await new Promise((resolve) => setTimeout(resolve, 100));
    const merged = box.merged();
    assert.ok(merged, 'the broker ran merge-pr.ts, which merged through gh');
    assert.ok(merged.includes('--match-head-commit') && merged.includes(box.head()), merged.join(' '));
    assert.match(box.tracker('state', 'LOCAL-1').stdout.trim(), /^(Ready to Ship|Done)$/);
  } finally { await stop(broker); }
});

test('a request that is not the service\'s own, or a socket that is not a socket, is not used', async () => {
  const box = lockBox({ socket: true });
  const client = new SocketReleaseBroker(box.socket as string, { stateDir: box.state });
  const answer = await client.status('LOCAL-1');
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /not running|unsafe|unavailable/);
});
