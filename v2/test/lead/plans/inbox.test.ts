// The inbox's plan item (docs/v2/milestone-2-plan.md, section 5.1), and what
// lane 7 narrows in inbox/store.ts: a plan item is never a request of a
// session, and a release's checks change only while it waits (issue 157).
import test from 'node:test';
import assert from 'node:assert/strict';
import { InboxStore, INBOX_TABLE } from '../../../src/inbox/store.ts';
import { openStore } from '../../../src/store/db.ts';

const totals = { minutes: 102, costUsd: 3.4, weekPercent: null, samples: 0 };

function inbox() {
  const store = openStore(':memory:');
  store.db.exec(INBOX_TABLE);
  return new InboxStore(store.db, () => new Date('2026-10-21T10:00:00.000Z'));
}

test('a plan item waits under the lead\'s ticket, is no request of any session, and is handled once', () => {
  const box = inbox();
  const item = box.addPlan({ project: 'guestbook', planId: 'plan-1', title: 'A plan', summary: 'Two tickets.', itemCount: 2, totals });
  assert.deepEqual(item, {
    id: 'plan:plan-1', kind: 'plan', ticket: 'lead', project: 'guestbook', since: '2026-10-21T10:00:00.000Z', state: 'waiting',
    planId: 'plan-1', title: 'A plan', summary: 'Two tickets.', itemCount: 2, totals,
  });
  assert.equal(box.find('', 'plan-1'), undefined, 'the answer routes never match a plan');
  assert.equal(box.waitingFor(''), 0);
  box.handleSession('', 'system');
  assert.equal(box.list()[0]?.state, 'waiting', 'ending a session never handles a plan');
  assert.equal(box.handle('plan:plan-1', 'u1'), true);
  assert.equal(box.handle('plan:plan-1', 'u1'), false);
});

test('a release\'s checks are written only while it waits', () => {
  const box = inbox();
  const release = box.addRelease({
    ticket: 'LOCAL-1', project: 'guestbook', title: 'T', announcement: 'A', pr: { number: 7, url: 'https://example.invalid/pull/7', checks: 'pending' },
    heads: [{ pr: 7, head: 'abc' }], requestedAt: '2026-10-21T10:00:00.000Z', captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [],
  });
  box.setReleaseChecks(release.id, 'passed');
  box.handle(release.id, 'u1');
  box.setReleaseChecks(release.id, 'failed');
  const stored = box.list().find((i) => i.id === release.id);
  assert.equal(stored?.kind === 'release' && stored.pr.checks, 'passed', 'a handled release keeps what the owner saw');
});
