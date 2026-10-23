// The inbox's fixture: the data of inbox.png that milestone 1 carries, and a
// stand-in for the service routes the screen calls, that the tests and the
// visual loop hand to the app as its DataSource (as fixtures/session.ts does;
// fixtures/source.ts, lane 6's, is not changed).
//
// Names are neutral and the story is the tower's and the session screen's:
// the example guestbook, the release of LOCAL-158, the `npm install
// date-fns` request of LOCAL-161, and the lead's plan of milestone 2 (the
// capture's plan card: five tickets, 25 minutes old, 2 h 15 of work and
// 3.9 % of the week) with the guestbook's content of the plan's question 5.
// The capture's rolled back release has no carrier (the inbox lists
// permissions, questions, releases and plans), so "Handled today" holds a
// permission answered earlier. A question of the lead is a separate export,
// so the list keeps the capture's four waiting items.
//
// The replanned milestone 2 (lane 21) adds the two-service ticket of the
// multi-service proof: its release as a train in each of its states, with
// its groups and flags, a session plan waiting for its Go, and a contract
// and a knowledge item (rendered for reading until lane 27). They are
// separate exports too, and `inboxFixture(now, { train, sessionPlan })` adds
// them to the list for the visual loop.
//
// The approval routes behave as lane 8's service does: the approval is held
// for a grace period and written at its end unless Undo came first, and
// what is written is recorded in `writes`. The plan routes behave as lane
// 7's: a proposed plan is approved once, its inbox item is then handled,
// and a second approval is a 409.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ContractItem, KnowledgeItem, NextInboxItem, PermissionItem, Plan, PlanItem, PlanItemInbox, QuestionItem, ReleaseItem, SessionPlanConfidence, SessionPlanItem, SessionSummary, TrainState,
} from '../../src/api/types.ts';
import { LEAD_TICKET } from '../../src/lead/contract.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { sendJson, type DataSource } from '../src/proxy.ts';
import { otherPlans } from './lead.ts';
import { AUTHOR_ID, REQUEST_ID, TICKET_ID as PERMISSION_TICKET, TICKET_TITLE as PERMISSION_TITLE } from './session.ts';
import { FIXTURE_NOW, FIXTURE_PROJECT } from './tower.ts';

export const RELEASE_TICKET = 'LOCAL-158';
export const RELEASE_TITLE = '“Comings and goings” replaces “Departures and arrivals”';
export const RELEASE_HEAD = '3f9c2a1d5e7b40c8a6f1d2e3b4c5a6978d0e1f2a';
export const QUESTION_TICKET = 'LOCAL-164';
export const QUESTION_ID = 'question-164';
export const QUESTION_SESSION = 'fixture-164';
export const QUESTION_TEXT = 'An entry can be signed with no name. Should the list show it as “Anonymous”?';
export const GRACE_MS = 60_000;
export const PLAN_ID = 'plan-3';
export const PLAN_TITLE = 'Make the guestbook ready for a small team';
export const LEAD_SESSION = 'lead-generation-3';
export const LEAD_QUESTION_ID = 'lead-question-2';
export const LEAD_QUESTION_TEXT = 'Should the JSON route list the hidden entries too?';
export const TRAIN_TICKET = 'LOCAL-170';
export const TRAIN_TITLE = 'An entry the filter flags is held for review instead of refused';
export const BLOCKED_TICKET = 'LOCAL-172';
export const BLOCKED_TITLE = 'The filter answers a severity with every verdict';
export const FILTER_HEAD = '7c41d0e9b2a5f3681d4e7a9c0b3f5e2d8a6c1b40';
export const GUESTBOOK_HEAD = 'e05b9a3c7d21f4e6a8b0c2d4f6e8a1b3c5d7e9f1';
export const PLAN_TICKET = 'LOCAL-165';
export const PLAN_TICKET_TITLE = 'Moderation: a held entry waits for a moderator';
export const PLAN_SESSION = 'fixture-165';
export const PLAN_REASON = 'The change follows the refusal path that exists; only the moderator\'s view is new.';

const MINUTE = 60_000;
const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * MINUTE).toISOString();

export type InboxFixture = {
  readonly project: string;
  readonly now: Date;
  readonly items: NextInboxItem[];
  readonly tickets: Ticket[];
  readonly sessions: SessionSummary[];
  readonly plans: Plan[];
};

