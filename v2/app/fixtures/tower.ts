// The tower's fixture: the data of tower.png, made by playing lane 1's fake
// adapter into an in-memory store, so that every session has real stored
// events. Names are neutral: the project is the example guestbook and
// tickets carry the local tracker's LOCAL-<n> ids; the titles and phrases
// are the capture's, and the two plans are the capture's shape with the
// guestbook's content: one proposed for 25 minutes, one with 3 of 6 landed.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CreateTicketBody, InboxItem, LeadState, Plan, PlanItem, Recipe, ReleaseItem, Schedule, SessionSummary, TicketStep, TrainState, Workspace } from '../../src/api/types.ts';
import type { Harness, Role, SessionId } from '../../src/session/contract.ts';
import { createFakeAdapter, type FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionPhase, SessionState } from '../../src/session/events.ts';
import { DEFAULT_SAFE_COMMANDS } from '../../src/session/policy.ts';
import { openStore, type Store } from '../../src/store/db.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { sendJson, type DataSource } from '../src/proxy.ts';
import type { TowerData } from '../web/screens/tower/model.ts';

export const FIXTURE_PROJECT = 'guestbook';

// The moment the tests read the fixture at: 09:41 local time, after both
// landings of the day (07:34 and 09:22).
export const FIXTURE_NOW = new Date(2026, 9, 21, 9, 41, 0);

type LiveSpec = {
  readonly ticket: string;
  readonly role: Role;
  readonly harness: Harness;
  readonly model: string;
  readonly minutes: number;
  readonly phase: SessionPhase;
  readonly status: string;
  readonly permission?: { readonly requestId: string; readonly command: string; readonly description: string; readonly reason: string };
};

const LIVE: readonly LiveSpec[] = [
  {
    ticket: 'LOCAL-161', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', minutes: 18, phase: 'waiting_human',
    status: 'Waiting for your permission to install date-fns',
    permission: { requestId: 'request-161', command: 'npm install date-fns', description: 'Install date-fns to group dates by week', reason: 'Network access and a new dependency.' },
  },
  { ticket: 'LOCAL-152', role: 'reviewer', harness: 'claude-code', model: 'claude-sonnet-5-5', minutes: 4, phase: 'reviewing', status: 'Reading the diff of src/screens/Envelope.jsx' },
  { ticket: 'LOCAL-160', role: 'author', harness: 'claude-code', model: 'claude-haiku-5-5', minutes: 2, phase: 'working', status: 'Running the docs tests · 12 passed so far' },
  { ticket: 'LOCAL-163', role: 'author', harness: 'codex', model: 'gpt-6-sol', minutes: 31, phase: 'working', status: 'Writing a test for a timeout on the bank API' },
];

const TITLES: Readonly<Record<string, string>> = {
  'LOCAL-158': '“Comings and goings” replaces “Departures and arrivals”',
  'LOCAL-161': 'Upcoming: group entries by week',
  'LOCAL-152': 'Envelope sheet shows its previous months',
  'LOCAL-160': 'Glossary: add the “Fast lane” entry',
  'LOCAL-163': 'Bank sync: retry once before failing',
};

// The lead's last line to the owner, as the capture writes it.
export const LEAD_LINE = 'LOCAL-161 is paused on a permission. I moved LOCAL-163 ahead so the machine stays busy.';

const minutesBefore = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);
const at = (now: Date, hours: number, minutes: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);

function script(spec: LiveSpec, startedAt: Date): FakeStep[] {
  const state: SessionState = {
    status: spec.status, phase: spec.phase, steps: [{ name: spec.role === 'reviewer' ? 'review' : 'author', startedAt: startedAt.toISOString(), finishedAt: null }],
    files: [], checks: [], usage: {},
  };
  const steps: FakeStep[] = [
    { emit: { type: 'STEP_STARTED', stepName: spec.role === 'reviewer' ? 'review' : 'author' } },
    { emit: { type: 'RUN_STARTED', threadId: spec.ticket, runId: 'turn-1' } },
    { emit: { type: 'STATE_SNAPSHOT', snapshot: state } },
  ];
  if (spec.permission) {
    const { requestId, command, description, reason } = spec.permission;
    steps.push(
      { emit: { type: 'TOOL_CALL_START', toolCallId: 'run-1', toolCallName: 'Bash' } },
      { emit: { type: 'TOOL_CALL_ARGS', toolCallId: 'run-1', delta: JSON.stringify({ kind: 'execute', command, description }) } },
      { permission: { requestId, toolCallId: 'run-1', tool: 'Bash', input: { kind: 'execute', command, description }, suggestion: { decision: 'ask', rule: 'network', reason } } },
    );
  } else {
    steps.push({ awaitMessage: true });
  }
  return steps;
}

