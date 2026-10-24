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
import {
  LOGIN_WAIT, NOTIFICATIONS_SKIPPED_NOTE, changes, highestShare, humanFacts, notificationCount, commitmentOutcomes, ledgerFacts, morningSummary, newTimeline, orderCheck, renderDurations, renderMultiDurations,
  sessionPlanFacts, track, trainFacts, PLANTED, type MultiResult, type ProofResult, type Snapshot,
} from '../../scripts/proof-report.ts';
import { TrainStore } from '../../src/release/store.ts';

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
  assert.deepEqual(commitmentOutcomes([]).map((o) => o.state), ['not_recorded', 'not_recorded']);
  // A commitment the lead made again after a refresh counts once: any done one settles it.
  assert.equal(commitmentOutcomes([commitment({ id: 'c3', text: 'how long the first ticket took', state: 'open' }), commitment({ id: 'c1', text: 'How long did the first ticket take from start to live', state: 'done' })])[0]?.state, 'done');
  assert.equal(PLANTED.length, 2);
});

test('the commitment check by the ids the lead recorded when each was planted: a paraphrase counts, a dropped id is lost', () => {
  const paraphrase = commitment({ id: 'c4', text: 'Report the start-to-live duration of the opening ticket once it ships.', state: 'done', fulfilledAt: '2026-10-23T08:31:00.000Z' });
  const reminder = commitment({ id: 'c5', text: 'Ping the owner about the page copy in the morning.', due: '2026-10-23T06:00:00.000Z' });
  const outcomes = commitmentOutcomes([paraphrase, reminder], { first_landing: ['c4'], reminder: ['c5'] });
  assert.deepEqual(outcomes.map((o) => [o.key, o.state, o.ids]), [['first_landing', 'done', ['c4']], ['reminder', 'open', ['c5']]]);
  // Recorded at step 4, gone by step 8: lost, which the milestone must never show.
  assert.deepEqual(commitmentOutcomes([paraphrase], { first_landing: ['c4'], reminder: ['c5'] }).map((o) => o.state), ['done', 'lost']);
  // Never recorded at step 4: said as such, not as lost.
  assert.deepEqual(commitmentOutcomes([paraphrase], { first_landing: ['c4'], reminder: [] }).map((o) => o.state), ['done', 'not_recorded']);
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
  db.prepare("INSERT INTO events (at, kind, ticket, detail, value, source) VALUES (?, 'release_watch_complete', 'LOCAL-1', '', 101, 'dispatcher')").run('2026-10-22T23:00:00.000Z');
  db.prepare("INSERT INTO events (at, kind, ticket, detail, value, source) VALUES (?, 'release_watch_complete', 'LOCAL-1', '', 101, 'dispatcher')").run('2026-10-22T20:00:00.000Z');
  const landed = ledgerFacts(db, since);
  assert.deepEqual(landed.tickets, { 'LOCAL-1': { sessions: 3, reviewRounds: 2, costUsd: 0.52, startedAt: '2026-10-22T21:01:00.000Z', lastAt: '2026-10-22T21:01:00.000Z', landedAt: '2026-10-22T23:00:00.000Z' } });
  assert.equal(facts.maxLive, 1);
  // A reviewer resumed through the review channel (issue 291) gives its rounds' verdicts in one session.
  session('a2', 'LOCAL-2', 'author'); session('r3', 'LOCAL-2', 'reviewer');
  for (const [round, verdict] of [[1, 'changes_requested'], [2, 'changes_requested'], [3, 'pass']] as const)
    store.events.append({ at: '2026-10-22T21:40:00.000Z', sessionId: 'r3', ticket: 'LOCAL-2', project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.review_verdict', value: { session: 'r3', verdict, round } } });
  assert.equal(ledgerFacts(db, since).tickets['LOCAL-2']?.reviewRounds, 3);
  // A ledger without the v1 events table yet has no notifications.
  const bare = openStore(':memory:');
  assert.deepEqual(ledgerFacts(bare.db, since).notifications, { count: 0, byKind: {}, firstAt: {} });
});

test('the lead\'s generation 1, started before the goal, counts in the cost, turns, highest share, compactions and login cuts (review 1, B1)', () => {
  const store = openStore(':memory:');
  const since = '2026-10-22T21:00:00.000Z';
  const lead = (id: string, created: string, status = 'working') => store.sessions.put({ id, project: 'guestbook', ticket: 'lead', role: 'lead', harness: 'claude-code', model: 'm', status, createdAt: created, updatedAt: created });
  const at = (sessionId: string, when: string, event: unknown) => store.events.append({ at: when, sessionId, ticket: 'lead', project: 'guestbook', event: event as never });
  const finished = (cost: number) => ({ type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'success' }, usage: [], result: { stopReason: 'end_turn', total_cost_usd: cost } });
  const share = (percent: number) => ({ type: 'CUSTOM', name: 'cleared.context_usage', value: { percent, totalTokens: 1, maxTokens: 100, isAutoCompactEnabled: true } });
  // Generation 1 started with the service, before the goal; it takes the evening.
  lead('g1', '2026-10-22T20:30:00.000Z');
  at('g1', '2026-10-22T20:31:00.000Z', finished(5));                     // its opening turn, before the goal: not counted
  at('g1', '2026-10-22T21:05:00.000Z', finished(0.4));
  at('g1', '2026-10-22T21:06:00.000Z', share(38));
  at('g1', '2026-10-22T21:07:00.000Z', { type: 'CUSTOM', name: 'cleared.compacted', value: { trigger: 'auto', preTokens: 9 } });
  at('g1', '2026-10-22T21:10:00.000Z', { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/status', value: LOGIN_WAIT }] });
  at('g1', '2026-10-22T21:12:00.000Z', { type: 'RUN_STARTED', threadId: 't', runId: 'r2' });
  // An older lead session, of another run, with nothing after the goal: left out.
  lead('old', '2026-10-20T08:00:00.000Z', 'stopped');
  at('old', '2026-10-20T09:00:00.000Z', finished(7));
  lead('g2', '2026-10-22T22:00:00.000Z');
  at('g2', '2026-10-22T22:05:00.000Z', finished(0.1));
  at('g2', '2026-10-22T22:06:00.000Z', share(12));
  const facts = ledgerFacts(store.db, since);
  assert.deepEqual(facts.lead, { generations: 2, turns: 2, costUsd: 0.5, highestPercent: 38, compactions: 1 });
  assert.deepEqual(facts.loginCuts, [{ session: 'g1', role: 'lead', ticket: 'lead', at: '2026-10-22T21:10:00.000Z', relaunchedAt: '2026-10-22T21:12:00.000Z', seconds: 120, ended: false }]);
});

test('the highest share is the larger of the ledger\'s and the lead\'s own record, not the first one known (review 1, B1)', () => {
  // The ledger read only later generations: the lead's record, which has generation 1, is higher.
  assert.equal(highestShare(12, 38), 38);
  assert.equal(highestShare(41, 38), 41);
  assert.equal(highestShare(null, 38), 38);
  assert.equal(highestShare(undefined, null), null);
});

test('each reading counts the notifications alone, without reading the sessions (review 1, F2)', () => {
  const store = openStore(':memory:');
  assert.equal(notificationCount(store.db, '2026-10-22T21:00:00.000Z'), 0);   // no events table yet
  applyTables(store.db, [...RUNS_TABLES]);
  const sent = (at: string) => store.db.prepare("INSERT INTO events (at, kind, detail, source) VALUES (?, 'notification_sent', '{}', 'notify')").run(at);
  sent('2026-10-22T20:00:00.000Z'); sent('2026-10-22T22:00:00.000Z'); sent('2026-10-22T23:00:00.000Z');
  assert.equal(notificationCount(store.db, '2026-10-22T21:00:00.000Z'), 2);
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

test('each login cut: when the runner waited for a new login, when it relaunched the session, how long it lasted', () => {
  const store = openStore(':memory:');
  const put = (id: string, ticket: string, role: string) => store.sessions.put({ id, project: 'guestbook', ticket, role: role as never, harness: 'claude-code', model: 'm', status: 'working', createdAt: '2026-10-22T21:01:00.000Z', updatedAt: '2026-10-22T21:01:00.000Z' });
  const at = (sessionId: string, ticket: string, when: string, event: unknown) => store.events.append({ at: when, sessionId, ticket, project: 'guestbook', event: event as never });
  const waiting = { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/phase', value: 'waiting_human' }, { op: 'replace', path: '/status', value: LOGIN_WAIT }] };
  const started = { type: 'RUN_STARTED', threadId: 't', runId: 'r' };
  put('l1', 'lead', 'lead'); put('a1', 'LOCAL-1', 'author');
  store.sessions.put({ id: 'l0', project: 'guestbook', ticket: 'lead', role: 'lead', harness: 'claude-code', model: 'm', status: 'stopped', createdAt: '2026-10-22T21:01:00.000Z', updatedAt: '2026-10-23T01:30:00.000Z' });
  at('l0', 'lead', '2026-10-23T01:00:00.000Z', waiting);                 // a generation that ended instead of resuming
  at('l1', 'lead', '2026-10-23T02:00:00.000Z', started);
  at('l1', 'lead', '2026-10-23T02:10:00.000Z', waiting);
  at('l1', 'lead', '2026-10-23T02:10:01.000Z', waiting);                 // the turn's end says it again: one cut
  at('l1', 'lead', '2026-10-23T02:18:30.000Z', started);                 // the runner relaunched the session
  at('a1', 'LOCAL-1', '2026-10-23T03:00:00.000Z', waiting);              // never relaunched
  const facts = ledgerFacts(store.db, '2026-10-22T21:00:00.000Z');
  assert.deepEqual(facts.loginCuts, [
    { session: 'l0', role: 'lead', ticket: 'lead', at: '2026-10-23T01:00:00.000Z', relaunchedAt: null, seconds: null, ended: true },
    { session: 'l1', role: 'lead', ticket: 'lead', at: '2026-10-23T02:10:00.000Z', relaunchedAt: '2026-10-23T02:18:30.000Z', seconds: 510, ended: false },
    { session: 'a1', role: 'author', ticket: 'LOCAL-1', at: '2026-10-23T03:00:00.000Z', relaunchedAt: null, seconds: null, ended: false },
  ]);
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
    tickets: { 'LOCAL-1': { sessions: 2, reviewRounds: 1, costUsd: 0.4, startedAt: '2026-10-22T21:03:30.000Z', lastAt: '2026-10-22T21:20:00.000Z', landedAt: '2026-10-23T08:10:00.000Z' } },
    gestures: [{ at: '2026-10-22T21:00:05.000Z', what: 'sent the goal' }, { at: '2026-10-23T08:05:00.000Z', what: 'approved release:a' }],
    planDoneAt: null,
    stand_ins: ['a bare copy of the guestbook as the forge'],
    notificationsSkipped: null,
    loginCuts: [{ session: 'l1', role: 'lead', ticket: 'lead', at: '2026-10-23T02:10:00.000Z', relaunchedAt: '2026-10-23T02:18:30.000Z', seconds: 510, ended: false }, { session: 'a1', role: 'author', ticket: 'LOCAL-1', at: '2026-10-23T03:00:00.000Z', relaunchedAt: null, seconds: null, ended: false }, { session: 'l0', role: 'lead', ticket: 'lead', at: '2026-10-23T01:00:00.000Z', relaunchedAt: null, seconds: null, ended: true }],
    sessionPlans: [], cards: [], leftForOwner: { knowledge: 0, contract: 0 },
  };
  const text = renderDurations(result);
  for (const expected of [
    '# Milestone 2 proof: durations (rehearsal)', '| 1 | goal | ok |', '| 2 | questions | failed |', 'goal sent → first question | 15 s',
    'last answer → plan proposed | 50 s', '| 1 | Entries as JSON | LOCAL-1 |', 'refreshes | 3', 'highest context share | 4.5 % (threshold 5 %)',
    '| first_landing | done | c1 |', '"3 after 2" | done', '| approval | 2 |', '| LOCAL-1 | 2 | 1 | $0.40 |', '| release | LOCAL-1 | 2026-10-22T21:20:00.000Z | 2026-10-23T08:05:00.000Z | 10 h 45 |',
    'owner gestures | 2', 'a bare copy of the guestbook as the forge', 'the plan is not done',
    '3 login cuts, 1 relaunched', '| 2026-10-23T01:00:00.000Z | lead | lead | not relaunched: the session ended |  |', '| 2026-10-23T02:10:00.000Z | lead | lead | 2026-10-23T02:18:30.000Z | 8 min 30 s |', '| 2026-10-23T03:00:00.000Z | author | LOCAL-1 | not relaunched |  |',
  ]) assert.ok(text.includes(expected), `missing: ${expected}\n\n${text}`);
  // Without an https address for the Mac (plan question 2), the notifications are skipped, not failed.
  const skipped = renderDurations({ ...result, notificationsSkipped: 'no https address for the Mac (plan question 2): inbox only', loginCuts: [] });
  assert.ok(skipped.includes('Skipped: no https address for the Mac (plan question 2): inbox only.'), skipped);
  assert.ok(skipped.includes('No login cut.'));
  assert.ok(!skipped.includes('plan proposed → plan notification sent'));
});

// ---- lane 29: the React screens, the owner's decisions and the multi-service proof

test('the skipped notification step says the owner\'s decision, in the steps and in the notifications section (lane 29)', () => {
  assert.equal(NOTIFICATIONS_SKIPPED_NOTE, 'skipped: no Mac notifications in this proof (owner decision)');
  const text = renderDurations(baseResult({
    steps: [{ n: 3, name: 'notifications', status: 'skipped', seenAt: '2026-10-22T21:02:00.000Z', note: NOTIFICATIONS_SKIPPED_NOTE }],
    notificationsSkipped: NOTIFICATIONS_SKIPPED_NOTE,
  }));
  assert.ok(text.includes('| 3 | notifications | skipped | 2026-10-22T21:02:00.000Z | skipped: no Mac notifications in this proof (owner decision) |'), text);
  assert.ok(text.includes('Skipped: no Mac notifications in this proof (owner decision). The waits are read from the inbox.'), text);
});

test('each session plan: its confidence, who gave the Go and when, and how long the gate held it (lane 29)', () => {
  const store = openStore(':memory:');
  const put = (id: string, ticket: string, service: string | null) => store.sessions.put({ id, project: 'guestbook', ticket, role: 'author', harness: 'claude-code', model: 'm', status: 'working', createdAt: '2026-10-22T21:01:00.000Z', updatedAt: '2026-10-22T21:01:00.000Z', service });
  const plan = (sessionId: string, ticket: string, at: string, confidence: string, go: unknown) => store.events.append({ at, sessionId, ticket, project: 'guestbook', event: { type: 'CUSTOM', name: 'cleared.session_plan', value: { steps: ['x'], files: ['src/a.ts'], confidence, reason: 'r', proposedAt: '2026-10-22T21:02:00.000Z', go } } as never });
  put('a1', 'LOCAL-1', null); put('a4', 'LOCAL-4', 'guestbook'); put('a5', 'LOCAL-5', null);
  plan('a1', 'LOCAL-1', '2026-10-22T21:02:00.000Z', 'high', null);
  plan('a1', 'LOCAL-1', '2026-10-22T21:02:01.000Z', 'high', { by: 'lead', at: '2026-10-22T21:02:01.000Z' });
  plan('a4', 'LOCAL-4', '2026-10-22T21:02:00.000Z', 'medium', null);
  plan('a4', 'LOCAL-4', '2026-10-23T06:00:30.000Z', 'medium', { by: 'owner', at: '2026-10-23T06:00:30.000Z' });
  plan('a5', 'LOCAL-5', '2026-10-22T21:02:00.000Z', 'low', null);
  assert.deepEqual(sessionPlanFacts(store.db, '2026-10-22T21:00:00.000Z'), [
    { session: 'a1', ticket: 'LOCAL-1', service: null, confidence: 'high', proposedAt: '2026-10-22T21:02:00.000Z', go: { by: 'lead', at: '2026-10-22T21:02:01.000Z' }, heldSeconds: 1 },
    { session: 'a4', ticket: 'LOCAL-4', service: 'guestbook', confidence: 'medium', proposedAt: '2026-10-22T21:02:00.000Z', go: { by: 'owner', at: '2026-10-23T06:00:30.000Z' }, heldSeconds: 32_310 },
    { session: 'a5', ticket: 'LOCAL-5', service: null, confidence: 'low', proposedAt: '2026-10-22T21:02:00.000Z', go: null, heldSeconds: null },
  ]);
  const text = renderDurations(baseResult({ sessionPlans: sessionPlanFacts(store.db, '2026-10-22T21:00:00.000Z') }));
  for (const expected of ['## Session plans', '| LOCAL-1 | a1 | high | lead | 2026-10-22T21:02:01.000Z | 1 s |', '| LOCAL-4 | a4 | medium | owner | 2026-10-23T06:00:30.000Z | 8 h 58 |', '| LOCAL-5 | a5 | low | no Go |  |  |'])
    assert.ok(text.includes(expected), `missing: ${expected}\n\n${text}`);
});

test('each release card as the owner saw it: its intent groups and its flags; and what was left to the owner (lane 29)', () => {
  const text = renderDurations(baseResult({
    cards: [{ ticket: 'LOCAL-1', item: 'release:LOCAL-1:101', at: '2026-10-23T06:05:00.000Z', groups: [{ intent: 'The JSON route', files: 2 }, { intent: 'Other changes', files: 1 }], flags: ['large'], shown: { groups: 2, flags: 1 } }],
    leftForOwner: { knowledge: 1, contract: 0 },
  }));
  for (const expected of ['## Release cards', '| LOCAL-1 | release:LOCAL-1:101 | The JSON route (2 files); Other changes (1 file) | large | 2 groups, 1 flag on screen |', 'Left to the owner: 1 knowledge item, 0 contract items.'])
    assert.ok(text.includes(expected), `missing: ${expected}\n\n${text}`);
});

test('the trains read from the ledger: each service in landing order with its merge, its verdict and the gap (lane 29)', () => {
  const store = openStore(':memory:');
  const trains = new TrainStore(store.db, () => new Date('2026-10-23T10:00:00.000Z'));
  const stop = (service: string, pr: number, state: string, at: string | null, mergedAt: string | null, note: string | null = null) => ({ service, pr: { number: pr, url: `https://forge.invalid/${pr}` }, head: 'h', requestedAt: '2026-10-23T09:00:00.000Z', state, at, note, signed: true, askedAt: mergedAt, mergedAt, next: null }) as never;
  trains.add({ item: 'release:LOCAL-1:101', ticket: 'LOCAL-1', project: 'guestbook', state: 'landed', compatibility: 'the guestbook consumes the filter API and is changed in this ticket', blocked: null, announcement: 'a',
    stops: [stop('filter-api', 101, 'healthy', '2026-10-23T09:10:20.000Z', '2026-10-23T09:10:00.000Z'), stop('guestbook', 102, 'healthy', '2026-10-23T09:11:30.000Z', '2026-10-23T09:11:00.000Z')] });
  trains.add({ item: 'release:LOCAL-2:103', ticket: 'LOCAL-2', project: 'guestbook', state: 'rolled_back', compatibility: null, blocked: null, announcement: 'a',
    stops: [stop('filter-api', 103, 'reverted', '2026-10-23T09:31:00.000Z', '2026-10-23T09:20:00.000Z'), stop('guestbook', 104, 'reverted', '2026-10-23T09:30:00.000Z', '2026-10-23T09:22:00.000Z', 'health failing twice')] });
  trains.add({ item: 'release:LOCAL-3:105', ticket: 'LOCAL-3', project: 'guestbook', state: 'blocked', compatibility: null, blocked: { reason: 'the contract changes', proposal: 'extend the ticket' }, announcement: 'a',
    stops: [stop('filter-api', 105, 'waiting', null, null)] });
  const facts = trainFacts(store.db);
  assert.deepEqual(facts.map((t) => [t.ticket, t.state, t.stops.map((s) => `${s.service}:${s.state}`)]), [
    ['LOCAL-1', 'landed', ['filter-api:healthy', 'guestbook:healthy']], ['LOCAL-2', 'rolled_back', ['filter-api:reverted', 'guestbook:reverted']], ['LOCAL-3', 'blocked', ['filter-api:waiting']],
  ]);
  assert.equal(facts[0]?.gapSeconds, 40, 'from the filter API healthy to the guestbook merged');
  assert.deepEqual(facts[1]?.revertOrder, ['guestbook', 'filter-api'], 'newest first: the guestbook reverted before the filter API');
  assert.deepEqual(facts[2]?.blocked, { reason: 'the contract changes', proposal: 'extend the ticket' });
  // No trains table yet: none.
  assert.deepEqual(trainFacts(openStore(':memory:').db), []);
});

test('step 11 read from the ledger: the terminal\'s lines, its close, the human\'s edits and the session\'s next turn (lane 29)', () => {
  const store = openStore(':memory:');
  store.sessions.put({ id: 's11', project: 'guestbook', ticket: 'LOCAL-4', role: 'author', harness: 'claude-code', model: 'm', status: 'working', createdAt: '2026-10-23T10:00:00.000Z', updatedAt: '2026-10-23T10:00:00.000Z' });
  const at = (when: string, event: unknown) => store.events.append({ at: when, sessionId: 's11', ticket: 'LOCAL-4', project: 'guestbook', event: event as never });
  const custom = (name: string, value: unknown) => ({ type: 'CUSTOM', name, value });
  at('2026-10-23T10:01:00.000Z', custom('cleared.terminal_opened', { by: 'owner', cols: 120, rows: 32 }));
  at('2026-10-23T10:01:05.000Z', custom('cleared.terminal_input', { by: 'owner', line: 'git status' }));
  at('2026-10-23T10:01:09.000Z', custom('cleared.terminal_input', { by: 'owner', line: 'npm test' }));
  at('2026-10-23T10:02:00.000Z', custom('cleared.human_edit', { path: 'src/page.ts', by: 'owner', added: 1, removed: 1, before: 'a', after: 'b', via: 'editor' }));
  at('2026-10-23T10:03:00.000Z', custom('cleared.terminal_closed', { by: 'owner', reason: 'give_back', outputBytes: 2048 }));
  at('2026-10-23T10:03:02.000Z', { type: 'RUN_STARTED', threadId: 't', runId: 'notice' });
  at('2026-10-23T09:59:00.000Z', { type: 'RUN_STARTED', threadId: 't', runId: 'before' });
  const facts = humanFacts(store.db, 's11', '2026-10-23T10:02:30.000Z');
  assert.deepEqual(facts, {
    openedAt: '2026-10-23T10:01:00.000Z', lines: 2, closed: { at: '2026-10-23T10:03:00.000Z', reason: 'give_back', outputBytes: 2048 },
    edits: [{ path: 'src/page.ts', via: 'editor', added: 1, removed: 1, at: '2026-10-23T10:02:00.000Z' }], noticeTurnAt: '2026-10-23T10:03:02.000Z',
  });
});

test('the multi-service durations: the steps, the steps of each ticket, the trains, the fake\'s calls and step 11 (lane 29)', () => {
  const result: MultiResult = {
    mode: 'rehearsal', app: 'http://127.0.0.1:9700', startedAt: '2026-10-23T09:00:00.000Z',
    steps: [{ n: 1, name: 'ticket', status: 'ok', seenAt: '2026-10-23T09:00:10.000Z', note: 'LOCAL-1 created' }, { n: 9, name: 'rollback', status: 'ok', seenAt: '2026-10-23T09:32:00.000Z', note: 'Rolled back, 2 of 2' }],
    times: { ticket_created_at: '2026-10-23T09:00:05.000Z', steps_proposed_at: '2026-10-23T09:00:07.000Z', contract_shown_at: '2026-10-23T09:02:00.000Z', contract_validated_at: '2026-10-23T09:02:30.000Z', approved_at: '2026-10-23T09:09:00.000Z', fake_first_answer_at: '2026-10-23T09:04:00.000Z', take_over_at: '2026-10-23T09:40:00.000Z', terminal_open_at: '2026-10-23T09:40:02.000Z', save_at: '2026-10-23T09:41:00.000Z', give_back_at: '2026-10-23T09:42:00.000Z' },
    tickets: { 1: 'LOCAL-1', 2: 'LOCAL-2', 3: 'LOCAL-3', 4: 'LOCAL-4' },
    ticketSteps: { 'LOCAL-1': [{ position: 1, kind: 'contract', service: 'filter-api', state: 'done', costUsd: 0.2, minutes: 2 }, { position: 2, kind: 'service', service: 'filter-api', state: 'done', costUsd: 0.3, minutes: 3 }] },
    trains: [{ ticket: 'LOCAL-1', item: 'release:LOCAL-1:101', state: 'landed', compatibility: 'the guestbook consumes the filter API', blocked: null, gapSeconds: 40, revertOrder: [],
      stops: [{ service: 'filter-api', pr: 101, state: 'healthy', mergedAt: '2026-10-23T09:10:00.000Z', at: '2026-10-23T09:10:20.000Z', note: null }, { service: 'guestbook', pr: 102, state: 'healthy', mergedAt: '2026-10-23T09:11:00.000Z', at: '2026-10-23T09:11:30.000Z', note: null }] }],
    fake: { calls: 3, operations: { check: 3 } },
    human: { openedAt: '2026-10-23T09:40:02.000Z', lines: 2, closed: { at: '2026-10-23T09:42:00.000Z', reason: 'give_back', outputBytes: 900 }, edits: [{ path: 'src/page.ts', via: 'editor', added: 1, removed: 1, at: '2026-10-23T09:41:00.000Z' }], noticeTurnAt: '2026-10-23T09:42:03.000Z' },
    saves: [{ at: '2026-10-23T09:41:00.000Z', status: 200, kept: true }],
    sessionPlans: [], gestures: [{ at: '2026-10-23T09:00:05.000Z', what: 'created LOCAL-1' }], stand_ins: ['the containers: a docker stand-in'], proposal: 'Extend the ticket to the guestbook, or keep the contract backward compatible.',
    questions: [{ at: '2026-10-23T09:20:00.000Z', ticket: 'LOCAL-3', session: '0b7f3c1e-5d0a-4a6e-9f3b-1c2d3e4f5a6b', question: 'Should the positions count from 0 or from 1?', options: ['From 1', 'From 0 (Recommended)'], answer: 'From 0 (Recommended)', how: 'recommended' }],
    permissions: [
      { at: '2026-10-23T09:21:00.000Z', ticket: 'LOCAL-3', session: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', role: 'reviewer', service: 'filter-api', command: 'npm run typecheck', answer: 'allow_once', rule: 'check' },
      { at: '2026-10-23T09:22:00.000Z', ticket: 'LOCAL-3', session: '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f', role: null, service: null, command: 'curl -s http://filter-api:8080/check | tail', answer: 'reject_once', rule: 'refused' },
    ],
    base: { frozen: 'proof-base', run: 'proof-run', repos: [{ service: 'guestbook', commit: 'a'.repeat(40), closed: [] }, { service: 'filter-api', commit: 'b'.repeat(40), closed: [7, 9] }], setAside: ['LOCAL-20', 'LOCAL-22'] },
  };
  const text = renderMultiDurations(result);
  for (const expected of [
    '# Milestone 2 multi-service proof: durations (rehearsal)', '| 9 | rollback | ok |', 'ticket created → steps proposed | 2 s', 'contract shown → validated | 30 s',
    '| LOCAL-1 | 1 | contract | filter-api | done | $0.20 | 2 min |', '| LOCAL-1 | landed | filter-api #101: merged 2026-10-23T09:10:00.000Z, healthy 2026-10-23T09:10:20.000Z; guestbook #102: merged 2026-10-23T09:11:00.000Z, healthy 2026-10-23T09:11:30.000Z | 40 s |',
    'The fake answered 3 calls (check 3); its first answer at 2026-10-23T09:04:00.000Z.', 'take over → terminal open | 2 s', 'give back → the notice\'s turn | 3 s', 'lines typed, journaled | 2',
    '| src/page.ts | editor | +1 -1 |', 'saves: 1, answered 200: 1, 409: 0, refused: 0; kept after Give back: 1', 'Extend the ticket to the guestbook, or keep the contract backward compatible.', 'the containers: a docker stand-in',
    '## Session questions', '| 2026-10-23T09:20:00.000Z | LOCAL-3 | 0b7f3c1e | Should the positions count from 0 or from 1? | From 1 / From 0 (Recommended) | From 0 (Recommended) | recommended |',
    '## The clean base', 'Each run branch `proof-run` was recreated from the frozen `proof-base`.', '| guestbook | aaaaaaaaaaaa | none |', '| filter-api | bbbbbbbbbbbb | #7, #9 |',
    'Earlier runs\' tickets put back to a clean state: LOCAL-20, LOCAL-22.',
    '## Session permissions', '| 2026-10-23T09:21:00.000Z | LOCAL-3 | 7c1d2e3f | reviewer | filter-api | npm run typecheck | allow_once | check |',
    '| 2026-10-23T09:22:00.000Z | LOCAL-3 | 7c1d2e3f | unknown | unknown | curl -s http://filter-api:8080/check \\| tail | reject_once | refused |',
    '1 declared check allowed once; 1 other request answered by the checkout rule.',
  ]) assert.ok(text.includes(expected), `missing: ${expected}\n\n${text}`);
  // A run that asked nothing and reset no base says so.
  const bare = renderMultiDurations({ ...result, questions: [], permissions: [], base: null });
  assert.ok(bare.includes('No session of the proof\'s tickets asked a question.'));
  assert.ok(bare.includes('No session of the proof\'s tickets asked a permission.'));
  assert.ok(bare.includes('The run did not reset a base'));
});

function baseResult(over: Partial<ProofResult> = {}): ProofResult {
  return {
    mode: 'rehearsal', app: 'http://127.0.0.1:9700', goal: 'g', startedAt: '2026-10-22T21:00:00.000Z', steps: [], times: {}, answers: [], plan: null, items: {}, maxRunning: 0, waits: {},
    morning: null, lead: { refreshCount: 0, highestPercent: null, threshold: 5, generations: null, turns: null, costUsd: null, compactions: null }, commitments: [], order: { state: 'open', note: '' },
    notifications: null, tickets: {}, gestures: [], planDoneAt: null, stand_ins: [], notificationsSkipped: null, loginCuts: [], sessionPlans: [], cards: [], leftForOwner: { knowledge: 0, contract: 0 }, ...over,
  };
}

// ---- issue 285: a run that took over an approved plan ----------------------------

test('a plan taken over: an item already started reads as unseen, not as kept or broken; one still waiting is read as before', () => {
  const t = newTimeline();
  // The first reading after the take-over: 2 had landed, 3 was running, 5 waited.
  track(t, snap('2026-10-24T17:00:00.000Z', { plan: { id: 'p1', state: 'approved', items: items(['put_back', 'landed', 'running', 'held', 'waiting']) } }));
  const atResume = { 1: 'put_back', 2: 'landed', 3: 'running', 4: 'held', 5: 'waiting' };
  assert.equal(orderCheck(t, 3, 2).state, 'done', 'without the take-over, the same reading would pass');
  assert.deepEqual(orderCheck(t, 3, 2, atResume), { state: 'open', note: 'item 3 was running when the run took the plan over: its start came before, unseen' });
  track(t, snap('2026-10-24T18:00:00.000Z', { plan: { id: 'p1', state: 'approved', items: items(['put_back', 'landed', 'landed', 'held', 'running']) } }));
  assert.deepEqual(orderCheck(t, 5, 3, atResume), { state: 'done', note: 'item 5 started at 2026-10-24T18:00:00.000Z, after item 3 landed at 2026-10-24T18:00:00.000Z' });
});

test('the durations of a run that took a plan over: the take-over, the blockage that stopped step 7, the times before it named so', () => {
  const text = renderDurations(baseResult({
    steps: [{ n: 1, name: 'goal', status: 'skipped', seenAt: '2026-10-24T17:00:00.000Z', note: 'took over plan p1' }],
    times: { resumed_at: '2026-10-24T17:00:00.000Z' },
    items: {
      1: { title: 'Entries as JSON', ticket: 'LOCAL-33', states: { landed: '2026-10-24T17:00:05.000Z' } },
      2: { title: 'Trimmed names', ticket: 'LOCAL-34', states: { put_back: '2026-10-24T17:00:05.000Z', running: '2026-10-24T17:00:40.000Z' } },
      3: { title: 'Names in the feed', ticket: 'LOCAL-35', states: { parked: '2026-10-24T19:00:00.000Z' } },
    },
    resumed: { planId: 'p1', at: '2026-10-24T17:00:00.000Z', items: { 1: 'landed', 2: 'put_back', 3: 'waiting' } },
    blocked: { since: '2026-10-24T19:00:00.000Z', line: 'plan p1 has nothing running and nothing to approve: 3 (LOCAL-35) parked', failed: true },
    planDoneAt: null,
  }));
  for (const expected of [
    'Took over plan p1 at 2026-10-24T17:00:00.000Z, its items then 1:landed 2:put_back 3:waiting: no goal was sent and nothing before the take-over is measured.',
    'Blocked since 2026-10-24T19:00:00.000Z: plan p1 has nothing running and nothing to approve: 3 (LOCAL-35) parked. Step 7 stopped on it.',
    '| taken over → plan done | the plan is not done |',
    '| 1 | Entries as JSON | LOCAL-33 |  |  | landed before the take-over |  |',
    '| 2 | Trimmed names | LOCAL-34 | 2026-10-24T17:00:40.000Z |  |  | put_back before the take-over |',
    '| 3 | Names in the feed | LOCAL-35 |  |  |  | 2026-10-24T19:00:00.000Z |',
  ]) assert.ok(text.includes(expected), `missing: ${expected}\n\n${text}`);
  assert.ok(!text.includes('goal sent → plan done'), text);
  const done = renderDurations(baseResult({ times: { resumed_at: '2026-10-24T17:00:00.000Z' }, resumed: { planId: 'p1', at: '2026-10-24T17:00:00.000Z', items: {} }, planDoneAt: '2026-10-24T20:30:00.000Z', blocked: { since: '2026-10-24T18:00:00.000Z', line: 'x', failed: false } }));
  assert.ok(done.includes('| taken over → plan done | 3 h 30 |'), done);
  assert.ok(done.includes('Was blocked since 2026-10-24T18:00:00.000Z: x'), done);
  assert.ok(!renderDurations(baseResult()).includes('Took over'), 'a run that sent its goal says nothing of a take-over');
});