// The capture's plan with the guestbook's content: four independent items,
// then the fifth after them. Its estimates add up to the capture's 3.9 % of
// the week, and its critical path, two at a time, is the capture's 2 h 15.
const ESTIMATES: readonly Pick<PlanItem['estimate'], 'minutes' | 'costUsd' | 'weekPercent'>[] = [
  { minutes: 45, costUsd: 0.80, weekPercent: 1.0 },
  { minutes: 40, costUsd: 0.70, weekPercent: 0.9 },
  { minutes: 20, costUsd: 0.30, weekPercent: 0.4 },
  { minutes: 10, costUsd: 0.15, weekPercent: 0.2 },
  { minutes: 75, costUsd: 1.10, weekPercent: 1.4 },
];
const SAMPLES = 23;

export function proposedPlan(now: Date = FIXTURE_NOW): Plan {
  const { running } = otherPlans(now);
  const items: PlanItem[] = running.items.map((item, index) => ({
    ...item, estimate: { ...(ESTIMATES[index] ?? { minutes: 12, costUsd: 0.30, weekPercent: null }), samples: SAMPLES }, ticket: null, state: 'waiting',
  }));
  return {
    ...running, id: PLAN_ID, goal: 'goal-14', title: PLAN_TITLE, items, state: 'proposed',
    totals: { minutes: 135, costUsd: 3.05, weekPercent: 3.9, samples: SAMPLES },
    proposedAt: ago(now, 25), approvedAt: null, approvedBy: null,
  };
}

export function planItemOf(plan: Plan, project: string = FIXTURE_PROJECT): PlanItemInbox {
  return {
    kind: 'plan', id: `plan:${plan.id}`, ticket: LEAD_TICKET, project, since: plan.proposedAt, state: plan.state === 'proposed' ? 'waiting' : 'handled',
    planId: plan.id, title: plan.title, summary: plan.summary, itemCount: plan.items.length, totals: plan.totals,
  };
}

// A question the lead asks the owner: under the lead's ticket, from the
// lead's session, answered on the lead's screen (the session answer route
// refuses the lead's session).
export function leadQuestion(now: Date = FIXTURE_NOW): QuestionItem {
  return {
    kind: 'question', id: `question:${LEAD_SESSION}:${LEAD_QUESTION_ID}`, ticket: LEAD_TICKET, project: FIXTURE_PROJECT, since: ago(now, 4), state: 'waiting',
    sessionId: LEAD_SESSION, requestId: LEAD_QUESTION_ID,
    questions: [{
      question: LEAD_QUESTION_TEXT, header: 'JSON route',
      options: [
        { label: 'Only the visible ones (Recommended)', description: 'The route shows what the page shows.' },
        { label: 'All of them, with a hidden flag', description: 'A moderator can read them from the route.' },
      ],
    }],
  };
}

// ------------------------------------------------- the replanned milestone 2

