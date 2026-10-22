// The pure parts of the milestone 2 proof (scripts/proof-report.ts): what
// changed between two readings of the state, the timeline the night watch
// keeps, the commitment check, the order of "3 after 2", the facts read
// from the ledger, and the durations table.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { LeadCommitment } from '../../src/api/types.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { RUNS_TABLES } from '../../src/approval/review.ts';
import { changes, commitmentOutcomes, ledgerFacts, morningSummary, newTimeline, orderCheck, renderDurations, track, PLANTED, type ProofResult, type Snapshot } from '../../scripts/proof-report.ts';

const lead = { generation: 1, phase: 'idle', percent: 3, highestPercent: 3, refreshCount: 0, openCommitments: 2 };
const items = (states: string[]) => states.map((state, i) => ({ position: i + 1, title: `Item ${i + 1}`, state, ticket: state === 'waiting' ? null : `LOCAL-${i + 1}`, after: i === 2 ? [2] : [] }));
const snap = (at: string, over: Partial<Snapshot> = {}): Snapshot => ({
  at, lead, plan: { id: 'p1', state: 'approved', items: items(['running', 'running', 'waiting', 'ready', 'waiting']) }, inbox: [], sessions: [], notifications: 0, ...over,
});

test('the first reading says what it found; a reading that changed nothing says nothing', () => {
  const first = snap('2026-10-22T21:00:00.000Z');
  assert.ok(changes(undefined, first).length > 0);
  assert.deepEqual(changes(first, snap('2026-10-22T21:05:00.000Z')), []);
});

test('each change the night watch reports: items, inbox, sessions, the lead, notifications', () => {
  const before = snap('2026-10-22T21:00:00.000Z', { sessions: [{ id: 's1', ticket: 'LOCAL-1', role: 'author', phase: 'working' }] });
  const after = snap('2026-10-22T21:05:00.000Z', {
    lead: { ...lead, generation: 2, refreshCount: 1, percent: 2.4 },
    plan: { id: 'p1', state: 'approved', items: items(['needs_approval', 'running', 'waiting', 'running', 'waiting']) },
    inbox: [{ id: 'release:LOCAL-1:101', kind: 'release', ticket: 'LOCAL-1' }],
    sessions: [{ id: 's2', ticket: 'LOCAL-4', role: 'author', phase: 'waiting' }],
    notifications: 2,
  });
  assert.deepEqual(changes(before, after), [
    'lead: generation 1 → 2 (refresh 1)',
    'lead: context 3 % → 2 %',
    'item 1 (LOCAL-1): running → needs_approval',
    'item 4 (LOCAL-4): ready → running',
    'inbox: + release release:LOCAL-1:101 (LOCAL-1)',
    'session: − author s1 (LOCAL-1)',
    'session: + author s2 (LOCAL-4) waiting',
    'notifications: 0 → 2',
  ]);
  assert.deepEqual(changes(after, { ...after, inbox: [], at: '2026-10-22T21:10:00.000Z' }), ['inbox: − release release:LOCAL-1:101 (LOCAL-1)']);
});

test('the timeline keeps when each item first reached each state, each wait, and the most items running at once', () => {
  const t = newTimeline();
  track(t, snap('2026-10-22T21:00:00.000Z'));
  track(t, snap('2026-10-22T21:05:00.000Z', { inbox: [{ id: 'permission:s1:r1', kind: 'permission', ticket: 'LOCAL-1' }], plan: { id: 'p1', state: 'approved', items: items(['running', 'needs_approval', 'waiting', 'running', 'waiting']) } }));
  track(t, snap('2026-10-22T21:10:00.000Z', { plan: { id: 'p1', state: 'approved', items: items(['running', 'landed', 'running', 'running', 'waiting']) } }));
  assert.equal(t.items[2]?.states.needs_approval, '2026-10-22T21:05:00.000Z');
  assert.equal(t.items[2]?.states.landed, '2026-10-22T21:10:00.000Z');
  assert.equal(t.items[1]?.states.running, '2026-10-22T21:00:00.000Z');
  assert.deepEqual(t.waits['permission:s1:r1'], { kind: 'permission', ticket: 'LOCAL-1', seenAt: '2026-10-22T21:05:00.000Z', goneAt: '2026-10-22T21:10:00.000Z' });
  assert.equal(t.maxRunning, 3);
  assert.equal(t.items[3]?.ticket, 'LOCAL-3');
});

