import test from 'node:test';
import assert from 'node:assert/strict';
import { API_ROUTES, MILESTONE_2_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, leadFrame, sseFrame, type ApiRoutes, type InboxItem, type LeadMessage, type LeadState, type NotificationStatus, type Plan, type SessionSummary } from '../../src/api/types.ts';
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
    // Milestone 2, section 7.1.
    'GET /api/lead',
    'GET /api/lead/memory',
    'GET /api/lead/messages',
    'GET /api/lead/stream',
    'GET /api/plans',
    'GET /api/plans/:id',
    'POST /api/lead/messages',
    'POST /api/plans/:id/approve',
    'POST /api/plans/:id/pause',
    'POST /api/plans/:id/reject',
    'POST /api/plans/:id/resume',
  ].sort());
  assert.equal(new Set(API_ROUTES).size, API_ROUTES.length);
  // A route of the type map is a route of the list, and the reverse (checked by tsc).
  const keys: readonly (keyof ApiRoutes)[] = API_ROUTES;
  assert.equal(keys.length, 23);
  assert.deepEqual([...MILESTONE_2_ROUTES].sort(), API_ROUTES.filter((route) => /\/api\/(lead|plans)/.test(route)).sort());
});

test('the lead stream names its frames, and a thread message carries its seq as the id', () => {
  const message: LeadMessage = { seq: 4, at: '2026-10-22T20:00:00.000Z', by: 'lead', text: 'Here is a plan in five tickets.', kind: 'plan', planId: 'p1' };
  assert.equal(leadFrame({ kind: 'message', message }), `id: 4\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
  const state: LeadState = {
    generation: 3, sessionId: 's1', phase: 'idle', model: 'claude-opus-5-5', context: { percent: 31, totalTokens: 62_000, maxTokens: 200_000 },
    highestPercent: 38, refreshedAt: '2026-10-22T19:50:00.000Z', refreshCount: 2, openCommitments: 1, pendingQuestion: null,
  };
  assert.equal(leadFrame({ kind: 'state', state }), `event: state\ndata: ${JSON.stringify(state)}\n\n`);
  assert.ok(leadFrame({ kind: 'plan', plan: { id: 'p1' } as Plan }).startsWith('event: plan\ndata: '));
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
  items.push({
    kind: 'plan', id: 'plan-p1', ticket: 'lead', project: 'guestbook', since: '2026-10-22T20:00:00.000Z', state: 'waiting',
    planId: 'p1', title: 'Make a long guestbook readable', summary: 'Pages of 20.', itemCount: 5, totals: { minutes: 120, costUsd: 2.7, weekPercent: null, samples: 2 },
  });
  const status: NotificationStatus = { available: false, reason: 'insecure', publicKey: null, devices: 0 };
  assert.equal(summary.lastSeq, 12);
  assert.deepEqual(items.map((item) => item.kind), ['permission', 'question', 'release', 'plan']);
  assert.equal(status.reason, 'insecure');
});
