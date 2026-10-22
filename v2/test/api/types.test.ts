import test from 'node:test';
import assert from 'node:assert/strict';
import { API_ROUTES, MILESTONE_2_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, SESSION_PREVIEW_ROUTE, leadFrame, sseFrame, type ApiRoutes, type InboxItem, type LeadMessage, type LeadState, type NotificationStatus, type Plan, type ReleaseItem, type SessionDetail, type SessionSummary, type TrainState, type Workspace } from '../../src/api/types.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
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
    // Milestone 2 replanned, lane 14: the workspace, and the preview route lane 15 serves.
    'GET /api/workspace',
    'GET /api/sessions/:id/preview/*',
  ].sort());
  assert.equal(new Set(API_ROUTES).size, API_ROUTES.length);
  // A route of the type map is a route of the list, and the reverse (checked by tsc).
  const keys: readonly (keyof ApiRoutes)[] = API_ROUTES;
  assert.equal(keys.length, 25);
  assert.equal(SESSION_PREVIEW_ROUTE, 'GET /api/sessions/:id/preview/*');
  assert.ok(!MILESTONE_2_ROUTES.includes(SESSION_PREVIEW_ROUTE) && !MILESTONE_2_ROUTES.includes('GET /api/workspace'), 'the lead module\'s routes only');
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

test('the workspace shapes of wave 5 and the train of wave 6 type check with real values', () => {
  const workspace: Workspace = {
    id: 'guestbook', name: 'Guestbook and its filter',
    services: [
      { name: 'guestbook', kind: 'repository', repo: 'example-org/cleared-example-guestbook', url: 'https://example.invalid/guestbook.git', base: 'main', path: null, healthUrl: 'http://127.0.0.1:8793/health', sensitivity: 'normal', consumes: ['filter-api'], run: { dockerfile: 'Dockerfile', port: 3000 }, contract: null },
      { name: 'filter-api', kind: 'folder', repo: 'example-org/cleared-examples', url: 'https://example.invalid/examples.git', base: 'main', path: 'filter-api', healthUrl: null, sensitivity: 'human:demo', consumes: [], run: null, contract: { format: 'openapi', path: 'contract/openapi.yaml' } },
    ],
  };
  const ticket: Ticket = {
    id: 'LOCAL-3', title: 'Held for review', body: '', labels: [], project: 'guestbook', status: 'Todo', createdAt: '2026-10-23T08:00:00.000Z', updatedAt: '2026-10-23T08:00:00.000Z',
    services: [{ name: 'filter-api', branch: 'cleared/LOCAL-3', pr: 12, state: 'open' }, { name: 'guestbook', branch: null, pr: null, state: 'open' }],
  };
  const summary: SessionSummary = { id: 's1', project: 'guestbook', ticket: 'LOCAL-3', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'working', status: 'Running the tests', startedAt: '2026-10-23T08:00:00.000Z', updatedAt: '2026-10-23T08:01:00.000Z', lastSeq: 3, service: 'filter-api' };
  const detail: SessionDetail = { ...summary, state: { status: 'Running the tests', phase: 'working', steps: [], files: [], checks: [], usage: {} }, previewKey: 'k'.repeat(32) };
  const train: TrainState = {
    state: 'landing',
    services: [
      { service: 'filter-api', pr: { number: 12, url: 'https://example.invalid/filter-api/pull/12' }, state: 'healthy', at: '2026-10-23T09:00:00.000Z' },
      { service: 'guestbook', pr: { number: 7, url: 'https://example.invalid/guestbook/pull/7' }, state: 'waiting', at: null },
    ],
    compatibility: 'the guestbook consumes the filter API and is changed in this ticket',
    blocked: null,
  };
  const release = { kind: 'release', train } as Pick<ReleaseItem, 'kind' | 'train'>;
  assert.deepEqual(workspace.services.map((s) => s.name), ['guestbook', 'filter-api']);
  assert.equal(ticket.services?.length, 2);
  assert.equal(detail.previewKey?.length, 32);
  assert.deepEqual(release.train?.services.map((s) => s.service), ['filter-api', 'guestbook'], 'providers land first');
});