// The summary the service would answer for a session, from its stored events.
function summary(store: Store, id: SessionId, spec: LiveSpec, startedAt: Date, project: string): SessionSummary {
  const events = store.events.after(id);
  let status = '';
  let phase: SessionPhase = 'starting';
  for (const { event } of events) {
    if (event.type === 'STATE_SNAPSHOT') ({ status, phase } = event.snapshot);
  }
  const last = events[events.length - 1];
  return {
    id, project, ticket: spec.ticket, role: spec.role, harness: spec.harness, model: spec.model, phase, status,
    startedAt: startedAt.toISOString(), updatedAt: last?.at ?? startedAt.toISOString(), lastSeq: last?.seq ?? 0,
  };
}

export type TowerFixture = TowerData & { readonly store: Store };

const planItem = (position: number, title: string, state: PlanItem['state'], minutes: number, after: readonly number[] = []): PlanItem => ({
  position, title, body: `${title}.\n\nAcceptance criteria\n- [ ] ${title}, with a test.`, lane: minutes <= 10 ? 'fast' : 'full', size: minutes <= 10 ? 'xs' : 's', after,
  estimate: { minutes, costUsd: minutes <= 10 ? 0.15 : 0.3, weekPercent: minutes <= 10 ? 0.4 : 0.9, samples: 23 },
  ticket: state === 'waiting' || state === 'ready' ? null : `LOCAL-${140 + position}`, state,
});

// The plan under way (3 of 6 landed, 1 running) and the one the lead
// proposes, which waits for the owner under Needs you.
function plans(now: Date): Plan[] {
  return [
    {
      id: 'plan-entries', goal: 'goal-12', title: 'Entries on desktop', summary: 'The guestbook reads well on a wide screen.', maxParallel: 2,
      items: [
        planItem(1, 'Entries in two columns from 1024 px', 'landed', 30),
        planItem(2, 'The form stays visible while scrolling', 'landed', 20),
        planItem(3, 'Long names wrap instead of overflowing', 'landed', 10),
        planItem(4, 'Each entry shows the time it was written', 'running', 30),
        planItem(5, 'Pages of 20 entries on desktop', 'waiting', 40, [4]),
        planItem(6, 'A link back to the newest page', 'waiting', 10, [5]),
      ],
      totals: { minutes: 110, costUsd: 1.65, weekPercent: 3.9, samples: 23 }, state: 'approved',
      proposedAt: minutesBefore(now, 26 * 60).toISOString(), approvedAt: minutesBefore(now, 25 * 60).toISOString(), approvedBy: 'demo',
    },
    {
      id: 'plan-readable', goal: 'goal-31', title: 'Make the guestbook readable on desktop', summary: 'Five tickets that make a long guestbook easy to read on a computer.', maxParallel: 2,
      items: [
        planItem(1, 'A GET /entries.json route that lists the entries', 'waiting', 40),
        planItem(2, 'Names and messages trimmed before they are stored', 'waiting', 30),
        planItem(3, 'The port and the database host in the start log', 'waiting', 20),
        planItem(4, 'A Troubleshooting section in the README', 'waiting', 10),
        planItem(5, 'The time each entry was written, on the page', 'waiting', 30, [1, 2, 3, 4]),
      ],
      totals: { minutes: 120, costUsd: 1.9, weekPercent: 4, samples: 23 }, state: 'proposed',
      proposedAt: minutesBefore(now, 25).toISOString(), approvedAt: null, approvedBy: null,
    },
  ];
}

// The lead as the capture shows it: always on, at 31 % of its context,
// refreshed from memory 10 minutes ago.
function lead(now: Date, sessionId: string): LeadState {
  return {
    generation: 3, sessionId, phase: 'idle', model: 'claude-opus-5-5', context: { percent: 31, totalTokens: 62_000, maxTokens: 200_000 },
    highestPercent: 41, refreshedAt: minutesBefore(now, 10).toISOString(), refreshCount: 2, openCommitments: 1, pendingQuestion: null,
  };
}

