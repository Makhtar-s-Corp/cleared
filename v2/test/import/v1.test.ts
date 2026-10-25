// Reading a v1 ledger (docs/v2/milestone-4-plan.md, section 3.3): one sample
// per measured ticket, its size from its label or its lines, its minutes
// without the owner's wait; the decisions the owner approved; and never a
// write to the v1 file or its folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { V1ImportError, readV1, sizeOfLines } from '../../src/import/v1.ts';
import { tempDir } from '../workspace/git.ts';
import { DECISIONS, OWNER, at, v1Ledger } from './v1-fixture.ts';

const measure = (total: number, extra: { lane?: 'fast' | 'full'; humanWait?: number | null; pr?: number; todo?: number; done?: number; at?: number } = {}) => ({
  at: at(extra.at ?? 200), total, lane: extra.lane ?? 'full', pr: extra.pr ?? 7, todo: at(extra.todo ?? 0), done: at(extra.done ?? total), humanWait: extra.humanWait ?? null,
});

test('one sample per measured ticket: its lane, its size label, its minutes from the first run less the owner\'s wait, its tokens', () => {
  const { ledger } = v1Ledger([
    { id: 'LOCAL-1', labels: ['size:m', 'Quick'], runs: [{ started: at(5), ended: at(30), tokens: 1000, lines: 300, pr: 7 }, { started: at(35), ended: at(40), tokens: 500 }],
      measures: [measure(60, { lane: 'fast', humanWait: 20 })] },
  ]);
  const v1 = readV1(ledger);
  // 60 minutes from Todo to the merge, the first run 5 minutes after Todo, 20 waited for the owner.
  assert.deepEqual(v1.samples, [{ ticket: 'LOCAL-1', lane: 'fast', size: 'm', minutes: 35, tokens: 1500, lines: 300, measuredAt: at(200) }]);
  assert.deepEqual(v1.skipped, []);
  assert.equal(v1.measured, 1);
});

test('without a size label, the size comes from the lines its merged pull request changed', () => {
  const { ledger } = v1Ledger([
    { id: 'LOCAL-1', runs: [{ started: at(0), ended: at(5), lines: 15, pr: 3 }], measures: [measure(30, { pr: 3 })] },
    { id: 'LOCAL-2', runs: [{ started: at(0), ended: at(5), lines: 900, pr: 2 }, { started: at(6), ended: at(9), lines: 101, pr: 4 }], measures: [measure(30, { pr: 4 })] },
    // A tracker that is not the ledger's: no label to read, the lines still say it.
    { id: 'TRK-12', runs: [{ started: at(0), ended: at(5), lines: 401, pr: 5 }], measures: [measure(30, { pr: 5 })] },
  ]);
  assert.deepEqual(readV1(ledger).samples.map((s) => [s.ticket, s.size, s.lines]), [['LOCAL-1', 'xs', 15], ['LOCAL-2', 'm', 101], ['TRK-12', 'l', 401]]);
});

test('the size thresholds: 20 lines or fewer xs, 100 or fewer s, 400 or fewer m, more l', () => {
  assert.deepEqual([0, 20, 21, 100, 101, 400, 401, 5000].map(sizeOfLines), ['xs', 'xs', 's', 's', 'm', 'm', 'l', 'l']);
});

test('a ticket with neither label nor lines, and a measure that cannot be read, are skipped and said', () => {
  const { ledger } = v1Ledger([
    { id: 'LOCAL-1', runs: [{ started: at(0), ended: at(5), tokens: 10 }], measures: [measure(30)] },
    { id: 'LOCAL-2', labels: ['size:huge'], measures: [measure(30)] },
    { id: 'LOCAL-3', labels: ['size:s'], measures: [{ at: at(9), unreadable: true }] },
  ]);
  const v1 = readV1(ledger);
  assert.deepEqual(v1.samples, []);
  assert.deepEqual(v1.skipped, [{ ticket: 'LOCAL-1', reason: 'no_size' }, { ticket: 'LOCAL-2', reason: 'no_size' }, { ticket: 'LOCAL-3', reason: 'unreadable' }]);
  assert.equal(v1.measured, 3);
});

test('a ticket measured twice gives one sample, its last measure', () => {
  const { ledger } = v1Ledger([
    { id: 'LOCAL-1', labels: ['size:s'], measures: [measure(30, { at: 40 }), measure(50, { at: 300, todo: 100, done: 150 })] },
  ]);
  const [sample, ...rest] = readV1(ledger).samples;
  assert.equal(rest.length, 0);
  assert.equal(sample?.minutes, 50);
  assert.equal(sample?.measuredAt, at(300));
});