// The release of the multi-service proof's first ticket as a train: the
// filter API (the provider) lands first, the guestbook (its consumer) after
// it. Before the approval the item waits; once approved it is handled and
// keeps its train, which the service updates as it lands (lane 16). The
// blocked card is the proof's third ticket: the contract changes and the
// guestbook, which consumes it, is not part of the ticket.
export function trainRelease(now: Date = FIXTURE_NOW, state: TrainState['state'] = 'waiting'): ReleaseItem {
  const project = FIXTURE_PROJECT;
  const filterPr = { number: 7, url: 'https://example.invalid/filter-api/pull/7' };
  const guestbookPr = { number: 43, url: 'https://example.invalid/guestbook/pull/43' };
  const stop = (service: string, pr: typeof filterPr, head: string, s: TrainState['services'][number]['state'], minutes: number | null, note: string | null = null) =>
    ({ service, pr, state: s, at: minutes === null ? null : ago(now, minutes), head, note });
  const blocked = state === 'blocked';
  const services: TrainState['services'] = blocked ? [stop('filter-api', { number: 9, url: 'https://example.invalid/filter-api/pull/9' }, FILTER_HEAD, 'waiting', null)]
    : state === 'waiting' ? [stop('filter-api', filterPr, FILTER_HEAD, 'waiting', null), stop('guestbook', guestbookPr, GUESTBOOK_HEAD, 'waiting', null)]
    : state === 'landing' ? [stop('filter-api', filterPr, FILTER_HEAD, 'healthy', 4), stop('guestbook', guestbookPr, GUESTBOOK_HEAD, 'merged', 1)]
    : state === 'landed' ? [stop('filter-api', filterPr, FILTER_HEAD, 'healthy', 9), stop('guestbook', guestbookPr, GUESTBOOK_HEAD, 'healthy', 5)]
    : state === 'rolled_back' ? [
      stop('filter-api', filterPr, FILTER_HEAD, 'reverted', 2, 'Reverted after the guestbook\'s health failed.'),
      stop('guestbook', guestbookPr, GUESTBOOK_HEAD, 'reverted', 3, 'GET /health failed twice after the deploy; the merge was reverted.'),
    ]
    : [stop('filter-api', filterPr, FILTER_HEAD, 'healthy', 8), stop('guestbook', guestbookPr, GUESTBOOK_HEAD, 'failed', 2, 'The merge failed: the base branch moved. Nothing was reverted.')];
  const train: TrainState = {
    state, services,
    compatibility: blocked ? 'guestbook consumes filter-api and is not changed in this ticket.' : 'guestbook consumes filter-api and is changed in this ticket.',
    blocked: blocked ? {
      reason: 'filter-api changes its contract (openapi.yaml), and guestbook, which consumes it, is not changed in this ticket.',
      proposal: 'Extend the contract so that guestbook keeps working as it is (add to it, without changing or removing what it calls), or keep the change backward compatible; or ask the lead to add a step on guestbook.',
    } : null,
  };
  const ticket = blocked ? BLOCKED_TICKET : TRAIN_TICKET;
  const since = ago(now, blocked ? 6 : 16);
  const first = services[0] as TrainState['services'][number];
  return {
    kind: 'release', id: `release:${ticket}:${first.pr?.number ?? 0}:${since}`, ticket, project, since,
    state: state === 'blocked' || state === 'waiting' ? 'waiting' : 'handled',
    title: blocked ? BLOCKED_TITLE : TRAIN_TITLE,
    announcement: blocked
      ? 'The filter now says how serious a match is. The guestbook is not part of this ticket.'
      : 'A flagged entry is kept and shown to the moderator instead of being refused. The filter API answers a severity; the guestbook holds the entries it marks high.',
    pr: { number: first.pr?.number ?? 0, url: first.pr?.url ?? '', checks: 'passed' },
    heads: services.flatMap((s) => (s.pr && s.head ? [{ pr: s.pr.number, head: s.head }] : [])),
    requestedAt: since,
    captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } },
    sessions: [{ role: 'author', model: 'claude-opus-5-5', minutes: 34 }, { role: 'reviewer', model: 'claude-sonnet-5-5', minutes: 9, rounds: 1 }],
    train,
    groups: blocked ? [{ intent: 'The verdict carries a severity', files: ['openapi.yaml', 'src/check.ts', 'test/check.test.ts'] }] : [
      { intent: 'The filter answers a severity', files: ['openapi.yaml', 'src/check.ts'] },
      { intent: 'A flagged entry is held for a moderator', files: ['migrations/004_held.sql', 'src/entries.ts', 'views/moderate.html'] },
      { intent: 'Other changes', files: ['package-lock.json'] },
    ],
    flags: blocked ? [{ kind: 'contract', files: ['openapi.yaml'], detail: 'Changes a contract another service may consume.' }] : [
      { kind: 'schema', files: ['migrations/004_held.sql'], detail: 'Changes the database: a migration or SQL file.' },
      { kind: 'dependency', files: ['package-lock.json'], detail: 'Changes the dependencies: package.json\'s dependencies or a lock file.' },
      { kind: 'contract', files: ['openapi.yaml'], detail: 'Changes a contract another service may consume.' },
    ],
  };
}

// An author's session plan waiting for its Go (decision 22, lane 17).
export function sessionPlanItem(now: Date = FIXTURE_NOW, confidence: SessionPlanConfidence = 'medium'): SessionPlanItem {
  const since = ago(now, 7);
  return {
    kind: 'session_plan', id: `session_plan:${PLAN_SESSION}:1`, ticket: PLAN_TICKET, project: FIXTURE_PROJECT, since, state: 'waiting',
    sessionId: PLAN_SESSION, service: 'guestbook',
    plan: {
      steps: [
        'Add a held column to the entries, set when the filter answers high',
        'Keep a held entry out of the public list',
        'Show the held entries on the moderator\'s page, with Publish and Delete',
        'Test the three cases: clean, held, refused',
      ],
      files: ['migrations/004_held.sql', 'src/entries.ts', 'views/moderate.html', 'test/entries.test.ts'],
      confidence, reason: PLAN_REASON, proposedAt: since, go: null,
    },
  };
}