export async function towerFixture(now: Date, options: { readonly project?: string } = {}): Promise<TowerFixture> {
  const project = options.project ?? FIXTURE_PROJECT;
  const store = openStore(':memory:');
  const sessions: SessionSummary[] = [];
  let next = 0;
  for (const spec of LIVE) {
    const startedAt = minutesBefore(now, spec.minutes);
    const adapter = createFakeAdapter({ log: store.events, script: script(spec, startedAt), harness: spec.harness, newId: () => `fixture-${++next}`, now: () => startedAt });
    const handle = await adapter.start({
      project, ticket: spec.ticket, role: spec.role, harness: spec.harness, model: spec.model, workdir: '/workspace', prompt: TITLES[spec.ticket] ?? spec.ticket,
      briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
      policy: { role: spec.role, base: 'main', workdir: '/workspace', scripts: ['test'], credentialFile: '/run/cleared/credential', safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [] },
    });
    sessions.push(summary(store, handle.id, spec, startedAt, project));
  }

  const permission = LIVE[0] as LiveSpec & { permission: NonNullable<LiveSpec['permission']> };
  const proposed = plans(now).filter((plan) => plan.state === 'proposed');
  const inbox: InboxItem[] = [
    {
      kind: 'release', id: 'release-158', ticket: 'LOCAL-158', project, since: minutesBefore(now, 12).toISOString(), state: 'waiting',
      title: TITLES['LOCAL-158'] as string, announcement: 'The list of upcoming movements is now titled “Comings and goings”.',
      pr: { number: 42, url: 'https://example.invalid/guestbook/pull/42', checks: 'passed' }, heads: [{ pr: 42, head: '3f9c2a1d5e7b' }],
      requestedAt: minutesBefore(now, 12).toISOString(), captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } },
      sessions: [{ role: 'author', model: 'claude-opus-5-5', minutes: 34 }, { role: 'reviewer', model: 'claude-sonnet-5-5', minutes: 6, rounds: 1 }],
    },
    {
      kind: 'permission', id: 'permission-161', ticket: 'LOCAL-161', project, since: minutesBefore(now, 3).toISOString(), state: 'waiting',
      sessionId: sessions[0]?.id ?? '', requestId: permission.permission.requestId, tool: 'Bash',
      input: { kind: 'execute', command: permission.permission.command, description: permission.permission.description },
      suggestion: { decision: 'ask', rule: 'network', reason: permission.permission.reason },
    },
    ...proposed.map((plan): InboxItem => ({
      kind: 'plan', id: `plan-item-${plan.id}`, ticket: 'lead', project, since: plan.proposedAt, state: 'waiting',
      planId: plan.id, title: plan.title, summary: plan.summary, itemCount: plan.items.length, totals: plan.totals,
    })),
  ];

  const open = (id: string, status: string, minutes: number): Ticket => ({
    id, title: TITLES[id] as string, body: '', labels: [], project, status, createdAt: minutesBefore(now, minutes).toISOString(), updatedAt: now.toISOString(),
  });
  const landed = (id: string, title: string, doneAt: Date, minutes: number): Ticket => ({
    id, title, body: '', labels: [], project, status: 'Done', createdAt: minutesBefore(doneAt, minutes).toISOString(), updatedAt: doneAt.toISOString(),
  });
  const tickets: Ticket[] = [
    open('LOCAL-158', 'Needs Approval', 64),
    open('LOCAL-161', 'In Progress', 18),
    open('LOCAL-152', 'In Review', 40),
    open('LOCAL-160', 'In Progress', 2),
    open('LOCAL-163', 'In Progress', 31),
    landed('LOCAL-149', 'Stale figures no longer survive two crossing reads', at(now, 7, 34), 52),
    landed('LOCAL-151', 'The envelope list reads one section at a time', at(now, 9, 22), 38),
  ];
  return { sessions, inbox, tickets, lead: lead(now, 'lead-generation-3'), leadLine: LEAD_LINE, plans: plans(now), weekLeft: null, store };
}

// ------------------------------------------- lane 22: a workspace of two services

