import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { DEFAULT_LIMIT, HistoryError, LedgerHistory, MAX_LIMIT, openLedgerReadOnly } from '../../src/mcp/history.ts';
import { createRedactor } from '../../src/mcp/redact.ts';
import { ENV, SECRETS, SESSIONS, makeLedger } from './support.ts';

const fixture = makeLedger();
const db = openLedgerReadOnly(fixture.path);
const history = new LedgerHistory(db, createRedactor({ env: ENV, paths: [fixture.dir] }));
after(() => { db.close(); fixture.close(); });

const ids = (items: readonly { id: string }[]) => items.map((s) => s.id);

test('search_sessions: newest first, by text, ticket, project, role and dates', () => {
  assert.deepEqual(ids(history.searchSessions({}).items), [SESSIONS.S3, SESSIONS.S2, SESSIONS.S1]);
  assert.deepEqual(ids(history.searchSessions({ ticket: 'LOCAL-7' }).items), [SESSIONS.S2, SESSIONS.S1]);
  assert.deepEqual(ids(history.searchSessions({ project: 'blog' }).items), [SESSIONS.S3]);
  assert.deepEqual(ids(history.searchSessions({ text: 'reviewer' }).items), [SESSIONS.S2]);
  assert.deepEqual(ids(history.searchSessions({ text: 'LOCAL-9' }).items), [SESSIONS.S3], 'the text is looked for in the ticket too');
  assert.deepEqual(ids(history.searchSessions({ text: 'local-9' }).items), [SESSIONS.S3], 'without case');
  assert.deepEqual(ids(history.searchSessions({ from: '2026-10-21', to: '2026-10-21' }).items), [SESSIONS.S2], 'a day is the whole day');
  assert.deepEqual(ids(history.searchSessions({ from: '2026-10-23' }).items), [SESSIONS.S3], 'a session still running on that day');
  assert.deepEqual(ids(history.searchSessions({ to: '2026-10-20T09:30:00Z' }).items), [SESSIONS.S1]);
  assert.deepEqual(history.searchSessions({ text: 'nothing like it' }).items, []);
});

test('a session says what it is and how long it ran, and never its preview key', () => {
  const [s1] = history.searchSessions({ ticket: 'LOCAL-7', role: 'author' }).items;
  assert.deepEqual(s1, {
    id: SESSIONS.S1, project: 'shop', ticket: 'LOCAL-7', role: 'author', harness: 'claude-code', model: 'claude-sonnet-5-5',
    status: 'done', service: 'web', createdAt: '2026-10-20T09:00:00.000Z', updatedAt: '2026-10-20T10:30:00.000Z', events: 5, durationMs: 90 * 60_000,
  });
  assert.ok(!JSON.stringify(history.searchSessions({})).includes(SECRETS.previewKey));
});

test('search_events: by text, ticket, project, session, type and custom name, newest first', () => {
  const hits = history.searchEvents({ text: 'basket total' }).items;
  assert.deepEqual(hits.map((e) => [e.sessionId, e.seq]), [[SESSIONS.S1, 2]]);
  assert.equal(hits[0]?.type, 'TEXT_MESSAGE_CONTENT');
  assert.deepEqual(history.searchEvents({ text: 'au centime' }).items.map((e) => e.sessionId), [SESSIONS.S2], 'French text, its quotes and accents');
  const verdicts = history.searchEvents({ type: 'cleared.review_verdict' }).items;
  assert.deepEqual(verdicts.map((e) => [e.sessionId, e.name]), [[SESSIONS.S2, 'cleared.review_verdict']]);
  assert.deepEqual(verdicts[0]?.event, { type: 'CUSTOM', name: 'cleared.review_verdict', value: { session: SESSIONS.S2, verdict: 'changes_requested', round: 1 } });
  assert.equal(history.searchEvents({ type: 'STEP_STARTED' }).items.length, 1);
  assert.equal(history.searchEvents({ ticket: 'LOCAL-7' }).items.length, 7);
  assert.equal(history.searchEvents({ project: 'blog', limit: 100 }).items.length, 30);
  assert.equal(history.searchEvents({ sessionId: SESSIONS.S2 }).items.length, 2);
  assert.deepEqual(history.searchEvents({ project: 'blog', from: '2026-10-22T08:28:00Z' }).items.map((e) => e.seq), [30, 29]);
  assert.equal(history.searchEvents({ text: 'post draft 1', project: 'blog', limit: 100 }).items.length, 11, '1 and 10 to 19');
});