// A contract step's change and a handover's knowledge (lanes 23 and 24),
// which this screen shows for reading until lane 27 gives them their buttons.
export function contractItem(now: Date = FIXTURE_NOW): ContractItem {
  return {
    kind: 'contract', id: 'contract:LOCAL-170:1', ticket: TRAIN_TICKET, project: FIXTURE_PROJECT, since: ago(now, 40), state: 'waiting',
    sessionId: 'fixture-170-contract', step: 'LOCAL-170:1', service: 'filter-api', path: 'openapi.yaml',
    diff: '--- a/openapi.yaml\n+++ b/openapi.yaml\n@@ -31,6 +31,9 @@\n           properties:\n             verdict:\n               type: string\n+            severity:\n+              type: string\n+              enum: [low, high]\n',
    outcome: null,
  };
}

export function knowledgeItem(now: Date = FIXTURE_NOW): KnowledgeItem {
  return {
    kind: 'knowledge', id: 'knowledge:fixture-158-author:1', ticket: RELEASE_TICKET, project: FIXTURE_PROJECT, since: ago(now, 50), state: 'waiting',
    sessionId: 'fixture-158-author', text: 'The archive page reuses the list\'s heading: a heading changes in both templates.', level: 'service', service: 'guestbook', outcome: null,
  };
}

// The owner's capture of 2026-10-22 22:02 (docs/v2/ui-overhaul-plan.md, 1.5
// and 11, lane 37): a reviewer's chained reads and tests, with no description
// from the harness, asking because one part is not allowed on its own; the
// policy's sentence in English beside its code.
export const REVIEW_COMMAND = 'git log -5 --oneline; git merge-base main HEAD; git show 3f9c2a1 --stat; npm test 2>&1 | tail -8';

// What the inbox's requests look like after an evening (lane 37): the
// reviewer's compound request that waits, a request answered earlier, and one
// that expired with its session (the store hands it as handled, as it does
// every request a session's end closes). The fixture source lists them, on
// its own sessions' ids.
type Asker = { readonly id: string; readonly ticket: string };
export function requestItems(now: Date, sessions: { readonly reviewer: Asker; readonly author: Asker }): PermissionItem[] {
  const base = { project: FIXTURE_PROJECT, tool: 'Bash' } as const;
  return [
    {
      ...base, kind: 'permission', id: `permission:${sessions.reviewer.id}:request-review-1`, ticket: sessions.reviewer.ticket, since: ago(now, 2), state: 'waiting',
      sessionId: sessions.reviewer.id, requestId: 'request-review-1', input: { kind: 'execute', command: REVIEW_COMMAND },
      suggestion: { decision: 'ask', rule: 'default', reason: 'git merge-base main HEAD is not a command the policy allows on its own' }, reasonCode: 'not_allowed',
    },
    {
      ...base, kind: 'permission', id: `permission:${sessions.author.id}:request-answered`, ticket: sessions.author.ticket, since: ago(now, 95), state: 'handled',
      sessionId: sessions.author.id, requestId: 'request-answered', input: { kind: 'execute', command: 'npx vitest run docs', description: 'Run the docs tests' },
      suggestion: { decision: 'ask', rule: 'default', reason: 'The command is not on the list of safe commands.' },
    },
    {
      ...base, kind: 'permission', id: `permission:${sessions.author.id}:request-expired`, ticket: sessions.author.ticket, since: ago(now, 140), state: 'handled',
      sessionId: sessions.author.id, requestId: 'request-expired', input: { kind: 'execute', command: 'npm run db:migrate', description: 'Apply the new migration to the test database' },
      suggestion: { decision: 'ask', rule: 'default', reason: 'The command is not on the list of safe commands.' },
    },
  ];
}

export type InboxFixtureOptions = {
  readonly train?: TrainState['state'];                       // a train release, in that state
  readonly sessionPlan?: SessionPlanConfidence;               // a session plan, with that confidence
  readonly reading?: boolean;                                 // the contract and knowledge items
};