// The tower of a workspace of two services (milestone 2, decisions 18, 21
// and 30, lane 22), beside the capture's data above, which stays as it is:
// the guestbook, which consumes the filter API (examples/workspace.conf),
// the filter API under the full review; the live sessions each on their
// service, one taken over by the owner; a train landing, a train rolled back
// in the last day, and a ticket blocked before approval. The fixture source
// (lane 20's in this wave) serves no workspace yet, so towerSource below
// answers these routes for the tests and the visual loop.
export const WORKSPACE: Workspace = {
  id: FIXTURE_PROJECT, name: 'Guestbook',
  services: [
    {
      name: 'guestbook', kind: 'repository', repo: 'example/cleared-example-guestbook', url: 'https://example.invalid/guestbook.git', base: 'main', path: null,
      healthUrl: 'http://127.0.0.1:8793/health', sensitivity: 'normal', consumes: ['filter-api'], run: { dockerfile: 'Dockerfile', port: 3000 }, contract: null,
    },
    {
      name: 'filter-api', kind: 'repository', repo: 'example/cleared-example-filter-api', url: 'https://example.invalid/filter-api.git', base: 'main', path: null,
      healthUrl: 'http://127.0.0.1:8795/health', sensitivity: 'full', consumes: [], run: { dockerfile: 'Dockerfile', port: 8795 }, contract: { format: 'openapi', path: 'contract/openapi.yaml' },
    },
  ],
};

// The owner's account in the tests; towerSource puts the signed-in user's id
// in its place, so the visual loop reads "taken over by you".
export const OWNER_ID = 'owner-account';

const WORKSPACE_TITLES: Readonly<Record<string, string>> = {
  'LOCAL-168': 'Longer entries are checked in one call',
  'LOCAL-169': 'An entry the filter flags is held for review instead of refused',
  'LOCAL-170': 'The filter API answers its version on /health',
  'LOCAL-171': 'The filter answers a severity with each word',
};

const SERVICE_OF: Readonly<Record<string, string>> = { 'LOCAL-161': 'guestbook', 'LOCAL-152': 'guestbook', 'LOCAL-160': 'guestbook', 'LOCAL-163': 'filter-api' };

const pr = (service: string, number: number) => ({ number, url: `https://example.invalid/${service}/pull/${number}` });

function trainRelease(id: string, ticket: string, project: string, since: Date, state: InboxItem['state'], train: TrainState): ReleaseItem {
  return {
    kind: 'release', id, ticket, project, since: since.toISOString(), state, title: WORKSPACE_TITLES[ticket] as string,
    announcement: `${WORKSPACE_TITLES[ticket] as string}.`, pr: { ...pr('guestbook', 50), checks: 'passed' }, heads: [{ pr: 50, head: '9a1b2c3d4e5f' }],
    requestedAt: since.toISOString(), captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } },
    sessions: [{ role: 'author', model: 'claude-opus-5-5', minutes: 26 }, { role: 'reviewer', model: 'claude-sonnet-5-5', minutes: 5, rounds: 1 }], train,
  };
}

// The trains of the workspace, as GET /api/inbox answers them: a train
// landing (the filter API healthy, the guestbook merged and its health being
// read), one rolled back in reverse order an hour ago, and one blocked before
// approval because it changes the contract without a step on the guestbook.
export function trainItems(now: Date, project = FIXTURE_PROJECT): ReleaseItem[] {
  const compatibility = 'The guestbook consumes the filter API and is changed in this ticket.';
  return [
    trainRelease('release-171', 'LOCAL-171', project, minutesBefore(now, 7), 'waiting', {
      state: 'blocked', compatibility: 'The guestbook consumes the filter API and is not changed in this ticket.',
      services: [{ service: 'filter-api', pr: pr('filter-api', 9), state: 'waiting', at: null }],
      blocked: {
        reason: 'The ticket changes contract/openapi.yaml of the filter API, and the guestbook, which consumes it, has no step.',
        proposal: 'Add a step on the guestbook, or keep the change backward compatible: an optional severity the guestbook may ignore.',
      },
    }),
    trainRelease('release-169', 'LOCAL-169', project, minutesBefore(now, 22), 'handled', {
      state: 'landing', compatibility, blocked: null,
      services: [
        { service: 'filter-api', pr: pr('filter-api', 8), state: 'healthy', at: minutesBefore(now, 9).toISOString() },
        { service: 'guestbook', pr: pr('guestbook', 51), state: 'merged', at: minutesBefore(now, 4).toISOString() },
      ],
    }),
    trainRelease('release-168', 'LOCAL-168', project, minutesBefore(now, 95), 'handled', {
      state: 'rolled_back', compatibility, blocked: null,
      services: [
        { service: 'filter-api', pr: pr('filter-api', 7), state: 'reverted', at: minutesBefore(now, 61).toISOString() },
        { service: 'guestbook', pr: pr('guestbook', 49), state: 'reverted', at: minutesBefore(now, 63).toISOString(), note: '/health failed twice after the deploy.' },
      ],
    }),
  ];
}