test('"3 after 2": kept when 3 started after 2 landed, broken before, open while 3 has not started', () => {
  const t = newTimeline();
  track(t, snap('2026-10-22T21:00:00.000Z', { plan: { id: 'p1', state: 'approved', items: items(['running', 'needs_approval', 'waiting', 'ready', 'waiting']) } }));
  assert.equal(orderCheck(t, 3, 2).state, 'open');
  track(t, snap('2026-10-23T08:20:00.000Z', { plan: { id: 'p1', state: 'approved', items: items(['landed', 'landed', 'waiting', 'landed', 'waiting']) } }));
  track(t, snap('2026-10-23T08:25:00.000Z', { plan: { id: 'p1', state: 'approved', items: items(['landed', 'landed', 'running', 'landed', 'waiting']) } }));
  assert.deepEqual(orderCheck(t, 3, 2), { state: 'done', note: 'item 3 started at 2026-10-23T08:25:00.000Z, after item 2 landed at 2026-10-23T08:20:00.000Z' });
  const early = newTimeline();
  track(early, snap('2026-10-22T21:00:00.000Z', { plan: { id: 'p1', state: 'approved', items: items(['running', 'running', 'running', 'ready', 'waiting']) } }));
  assert.equal(orderCheck(early, 3, 2).state, 'broken');
});

const commitment = (over: Partial<LeadCommitment>): LeadCommitment => ({ id: 'c1', text: '', ticket: null, due: null, state: 'open', createdAt: '2026-10-22T21:02:00.000Z', fulfilledAt: null, note: null, ...over });

test('the commitment check: each planted commitment found done or open, and lost when no commitment holds it', () => {
  const outcomes = commitmentOutcomes([
    commitment({ id: 'c1', text: 'Tell the owner how long the first ticket took from start to live.', state: 'done', fulfilledAt: '2026-10-23T08:31:00.000Z', note: 'told: 11 h 20' }),
    commitment({ id: 'c2', text: 'At 08:00 remind the owner to check the texts of the page.', due: '2026-10-23T06:00:00.000Z' }),
  ]);
  assert.deepEqual(outcomes.map((o) => [o.key, o.state, o.ids]), [['first_landing', 'done', ['c1']], ['reminder', 'open', ['c2']]]);
  assert.equal(outcomes[1]?.due, '2026-10-23T06:00:00.000Z');
  assert.deepEqual(commitmentOutcomes([]).map((o) => o.state), ['lost', 'lost']);
  // A commitment the lead made again after a refresh counts once: any done one settles it.
  assert.equal(commitmentOutcomes([commitment({ id: 'c3', text: 'how long the first ticket took', state: 'open' }), commitment({ id: 'c1', text: 'How long did the first ticket take from start to live', state: 'done' })])[0]?.state, 'done');
  assert.equal(PLANTED.length, 2);
});

test('the morning: what waits by kind, tickets by state, and the lead\'s night messages', () => {
  const morning = morningSummary(
    snap('2026-10-23T06:00:00.000Z', {
      inbox: [{ id: 'release:a', kind: 'release', ticket: 'LOCAL-1' }, { id: 'release:b', kind: 'release', ticket: 'LOCAL-2' }, { id: 'permission:c', kind: 'permission', ticket: 'LOCAL-4' }],
      plan: { id: 'p1', state: 'approved', items: items(['needs_approval', 'needs_approval', 'waiting', 'running', 'waiting']) },
    }),
    [
      { seq: 1, at: '2026-10-22T20:59:00.000Z', by: 'lead', text: 'Before the night.', kind: 'message' },
      { seq: 2, at: '2026-10-22T23:30:00.000Z', by: 'lead', text: 'LOCAL-1 waits for your approval.', kind: 'message' },
      { seq: 3, at: '2026-10-23T01:00:00.000Z', by: 'system', text: 'refresh', kind: 'refresh', generation: 2 },
    ],
    '2026-10-22T21:00:00.000Z',
  );
  assert.deepEqual(morning.waitingByKind, { release: 2, permission: 1 });
  assert.deepEqual(morning.itemsByState, { needs_approval: 2, waiting: 2, running: 1 });
  assert.deepEqual(morning.nightMessages, [{ at: '2026-10-22T23:30:00.000Z', by: 'lead', text: 'LOCAL-1 waits for your approval.' }, { at: '2026-10-23T01:00:00.000Z', by: 'system', text: 'generation 2 starts' }]);
});