// Captures of the example's page, drawn as SVG, served by the stand-in at
// these same-origin addresses (the service gives none in milestone 1).
const capture = (side: 'before' | 'after', frame: 'desktop' | 'phone') => `/api/service/captures/${side}-${frame}.svg`;

export function inboxFixture(now: Date = FIXTURE_NOW, options: InboxFixtureOptions = {}): InboxFixture {
  const project = FIXTURE_PROJECT;
  const session = (id: string, ticket: string, role: SessionSummary['role'], model: string, minutes: number, phase: SessionSummary['phase'], status: string): SessionSummary => ({
    id, project, ticket, role, harness: 'claude-code', model, phase, status, startedAt: ago(now, minutes), updatedAt: ago(now, 1), lastSeq: 1,
  });
  const sessions: SessionSummary[] = [
    session('fixture-158-author', RELEASE_TICKET, 'author', 'claude-opus-5-5', 30, 'done', 'Done'),
    session('fixture-158-review', RELEASE_TICKET, 'reviewer', 'claude-sonnet-5-5', 20, 'done', 'Done'),
    session(AUTHOR_ID, PERMISSION_TICKET, 'author', 'claude-opus-5-5', 18, 'waiting_human', 'Waiting for your permission to install date-fns'),
    session(QUESTION_SESSION, QUESTION_TICKET, 'author', 'claude-opus-5-5', 70, 'waiting_human', 'Waiting for your answer'),
    session('fixture-160', 'LOCAL-160', 'author', 'claude-haiku-5-5', 200, 'done', 'Done'),
  ];

  const release: ReleaseItem = {
    kind: 'release', id: `release:${RELEASE_TICKET}:42:${ago(now, 12)}`, ticket: RELEASE_TICKET, project, since: ago(now, 12), state: 'waiting',
    title: RELEASE_TITLE,
    announcement: 'Two testers out of two found it clearer. The heading changes on the list and on the archive, nothing else.',
    pr: { number: 42, url: 'https://example.invalid/guestbook/pull/42', checks: 'passed' },
    heads: [{ pr: 42, head: RELEASE_HEAD }],
    requestedAt: ago(now, 12),
    captures: {
      before: { desktop: capture('before', 'desktop'), phone: capture('before', 'phone') },
      after: { desktop: capture('after', 'desktop'), phone: capture('after', 'phone') },
    },
    sessions: [{ role: 'author', model: 'claude-opus-5-5', minutes: 2 }, { role: 'reviewer', model: 'claude-sonnet-5-5', minutes: 6, rounds: 1 }],
  };
  const items: NextInboxItem[] = [
    release,
    {
      kind: 'permission', id: `permission:${AUTHOR_ID}:${REQUEST_ID}`, ticket: PERMISSION_TICKET, project, since: ago(now, 3), state: 'waiting',
      sessionId: AUTHOR_ID, requestId: REQUEST_ID, tool: 'Bash',
      input: { kind: 'execute', command: 'npm install date-fns', description: 'Install date-fns to group dates by week' },
      suggestion: { decision: 'ask', rule: 'install.package', reason: 'Network access and a new dependency.' },
    },
    {
      kind: 'question', id: `question:${QUESTION_SESSION}:${QUESTION_ID}`, ticket: QUESTION_TICKET, project, since: ago(now, 60), state: 'waiting',
      sessionId: QUESTION_SESSION, requestId: QUESTION_ID,
      questions: [{
        question: QUESTION_TEXT, header: 'Empty name',
        options: [
          { label: 'Show “Anonymous” (Recommended)', description: 'Every entry stays visible, and the form keeps the name optional.' },
          { label: 'Refuse the entry', description: 'The form asks for a name before it saves.' },
        ],
      }],
    },
    {
      kind: 'permission', id: 'permission:fixture-160:request-160', ticket: 'LOCAL-160', project, since: ago(now, 180), state: 'handled',
      sessionId: 'fixture-160', requestId: 'request-160', tool: 'Bash',
      input: { kind: 'execute', command: 'npm run db:migrate', description: 'Apply the new migration to the test database' },
      suggestion: { decision: 'ask', rule: 'default', reason: 'The command is not on the list of safe commands.' },
    },
  ];
  // Milestone 2: the lead's plan, after milestone 1's items, so their
  // positions stay as the tests read them.
  const plans = [proposedPlan(now)];
  items.push(...plans.map((plan) => planItemOf(plan, project)));

  const ticket = (id: string, title: string, status: string, minutes: number): Ticket => ({
    id, title, body: '', labels: [], project, status, createdAt: ago(now, minutes), updatedAt: ago(now, 1),
  });
  const tickets: Ticket[] = [
    ticket(RELEASE_TICKET, RELEASE_TITLE, 'Needs Approval', 64),
    ticket(PERMISSION_TICKET, PERMISSION_TITLE, 'In Progress', 18),
    ticket(QUESTION_TICKET, 'Entries: what an entry without a name shows', 'In Progress', 70),
    ticket('LOCAL-160', 'Glossary: add the “Fast lane” entry', 'In Progress', 200),
  ];
  if (options.train) {
    const train = trainRelease(now, options.train);
    items.unshift(train);
    tickets.push(ticket(train.ticket, train.title, train.state === 'waiting' ? 'Needs Approval' : 'Done', 90));
    sessions.push(session(`fixture-${train.ticket.slice(6)}-author`, train.ticket, 'author', 'claude-opus-5-5', 80, 'done', 'Done'));
  }
  if (options.sessionPlan) {
    const plan = sessionPlanItem(now, options.sessionPlan);
    items.push(plan);
    tickets.push(ticket(PLAN_TICKET, PLAN_TICKET_TITLE, 'In Progress', 12));
    sessions.push({ ...session(PLAN_SESSION, PLAN_TICKET, 'author', 'claude-opus-5-5', 12, 'waiting_human', 'Waiting for the Go on its plan'), service: 'guestbook' });
  }
  if (options.reading) items.push(contractItem(now), knowledgeItem(now));
  return { project, now, items, tickets, sessions, plans };
}

