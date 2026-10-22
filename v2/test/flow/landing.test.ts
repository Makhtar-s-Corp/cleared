// The landing follow-through (docs/v2/milestone-2-plan.md, decision 12, lane 2):
// a ticket in the go state is merged through the lock, asked again while the
// lock queues it, watched until the release watch says how it went, and Done.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FlowEffects } from '../../src/flow/engine.ts';
import { FlowEngine } from '../../src/flow/engine.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import { readFileSync } from 'node:fs';
import { RELEASES_TABLE, approved, ledgerRow, quickAuthor, releaseRow, setup, stepLines, type Setup, type SetupOptions } from './support.ts';

type Merge = Awaited<ReturnType<FlowEffects['mergeRelease']>>;

// A lock that answers from a list, and records when it was asked.
function lock(answers: Merge['outcome'][], at: () => number) {
  const asked: number[] = [];
  const effects: Partial<FlowEffects> = {
    async mergeRelease() {
      asked.push(at());
      const outcome = answers.shift() ?? 'queued';
      return { outcome, message: outcome === 'refused' ? '#7 is not put live: the user has not agreed' : `the lock said ${outcome}` };
    },
  };
  return { asked, effects };
}

async function landing(options: SetupOptions & { answers?: Merge['outcome'][]; approveAfterMs?: number } = {}) {
  let now = () => 0;
  const broker = lock(options.answers ?? [], () => now());
  const t = await setup({ scripts: { author: quickAuthor }, ...options, effects: { ...broker.effects, ...options.effects } });
  now = () => t.clock.now;
  await approved(t, options.approveAfterMs);
  return { t, asked: broker.asked };
}

const reviewer = (t: Setup) => t.startedSessions.find((s) => s.input.role === 'reviewer')!.id;
const steps = (t: Setup) => stepLines(t.store.events.after(reviewer(t)));
const stepAt = (t: Setup, type: 'STEP_STARTED' | 'STEP_FINISHED', name: string) =>
  t.store.events.after(reviewer(t)).find((e) => e.event.type === type && e.event.stepName === name)?.at;
const types = (t: Setup) => t.flowEvents.map((e) => e.type);
const of = <K extends FlowEvent['type']>(t: Setup, type: K) => t.flowEvents.filter((e): e is Extract<FlowEvent, { type: K }> => e.type === type);

async function tickAfter(t: Setup, ms: number): Promise<void> {
  t.clock.now += ms;
  await t.engine.tick();
  await t.engine.settled();
}

const iso = (ms: number) => new Date(ms).toISOString();

test('a merge the lock queues is asked again every 60 seconds until it merges; the watch runs from the merge to the healthy row; the ticket is Done', async () => {
  const { t, asked } = await landing({ answers: ['queued', 'queued', 'merged'] });
  const approvedAt = t.clock.now;
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Ready to Ship');
  assert.deepEqual(asked, [], 'the approval writer asks the lock first: the flow waits one interval');

  await tickAfter(t, 30_000);
  assert.deepEqual(asked, [], 'not before the interval');
  await tickAfter(t, 30_000);
  await tickAfter(t, 60_000);
  await tickAfter(t, 30_000);
  assert.equal(asked.length, 2, 'a tick inside the interval asks nothing');
  await tickAfter(t, 30_000);
  assert.deepEqual(asked.map((at) => (at - approvedAt) / 1000), [60, 120, 180], 'three calls, 60 seconds apart');
  await tickAfter(t, 60_000);
  assert.equal(asked.length, 3, 'merged: never asked again');

  // The watch step opened at the merge, on the session the approval ran on.
  assert.deepEqual(steps(t).slice(-3), ['+approval', '-approval', '+watch']);
  assert.equal(stepAt(t, 'STEP_STARTED', 'watch'), iso(approvedAt + 180_000));
  assert.deepEqual(types(t).filter((x) => x.startsWith('release_')), ['release_requested', 'release_approved', 'release_merged']);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Ready to Ship', 'not Done before the release watch says it is healthy');

  // The release watch's healthy end, in the ledger: the watch closes at that row's time, the ticket lands and is Done.
  const healthyAt = iso(approvedAt + 400_000);
  releaseRow(t.store, { ticket: t.ticket.id, pr: 7, status: 'watching', mergedAt: iso(approvedAt + 180_000) });
  await tickAfter(t, 60_000);
  assert.equal(steps(t).at(-1), '+watch', 'a release still watched is not landed');
  t.store.db.prepare("UPDATE releases SET status = 'complete', last_health = 'HTTP 200', ended_at = ?").run(healthyAt);
  ledgerRow(t.store, { kind: 'release_watch_complete', ticket: t.ticket.id, pr: 7, at: healthyAt, detail: 'HTTP 200' });
  await tickAfter(t, 300_000);
  assert.equal(steps(t).at(-1), '-watch');
  assert.equal(stepAt(t, 'STEP_FINISHED', 'watch'), healthyAt);
  assert.deepEqual(of(t, 'release_landed').map((e) => [e.pr, e.health]), [[7, 'healthy']]);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Done');
  assert.equal((await t.tickets.history(t.ticket.id)).at(-1)?.by.kind, 'agents');

  // Nothing more happens on later ticks.
  const before = t.flowEvents.length;
  await tickAfter(t, 600_000);
  assert.equal(t.flowEvents.length, before);
  assert.equal(steps(t).filter((s) => s === '-watch').length, 1);
});