test('the ledger facts: notifications by kind, the lead\'s turns, cost and highest share, each ticket\'s sessions, rounds and cost', () => {
  const store = openStore(':memory:');
  applyTables(store.db, [...RUNS_TABLES]);
  const db: DatabaseSync = store.db;
  const since = '2026-10-22T21:00:00.000Z';
  const session = (id: string, ticket: string, role: string) => store.sessions.put({ id, project: 'guestbook', ticket, role: role as never, harness: 'claude-code', model: 'm', status: 'done', createdAt: '2026-10-22T21:01:00.000Z', updatedAt: '2026-10-22T21:01:00.000Z' });
  const finished = (sessionId: string, ticket: string, cost: number, at = '2026-10-22T21:30:00.000Z') =>
    store.events.append({ at, sessionId, ticket, project: 'guestbook', event: { type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: cost } } });
  const share = (sessionId: string, percent: number) =>
    store.events.append({ at: '2026-10-22T21:31:00.000Z', sessionId, ticket: 'lead', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.context_usage', value: { percent, totalTokens: 1, maxTokens: 100, isAutoCompactEnabled: true } } });
  session('l1', 'lead', 'lead'); session('l2', 'lead', 'lead'); session('a1', 'LOCAL-1', 'author'); session('r1', 'LOCAL-1', 'reviewer'); session('r2', 'LOCAL-1', 'reviewer');
  finished('l1', 'lead', 0.05); finished('l1', 'lead', 0.05); finished('l2', 'lead', 0.1); finished('a1', 'LOCAL-1', 0.3); finished('r1', 'LOCAL-1', 0.1); finished('r2', 'LOCAL-1', 0.12);
  finished('l1', 'lead', 9, '2026-10-22T20:00:00.000Z');   // before the goal: not counted
  share('l1', 4.2); share('l2', 3.1);
  const sent = (kind: string, at = '2026-10-22T22:00:00.000Z') => db.prepare("INSERT INTO events (at, kind, detail, source) VALUES (?, 'notification_sent', ?, 'notify')").run(at, JSON.stringify({ event: kind, adapter: 'email' }));
  sent('plan'); sent('permission'); sent('approval'); sent('approval'); sent('approval', '2026-10-22T20:00:00.000Z');
  const facts = ledgerFacts(db, since);
  assert.deepEqual(facts.notifications, { count: 4, byKind: { plan: 1, permission: 1, approval: 2 }, firstAt: { plan: '2026-10-22T22:00:00.000Z', permission: '2026-10-22T22:00:00.000Z', approval: '2026-10-22T22:00:00.000Z' } });
  assert.deepEqual(facts.lead, { generations: 2, turns: 3, costUsd: 0.2, highestPercent: 4.2, compactions: 0 });
  assert.deepEqual(facts.tickets, { 'LOCAL-1': { sessions: 3, reviewRounds: 2, costUsd: 0.52, startedAt: '2026-10-22T21:01:00.000Z', lastAt: '2026-10-22T21:01:00.000Z' } });
  assert.equal(facts.maxLive, 1);
  // A ledger without the v1 events table yet has no notifications.
  const bare = openStore(':memory:');
  assert.deepEqual(ledgerFacts(bare.db, since).notifications, { count: 0, byKind: {}, firstAt: {} });
});

test('the most tickets live at once, from the sessions\' first start to their last update', () => {
  const store = openStore(':memory:');
  const session = (id: string, ticket: string, role: string, from: string, to: string) => store.sessions.put({ id, project: 'guestbook', ticket, role: role as never, harness: 'claude-code', model: 'm', status: 'done', createdAt: from, updatedAt: to });
  session('a1', 'LOCAL-1', 'author', '2026-10-22T21:01:00.000Z', '2026-10-22T21:05:00.000Z');
  session('r1', 'LOCAL-1', 'reviewer', '2026-10-22T21:05:00.000Z', '2026-10-22T21:09:00.000Z');
  session('a2', 'LOCAL-2', 'author', '2026-10-22T21:02:00.000Z', '2026-10-22T21:04:00.000Z');
  session('a3', 'LOCAL-3', 'author', '2026-10-22T21:10:00.000Z', '2026-10-22T21:12:00.000Z');
  session('a4', 'LOCAL-4', 'author', '2026-10-22T21:08:00.000Z', '2026-10-22T21:11:00.000Z');
  const facts = ledgerFacts(store.db, '2026-10-22T21:00:00.000Z');
  assert.equal(facts.maxLive, 2);
  assert.equal(facts.tickets['LOCAL-1']?.lastAt, '2026-10-22T21:09:00.000Z');
});

test('the durations table names every step with its time, the lead, the commitments, the costs and the waits', () => {
  const result: ProofResult = {
    mode: 'rehearsal', app: 'http://127.0.0.1:9700', goal: 'Make the guestbook ready for a small team.', startedAt: '2026-10-22T21:00:00.000Z',
    steps: [{ n: 1, name: 'goal', status: 'ok', seenAt: '2026-10-22T21:00:05.000Z', note: 'goal sent' }, { n: 2, name: 'questions', status: 'failed', seenAt: '2026-10-22T21:01:00.000Z', note: 'no question' }],
    times: { goal_sent_at: '2026-10-22T21:00:05.000Z', first_question_at: '2026-10-22T21:00:20.000Z', plan_proposed_at: '2026-10-22T21:01:30.000Z', approved_at: '2026-10-22T21:03:00.000Z' },
    answers: [{ at: '2026-10-22T21:00:40.000Z', text: 'Pages of 20 (Recommended)' }],
    plan: { id: 'p1', title: 'Ready for a small team', items: [{ position: 1, title: 'Entries as JSON', lane: 'full', after: [], minutes: 12, costUsd: 0.3 }], totals: { minutes: 12, costUsd: 0.3, samples: 0 } },
    items: { 1: { title: 'Entries as JSON', ticket: 'LOCAL-1', states: { running: '2026-10-22T21:03:30.000Z', needs_approval: '2026-10-22T21:20:00.000Z', landed: '2026-10-23T08:10:00.000Z' } } },
    maxRunning: 2,
    waits: { 'release:a': { kind: 'release', ticket: 'LOCAL-1', seenAt: '2026-10-22T21:20:00.000Z', goneAt: '2026-10-23T08:05:00.000Z' } },
    morning: { at: '2026-10-23T06:00:00.000Z', waitingByKind: { release: 1 }, itemsByState: { needs_approval: 1 }, nightMessages: [{ at: '2026-10-22T23:00:00.000Z', by: 'lead', text: 'LOCAL-1 waits.' }] },
    lead: { refreshCount: 3, highestPercent: 4.5, threshold: 5, generations: 4, turns: 12, costUsd: 0.6, compactions: 0 },
    commitments: [{ key: 'first_landing', planted: 'When the first ticket lands, tell me how long it took from start to live.', state: 'done', ids: ['c1'], due: null, fulfilledAt: '2026-10-23T08:11:00.000Z', note: 'told' }],
    order: { state: 'done', note: 'item 3 started after item 2 landed' },
    notifications: { count: 3, byKind: { plan: 1, approval: 2 }, firstAt: { plan: '2026-10-22T21:01:40.000Z' } },
    tickets: { 'LOCAL-1': { sessions: 2, reviewRounds: 1, costUsd: 0.4, startedAt: '2026-10-22T21:03:30.000Z', lastAt: '2026-10-22T21:20:00.000Z' } },
    gestures: [{ at: '2026-10-22T21:00:05.000Z', what: 'sent the goal' }, { at: '2026-10-23T08:05:00.000Z', what: 'approved release:a' }],
    planDoneAt: null,
    stand_ins: ['a bare copy of the guestbook as the forge'],
  };
  const text = renderDurations(result);
  for (const expected of [
    '# Milestone 2 proof: durations (rehearsal)', '| 1 | goal | ok |', '| 2 | questions | failed |', 'goal sent → first question | 15 s',
    'last answer → plan proposed | 50 s', '| 1 | Entries as JSON | LOCAL-1 |', 'refreshes | 3', 'highest context share | 4.5 % (threshold 5 %)',
    '| first_landing | done | c1 |', '"3 after 2" | done', '| approval | 2 |', '| LOCAL-1 | 2 | 1 | $0.40 |', '| release | LOCAL-1 | 2026-10-22T21:20:00.000Z | 2026-10-23T08:05:00.000Z | 10 h 45 |',
    'owner gestures | 2', 'a bare copy of the guestbook as the forge', 'the plan is not done',
  ]) assert.ok(text.includes(expected), `missing: ${expected}\n\n${text}`);
});
