// Estimates from history (docs/v2/milestone-2-plan.md, section 5.2): the
// medians of the project's done tickets of the same size and lane, the
// defaults below three samples, and the plan's time as its critical path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ESTIMATES, criticalPath, estimateFor, historyOf, planTotals } from '../../../src/lead/plans/estimates.ts';
import { examplePlanInput } from '../../../src/session/adapters/fake.ts';
import { openStore } from '../../../src/store/db.ts';
import { MemoryTicketStore } from '../../../src/tickets/contract.ts';
import { doneTicket } from './support.ts';

test('seven done tickets of size s give the median time and cost, with samples: 7', async () => {
  const store = openStore(':memory:');
  const tickets = new MemoryTicketStore();
  const minutes = [10, 14, 9, 30, 12, 11, 13];
  for (const [i, m] of minutes.entries()) await doneTicket(store, tickets, { size: 's', minutes: m, costUsd: 0.1 * (i + 1) });
  // A ticket of another size, one of the fast lane, one not Done and one of another project are not samples.
  await doneTicket(store, tickets, { size: 'm', minutes: 99, costUsd: 9 });
  await doneTicket(store, tickets, { size: 's', lane: 'fast', minutes: 99, costUsd: 9 });
  await doneTicket(store, tickets, { size: 's', minutes: 99, costUsd: 9, status: 'Needs Approval' });
  await doneTicket(store, tickets, { size: 's', minutes: 99, costUsd: 9, project: 'other' });
  const samples = await historyOf({ tickets, store }, 'guestbook');
  assert.deepEqual(estimateFor(samples, 's', 'full'), { minutes: 12, costUsd: 0.4, weekPercent: null, samples: 7 });
});

test('the time runs from the author\'s first turn to the release request, without the waits for the owner', async () => {
  const store = openStore(':memory:');
  const tickets = new MemoryTicketStore();
  await doneTicket(store, tickets, { size: 'xs', minutes: 20, waitMinutes: 15, costUsd: 0.2 });
  const [sample] = await historyOf({ tickets, store }, 'guestbook');
  assert.equal(sample?.minutes, 5, '20 minutes of which 15 waited for the owner');
  assert.equal(sample?.costUsd, 0.2, 'the cost of the author and of the reviewer');
});

test('two done tickets are not enough: the defaults, with samples: 2', async () => {
  const store = openStore(':memory:');
  const tickets = new MemoryTicketStore();
  await doneTicket(store, tickets, { size: 's', minutes: 50, costUsd: 3 });
  await doneTicket(store, tickets, { size: 's', minutes: 70, costUsd: 3 });
  const samples = await historyOf({ tickets, store }, 'guestbook');
  assert.deepEqual(estimateFor(samples, 's', 'full'), { minutes: 12, costUsd: 0.3, weekPercent: null, samples: 2 });
  assert.deepEqual(DEFAULT_ESTIMATES, { xs: { minutes: 5, costUsd: 0.15 }, s: { minutes: 12, costUsd: 0.3 }, m: { minutes: 30, costUsd: 0.8 }, l: { minutes: 60, costUsd: 2 } });
  assert.equal(estimateFor([], 'l', 'fast').samples, 0);
});

test('the plan\'s time is its critical path given after and two at a time, not the sum', () => {
  // The acceptance's plan: 1, 2 and 4 independent, 3 after 2, 5 after 3, ten minutes each.
  const ten = [[], [], [2], [], [3]].map((after) => ({ after, minutes: 10 }));
  // 0-10: 1 and 2; 10-20: 3 and 4; 20-30: 5.
  assert.equal(criticalPath(ten, 2), 30);
  assert.equal(criticalPath(ten, 1), 50);
  assert.equal(criticalPath(ten, 5), 30, 'the chain 2, 3, 5');

  // lead-and-plan.png's plan with its estimates: 1, 2, 3 in a row (120 min), 4 and 5 beside them.
  const capture = examplePlanInput.items.map((item, i) => ({ after: [...item.after], minutes: [40, 50, 30, 10, 5][i] ?? 0 }));
  assert.equal(criticalPath(capture, 2), 120, 'lane 1\'s fixture says 120');
});

test('the totals add the costs and take the fewest samples; the week share stays unknown', () => {
  const estimate = (minutes: number, costUsd: number, samples: number) => ({ minutes, costUsd, weekPercent: null, samples });
  const totals = planTotals([
    { after: [], estimate: estimate(10, 0.3, 7) },
    { after: [1], estimate: estimate(20, 0.15, 2) },
  ], 2);
  assert.deepEqual(totals, { minutes: 30, costUsd: 0.45, weekPercent: null, samples: 2 });
});
