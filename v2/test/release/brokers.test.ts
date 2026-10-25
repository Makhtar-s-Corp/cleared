// Two release brokers, one per service, on one shared ledger
// (docs/v2/milestone-2-plan.md, decision 21, lane 16): each started with
// ORCH_LEDGER naming the service's ledger and its own state folder, over its
// own temporary repository, both pull requests numbered 7. The real v1
// scripts (serve/release-broker.mjs, ask-validation.ts, merge-pr.ts,
// tracker.ts, lib/release.mjs) run unchanged; gh and docker are fakes, so
// nothing reaches GitHub or Docker. The train's own pieces drive them: the
// per-service locks of approval/service.ts and the train's approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RUNS_TABLES } from '../../src/approval/review.ts';
import { APPROVAL_TABLES, createApproval, serviceLocks, TrainApprovals, type Environment } from '../../src/approval/service.ts';
import { ApprovalSigner } from '../../src/approval/signer.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import { MemoryUsers } from '../../src/modules/registry.ts';
import { reviewRun } from '../../src/release/lock.ts';
import { TrainStore, type Stop } from '../../src/release/store.ts';
import { applyTables } from '../../src/store/db.ts';
import { LocalTicketStore, TICKET_TABLES } from '../../src/tickets/local-store.ts';
import type { ServiceConfig, WorkspaceConfig } from '../../src/workspace/config.ts';
import { CLEARED_HOME, OWNER, lockBox, lockConf } from '../approval/harness.ts';
import { FakeTimers, PROOF } from '../approval/support.ts';

