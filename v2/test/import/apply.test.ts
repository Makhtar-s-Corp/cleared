// The import into v2's ledger (docs/v2/milestone-4-plan.md, sections 3.3
// and 3.4): a dry run writes nothing, --apply writes the samples once, a
// second run adds nothing, v2's own ledger is never read as v1's, and the
// plans' estimates count what was imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { V1ImportError } from '../../src/import/v1.ts';
import { importV1 } from '../../src/import/apply.ts';
import { importedSamples } from '../../src/import/samples.ts';
import { DEFAULT_ESTIMATES, estimateFor, historyOf } from '../../src/lead/plans/estimates.ts';
import { openStore } from '../../src/store/db.ts';
import { MemoryTicketStore } from '../../src/tickets/contract.ts';
import { tempDir } from '../workspace/git.ts';
import { OWNER, at, v1Ledger, v2Checkout, type V1Ticket } from './v1-fixture.ts';

const sized = (id: string, size: string, minutes: number, lane: 'fast' | 'full' = 'full'): V1Ticket => ({
  id, labels: [`size:${size}`], runs: [{ started: at(0), ended: at(minutes), tokens: 100 }],
  measures: [{ at: at(minutes + 1), total: minutes, lane, pr: 1, todo: at(0), done: at(minutes), humanWait: null }],
});

function setup(tickets: readonly V1Ticket[]) {
  const v1 = v1Ledger(tickets);
  const ledger = join(tempDir('v2-state'), 'ledger.db');
  const checkout = v2Checkout(v1.checkout);
  const run = (apply: boolean, over: Partial<Parameters<typeof importV1>[0]> = {}) =>
    importV1({ from: v1.ledger, ledger, project: 'shop', checkout, ownerId: OWNER, apply, ...over });
  return { v1, ledger, checkout, run };
}

const count = (ledger: string, table: string) => {
  const db = new DatabaseSync(ledger, { readOnly: true });
  try { return Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n); } finally { db.close(); }
};

test('a dry run says what it would import and writes nothing, not even an empty ledger', async () => {
  const { ledger, run } = setup([sized('LOCAL-1', 's', 10), sized('LOCAL-2', 'm', 40), { id: 'LOCAL-3', measures: [{ at: at(9), unreadable: true }] }]);
  const report = await run(false);
  assert.equal(report.applied, false);
  assert.deepEqual(report.samples.added.map((s) => s.ticket), ['LOCAL-1', 'LOCAL-2']);
  assert.deepEqual(report.samples.skipped, [{ ticket: 'LOCAL-3', reason: 'unreadable' }]);
  assert.deepEqual(report.approvals.added.map((a) => a.path), ['docs/decisions/0001-queue.md', 'docs/decisions/0002-cache.md']);
  assert.equal(report.handovers, 1);
  assert.equal(existsSync(ledger), false);
});

test('--apply writes the samples for the workspace; a second run adds nothing and says what was already there', async () => {
  const { ledger, run } = setup([sized('LOCAL-1', 's', 10), sized('LOCAL-2', 'm', 40)]);
  const first = await run(true);
  assert.equal(first.applied, true);
  assert.equal(first.samples.added.length, 2);
  assert.equal(count(ledger, 'v1_ticket_samples'), 2);
  const second = await run(true);
  assert.deepEqual(second.samples.added, []);
  assert.deepEqual(second.samples.known, ['LOCAL-1', 'LOCAL-2']);
  assert.deepEqual(second.approvals.added, []);
  assert.deepEqual(second.approvals.known, ['docs/decisions/0001-queue.md', 'docs/decisions/0002-cache.md']);
  assert.equal(count(ledger, 'v1_ticket_samples'), 2);
  // A dry run after the import has nothing to do either.
  assert.deepEqual((await run(false)).samples.added, []);
});

test('the same v1 ticket imported for two workspaces is a sample of each', async () => {
  const { ledger, run } = setup([sized('LOCAL-1', 's', 10)]);
  await run(true);
  await run(true, { project: 'other' });
  const db = new DatabaseSync(ledger, { readOnly: true });
  try {
    assert.equal(importedSamples(db, 'shop').length, 1);
    assert.equal(importedSamples(db, 'other').length, 1);
    assert.deepEqual(importedSamples(db, 'nobody'), []);
  } finally { db.close(); }
});

test('a second v1 ledger whose ticket numbers are taken is said, never counted as already imported', async () => {
  const { run } = setup([sized('LOCAL-1', 's', 10), sized('LOCAL-2', 'm', 40)]);
  await run(true);
  const other = v1Ledger([sized('LOCAL-1', 'l', 70), { ...sized('LOCAL-3', 'xs', 5) }]);
  const report = await run(true, { from: other.ledger });
  assert.deepEqual(report.samples.added.map((s) => s.ticket), ['LOCAL-3']);
  assert.deepEqual(report.samples.known, []);
  assert.deepEqual(report.samples.skipped, [{ ticket: 'LOCAL-1', reason: 'taken' }]);
});

test('the v1 ledger is byte for byte the same after an import', async () => {
  const { v1, run } = setup([sized('LOCAL-1', 's', 10)]);
  const before = readFileSync(v1.ledger);
  await run(true);
  assert.deepEqual(readFileSync(v1.ledger), before);
});

test('v2\'s own ledger is refused as the v1 one, by its path or through a link', async () => {
  const { v1, run } = setup([sized('LOCAL-1', 's', 10)]);
  const same = (error: unknown) => error instanceof V1ImportError && error.code === 'same_file';
  await assert.rejects(run(true, { ledger: v1.ledger }), same);
  const dir = tempDir('link');
  mkdirSync(join(dir, 'state'));
  symlinkSync(v1.ledger, join(dir, 'state', 'ledger.db'));
  await assert.rejects(run(true, { ledger: join(dir, 'state', 'ledger.db') }), same);
  await assert.rejects(run(false, { from: join(dir, 'state', 'ledger.db'), ledger: v1.ledger }), same);
});

test('imported samples feed the plans\' estimates: the median minutes, the default cost, the sample count', async () => {
  const { ledger, run } = setup([sized('LOCAL-1', 's', 10), sized('LOCAL-2', 's', 30), sized('LOCAL-3', 's', 20), sized('LOCAL-4', 's', 99, 'fast')]);
  await run(true);
  const store = openStore(ledger);
  try {
    const samples = await historyOf({ tickets: new MemoryTicketStore(), store }, 'shop');
    assert.equal(samples.length, 4);
    // The minutes from v1's history; the cost the default, so the count says none.
    assert.deepEqual(estimateFor(samples, 's', 'full'), { minutes: 20, costUsd: DEFAULT_ESTIMATES.s.costUsd, weekPercent: null, samples: 0 });
    assert.deepEqual(estimateFor(samples, 's', 'fast'), { ...DEFAULT_ESTIMATES.s, weekPercent: null, samples: 1 });
    assert.deepEqual(await historyOf({ tickets: new MemoryTicketStore(), store }, 'other'), []);
  } finally { store.close(); }
});

test('a ledger with no import yet gives v2\'s history alone', async () => {
  const store = openStore(':memory:');
  assert.deepEqual(importedSamples(store.db, 'shop'), []);
  assert.deepEqual(await historyOf({ tickets: new MemoryTicketStore(), store }, 'shop'), []);
});
