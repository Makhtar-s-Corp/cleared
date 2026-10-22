// The feature end to end (docs/v2/milestone-2-plan.md, lane 18): on the fake
// adapter, a ticket whose author left a report as its last
// `cleared.changes` journal event is published, and the release item lane
// 16's publish step makes through addRelease carries the groups and the
// flags flags() computes from the report and the diff. The wiring is lane
// 16's; this test proves the filled function reaches the card.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ReleaseItem } from '../../src/api/types.ts';
import type { AgUiEvent } from '../../src/session/events.ts';
import { CHANGES_EVENT } from '../../src/release/flags.ts';
import { REPORT_PASS, finished, reviewerScript, setup, started, text, until } from '../flow/support.ts';

const DIFF = [
  'diff --git a/package.json b/package.json',
  'index 1111111..2222222 100644',
  '--- a/package.json',
  '+++ b/package.json',
  '@@ -8,3 +8,4 @@',
  '   "dependencies": {',
  '+    "left-pad": "1.3.0",',
  '     "pg": "8.13.1"',
  '   },',
  'diff --git a/db/migrations/0003_held.sql b/db/migrations/0003_held.sql',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/db/migrations/0003_held.sql',
  '@@ -0,0 +1 @@',
  '+ALTER TABLE entries ADD COLUMN held BOOLEAN;',
  'diff --git a/src/page.ts b/src/page.ts',
  'index 4444444..5555555 100644',
  '--- a/src/page.ts',
  '+++ b/src/page.ts',
  '@@ -1,3 +1,3 @@',
  ' export function page() {',
  '-  return entries;',
  '+  return entries.toReversed();',
  ' }',
  '',
].join('\n');

async function publishWith(report: unknown) {
  const author = [started, ...text('a1', 'I will sort the entries.'), { awaitMessage: true as const }, finished(0.4)];
  const t = await setup({
    scripts: { author, reviewers: [reviewerScript(REPORT_PASS)] },
    effects: { async changes() { return { files: ['package.json', 'db/migrations/0003_held.sql', 'src/page.ts'], diff: DIFF }; } },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.startedSessions.length > 0, 'the author');
  const session = t.startedSessions[0]!.id;
  const plant = (value: unknown) => t.store.events.append({
    at: new Date(t.clock.now).toISOString(), sessionId: session, ticket: t.ticket.id, project: 'guestbook',
    event: { type: 'CUSTOM', name: CHANGES_EVENT, value } as unknown as AgUiEvent,
  });
  if (report !== undefined) {
    plant({ groups: [{ intent: 'An earlier report', files: ['src/page.ts'] }] });
    plant(report);
  }
  await t.engine.send(session, 'Go on.', 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release item');
  await t.engine.settled();
  const item = t.inbox.list().find((i) => i.kind === 'release') as ReleaseItem;
  await t.engine.close();
  return item;
}

test('the release card carries the groups of the last report and the flags of the diff', async () => {
  const item = await publishWith({ groups: [{ intent: 'Show the newest entry first', files: ['src/page.ts'] }, { intent: 'Keep held entries', files: ['db/migrations/0003_held.sql'] }] });
  assert.deepEqual(item.groups, [
    { intent: 'Show the newest entry first', files: ['src/page.ts'] },
    { intent: 'Keep held entries', files: ['db/migrations/0003_held.sql'] },
    { intent: 'Other changes', files: ['package.json'] },
  ]);
  assert.deepEqual(item.flags?.map((f) => [f.kind, f.files]), [['schema', ['db/migrations/0003_held.sql']], ['dependency', ['package.json']]]);
});

test('without a report the card has the flags and no group', async () => {
  const item = await publishWith(undefined);
  assert.equal(item.groups, undefined, 'no group is kept when there is none');
  assert.deepEqual(item.flags?.map((f) => f.kind), ['schema', 'dependency']);
});