async function startBroker(env: NodeJS.ProcessEnv, socket: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--no-warnings', join(CLEARED_HOME, 'serve/release-broker.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  for (let i = 0; i < 100 && !existsSync(socket); i++) {
    if (child.exitCode !== null) throw new Error(`the broker stopped: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!existsSync(socket)) throw new Error(`the broker did not listen: ${stderr}`);
  return child;
}
async function stop(child: ChildProcess) { child.kill('SIGTERM'); if (child.exitCode === null) await once(child, 'exit'); }

const ANNOUNCEMENT = 'Ticket LOCAL-1: Held for review\n\nAn entry the filter flags is held for review. Open the guestbook and post a flagged entry.';
// What the pull request prints, kept for the pull request's raw lines.
const said = (label: string, run: { status: number | null; stdout: string; stderr: string }) =>
  console.log(`[${label}] exit ${run.status}\n${run.stdout.trim()}\n${run.stderr.trim()}`.trim());

test('two brokers on one shared ledger: each finds the ticket and its own review, the train lands them in order, and request_rollback from the service account reverts the provider\'s own merge after the consumer\'s', { timeout: 120_000 }, async () => {
  const provider = lockBox({ socket: true });                    // the filter API
  const consumer = lockBox({ socket: true });                    // the guestbook
  const ledger = join(provider.state, 'ledger.db');
  // One owner, one key: the consumer's broker reads the same public key.
  writeFileSync(consumer.confFile, lockConf({ publicKey: provider.keys.publicKey, socket: consumer.socket as string }));
  const envOf = (box: typeof provider) => ({ ...box.env, ORCH_LEDGER: ledger, CLEARED_LEDGER: ledger });

  const db = new DatabaseSync(ledger);
  db.exec('PRAGMA busy_timeout = 5000');
  applyTables(db, [...TICKET_TABLES, ...RUNS_TABLES, ...APPROVAL_TABLES, INBOX_TABLE]);
  const users = new MemoryUsers();
  users.users.set('u-owner', { id: 'u-owner', name: OWNER });
  const timers = new FakeTimers();
  const signer = ApprovalSigner.load(provider.keyFile);
  const parts = createApproval({ db, users, stateDir: provider.state, ownerId: OWNER, publicKey: provider.keys.publicKey, signer, proof: PROOF, verdict: 'no blocking issues', timers, broker: null });
  const store: LocalTicketStore = parts.ticketStore;
  const environment: Environment = { ...parts, conf: { ownerId: OWNER, publicKey: provider.keys.publicKey, states: store.states } as Environment['conf'], signer, stateDir: provider.state, users, proof: PROOF };
  const svc = (name: string, box: typeof provider, consumes: string[] = []): ServiceConfig => ({
    name, kind: 'repository', repo: `example-org/${name}`, url: 'https://example.invalid/x.git', base: 'main', path: null, dir: box.repo,
    healthUrl: null, sensitivity: 'normal', consumes, run: null, contract: null, brokerSocket: box.socket as string, brokerState: box.state,
  });
  const workspace: WorkspaceConfig = { id: 'guestbook', name: 'Guestbook', file: null, services: [svc('guestbook', consumer, ['filter-api']), svc('filter-api', provider)] };
  const locks = serviceLocks(db, workspace, { env: envOf(provider), environment });
  const filterLock = locks(workspace.services[1] as ServiceConfig);
  const guestbookLock = locks(workspace.services[0] as ServiceConfig);

  const brokers = [await startBroker(envOf(provider), provider.socket as string), await startBroker(envOf(consumer), consumer.socket as string)];
  try {
    provider.commit('src/check.ts', 'export const held = true;\n');
    provider.publish();
    consumer.commit('src/page.ts', 'export const page = 2;\n');
    consumer.publish();
    const ticket = await store.create({ title: 'Held for review', body: 'An entry the filter flags is held for review.', project: 'guestbook' }, { kind: 'agents', id: 'cleared-v2' });
    assert.equal(ticket.id, 'LOCAL-1');
    await store.move(ticket.id, 'In Review', { kind: 'agents', id: 'cleared-v2' });

    // The publish step of the train: each review recorded where that service's merge-pr.ts reads it, then each approval asked on its own broker.
    const at = new Date().toISOString();
    await filterLock.recordReview({ ticket: ticket.id, pr: 7, session: reviewRun('3f0c5e2a-9d1b-4c47-8a55-7b2f1e0d9c64', 'filter-api'), model: 'claude-sonnet-5-5', verdict: 'pass', round: 1, report: 'Read the diff and ran the tests.', at, commit: provider.head(), verdictPhrase: 'no blocking issues' });
    await guestbookLock.recordReview({ ticket: ticket.id, pr: 7, session: reviewRun('3f0c5e2a-9d1b-4c47-8a55-7b2f1e0d9c64', 'guestbook'), model: 'claude-sonnet-5-5', verdict: 'pass', round: 1, report: 'Read the diff and ran the tests.', at, commit: consumer.head(), verdictPhrase: 'no blocking issues' });
    assert.ok(existsSync(join(provider.state, 'reports')) && existsSync(join(consumer.state, 'reports')), 'each report in its own broker\'s folder');
    const filterAsked = await filterLock.ask({ ticket: ticket.id, pr: 7, request: ANNOUNCEMENT });
    const guestbookAsked = await guestbookLock.ask({ ticket: ticket.id, pr: 7, request: ANNOUNCEMENT });
    assert.notEqual(filterAsked.requestedAt, guestbookAsked.requestedAt, 'two records, two requests');
    assert.equal(provider.tracker('state', ticket.id).stdout.trim(), 'Needs Approval');

    const dry = (box: typeof provider, label: string) => {
      // As the broker runs it: with the secret it wrote in its own state folder at start.
      const secret = readFileSync(join(box.state, 'release-broker.secret'), 'utf8');
      const run = box.run('merge-pr.ts', ['7', ticket.id, '-', '--dry-run'], { ORCH_LEDGER: ledger, ORCH_BROKER_SECRET: secret, CLEARED_BROKER_SECRET: secret }, ANNOUNCEMENT);
      said(label, run);
      return run;
    };
    assert.equal(dry(provider, 'filter-api before approval').status, 6, 'asked is not agreed');

    // The owner's one gesture, held for the grace, then written bound to the first service's record.
    const stops: Stop[] = [
      { service: 'filter-api', pr: { number: 7, url: 'https://example.invalid/filter-api/pull/7' }, head: provider.head(), requestedAt: filterAsked.requestedAt, state: 'waiting', at: null, note: null, signed: false, askedAt: null, mergedAt: null, next: null },
      { service: 'guestbook', pr: { number: 7, url: 'https://example.invalid/guestbook/pull/7' }, head: consumer.head(), requestedAt: guestbookAsked.requestedAt, state: 'waiting', at: null, note: null, signed: false, askedAt: null, mergedAt: null, next: null },
    ];
    const item = new InboxStore(db).addRelease({
      ticket: ticket.id, project: 'guestbook', title: ticket.title, announcement: ANNOUNCEMENT, requestedAt: filterAsked.requestedAt,
      pr: { number: 7, url: stops[0]!.pr.url, checks: 'passed' }, heads: stops.map((s) => ({ pr: 7, head: s.head })),
      captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [],
    });
    new TrainStore(db).add({ item: item.id, ticket: ticket.id, project: 'guestbook', state: 'waiting', stops, compatibility: null, blocked: null, announcement: ANNOUNCEMENT });
    const approvals = new TrainApprovals({ db, workspace, locks, environment, env: envOf(provider), timers });
    await approvals.begin({ ticket: ticket.id, by: 'u-owner', requestedAt: filterAsked.requestedAt, heads: stops.map((s) => ({ pr: 7, head: s.head })) });
    await timers.fire();
    assert.equal(provider.tracker('state', ticket.id).stdout.trim(), 'Ready to Ship');

    const filterWould = dry(provider, 'filter-api after approval');
    assert.equal(filterWould.status, 0, filterWould.stderr);
    const would = JSON.parse(filterWould.stdout) as { would_merge?: number; head?: string; reviewed_commit?: string; agreement?: string };
    assert.deepEqual([would.would_merge, would.head, would.reviewed_commit, would.agreement], [7, provider.head(), provider.head(), 'status'], 'the review found in the shared ledger, its report in the broker\'s own folder');
    const guestbookEarly = dry(consumer, 'guestbook before its own move');
    assert.equal(guestbookEarly.status, 6, 'the owner\'s first move is bound to the filter API\'s record, not the guestbook\'s');

    // The provider lands for real through its broker: merge-pr.ts merges (the fake gh records it) and closes the ticket on its own record.
    const landed = await filterLock.release({ ticket: ticket.id, pr: 7, announcement: ANNOUNCEMENT });
    console.log(`[filter-api release] ${JSON.stringify(landed)}`);
    assert.equal(landed.outcome, 'merged', landed.message);
    assert.ok(readFileSync(join(provider.fake, 'pr-merged'), 'utf8').includes(provider.head()), 'the checked head of the filter API was merged');
    assert.equal(existsSync(join(consumer.fake, 'pr-merged')), false, 'the guestbook is not merged with it');
    const afterFirst = provider.tracker('state', ticket.id).stdout.trim();
    console.log(`[after the filter API's merge] the ticket is in ${afterFirst}`);
    assert.equal(afterFirst, 'Done', 'merge-pr.ts closes the ticket once its own record is merged: why the train signs again');
    const closed = dry(consumer, 'guestbook on the closed ticket');
    assert.equal(closed.status, 6);

    // The train's step before the next landing: the ticket back to validate, the owner's move signed again, bound to the guestbook's record.
    await store.move(ticket.id, 'Needs Approval', { kind: 'agents', id: 'cleared-v2' });
    assert.equal(guestbookLock.check({ ticket: ticket.id, requestedAt: guestbookAsked.requestedAt, head: { pr: 7, head: consumer.head() } }), undefined);
    await guestbookLock.sign({ ticket: ticket.id, by: 'u-owner', requestedAt: guestbookAsked.requestedAt, heads: [{ pr: 7, head: consumer.head() }] });
    const guestbookWould = dry(consumer, 'guestbook after its own move');
    assert.equal(guestbookWould.status, 0, guestbookWould.stderr);
    const theirs = JSON.parse(guestbookWould.stdout) as { would_merge?: number; head?: string; reviewed_commit?: string };
    assert.deepEqual([theirs.would_merge, theirs.head, theirs.reviewed_commit], [7, consumer.head(), consumer.head()], 'its own review of its own #7, not the filter API\'s');
    // The two brokers' merge-pr.ts at once on the one ledger, five times: each
    // answers what it answers alone, and neither stops on the database.
    const at_once = (box: typeof provider) => new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const secret = readFileSync(join(box.state, 'release-broker.secret'), 'utf8');
      const child = spawn(join(CLEARED_HOME, 'merge-pr.ts'), ['7', ticket.id, '-', '--dry-run'], { env: { ...box.env, ORCH_LEDGER: ledger, ORCH_BROKER_SECRET: secret, CLEARED_BROKER_SECRET: secret } });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stderr }));
      child.stdin.end(ANNOUNCEMENT);
    });
    for (let round = 0; round < 5; round++) {
      const [one, two] = await Promise.all([at_once(provider), at_once(consumer)]);
      assert.equal(two.status, 0, two.stderr);
      assert.equal(one.status, 6, 'the filter API\'s merge-pr.ts refuses a move bound to the guestbook\'s record, as alone');
      assert.doesNotMatch(`${one.stderr}${two.stderr}`, /locked|SQLITE_BUSY|busy/i);
    }
    console.log('[at once] five rounds of both dry runs together: 0 and 6 each time, no lock error');
    const second = await guestbookLock.release({ ticket: ticket.id, pr: 7, announcement: ANNOUNCEMENT });
    console.log(`[guestbook release] ${JSON.stringify(second)}`);
    assert.equal(second.outcome, 'merged', second.message);
    assert.ok(readFileSync(join(consumer.fake, 'pr-merged'), 'utf8').includes(consumer.head()), 'the checked head of the guestbook was merged');
    const merges = db.prepare("SELECT kind, ticket, value, detail FROM events WHERE kind = 'merged_by_script' ORDER BY event_id").all() as { detail: string }[];
    console.log(`[merged_by_script rows] ${merges.map((m) => m.detail).join(' | ')}`);
    assert.equal(merges.length, 2, 'both merges in the one ledger');
    assert.ok(merges[0]?.detail.includes(provider.head().slice(0, 8)) && merges[1]?.detail.includes(consumer.head().slice(0, 8)), 'in landing order');

    // request_rollback on the provider's broker, from the service's account: accepted by the broker under human_user.
    const none = await filterLock.rollback({ ticket: ticket.id });
    console.log(`[filter-api request_rollback, no release row] ${JSON.stringify(none)}`);
    assert.doesNotMatch(none.message, /Only the configured human account|not an authorized/, 'the broker accepts the service account as its human account');
    assert.match(none.message, /No Cleared release recorded for LOCAL-1/, 'it reached lib/release.mjs rollback');

    // The fake gh merges nothing on the forge, so no watch started. The
    // merges are made on each repository's base as the forge would, and the
    // rows lib/release.mjs writes for them are written: the filter API's,
    // then the guestbook's, which its own watch reverted. On the shared
    // ledger the ticket's newest row is the guestbook's; the filter API's
    // broker reverts the filter API's own merge (lib/release.mjs ownRelease).
    const mergeOnBase = (box: typeof provider): string => {
      box.git(box.repo, 'checkout', '-q', 'main');
      box.git(box.repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #7', 'cleared/LOCAL-1');
      box.git(box.repo, 'push', '-q', 'origin', 'main');
      return box.git(box.repo, 'rev-parse', 'HEAD').trim();
    };
    const providerMerge = mergeOnBase(provider);
    const consumerMerge = mergeOnBase(consumer);
    const insert = db.prepare("INSERT INTO releases (ticket, pr, merge_sha, title, merged_at, status, rollback_sha, ended_at) VALUES (?, 7, ?, 'Held for review', ?, ?, ?, ?)");
    insert.run(ticket.id, providerMerge, new Date(Date.now() - 1_200_000).toISOString(), 'complete', null, new Date(Date.now() - 300_000).toISOString());
    insert.run(ticket.id, consumerMerge, new Date(Date.now() - 200_000).toISOString(), 'rolled_back', 'f'.repeat(40), new Date().toISOString());
    console.log(`[releases rows] ${JSON.stringify(db.prepare('SELECT ticket, pr, merge_sha, status, rollback_sha FROM releases ORDER BY id').all())}`);
    const rolled = await filterLock.rollback({ ticket: ticket.id });
    console.log(`[filter-api request_rollback, after the guestbook's own rollback] ${JSON.stringify(rolled)}`);
    assert.equal(rolled.ok, true, rolled.message);
    assert.match(rolled.message, new RegExp(`Merge to revert: ${providerMerge}`), 'the filter API\'s own merge, not the ticket\'s newest row');
    const reverted = db.prepare('SELECT merge_sha, status, rollback_sha FROM releases WHERE merge_sha = ?').get(providerMerge) as { status: string; rollback_sha: string | null };
    console.log(`[the filter API's release after it] ${JSON.stringify(reverted)}`);
    assert.ok(reverted.rollback_sha, 'its revert is recorded on its own row');
    provider.git(provider.repo, 'fetch', '-q', 'origin', 'main');
    assert.equal(provider.git(provider.repo, 'rev-parse', 'origin/main').trim(), reverted.rollback_sha, 'the revert is on the filter API\'s base');
    assert.equal(provider.git(provider.repo, 'ls-tree', '--name-only', 'origin/main', 'src/check.ts').trim(), '', 'its change is undone');
    consumer.git(consumer.repo, 'fetch', '-q', 'origin', 'main');
    assert.equal(consumer.git(consumer.repo, 'rev-parse', 'origin/main').trim(), consumerMerge, 'the guestbook\'s base is untouched');
  } finally {
    for (const broker of brokers) await stop(broker);
    db.close();
  }
});
