// The decisions the owner approved in v1, approved again in v2 only when
// nothing has changed (docs/v2/milestone-4-plan.md, section 3.3, item 2):
// v1 holds the owner's record, the owner is v2's, and the file is the same
// text, committed and on disk. Proven through a real v2 briefing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { importV1 } from '../../src/import/apply.ts';
import { readBriefing } from '../../src/workspace/briefing.ts';
import { tempDir } from '../workspace/git.ts';
import { DECISIONS, OWNER, v1Ledger, v2Checkout } from './v1-fixture.ts';

const QUEUE = 'docs/decisions/0001-queue.md';
const CACHE = 'docs/decisions/0002-cache.md';
const FONTS = 'docs/decisions/0003-fonts.md';
// Shares words with the queue and the cache decisions, as lib/memory selects.
const TICKET = { id: 'LOCAL-1', title: 'Orders through the queue', body: 'Send each order through the queue; the catalogue page stays cached.' };

function setup(options: { edits?: Record<string, string>; dirty?: Record<string, string>; approvedWithoutRecord?: string[]; approve?: string[] } = {}) {
  const v1 = v1Ledger([], { approve: options.approve ?? [QUEUE, CACHE], approvedWithoutRecord: options.approvedWithoutRecord ?? [] });
  const state = tempDir('v2-state');
  const ledger = join(state, 'ledger.db');
  const checkout = v2Checkout(v1.checkout, options.edits, options.dirty);
  const env = { CLEARED_STATE_DIR: state };
  const run = (apply: boolean, ownerId: string | null = OWNER) => importV1({ from: v1.ledger, ledger, project: 'shop', checkout, ownerId: ownerId ?? undefined, apply, env });
  const briefed = async () => (await readBriefing({ project: checkout, role: 'author', ticket: TICKET, env })).decisions.map((d) => d.split('\n')[0]);
  return { v1, ledger, checkout, run, briefed };
}

test('an approved v1 decision is briefed by v2 after the import, and not before', async () => {
  const { run, briefed } = setup();
  assert.deepEqual(await briefed(), [], 'v2 indexed the files: proposals, never briefed');
  const report = await run(true);
  assert.deepEqual(report.approvals.added.map((a) => [a.path, a.by]), [[QUEUE, OWNER], [CACHE, OWNER]]);
  assert.deepEqual((await briefed()).sort(), ['# Cache', '# Queue']);
});

test('v2 records the approval as the owner\'s, and keeps v1\'s record of it', async () => {
  const { v1, ledger, run } = setup({ approve: [QUEUE] });
  await run(true);
  const db = new DatabaseSync(ledger, { readOnly: true });
  const old = new DatabaseSync(v1.ledger, { readOnly: true });
  try {
    const entry = db.prepare('SELECT id, status FROM memory_entries WHERE source_where = ?').get(QUEUE) as { id: string; status: string };
    assert.equal(entry.status, 'approved');
    const event = db.prepare("SELECT detail FROM events WHERE kind = 'memory_approved'").all() as { detail: string }[];
    assert.deepEqual(event.map((e) => JSON.parse(e.detail).id), [entry.id]);
    assert.equal(JSON.parse((event[0] as { detail: string }).detail).by, OWNER);
    const v1At = (old.prepare("SELECT at FROM events WHERE kind = 'memory_approved'").get() as { at: string }).at;
    assert.deepEqual({ ...db.prepare('SELECT id, path, v1_by, v1_at FROM v1_memory_approvals').get() as object }, { id: entry.id, path: QUEUE, v1_by: OWNER, v1_at: v1At });
  } finally {
    db.close();
    old.close();
  }
});

test('a decision edited since v1 stays a proposal, committed or only on disk', async () => {
  const { run, briefed } = setup({ edits: { [CACHE]: '# Cache\nThe catalogue page is cached for one hour.\n' }, dirty: { [QUEUE]: `${DECISIONS[QUEUE]}Unless the queue is down.\n` } });
  const report = await run(true);
  assert.deepEqual(report.approvals.added, []);
  assert.deepEqual(report.approvals.skipped, [{ path: QUEUE, reason: 'changed' }, { path: CACHE, reason: 'changed' }]);
  assert.deepEqual(await briefed(), []);
});

test('a decision whose file is gone from v2\'s checkout is said, not approved', async () => {
  const { checkout, run } = setup({ approve: [QUEUE] });
  const { rmSync } = await import('node:fs');
  rmSync(join(checkout, QUEUE));
  assert.deepEqual((await run(false)).approvals.skipped, [{ path: QUEUE, reason: 'missing' }]);
});

test('another owner, no owner set, or an approval v1 holds no record of: nothing is approved', async () => {
  const { run, briefed } = setup({ approve: [QUEUE], approvedWithoutRecord: [FONTS] });
  const other = await run(true, 'someone-else');
  assert.deepEqual(other.approvals.skipped, [{ path: QUEUE, reason: 'other_owner' }, { path: FONTS, reason: 'no_record' }]);
  const none = await run(true, null);
  assert.deepEqual(none.approvals.skipped, [{ path: QUEUE, reason: 'no_owner' }, { path: FONTS, reason: 'no_record' }]);
  assert.deepEqual(await briefed(), []);
});

test('a dry run approves nothing', async () => {
  const { run, briefed } = setup();
  assert.equal((await run(false)).approvals.added.length, 2);
  assert.deepEqual(await briefed(), []);
});