test('a merge the approval already made is read from the ledger: no call, the watch opens at the merge, and a Done move by the lock is kept', async () => {
  const { t, asked } = await landing();
  const approvedAt = t.clock.now;
  const mergedAt = iso(approvedAt + 20_000).replace('.000Z', 'Z');
  ledgerRow(t.store, { kind: 'merged_by_script', ticket: t.ticket.id, pr: 7, at: mergedAt });
  await t.tickets.move(t.ticket.id, 'Done', { kind: 'agents', id: 'cleared' });
  await tickAfter(t, 60_000);
  assert.deepEqual(asked, []);
  assert.equal(stepAt(t, 'STEP_STARTED', 'watch'), new Date(mergedAt).toISOString(), 'the merge time the ledger holds');
  assert.deepEqual(types(t).at(-1), 'release_merged');

  releaseRow(t.store, { ticket: t.ticket.id, pr: 7, status: 'complete', mergedAt, endedAt: iso(approvedAt + 200_000) });
  ledgerRow(t.store, { kind: 'release_watch_complete', ticket: t.ticket.id, pr: 7, at: iso(approvedAt + 200_000) });
  await tickAfter(t, 200_000);
  assert.deepEqual(of(t, 'release_landed').map((e) => e.health), ['healthy']);
  assert.equal((await t.tickets.history(t.ticket.id)).filter((h) => h.status === 'Done').length, 1, 'the lock moved it to Done: the flow does not move it again');
});

test('the merge time is compared as an instant: a row written to the second, in the second of the go move, counts', async () => {
  const { t, asked } = await landing({ approveAfterMs: 400 });
  const goAt = (await t.tickets.history(t.ticket.id)).at(-1)!.at;
  assert.match(goAt, /\.400Z$/);
  // merge-pr.sh writes its time to the second (now_utc), so its row reads before the go move's millisecond.
  ledgerRow(t.store, { kind: 'merged_by_script', ticket: t.ticket.id, pr: 7, at: goAt.replace(/\.\d+Z$/, 'Z') });
  await tickAfter(t, 60_000);
  assert.deepEqual(asked, []);
  assert.ok(types(t).includes('release_merged'));
});

test('ledger rows of another pull request, another ticket, or from before the approval are not this release', async () => {
  const { t, asked } = await landing({ answers: ['queued', 'queued'] });
  const before = iso(t.clock.now - 3600_000);
  ledgerRow(t.store, { kind: 'merged_by_script', ticket: t.ticket.id, pr: 7, at: before });
  ledgerRow(t.store, { kind: 'merged_by_script', ticket: t.ticket.id, pr: 8, at: iso(t.clock.now + 1000) });
  ledgerRow(t.store, { kind: 'merged_by_script', ticket: 'LOCAL-99', pr: 7, at: iso(t.clock.now + 1000) });
  await tickAfter(t, 60_000);
  await tickAfter(t, 60_000);
  assert.equal(asked.length, 2);
  assert.ok(!types(t).includes('release_merged'));
});