// The capture's tower in that workspace: each live session on its service,
// the filter API's session LOCAL-170 taken over by `owner`, and the trains.
export async function workspaceFixture(now: Date, options: { readonly project?: string; readonly owner?: string } = {}): Promise<TowerFixture & { readonly workspace: Workspace }> {
  const base = await towerFixture(now, options);
  const project = options.project ?? FIXTURE_PROJECT;
  const startedAt = minutesBefore(now, 12);
  const taken: SessionSummary = {
    id: 'fixture-taken-170', project, ticket: 'LOCAL-170', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', phase: 'working',
    status: 'Adding the version to the /health answer', startedAt: startedAt.toISOString(), updatedAt: minutesBefore(now, 6).toISOString(), lastSeq: 9,
    service: 'filter-api', takenOver: { by: options.owner ?? OWNER_ID, at: minutesBefore(now, 6).toISOString() },
  };
  const ticket = (id: string, status: string, minutes: number): Ticket => ({
    id, title: WORKSPACE_TITLES[id] as string, body: '', labels: [], project, status, createdAt: minutesBefore(now, minutes).toISOString(), updatedAt: now.toISOString(),
  });
  return {
    ...base,
    workspace: { ...WORKSPACE, id: project },
    sessions: [...base.sessions.map((s) => ({ ...s, service: SERVICE_OF[s.ticket] ?? 'guestbook' })), taken],
    inbox: [...base.inbox, ...trainItems(now, project)],
    tickets: [...base.tickets, ticket('LOCAL-168', 'Todo', 140), ticket('LOCAL-169', 'Needs Approval', 70), ticket('LOCAL-170', 'In Progress', 12), ticket('LOCAL-171', 'Needs Approval', 40)],
  };
}

// A stand-in for the tower's routes in that workspace: GET /api/workspace,
// the sessions (the taken-over one by the signed-in user), the inbox, the
// tickets, and POST /api/tickets, which keeps what was asked in `calls`;
// every other route goes to `rest` (the fixture source, for the lead and
// the plans), as lane 20's fixture source will once it serves the workspace.
export type TowerCall = { readonly method: string; readonly path: string; readonly body: unknown };
export type TowerSource = DataSource & { readonly calls: TowerCall[] };

export function towerSource(now: () => Date, rest?: DataSource): TowerSource {
  const calls: TowerCall[] = [];
  let created = 0;
  const read = (request: IncomingMessage): Promise<unknown> => new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
    request.on('end', () => { try { resolve(text ? JSON.parse(text) : null); } catch { resolve(undefined); } });
    request.on('error', () => resolve(undefined));
  });
  async function handle(request: IncomingMessage, response: ServerResponse, method: string, path: string, user: string): Promise<boolean> {
    const fixture = await workspaceFixture(now(), { owner: user });
    if (method === 'GET' && path === '/api/workspace') return sendJson(response, 200, fixture.workspace), true;
    if (method === 'GET' && path === '/api/sessions') return sendJson(response, 200, fixture.sessions), true;
    if (method === 'GET' && path === '/api/inbox') return sendJson(response, 200, fixture.inbox), true;
    if (method === 'GET' && path === '/api/tickets') return sendJson(response, 200, fixture.tickets), true;
    // Lane 27: the recipes and their run (a missing parameter refused as
    // lane 26 refuses it), the schedules, and LOCAL-163's steps.
    if (method === 'GET' && path === '/api/recipes') return sendJson(response, 200, RECIPES), true;
    if (method === 'GET' && path === '/api/schedules') return sendJson(response, 200, schedulesFixture(now())), true;
    const steps = /^\/api\/tickets\/([^/]+)\/steps$/.exec(path);
    if (method === 'GET' && steps) return sendJson(response, 200, decodeURIComponent(steps[1] as string) === 'LOCAL-163' ? ticketSteps(fixture.sessions) : []), true;
    const run = /^\/api\/recipes\/([^/]+)\/run$/.exec(path);
    if (method === 'POST' && run) {
      const body = await read(request) as { parameters?: Record<string, unknown> } | undefined;
      calls.push({ method, path, body });
      const recipe = RECIPES.find((r) => r.name === decodeURIComponent(run[1] as string));
      if (!recipe) return sendJson(response, 404, { error: 'no such recipe' }), true;
      const given = body?.parameters ?? {};
      const missing = recipe.parameters.find((p) => p.required && (typeof given[p.name] !== 'string' || !(given[p.name] as string).trim()));
      if (missing) return sendJson(response, 400, { error: `the parameter ${missing.name} is missing` }), true;
      return sendJson(response, 200, recipe.kind === 'ticket' ? { accepted: true, plan: 'plan-recipe-1' } : { accepted: true, message: 1 }), true;
    }
    if (method === 'POST' && path === '/api/tickets') {
      const body = await read(request) as CreateTicketBody | undefined;
      calls.push({ method, path, body });
      const ticket: Ticket = {
        id: `LOCAL-${180 + ++created}`, title: body?.title ?? '', body: body?.body ?? '', labels: [], project: fixture.workspace.id, status: 'Todo',
        createdAt: now().toISOString(), updatedAt: now().toISOString(), ...(body?.services ? { services: body.services.map((name) => ({ name, branch: null, pr: null, state: 'open' as const })) } : {}),
      };
      return sendJson(response, 201, ticket), true;
    }
    return false;
  }
  return {
    kind: 'fixtures', calls,
    forward(request, response, forward) {
      const path = new URL(forward.path, 'http://fixtures').pathname;
      handle(request, response, forward.method, path, forward.user.id).then((done) => {
        if (done) return;
        if (rest) rest.forward(request, response, forward);
        else sendJson(response, 404, { error: 'not in the fixtures' });
      }).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
        else response.destroy();
      });
    },
  };
}

