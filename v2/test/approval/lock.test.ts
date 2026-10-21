// The proof of the lane: the lock runs unchanged on what the service writes.
// merge-pr.sh, ask-validation.sh and tracker.sh are the real v1 scripts; gh
// and docker are fakes, so nothing is merged and nothing reaches GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LedgerReviewRecorder, RUNS_TABLES } from '../../src/approval/review.ts';
import { applyTables } from '../../src/store/db.ts';
import { TICKET_TABLES } from '../../src/tickets/local-store.ts';
import { APPROVAL_TABLES } from '../../src/approval/service.ts';
import { service } from './support.ts';

const ANNOUNCEMENT = 'The guestbook now shows the newest entry first. Open the guestbook and add two entries.';

async function world() {
  const s = await service({ broker: null, realClock: true });
  const { box } = s;
  box.commit('src/page.ts', 'export const page = 2;\n');
  box.publish();
  const ticket = await s.waiting();
  assert.equal(ticket.id, 'LOCAL-1');
  const recorder = new LedgerReviewRecorder(s.db, { stateDir: box.state, verdict: 'no blocking issues' });
  const review = (verdict: 'pass' | 'changes_requested' = 'pass', round = 1) =>
    recorder.record({ ticket: 'LOCAL-1', pr: 7, session: 'sess-1', model: 'claude-sonnet-5-5', round, verdict, report: 'Read the diff and ran the tests.', at: new Date().toISOString(), commit: box.head() } as never);
  // What the lead does through the broker: ask for the approval (v1 ask-validation.sh), for the head now.
  const ask = () => box.run('ask-validation.sh', ['LOCAL-1', '-', '--pr', '7'], {}, '**What changes.** The newest entry comes first. Do you put it live?');
  const dry = (extra: string[] = []) => box.run('merge-pr.sh', ['7', 'LOCAL-1', '-', '--dry-run', ...extra], {}, ANNOUNCEMENT);
  const approveWithTheShownHeads = async () => {
    const record = JSON.parse((await import('node:fs')).readFileSync(join(box.state, 'validations', 'LOCAL-1.json'), 'utf8')) as { at: string; pulls: { pr: number; head: string }[] };
    await s.writer.begin({ ticket: 'LOCAL-1', by: 'u-owner', requestedAt: record.at, heads: record.pulls.map(({ pr, head: h }) => ({ pr, head: h })) });
    await s.timers.fire();
  };
  return { ...s, review, ask, dry, approveWithTheShownHeads };
}

test('merge-pr.sh --dry-run reaches "would merge" after the review record and the app\'s approval, and not before', async () => {
  const w = await world();
  const { box } = w;
  const before = w.dry();
  assert.equal(before.status, 6);
  assert.match(before.stderr, /has no review for LOCAL-1/);

  await w.review();
  const unasked = w.dry();
  assert.equal(unasked.status, 6, unasked.stderr);
  assert.match(unasked.stderr, /the user has not agreed|tracker could not say|not in/);

  const asked = w.ask();
  assert.equal(asked.status, 0, asked.stderr);
  assert.equal(box.tracker('state', 'LOCAL-1').stdout.trim(), 'Needs Approval');
  const waiting = w.dry();
  assert.equal(waiting.status, 6, 'asked is not agreed');

  await w.approveWithTheShownHeads();
  assert.equal(box.tracker('state', 'LOCAL-1').stdout.trim(), 'Ready to Ship');
  assert.equal(box.tracker('identity').stdout.trim(), 'app');
  const agreed = w.dry();
  assert.equal(agreed.status, 0, `${agreed.stdout}\n${agreed.stderr}`);
  const would = JSON.parse(agreed.stdout) as Record<string, unknown>;
  assert.equal(would.would_merge, 7);
  assert.equal(would.ticket, 'LOCAL-1');
  assert.equal(would.head, box.head());
  assert.equal(would.reviewed_commit, box.head());
  assert.equal(would.agreement, 'status');
  assert.equal(box.merged(), null, 'a dry run merges nothing');
});

test('a review that asks for changes does not let it through, even after the approval', async () => {
  const w = await world();
  await w.review('changes_requested');
  assert.equal(w.ask().status, 0);
  await w.approveWithTheShownHeads();
  const refused = w.dry();
  assert.equal(refused.status, 6);
  assert.match(refused.stderr, /has no review for LOCAL-1/);
});

test('a new commit on the branch is refused: first for want of a review, then, reviewed again, for the version he was shown', async () => {
  const w = await world();
  const { box } = w;
  await w.review();
  assert.equal(w.ask().status, 0);
  const shown = box.head();
  await w.approveWithTheShownHeads();
  assert.equal(w.dry().status, 0);

  box.commit('src/page.ts', 'export const page = 3;\n');
  box.publish();
  assert.notEqual(box.head(), shown);
  const unreviewed = w.dry();
  assert.equal(unreviewed.status, 6);
  assert.match(unreviewed.stderr, /has no review for LOCAL-1/, 'check 3 comes first');

  await w.review('pass', 2);
  const unshown = w.dry();
  assert.equal(unshown.status, 6, unshown.stdout);
  assert.match(unshown.stderr, /is not the version he was shown/, 'check 4: his agreement is to the version he saw');
  // A dry run changes nothing; the real run puts the card back where the request waits for him.
  assert.equal(box.tracker('state', 'LOCAL-1').stdout.trim(), 'Ready to Ship');
  const real = box.run('merge-pr.sh', ['7', 'LOCAL-1', '-'], {}, ANNOUNCEMENT);
  assert.equal(real.status, 6);
  assert.match(real.stderr, /is back in « Needs Approval »/);
  assert.equal(box.tracker('state', 'LOCAL-1').stdout.trim(), 'Needs Approval');
  assert.equal(box.merged(), null);
});

test('asking again after the approval takes the card back, and the approval already given does not answer the new request', async () => {
  const w = await world();
  await w.review();
  assert.equal(w.ask().status, 0);
  await w.approveWithTheShownHeads();
  assert.equal(w.dry().status, 0);
  const again = w.ask();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(w.box.tracker('state', 'LOCAL-1').stdout.trim(), 'Needs Approval');
  assert.equal(w.dry().status, 6);
  await w.approveWithTheShownHeads();
  assert.equal(w.dry().status, 0, 'and the owner\'s new approval, bound to the new request, does');
});

test('a tool of the agents writing the same row without the key does not count as the human', async () => {
  const w = await world();
  await w.review();
  assert.equal(w.ask().status, 0);
  // A process with the database but not the key: the row says human, the proof is invented.
  w.db.exec(`UPDATE tracker_tickets SET status = 'Ready to Ship' WHERE id = 1`);
  w.db.prepare(`INSERT INTO tracker_history(ticket, status, actor_kind, actor_id, at, proof, approval_context, content_hash) VALUES (1, 'Ready to Ship', 'human', 'demo', ?, 'AAAA', NULL, NULL)`).run(new Date().toISOString());
  const refused = w.dry();
  assert.equal(refused.status, 6);
  assert.match(refused.stderr, /did not put it there himself|not put it there|put back/);
});

test('the service and the v1 scripts create the shared tables without conflict, in either order', () => {
  const db = new DatabaseSync(':memory:');
  applyTables(db, [...TICKET_TABLES, ...RUNS_TABLES, ...APPROVAL_TABLES]);
  applyTables(db, [...TICKET_TABLES, ...RUNS_TABLES, ...APPROVAL_TABLES]);
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
  assert.ok(['events', 'runs', 'tracker_comments', 'tracker_history', 'tracker_tickets'].every((name) => names.includes(name)));
});