test('a rollback pushed by the release watch is rolled_back: the watch closes, the note is on the ticket, and the ticket is put back', async () => {
  const { t } = await landing({ answers: ['merged'] });
  await tickAfter(t, 60_000);
  assert.ok(types(t).includes('release_merged'));
  ledgerRow(t.store, { kind: 'release_health_failing', ticket: t.ticket.id, pr: 7, at: iso(t.clock.now + 60_000), detail: 'HTTP 500' });
  ledgerRow(t.store, { kind: 'rollback_pushed', ticket: t.ticket.id, pr: 7, at: iso(t.clock.now + 90_000), detail: 'abc reverted by def' });
  await tickAfter(t, 120_000);
  assert.equal(steps(t).at(-1), '-watch');
  const [rolled] = of(t, 'rolled_back');
  assert.equal(rolled?.pr, 7);
  assert.match(rolled?.note ?? '', /abc reverted by def/);
  assert.deepEqual(of(t, 'ticket_put_back').map((e) => e.reason), ['rolled_back']);
  assert.ok(!types(t).includes('release_landed'));
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /rolled back|reverted/i);
});

test('a refusal for good is noted on the ticket, which goes back to Todo, and the lock is not asked again', async () => {
  const { t, asked } = await landing({ answers: ['refused'] });
  await tickAfter(t, 60_000);
  assert.equal(asked.length, 1);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Todo');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /the user has not agreed/);
  assert.deepEqual(of(t, 'ticket_put_back').map((e) => e.reason), ['merge_refused']);
  await tickAfter(t, 60_000);
  await tickAfter(t, 60_000);
  assert.equal(asked.length, 1);
  assert.ok(!steps(t).includes('+watch'));
});

test('an unavailable lock is asked again, like a queued merge', async () => {
  const { t, asked } = await landing({ answers: ['unavailable', 'merged'] });
  await tickAfter(t, 60_000);
  await tickAfter(t, 60_000);
  assert.equal(asked.length, 2);
  assert.ok(types(t).includes('release_merged'));
});

test('a merge still running is not asked a second time', async () => {
  let release: (merge: Merge) => void = () => {};
  const calls: number[] = [];
  const { t } = await landing({ effects: { mergeRelease: () => { calls.push(1); return new Promise<Merge>((resolve) => { release = resolve; }); } } });
  t.clock.now += 60_000;
  await t.engine.tick();
  t.clock.now += 60_000;
  await t.engine.tick();
  t.clock.now += 60_000;
  await t.engine.tick();
  assert.equal(calls.length, 1);
  release({ outcome: 'merged', message: '' });
  await t.engine.settled();
  assert.ok(types(t).includes('release_merged'));
});

test('a watch that ends with a failing health and no rollback is release_unhealthy: noted, closed, never Done by the flow', async () => {
  const { t } = await landing({ answers: ['merged'] });
  await tickAfter(t, 60_000);
  releaseRow(t.store, { ticket: t.ticket.id, pr: 7, status: 'complete', mergedAt: iso(t.clock.now), lastHealth: 'HTTP 503', endedAt: iso(t.clock.now + 120_000) });
  ledgerRow(t.store, { kind: 'release_health_failing', ticket: t.ticket.id, pr: 7, at: iso(t.clock.now + 60_000), detail: 'HTTP 503' });
  ledgerRow(t.store, { kind: 'release_watch_complete', ticket: t.ticket.id, pr: 7, at: iso(t.clock.now + 120_000), detail: 'HTTP 503' });
  await tickAfter(t, 180_000);
  assert.equal(steps(t).at(-1), '-watch');
  assert.deepEqual(of(t, 'release_unhealthy').map((e) => e.pr), [7]);
  assert.ok(!types(t).includes('release_landed'));
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Ready to Ship');
  assert.match((await t.tickets.comments(t.ticket.id)).at(-1)?.body ?? '', /HTTP 503/);
});

