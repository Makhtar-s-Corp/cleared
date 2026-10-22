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
// The approval routes behave as lane 8's service does: the approval is held
// for a grace period and written at its end unless Undo came first, and
// what is written is recorded in `writes`. The plan routes behave as lane
// 7's: a proposed plan is approved once, its inbox item is then handled,
// and a second approval is a 409.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { InboxItem, Plan, PlanItem, PlanItemInbox, QuestionItem, ReleaseItem, SessionSummary } from '../../src/api/types.ts';
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

const MINUTE = 60_000;
const ago = (now: Date, minutes: number) => new Date(now.getTime() - minutes * MINUTE).toISOString();

export type InboxFixture = {
  readonly project: string;
  readonly now: Date;
  readonly items: InboxItem[];
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

// Captures of the example's page, drawn as SVG, served by the stand-in at
// these same-origin addresses (the service gives none in milestone 1).
const capture = (side: 'before' | 'after', frame: 'desktop' | 'phone') => `/api/service/captures/${side}-${frame}.svg`;

export function inboxFixture(now: Date = FIXTURE_NOW): InboxFixture {
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
  const items: InboxItem[] = [
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