// The page of the example, before and after the release, in a desktop or a
// phone frame: a heading, the renamed section and three entries.
export function captureSvg(side: 'before' | 'after', frame: 'desktop' | 'phone'): string {
  const [width, height] = frame === 'desktop' ? [640, 400] : [300, 560];
  const heading = side === 'before' ? 'Departures and arrivals' : 'Comings and goings';
  const mark = side === 'before' ? '#FDE2E2' : '#DCFCE7';
  const pad = 24;
  const lines = [0.92, 0.74, 0.58].map((share, index) =>
    `<rect x="${pad}" y="${150 + index * 26}" width="${Math.round((width - 2 * pad) * share)}" height="10" rx="3" fill="#E4DACB"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Geist, Arial, sans-serif">`
    + `<rect width="${width}" height="${height}" fill="#F3EEE6"/>`
    + `<text x="${pad}" y="${pad + 14}" font-size="12" fill="#8C7B66">GUESTBOOK</text>`
    + `<text x="${pad}" y="${pad + 50}" font-size="26" font-weight="700" fill="#3A2E22">12 entries</text>`
    + `<rect x="${pad - 8}" y="${pad + 72}" width="${width - 2 * pad + 16}" height="30" rx="5" fill="${mark}"/>`
    + `<text x="${pad}" y="${pad + 92}" font-size="14" font-weight="600" fill="#3A2E22">${heading}</text>`
    + `${lines}</svg>`;
}

export type Call = { readonly method: string; readonly path: string; readonly user: string; readonly body: unknown };
export type Write = { readonly ticket: string; readonly by: string; readonly requestedAt: string; readonly heads: readonly { readonly pr: number; readonly head: string }[] };

export type InboxSource = DataSource & {
  readonly calls: Call[];
  readonly writes: Write[];
  readonly plans: Plan[];
  // Settles a waiting item the way the service does without the person: an
  // interrupt, the session's end, or a teammate's answer on the session screen.
  settle(id: string): void;
};

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
    request.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(undefined); } });
    request.on('error', () => resolve(undefined));
  });
}

const sameHeads = (a: unknown, b: readonly { pr: number; head: string }[]) =>
  Array.isArray(a) && a.length === b.length && b.every((h, i) => (a[i] as { pr?: unknown; head?: unknown })?.pr === h.pr && (a[i] as { head?: unknown })?.head === h.head);