test('a watch that could not start, or a rollback the watch could not make, is release_unhealthy too', async () => {
  for (const kind of ['release_watch_failed', 'rollback_migrations_blocked']) {
    const { t } = await landing({ answers: ['merged'] });
    await tickAfter(t, 60_000);
    // merge-pr.sh writes release_watch_failed when the watch never started, so no release row; the blocked rollback ends the row as failed.
    if (kind !== 'release_watch_failed') releaseRow(t.store, { ticket: t.ticket.id, pr: 7, status: 'failed', mergedAt: iso(t.clock.now), endedAt: iso(t.clock.now + 1000) });
    ledgerRow(t.store, { kind, ticket: t.ticket.id, pr: 7, at: iso(t.clock.now + 1000), detail: `${kind} detail` });
    await tickAfter(t, 60_000);
    assert.deepEqual(of(t, 'release_unhealthy').map((e) => e.note.includes(`${kind} detail`)), [true], kind);
  }
});

test('a project without a health check lands at the merge, unwatched', async () => {
  const { t } = await landing({ answers: ['merged'] });
  await tickAfter(t, 60_000);
  releaseRow(t.store, { ticket: t.ticket.id, pr: 7, status: 'complete', mergedAt: iso(t.clock.now) });
  ledgerRow(t.store, { kind: 'release_health_unconfigured', ticket: t.ticket.id, pr: 7, at: iso(t.clock.now), detail: 'No [release] health_url or health_command' });
  await tickAfter(t, 30_000);
  assert.deepEqual(of(t, 'release_landed').map((e) => e.health), ['unwatched']);
  assert.equal((await t.tickets.get(t.ticket.id))?.status, 'Done');
});

test('without the v1 events table the landing still asks the lock and nothing throws', async () => {
  const { t, asked } = await landing({ ledger: false, answers: ['queued', 'merged'] });
  await tickAfter(t, 60_000);
  await tickAfter(t, 60_000);
  assert.equal(asked.length, 2);
  assert.ok(types(t).includes('release_merged'));
});

test('the merge is asked with the release\'s announcement, which merge-pr.sh needs for an agreed change', async () => {
  const seen: string[] = [];
  const { t } = await landing({ effects: { async mergeRelease(input) { seen.push(input.announcement); return { outcome: 'merged', message: '' }; } } });
  await tickAfter(t, 60_000);
  assert.equal(seen.length, 1);
  assert.match(seen[0] ?? '', /Newest entry first/);
  assert.match(seen[0] ?? '', /Pull request: https:\/\/example\.invalid\/pull\/7/);
});

test('a new engine follows a landing the last one started: the retries go on, the merge opens the watch once', async () => {
  const { t, asked } = await landing({ answers: ['queued', 'merged'] });
  await tickAfter(t, 60_000);
  assert.equal(asked.length, 1);
  const next = new FlowEngine(t.deps);
  const events: FlowEvent[] = [];
  next.subscribe((e) => { events.push(e); });
  await next.recover();
  t.clock.now += 30_000;
  await next.tick();
  await next.settled();
  assert.equal(asked.length, 1, 'the new engine waits one interval too');
  t.clock.now += 60_000;
  await next.tick();
  await next.settled();
  assert.equal(asked.length, 2);
  assert.deepEqual(events.map((e) => e.type), ['release_merged']);
  t.clock.now += 60_000;
  await next.tick();
  await next.settled();
  assert.equal(steps(t).filter((s) => s === '+watch').length, 1);
});

test('the releases table of the tests is lib/release.mjs\'s, word for word', () => {
  const v1 = readFileSync(new URL('../../../lib/release.mjs', import.meta.url), 'utf8');
  assert.ok(v1.includes(RELEASES_TABLE), 'support.ts RELEASES_TABLE must be copied from lib/release.mjs');
});
