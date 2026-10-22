import test from 'node:test';
import assert from 'node:assert/strict';
import { API_ROUTES, ASK_ROUTES, KNOWLEDGE_ROUTES, MILESTONE_2_ROUTES, RECIPE_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, SESSION_PLAN_ROUTES, SESSION_PREVIEW_ROUTE, SESSION_TABS_ROUTES, STEP_ROUTES, TERMINAL_INPUT_MAX_BYTES, TERMINAL_ROUTES, leadFrame, sseFrame, type ApiRoutes, type InboxItem, type LeadMessage, type LeadState, type NotificationStatus, type Plan, type ReleaseItem, type SessionDetail, type SessionSummary, type TrainState, type Workspace, type Ask, type ContractItem, type FileWrite, type FileWriteRefusal, type HumanEdit, type KnowledgeItem, type NextInboxItem, type Recipe, type Schedule, type SessionPlanItem, type TerminalChunk, type TicketStep } from '../../src/api/types.ts';
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
    // Lane 16, for waves 7 and 8: the session plan's Go and Change (lane 17), the Editor tab and the takeover (lane 20).
    'POST /api/sessions/:id/plan/go',
    'POST /api/sessions/:id/plan/change',
    'GET /api/sessions/:id/files',
    'GET /api/sessions/:id/files/*',
    'POST /api/sessions/:id/takeover',
    'POST /api/sessions/:id/giveback',
    // Lane 17, for waves 9 to 11: the ticket's steps and the contract item (lane 23), the knowledge
    // items and the skill (lane 24), the questions to the code (lane 25), the recipes and the
    // schedules (lane 26), the web terminal and the editor's save (lane 31).
    'GET /api/tickets/:id/steps',
    'POST /api/contracts/:id/approve',
    'POST /api/contracts/:id/sendback',
    'POST /api/knowledge/:id/approve',
    'POST /api/knowledge/:id/reject',
    'POST /api/services/:name/skill',
    'POST /api/asks',
    'GET /api/asks/:id',
    'POST /api/asks/:id/follow',
    'GET /api/recipes',
    'POST /api/recipes/:name/run',
    'GET /api/schedules',
    'POST /api/schedules',
    'DELETE /api/schedules/:id',
    'POST /api/sessions/:id/terminal/open',
    'POST /api/sessions/:id/terminal/input',
    'POST /api/sessions/:id/terminal/resize',
    'POST /api/sessions/:id/terminal/close',
    'GET /api/sessions/:id/terminal/stream',
    'PUT /api/sessions/:id/files/*',
  ].sort());
  assert.equal(new Set(API_ROUTES).size, API_ROUTES.length);
  // A route of the type map is a route of the list, and the reverse (checked by tsc).
  const keys: readonly (keyof ApiRoutes)[] = API_ROUTES;
  assert.equal(keys.length, 51);
  const ahead = [...SESSION_PLAN_ROUTES, ...SESSION_TABS_ROUTES, ...STEP_ROUTES, ...KNOWLEDGE_ROUTES, ...ASK_ROUTES, ...RECIPE_ROUTES, ...TERMINAL_ROUTES];
  assert.deepEqual(ahead.filter((route) => !API_ROUTES.includes(route)), []);
  assert.equal(new Set(ahead).size, ahead.length, 'each route of a later lane is in one list');
  assert.ok(ahead.every((route) => !MILESTONE_2_ROUTES.includes(route)));
  // The routes lane 31 serves: the terminal's four posts and its stream, and the editor's save.
  assert.deepEqual([...TERMINAL_ROUTES].sort(), [
    'GET /api/sessions/:id/terminal/stream', 'POST /api/sessions/:id/terminal/close', 'POST /api/sessions/:id/terminal/input',
    'POST /api/sessions/:id/terminal/open', 'POST /api/sessions/:id/terminal/resize', 'PUT /api/sessions/:id/files/*',
  ]);
  assert.deepEqual(TERMINAL_INPUT_MAX_BYTES, 4096);
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