test('paging: a default and a ceiling, and a cursor that goes on where the page stopped', () => {
  assert.equal(DEFAULT_LIMIT, 20);
  assert.equal(MAX_LIMIT, 100);
  const first = history.searchEvents({ project: 'blog' });
  assert.equal(first.items.length, DEFAULT_LIMIT);
  assert.ok(first.next);
  const second = history.searchEvents({ project: 'blog', cursor: first.next ?? undefined });
  assert.equal(second.items.length, 10);
  assert.equal(second.next, null);
  assert.deepEqual([...first.items, ...second.items].map((e) => e.seq), Array.from({ length: 30 }, (_, i) => 30 - i));
  const sessions = history.searchSessions({ limit: 2 });
  assert.equal(sessions.items.length, 2);
  assert.deepEqual(ids(history.searchSessions({ limit: 2, cursor: sessions.next ?? undefined }).items), [SESSIONS.S1]);
  assert.equal(history.searchEvents({ project: 'blog', limit: 1000 }).items.length, 30, 'more than the ceiling is the ceiling');
  assert.equal(history.searchEvents({ limit: 1000 }).items.length <= MAX_LIMIT, true);
  for (const limit of [0, -1, 1.5]) assert.throws(() => history.searchEvents({ limit }), HistoryError, String(limit));
  assert.throws(() => history.searchEvents({ cursor: 'not a cursor' }), HistoryError);
  assert.throws(() => history.searchSessions({ cursor: first.next ?? '' }), HistoryError, 'a cursor of the events is not one of the sessions');
});

test('dates: ISO days or moments, anything else refused', () => {
  for (const from of ['yesterday', '2026-13-01', '20/10/2026', '']) assert.throws(() => history.searchSessions({ from }), HistoryError, from);
  assert.throws(() => history.searchEvents({ from: '2026-10-22', to: '2026-10-21' }), HistoryError, 'to before from');
});

test('get_session_timeline: the session and its events in order, cleaned, paged by seq', () => {
  const timeline = history.timeline(SESSIONS.S1, {});
  assert.ok(timeline);
  assert.equal(timeline.session.id, SESSIONS.S1);
  assert.deepEqual(timeline.events.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(timeline.next, null);
  const text = JSON.stringify(timeline);
  for (const secret of Object.values(SECRETS)) assert.ok(!text.includes(secret), `the timeline shows a secret: ${secret.slice(0, 6)}`);
  assert.match(text, /\[removed: GitHub token\]/);
  assert.match(text, /\[removed: bearer token\]/);
  const long = timeline.events[4]?.event as { delta: string };
  assert.ok(long.delta.length < 1200, 'a long text is cut');
  const page = history.timeline(SESSIONS.S3, { limit: 25 });
  assert.equal(page?.events.length, 25);
  assert.equal(page?.next, 25);
  assert.deepEqual(history.timeline(SESSIONS.S3, { afterSeq: page?.next ?? 0 })?.events.map((e) => e.seq), [26, 27, 28, 29, 30]);
  assert.equal(history.timeline('44444444-4444-4444-8444-444444444444', {}), undefined);
});

test('a search never tells whether a secret is in the ledger: a term shaped like one is refused, a piece of one finds nothing', () => {
  assert.throws(() => history.searchEvents({ text: SECRETS.github }), HistoryError);
  assert.throws(() => history.searchSessions({ text: SECRETS.anthropic }), HistoryError);
  for (const piece of [SECRETS.github.slice(0, 10), SECRETS.anthropic.slice(0, 14), SECRETS.envValue.slice(0, 20), SECRETS.envToken, SECRETS.bearer.slice(0, 12)])
    assert.deepEqual(history.searchEvents({ text: piece }).items, [], `a piece finds its event: ${piece.slice(0, 4)}`);
  assert.deepEqual(history.searchEvents({ text: SECRETS.previewKey.slice(0, 20) }).items, []);
  assert.deepEqual(history.searchSessions({ text: SECRETS.previewKey.slice(0, 20) }).items, [], 'the preview key is not searched');
});

test('a LIKE wildcard in the text is a character, not a wildcard', () => {
  assert.deepEqual(history.searchEvents({ text: '%' }).items, []);
  assert.deepEqual(history.searchEvents({ text: 'post_draft' }).items, []);
});