export function inboxSource(fixture: InboxFixture, options: {
  readonly now?: () => Date;
  readonly later?: (run: () => void, ms: number) => unknown;
  readonly graceMs?: number;
} = {}): InboxSource {
  const calls: Call[] = [];
  const writes: Write[] = [];
  const now = options.now ?? (() => new Date());
  const later = options.later ?? ((run, ms) => setTimeout(run, ms));
  const graceMs = options.graceMs ?? GRACE_MS;
  const items = fixture.items.map((item) => ({ ...item }));
  const tickets = fixture.tickets.map((ticket) => ({ ...ticket }));
  const held = new Map<string, { undone: boolean }>();
  const plans = fixture.plans.map((plan) => ({ ...plan }));

  // Lane 7's approval: the tickets are created in position order and the
  // first independent ones start, at most maxParallel at once.
  const approvePlan = (index: number, user: string): Plan => {
    const plan = plans[index] as Plan;
    let started = 0;
    const items = plan.items.map((item, n): PlanItem => {
      const start = item.after.length === 0 && started < plan.maxParallel;
      if (start) started += 1;
      return { ...item, ticket: `LOCAL-${301 + n}`, state: start ? 'running' : 'waiting' };
    });
    const approved: Plan = { ...plan, items, state: 'approved', approvedAt: now().toISOString(), approvedBy: user };
    plans[index] = approved;
    return approved;
  };

  const settle = (id: string) => {
    const index = items.findIndex((item) => item.id === id);
    const item = items[index];
    if (item) items[index] = { ...item, state: 'handled' };
  };

  async function handle(request: IncomingMessage, response: ServerResponse, method: string, url: URL, user: string): Promise<void> {
    const parts = url.pathname.split('/').slice(2);              // after '/api'
    const [collection, id, sub, requestId, action] = parts;
    if (method === 'GET') {
      if (collection === 'inbox' && parts.length === 1) return sendJson(response, 200, items);
      if (collection === 'tickets' && parts.length === 1) return sendJson(response, 200, tickets);
      if (collection === 'sessions' && parts.length === 1) return sendJson(response, 200, fixture.sessions);
      if (collection === 'plans' && parts.length === 1) return sendJson(response, 200, plans);
      if (collection === 'plans' && parts.length === 2) {
        const plan = plans.find((p) => p.id === id);
        return plan ? sendJson(response, 200, plan) : sendJson(response, 404, { error: `unknown plan ${id}` });
      }
      const shot = collection === 'captures' && parts.length === 2 ? /^(before|after)-(desktop|phone)\.svg$/.exec(id ?? '') : null;
      if (shot) {
        const svg = captureSvg(shot[1] as 'before' | 'after', shot[2] as 'desktop' | 'phone');
        response.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': String(Buffer.byteLength(svg)), 'cache-control': 'no-store' });
        return void response.end(svg);
      }
      return sendJson(response, 404, { error: 'not in the fixtures' });
    }
    if (method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
    const body = await readJson(request);
    calls.push({ method, path: url.pathname, user, body });
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

    if (collection === 'sessions' && sub === 'requests' && action === 'answer' && requestId) {
      const item = items.find((i) => (i.kind === 'permission' || i.kind === 'question') && i.sessionId === id && i.requestId === requestId);
      if (!item || item.state !== 'waiting') return sendJson(response, 404, { error: `no request ${requestId} is waiting in session ${id}` });
      const kind = (record.decision as { kind?: unknown } | undefined)?.kind;
      if ((item.kind === 'question') !== (kind === 'answer')) return sendJson(response, 400, { error: 'the decision does not fit the request' });
      settle(item.id);
      return sendJson(response, 200, { accepted: true });
    }
    // Lane 17's Go and Change: the session's plan waiting for its Go is
    // handled, with the Go's author and time; a Change needs its message.
    if (collection === 'sessions' && id && sub === 'plan' && (requestId === 'go' || requestId === 'change') && parts.length === 4) {
      const index = items.findIndex((i) => i.kind === 'session_plan' && i.sessionId === id && i.state === 'waiting');
      const item = items[index];
      if (!item || item.kind !== 'session_plan') return sendJson(response, 409, { error: `session ${id} has no session plan waiting for its Go` });
      if (requestId === 'change') {
        const message = record.message;
        if (typeof message !== 'string' || message.trim() === '' || message.length > 2000) return sendJson(response, 400, { error: 'message must be a non-empty text of at most 2000 characters' });
        items[index] = { ...item, state: 'handled' };
      } else items[index] = { ...item, state: 'handled', plan: { ...item.plan, go: { by: user, at: now().toISOString() } } };
      return sendJson(response, 200, { accepted: true });
    }
    // Lane 23's and lane 24's routes (lane 27): a contract item validated or
    // sent back with a message, a knowledge item approved or rejected, each
    // answered once, named by its inbox id.
    if ((collection === 'contracts' || collection === 'knowledge') && id && parts.length === 3) {
      const index = items.findIndex((i) => i.id === decodeURIComponent(id) && i.kind === (collection === 'contracts' ? 'contract' : 'knowledge'));
      const item = items[index];
      if (!item || (item.kind !== 'contract' && item.kind !== 'knowledge')) return sendJson(response, 404, { error: `no item ${id}` });
      if (item.state !== 'waiting') return sendJson(response, 409, { error: `item ${id} is answered` });
      const at = now().toISOString();
      if (item.kind === 'contract' && sub === 'sendback') {
        const message = record.message;
        if (typeof message !== 'string' || message.trim() === '' || message.length > 2000) return sendJson(response, 400, { error: 'message must be a non-empty text of at most 2000 characters' });
        items[index] = { ...item, state: 'handled', outcome: { decision: 'send_back', message, by: user, at } };
      } else if (item.kind === 'contract' && sub === 'approve') items[index] = { ...item, state: 'handled', outcome: { decision: 'approve', by: user, at } };
      else if (item.kind === 'knowledge' && (sub === 'approve' || sub === 'reject')) items[index] = { ...item, state: 'handled', outcome: { decision: sub, by: user, at } };
      else return sendJson(response, 404, { error: 'not in the fixtures' });
      return sendJson(response, 200, { accepted: true });
    }
    if (collection === 'plans' && id && sub === 'approve' && parts.length === 3) {
      const index = plans.findIndex((p) => p.id === id);
      const plan = plans[index];
      if (!plan) return sendJson(response, 404, { error: `unknown plan ${id}` });
      if (plan.state !== 'proposed') return sendJson(response, 409, { error: `plan ${id} is ${plan.state}: only a proposed plan is approved` });
      const approved = approvePlan(index, user);
      for (const item of items) if (item.kind === 'plan' && item.planId === id) settle(item.id);
      return sendJson(response, 200, approved);
    }
    if (collection === 'tickets' && id && sub === 'move' && parts.length === 3) {
      const ticket = tickets.find((t) => t.id === id);
      if (!ticket) return sendJson(response, 404, { error: 'unknown ticket' });
      if (record.status !== 'Todo') return sendJson(response, 400, { error: 'the fixture moves a ticket to Todo only' });
      ticket.status = 'Todo';
      for (const item of items) if (item.kind === 'release' && item.ticket === id && item.state === 'waiting') settle(item.id);
      return sendJson(response, 200, ticket);
    }
    if (collection === 'tickets' && id && sub === 'approve' && parts.length === 3) {
      const release = items.find((i): i is ReleaseItem => i.kind === 'release' && i.ticket === id && i.state === 'waiting');
      if (!release) return sendJson(response, 409, { error: `ticket ${id} does not wait for an approval` });
      if (release.train?.blocked) return sendJson(response, 409, { error: release.train.blocked.reason, proposal: release.train.blocked.proposal });
      if (held.has(id)) return sendJson(response, 409, { error: 'an approval of this ticket is already held' });
      if (record.requestedAt !== release.requestedAt || !sameHeads(record.heads, release.heads))
        return sendJson(response, 409, { error: 'this is not the version the release asks for' });
      const hold = { undone: false };
      held.set(id, hold);
      const dueAt = new Date(now().getTime() + graceMs).toISOString();
      later(() => {
        held.delete(id);
        if (hold.undone) return;
        writes.push({ ticket: id, by: user, requestedAt: release.requestedAt, heads: release.heads });
        settle(release.id);
      }, graceMs);
      return sendJson(response, 202, { accepted: true, by: user, dueAt });
    }
    if (collection === 'tickets' && id && sub === 'approve' && requestId === 'undo' && parts.length === 4) {
      const hold = held.get(id);
      if (!hold) return sendJson(response, 409, { error: 'nothing is held for this ticket' });
      hold.undone = true;
      held.delete(id);
      return sendJson(response, 200, { undone: true });
    }
    sendJson(response, 404, { error: 'not in the fixtures' });
  }

  return {
    kind: 'fixtures',
    calls,
    writes,
    plans,
    settle,
    forward(request, response, forward) {
      handle(request, response, forward.method, new URL(forward.path, 'http://fixtures'), forward.user.id).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
        else response.destroy();
      });
    },
  };
}
