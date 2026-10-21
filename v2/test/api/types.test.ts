import test from 'node:test';
import assert from 'node:assert/strict';
import { API_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, sseFrame, type ApiRoutes, type InboxItem, type SessionSummary } from '../../src/api/types.ts';
import type { SessionEvent } from '../../src/session/events.ts';

test('the API lists every route the app lanes build against, once', () => {
  assert.deepEqual([...API_ROUTES].sort(), [
    'GET /api/inbox',
    'GET /api/sessions',
    'GET /api/sessions/:id',
    'GET /api/sessions/:id/events',
    'GET /api/tickets',
    'GET /api/tickets/:id',
    'POST /api/sessions/:id/interrupt',
    'POST /api/sessions/:id/messages',
    'POST /api/sessions/:id/requests/:requestId/answer',
    'POST /api/tickets',
    'POST /api/tickets/:id/approve',
    'POST /api/tickets/:id/move',
  ]);
  assert.equal(new Set(API_ROUTES).size, API_ROUTES.length);
  // A route of the type map is a route of the list, and the reverse (checked by tsc).
  const keys: readonly (keyof ApiRoutes)[] = API_ROUTES;
  assert.equal(keys.length, 12);
});

test('the app proves itself to the service with two headers', () => {
  assert.equal(SERVICE_USER_HEADER, 'x-cleared-user');
  assert.equal(SERVICE_PROOF_HEADER, 'x-cleared-proof');
});

test('an event goes out as one server-sent event whose id is its seq', () => {
  const event: SessionEvent = { seq: 7, at: '2026-10-21T10:00:00.000Z', sessionId: 's1', ticket: 'LOCAL-1', project: 'guestbook', event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'line one\nline two' } };
  const frame = sseFrame(event);
  assert.equal(frame, `id: 7\nevent: TEXT_MESSAGE_CONTENT\ndata: ${JSON.stringify(event)}\n\n`);
  assert.equal(frame.split('\n\n').length, 2, 'one frame: the JSON carries its newlines escaped');
});

test('the shapes the app renders type check with real values', () => {
  const summary: SessionSummary = { id: 's1', project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'working', status: 'Running the tests', startedAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-10-21T10:01:00.000Z', lastSeq: 12 };
  const items: InboxItem[] = [
    { kind: 'permission', id: 'q1', sessionId: 's1', ticket: 'LOCAL-1', project: 'guestbook', since: '2026-10-21T10:00:00.000Z', state: 'waiting', requestId: 'q1', tool: 'Bash', input: { kind: 'execute', command: 'touch x' }, suggestion: { decision: 'ask', rule: 'default', reason: 'no rule matched' } },
    { kind: 'question', id: 'q2', sessionId: 's1', ticket: 'LOCAL-1', project: 'guestbook', since: '2026-10-21T10:00:00.000Z', state: 'waiting', requestId: 'q2', questions: [{ question: 'Which order?', options: [{ label: 'Newest first' }] }] },
    { kind: 'release', id: 'r1', ticket: 'LOCAL-1', project: 'guestbook', since: '2026-10-21T10:00:00.000Z', state: 'handled', title: 'Newest entry first', announcement: 'The guestbook now shows the newest entry first.', pr: { number: 3, url: 'https://github.com/example/guestbook/pull/3', checks: 'passed' }, heads: [{ pr: 3, head: 'abc123' }], requestedAt: '2026-10-21T10:00:00.000Z', captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [{ role: 'author', model: 'claude-opus-5-5', minutes: 12 }, { role: 'reviewer', model: 'claude-sonnet-5-5', minutes: 4, rounds: 1 }] },
  ];
  assert.equal(summary.lastSeq, 12);
  assert.deepEqual(items.map((item) => item.kind), ['permission', 'question', 'release']);
});