test('without a run in the span the minutes run from Todo; an unmeasured wait counts as none; never below zero', () => {
  const { ledger } = v1Ledger([
    { id: 'LOCAL-1', labels: ['size:s'], runs: [{ started: at(-50), ended: at(-40), tokens: 7 }], measures: [measure(30)] },
    { id: 'LOCAL-2', labels: ['size:s'], measures: [measure(10, { humanWait: 25 })] },
  ]);
  assert.deepEqual(readV1(ledger).samples.map((s) => [s.ticket, s.minutes, s.tokens]), [['LOCAL-1', 30, null], ['LOCAL-2', 0, null]]);
});

test('the decisions the owner approved, with who approved them and when; a proposal is not one, a handover is counted', () => {
  const { ledger } = v1Ledger([], { approvedWithoutRecord: ['docs/decisions/0003-fonts.md'] });
  const v1 = readV1(ledger);
  const byPath = new Map(v1.approvals.map((a) => [a.path, a]));
  assert.deepEqual([...byPath.keys()].sort(), ['docs/decisions/0001-queue.md', 'docs/decisions/0002-cache.md', 'docs/decisions/0003-fonts.md']);
  const queue = byPath.get('docs/decisions/0001-queue.md');
  assert.equal(queue?.content, DECISIONS['docs/decisions/0001-queue.md']);
  assert.equal(queue?.by, OWNER);
  assert.ok(queue?.at && Number.isFinite(Date.parse(queue.at)));
  assert.match(queue?.id ?? '', /^file:[0-9a-f]{24}$/);
  assert.equal(byPath.get('docs/decisions/0003-fonts.md')?.by, null, 'approved with no record of who did');
  assert.equal(v1.handovers, 1);
});

test('the v1 ledger and its folder are never written, even read-only on disk', () => {
  const { ledger, state } = v1Ledger([{ id: 'LOCAL-1', labels: ['size:s'], measures: [measure(30)] }]);
  const before = { bytes: readFileSync(ledger), files: readdirSync(state).sort() };
  chmodSync(ledger, 0o400);
  chmodSync(state, 0o500);
  try {
    assert.equal(readV1(ledger).samples.length, 1);
    assert.deepEqual(readdirSync(state).sort(), before.files, 'no -shm or -wal file made beside it');
    assert.deepEqual(readFileSync(ledger), before.bytes);
  } finally {
    chmodSync(state, 0o700);
    chmodSync(ledger, 0o600);
  }
});

test('rows still in v1\'s write-ahead log are read', () => {
  const { ledger, state } = v1Ledger([]);
  const writer = new DatabaseSync(ledger);
  try {
    writer.exec('PRAGMA wal_autocheckpoint = 0');
    writer.prepare("INSERT INTO tracker_tickets (title, body, labels, project, status, created_at, updated_at) VALUES ('Late', '', '[\"size:l\"]', 'shop', 'Done', ?, ?)").run(at(0), at(0));
    writer.prepare("INSERT INTO events (at, kind, ticket, detail, value) VALUES (?, 'ticket_measured', 'LOCAL-1', ?, 45)")
      .run(at(60), JSON.stringify({ lane: 'full', pr: 1, todo_at: at(0), done_at: at(45), human_wait_min: null }));
    assert.ok(readdirSync(state).includes('ledger.db-wal'));
    const before = readFileSync(`${ledger}-wal`);
    assert.deepEqual(readV1(ledger).samples.map((s) => [s.ticket, s.size, s.minutes]), [['LOCAL-1', 'l', 45]]);
    assert.deepEqual(readFileSync(`${ledger}-wal`), before);
  } finally {
    writer.close();
  }
});

test('a missing file and a file that is not a v1 ledger are refused, with a code', () => {
  const dir = tempDir('not-v1');
  assert.throws(() => readV1(join(dir, 'nothing.db')), (error: unknown) => error instanceof V1ImportError && error.code === 'not_found');
  const other = join(dir, 'other.db');
  const db = new DatabaseSync(other);
  db.exec('CREATE TABLE things (x)');
  db.close();
  assert.throws(() => readV1(other), (error: unknown) => error instanceof V1ImportError && error.code === 'not_v1');
});