test('the shapes of waves 9 to 11 (lane 17) type check with real values', () => {
  const steps: TicketStep[] = [
    { id: 'step-1', ticket: 'LOCAL-3', kind: 'contract', service: 'filter-api', position: 1, after: [], state: 'done', session: 's1', costUsd: 0.4 },
    { id: 'step-2', ticket: 'LOCAL-3', kind: 'service', service: 'filter-api', position: 2, after: [1], state: 'running', session: 's2', costUsd: null },
    { id: 'step-3', ticket: 'LOCAL-3', kind: 'service', service: 'guestbook', position: 3, after: [1], state: 'waiting', session: null, costUsd: null },
    { id: 'step-4', ticket: 'LOCAL-3', kind: 'integration', service: 'guestbook', position: 4, after: [2, 3], state: 'waiting', session: null, costUsd: null },
  ];
  const base = { ticket: 'LOCAL-3', project: 'guestbook', since: '2026-10-23T08:00:00.000Z', state: 'waiting' as const };
  const plan: SessionPlanItem = { ...base, id: 'session_plan:s2:1', kind: 'session_plan', sessionId: 's2', service: 'filter-api', plan: { steps: ['Add severity'], files: ['src/check.ts'], confidence: 'medium', reason: 'A new field.', proposedAt: base.since, go: null } };
  const contract: ContractItem = { ...base, id: 'contract:LOCAL-3:step-1:1', kind: 'contract', sessionId: 's1', step: 'step-1', service: 'filter-api', path: 'contract/openapi.yaml', diff: '+      severity:\n', outcome: null };
  const knowledge: KnowledgeItem = { ...base, id: 'knowledge:s1:1', kind: 'knowledge', sessionId: 's1', text: 'Words are matched whole.', level: 'contract', service: 'filter-api', outcome: { decision: 'approve', by: 'u1', at: base.since } };
  const items: NextInboxItem[] = [plan, contract, knowledge];
  const ask: Ask = {
    id: 'ask-1', question: 'Where is an entry refused?', service: 'guestbook', target: { service: 'guestbook', path: 'src/page.ts', line: 12 }, session: 's9', state: 'answered',
    turns: [{ question: 'Where is an entry refused?', answer: 'In src/page.ts, line 14.', at: base.since, costUsd: 0.05, inputTokens: 2000, outputTokens: 120 }],
    costUsd: 0.05, inputTokens: 2000, outputTokens: 120, weekPercent: null, createdAt: base.since, by: 'u1',
  };
  const recipe: Recipe = { name: 'bump-dependency', service: 'guestbook', kind: 'ticket', parameters: [{ name: 'package', description: 'The package to bump', required: true }], lane: 'fast', size: 's', services: ['guestbook'], body: 'Bump {{package}} to its latest version.' };
  const schedule: Schedule = { id: 'sch-1', recipe: 'bump-dependency', goal: null, parameters: { package: 'pg' }, at: null, every: 'day 03:00', budgetUsd: 2, weekCapPercent: 50, createdBy: 'u1', enabled: true, nextRunAt: '2026-10-24T03:00:00.000+02:00', lastRunAt: null, createdAt: base.since };
  const chunk: TerminalChunk = { seq: 1, data: '$ git status\r\n' };
  const write: FileWrite = { text: 'export const x = 1;\n', hash: 'a'.repeat(64), confirm: 'install.package' };
  const refusal: FileWriteRefusal = { error: 'the policy refuses this save', rule: 'default', reason: '.git/** is the service\'s own git', hash: 'b'.repeat(64), confirmable: false };
  const edit: HumanEdit = { path: 'src/page.ts', by: 'u1', at: base.since, added: 1, removed: 1, before: 'a'.repeat(64), after: 'b'.repeat(64), via: 'editor' };
  assert.deepEqual(steps.map((s) => s.kind), ['contract', 'service', 'service', 'integration']);
  assert.deepEqual(items.map((i) => i.kind), ['session_plan', 'contract', 'knowledge']);
  assert.equal(ask.turns.length, 1);
  assert.equal(recipe.parameters[0]?.name, 'package');
  assert.equal(schedule.every, 'day 03:00');
  assert.equal(chunk.seq, 1);
  assert.equal(write.confirm, 'install.package');
  assert.equal(refusal.confirmable, false);
  assert.equal(edit.via, 'editor');
});
