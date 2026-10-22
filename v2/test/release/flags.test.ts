// The release card's groups and flags (decision 23): lane 16 fixes the
// signature and places the call, with an empty default lane 18 fills; the
// publish step reads the author's report from the session's last
// `cleared.changes` journal event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHANGES_EVENT, changesReport, flags } from '../../src/release/flags.ts';
import type { SessionEvent } from '../../src/session/events.ts';

const custom = (seq: number, name: string, value: unknown): SessionEvent =>
  ({ seq, at: '2026-10-22T10:00:00.000Z', sessionId: 's1', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'CUSTOM', name, value } } as unknown as SessionEvent);

test('the default gives no group and no flag, with or without a report', () => {
  assert.deepEqual(flags({ diff: 'diff --git a/package.json b/package.json\n+  "left-pad": "1.0.0"\n' }), { groups: [], flags: [] });
  assert.deepEqual(flags({ diff: '', report: { groups: [{ intent: 'Sort the entries', files: ['src/page.ts'] }] } }), { groups: [], flags: [] });
});

test('the report is the value of the last cleared.changes event, by that name', () => {
  assert.equal(CHANGES_EVENT, 'cleared.changes');
  const events = [
    custom(1, 'cleared.changes', { groups: [{ intent: 'First try', files: ['a.ts'] }] }),
    custom(2, 'cleared.question', { groups: [{ intent: 'Not a report', files: ['x.ts'] }] }),
    custom(3, 'cleared.changes', { groups: [{ intent: 'Sort the entries', files: ['src/page.ts', 'test/page.test.ts'] }, { intent: 'Docs', files: ['README.md'] }] }),
    custom(4, 'cleared.review_verdict', { verdict: 'pass' }),
  ];
  assert.deepEqual(changesReport(events), { groups: [{ intent: 'Sort the entries', files: ['src/page.ts', 'test/page.test.ts'] }, { intent: 'Docs', files: ['README.md'] }] });
});

test('no report, or a report of another shape, reads as none', () => {
  assert.equal(changesReport([]), undefined);
  assert.equal(changesReport([custom(1, 'cleared.changes', { groups: 'all of it' })]), undefined);
  assert.equal(changesReport([custom(1, 'cleared.changes', { groups: [{ intent: 3, files: [] }] })]), undefined);
  assert.equal(changesReport([custom(1, 'cleared.changes', null)]), undefined);
});