// ------------------------------------------- lane 27: steps, recipes and schedules

// The steps of LOCAL-163 in the workspace of two services (decision 26): the
// contract of the filter API validated, the filter API's own step running in
// LOCAL-163's live session, then the guestbook's step and the integration.
// The tower reads them per ticket of its live sessions (step 2 of 4).
export function ticketSteps(sessions: readonly SessionSummary[], ticket = 'LOCAL-163'): TicketStep[] {
  const live = sessions.find((s) => s.ticket === ticket && s.role === 'author')?.id ?? null;
  const step = (position: number, kind: TicketStep['kind'], service: string, after: readonly number[], state: TicketStep['state'], session: string | null, costUsd: number | null): TicketStep =>
    ({ id: `${ticket}:${position}`, ticket, kind, service, position, after, state, session, costUsd });
  return [
    step(1, 'contract', 'filter-api', [], 'done', `${ticket}-contract`, 0.21),
    step(2, 'service', 'filter-api', [1], 'running', live, 0.34),
    step(3, 'service', 'guestbook', [1], 'waiting', null, null),
    step(4, 'integration', 'guestbook', [2, 3], 'waiting', null, null),
  ];
}

// The recipes of the guestbook's repository (decision 29): a ticket recipe
// with a required and an optional parameter, and a goal recipe with none.
export const RECIPES: readonly Recipe[] = [
  {
    name: 'dependency-update', service: 'guestbook', kind: 'ticket', lane: 'full', size: 's', services: ['guestbook'],
    parameters: [{ name: 'package', description: 'The package to update', required: true }, { name: 'version', description: 'The version to reach; the latest when empty', required: false }],
    body: 'Update {{package}} to {{version}}.\n\nAcceptance criteria\n- [ ] the tests pass\n- [ ] the lock file changes only for {{package}}',
  },
  {
    name: 'weekly-review', service: 'guestbook', kind: 'goal', services: ['guestbook'], parameters: [],
    body: 'Read the open tickets of the week and propose a plan for the ones that stalled.',
  },
];

// The schedules (decision 29): the dependency update every night at 03:00,
// the weekly review on Monday mornings, and a one-off run switched off.
export function schedulesFixture(now: Date): Schedule[] {
  const on = (days: number, hours: number, minutes: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hours, minutes).toISOString();
  const base = { createdBy: 'user-demo', createdAt: minutesBefore(now, 3 * 24 * 60).toISOString() } as const;
  return [
    { ...base, id: 'schedule-1', recipe: 'dependency-update', goal: null, parameters: { package: 'pg' }, at: null, every: 'day 03:00', budgetUsd: 0.5, weekCapPercent: 60, enabled: true, nextRunAt: on(1, 3, 0), lastRunAt: on(0, 3, 0) },
    { ...base, id: 'schedule-2', recipe: 'weekly-review', goal: null, parameters: {}, at: null, every: 'week mon 08:00', budgetUsd: 1, weekCapPercent: 50, enabled: true, nextRunAt: on(5, 8, 0), lastRunAt: null },
    { ...base, id: 'schedule-3', recipe: null, goal: 'Read the error log of the night and open a ticket for each new error', parameters: {}, at: on(2, 6, 30), every: null, budgetUsd: 0.3, weekCapPercent: 60, enabled: false, nextRunAt: null, lastRunAt: null },
  ];
}
