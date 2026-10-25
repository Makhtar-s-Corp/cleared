// The lead's fixture: the thread and the plan of lead-and-plan.png, made by
// playing the fake adapter's scripted lead (exampleLeadScript) into an
// in-memory store, with host tools that record what the lead commits and
// proposes, as lanes 5 and 7 will in their tables. The thread, the plan,
// the commitments and the context share are read back from what was played.
// Names are neutral: the project is the example guestbook, and the plan is
// the capture's shape (2 after 1, 3 after 2, two fast lane items) with the
// guestbook's content.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { leadFrame, type Estimate, type LeadCommitment, type LeadMemory, type LeadMessage, type LeadState, type Plan, type PlanItem, type PlanItemInbox, type ReleaseItem, type SessionSummary } from '../../src/api/types.ts';
import { LEAD_TICKET, bindLeadTools } from '../../src/lead/contract.ts';
import { createFakeAdapter, exampleLeadScript } from '../../src/session/adapters/fake.ts';
import type { CustomValue, SessionPhase } from '../../src/session/events.ts';
import { DEFAULT_SAFE_COMMANDS } from '../../src/session/policy.ts';
import { openStore, type Store } from '../../src/store/db.ts';
import { sendJson, type DataSource } from '../src/proxy.ts';
import { FIXTURE_PROJECT } from './tower.ts';

export const LEAD_OWNER = 'owner';
export const LEAD_GOAL = 'Goal: make the guestbook readable once it has many entries. I want it before Friday.';
export const LEAD_ANSWER = 'Pages of 20. The phone keeps the long list.';
const LEAD_MODEL = 'claude-opus-5-5';

// The capture's estimates, by position: minutes, and the week share it shows.
const ESTIMATES: readonly (Omit<Estimate, 'samples'>)[] = [
  { minutes: 40, costUsd: 0.80, weekPercent: 1.2 },
  { minutes: 50, costUsd: 1.10, weekPercent: 1.6 },
  { minutes: 30, costUsd: 0.55, weekPercent: 0.8 },
  { minutes: 10, costUsd: 0.15, weekPercent: 0.2 },
  { minutes: 5, costUsd: 0.10, weekPercent: 0.1 },
];
const SAMPLES = 23;

export type LeadFixture = {
  readonly state: LeadState;
  readonly messages: readonly LeadMessage[];
  readonly memory: LeadMemory;
  readonly plans: readonly Plan[];
  readonly inbox: readonly PlanItemInbox[];
  readonly session: SessionSummary;
  readonly store: Store;
};

const minutesBefore = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);
const round = (value: number) => Math.round(value * 100) / 100;

export async function leadFixture(now: Date, options: { readonly project?: string } = {}): Promise<LeadFixture> {
  const project = options.project ?? FIXTURE_PROJECT;
  const store = openStore(':memory:');
  const refreshedAt = minutesBefore(now, 10);
  let clock = refreshedAt;
  const plans: Plan[] = [];
  const commitments: LeadCommitment[] = [{
    id: 'commitment-1', text: 'Tell the owner when the checks of the example are green again.', ticket: null, due: null, state: 'done',
    createdAt: minutesBefore(now, 300).toISOString(), fulfilledAt: minutesBefore(now, 240).toISOString(), note: 'Told at 15:41: green after the lock file fix.',
  }];

  // What lanes 5 and 7 do in their tables, in memory.
  const tools = bindLeadTools({
    search_memory: async () => 'decision 1: the page works without JavaScript\ndecision 3: entries are shown newest first',
    propose_plan: async (input) => {
      const items: PlanItem[] = input.items.map((item, index) => ({
        position: index + 1, title: item.title, body: item.body, lane: item.lane, size: item.size, after: [...item.after],
        estimate: { ...(ESTIMATES[index] ?? { minutes: 12, costUsd: 0.3, weekPercent: null }), samples: SAMPLES }, ticket: null, state: 'waiting',
      }));
      const sum = (key: 'costUsd' | 'weekPercent') => round(items.reduce((total, item) => total + (item.estimate[key] ?? 0), 0));
      // The critical path with two at a time: 1, 2 and 3 in a row (120 min)
      // while 4 and 5 run beside them. The capture's "2 h 15" is the sum.
      const plan: Plan = {
        id: 'plan-1', goal: input.goal, title: input.title, summary: input.summary, items, maxParallel: 2,
        totals: { minutes: 120, costUsd: sum('costUsd'), weekPercent: sum('weekPercent'), samples: SAMPLES },
        state: 'proposed', proposedAt: clock.toISOString(), approvedAt: null, approvedBy: null,
      };
      plans.push(plan);
      return { plan: plan.id, supersedes: null, totals: plan.totals };
    },
    commit: async (input) => {
      const id = `commitment-${commitments.length + 1}`;
      commitments.unshift({ id, text: input.text, ticket: input.ticket ?? null, due: input.due ?? null, state: 'open', createdAt: clock.toISOString(), fulfilledAt: null, note: null });
      return { id };
    },
  });

  const adapter = createFakeAdapter({ log: store.events, script: exampleLeadScript, newId: () => 'lead-generation-3', now: () => clock });
  const handle = await adapter.start({
    project, ticket: LEAD_TICKET, role: 'lead', harness: 'claude-code', model: LEAD_MODEL, workdir: '/workspace', tools,
    prompt: 'You are the project lead of the guestbook. Wait for the owner.',
    briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: 'Generation 2 handed over: nothing in progress.' },
    policy: { role: 'lead', base: 'main', workdir: '/workspace', scripts: ['test'], credentialFile: '/run/cleared/credential', safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [] },
  });
  clock = minutesBefore(now, 8);
  await handle.send({ text: LEAD_GOAL, by: LEAD_OWNER });
  clock = minutesBefore(now, 6);
  await handle.answer('lead-question-1', { decision: { kind: 'answer', answers: { 'Desktop list': LEAD_ANSWER } }, by: LEAD_OWNER });

  // The thread as lane 5 keeps it (lead_messages), from the stored events:
  // the owner's messages and answers, the lead's question and its reply in
  // the owner's turn, which follows the plan it proposed.
  const events = store.events.after(handle.id);
  const messages: LeadMessage[] = [{ seq: 1, at: refreshedAt.toISOString(), by: 'system', text: 'Refreshed from memory', kind: 'refresh', generation: 3 }];
  const add = (message: Omit<LeadMessage, 'seq'>) => messages.push({ seq: messages.length + 1, ...message });
  const texts = new Map<string, { role: 'assistant' | 'user'; text: string }>();
  let proposed: string | undefined;
  let context: CustomValue['cleared.context_usage'] | undefined;
  let phase: SessionPhase = 'starting';
  let status = '';
  for (const { at, event } of events) {
    if (event.type === 'TEXT_MESSAGE_START') texts.set(event.messageId, { role: event.role, text: '' });
    if (event.type === 'TEXT_MESSAGE_CONTENT') { const open = texts.get(event.messageId); if (open) open.text += event.delta; }
    if (event.type === 'TEXT_MESSAGE_END') {
      const done = texts.get(event.messageId);
      if (done?.role === 'user') add({ at, by: 'owner', user: LEAD_OWNER, text: done.text, kind: 'message' });
      else if (done) add({ at, by: 'lead', text: done.text, ...(proposed ? { kind: 'plan', planId: proposed } : { kind: 'message' }) });
    }
    if (event.type === 'STATE_SNAPSHOT') ({ phase, status } = event.snapshot);
    if (event.type !== 'CUSTOM') continue;
    if (event.name === 'cleared.question') {
      const first = event.value.questions[0];
      add({ at, by: 'lead', text: first?.question ?? '', kind: 'question', question: { sessionId: handle.id, requestId: event.value.requestId, questions: event.value.questions, state: 'waiting' } });
    }
    if (event.name === 'cleared.answered') {
      const asked = messages.find((m) => m.question?.requestId === event.value.requestId);
      if (asked?.question) messages[asked.seq - 1] = { ...asked, question: { ...asked.question, state: 'handled' } };
      add({ at, by: 'owner', user: LEAD_OWNER, text: LEAD_ANSWER, kind: 'message' });
    }
    if (event.name === 'cleared.host_call' && event.value.name === 'propose_plan' && event.value.outcome === 'ok') proposed = plans.at(-1)?.id;
    if (event.name === 'cleared.context_usage') context = event.value;
  }

  const last = events.at(-1);
  const session: SessionSummary = {
    id: handle.id, project, ticket: LEAD_TICKET, role: 'lead', harness: 'claude-code', model: LEAD_MODEL, phase, status,
    startedAt: refreshedAt.toISOString(), updatedAt: last?.at ?? refreshedAt.toISOString(), lastSeq: last?.seq ?? 0,
  };
  const open = commitments.filter((c) => c.state === 'open').length;
  const state: LeadState = {
    generation: 3, sessionId: handle.id, phase: 'idle', model: LEAD_MODEL,
    context: context ? { percent: context.percent, totalTokens: context.totalTokens, maxTokens: context.maxTokens } : null,
    highestPercent: Math.max(41, context?.percent ?? 0), refreshedAt: refreshedAt.toISOString(), refreshCount: 2, openCommitments: open, pendingQuestion: null,
  };
  const memory: LeadMemory = {
    handover: {
      id: 'handover-2', generation: 2, at: refreshedAt.toISOString(), machine: false,
      summary: 'The owner asked for nothing new since the morning. The example\'s checks are green again; I told the owner. Nothing in progress.',
    },
    commitments: [...commitments.filter((c) => c.state === 'open'), ...commitments.filter((c) => c.state === 'done')],
  };
  const inbox: PlanItemInbox[] = plans.filter((plan) => plan.state === 'proposed').map((plan) => ({
    kind: 'plan', id: `plan-item-${plan.id}`, ticket: LEAD_TICKET, project, since: plan.proposedAt, state: 'waiting',
    planId: plan.id, title: plan.title, summary: plan.summary, itemCount: plan.items.length, totals: plan.totals,
  }));
  return { state, messages, memory, plans, inbox, session, store };
}

// ------------------------------------------- lane 22: a plan across two services

// A plan of the workspace of two services (decisions 18 and 24, lane 22):
// each item carries the services its body names with their sensitivity, as
// lane 18's plan store gives them, the filter API under the full review.
// Its own value, so the fixture source keeps lane 1's plan.
export const SERVICE_PLAN_ID = 'plan-7';

export function servicePlan(now: Date): Plan {
  const guestbook = { service: 'guestbook', sensitivity: 'normal' } as const;
  const filter = { service: 'filter-api', sensitivity: 'full' } as const;
  const item = (position: number, title: string, minutes: number, costUsd: number, after: readonly number[], sensitivity: PlanItem['sensitivity']): PlanItem => ({
    position, title, body: `${title}.\n\nAcceptance criteria\n- [ ] ${title}, with a test.`, lane: 'full', size: minutes > 30 ? 'm' : 's', after,
    estimate: { minutes, costUsd, weekPercent: null, samples: 4 }, ticket: null, state: 'waiting', ...(sensitivity ? { sensitivity } : {}),
  });
  return {
    id: SERVICE_PLAN_ID, goal: 'goal-40', title: 'Flagged entries are held for review',
    summary: 'The filter API answers a severity; the guestbook holds a flagged entry for review instead of refusing it.',
    items: [
      item(1, 'The filter answers a severity with each word', 30, 0.70, [], [filter]),
      item(2, 'The guestbook holds an entry the filter flags', 40, 0.90, [1], [guestbook, filter]),
      item(3, 'A page lists the entries held for review', 30, 0.60, [2], [guestbook]),
      item(4, 'The README of each says how a flagged entry is handled', 10, 0.20, [2], [guestbook, filter]),
    ],
    maxParallel: 2, totals: { minutes: 100, costUsd: 2.40, weekPercent: null, samples: 4 }, state: 'proposed',
    proposedAt: minutesBefore(now, 8).toISOString(), approvedAt: null, approvedBy: null,
  };
}

// The same plan with its second item in steps across the two services
// (decision 26, lane 23's PlanItem.steps): the contract of the filter API,
// a step per service after it, then the integration on the guestbook, each
// with its estimate; the item's estimate is their critical path (lane 27).
export function stepsPlan(now: Date): Plan {
  const plan = servicePlan(now);
  const estimate = (minutes: number, costUsd: number): Estimate => ({ minutes, costUsd, weekPercent: null, samples: 4 });
  const steps: NonNullable<PlanItem['steps']> = [
    { position: 1, kind: 'contract', service: 'filter-api', after: [], estimate: estimate(10, 0.15) },
    { position: 2, kind: 'service', service: 'filter-api', after: [1], estimate: estimate(15, 0.25) },
    { position: 3, kind: 'service', service: 'guestbook', after: [1], estimate: estimate(20, 0.30) },
    { position: 4, kind: 'integration', service: 'guestbook', after: [2, 3], estimate: estimate(10, 0.20) },
  ];
  return { ...plan, items: plan.items.map((item) => (item.position === 2 ? { ...item, steps, estimate: estimate(40, 0.90) } : item)) };
}

// ------------------------------------------------- lane 8: the screen's other states

// The lead screen's other states (milestone 2, lane 8), beside what lane 1
// plays above: a plan running overnight, the same plan paused, and one done
// the day before, with the guestbook's content of the plan's question 5; and
// the thread while the lead's question still waits. They are separate values,
// so the fixture source keeps serving lane 1's single proposed plan.
const OTHER_ITEMS: readonly (Omit<PlanItem, 'estimate' | 'ticket' | 'state'> & { readonly minutes: number; readonly costUsd: number })[] = [
  { position: 1, title: 'A GET /entries.json route that lists the entries', body: 'List the entries as JSON, newest first.\n\nAcceptance criteria\n- [ ] the route answers the entries\n- [ ] a test', lane: 'full', size: 's', after: [], minutes: 12, costUsd: 0.30 },
  { position: 2, title: 'Names and messages trimmed before they are stored', body: 'Trim the spaces around a name and a message.\n\nAcceptance criteria\n- [ ] both fields trimmed\n- [ ] a test', lane: 'full', size: 's', after: [], minutes: 12, costUsd: 0.30 },
  { position: 3, title: 'The port and the database host in the log at start', body: 'Write the port and the database host when the app starts.\n\nAcceptance criteria\n- [ ] one line at start\n- [ ] a test', lane: 'full', size: 'xs', after: [], minutes: 5, costUsd: 0.15 },
  { position: 4, title: 'A Troubleshooting section for a database that does not answer', body: 'Say what to check when the database does not answer.\n\nAcceptance criteria\n- [ ] the section in the README', lane: 'fast', size: 'xs', after: [], minutes: 5, costUsd: 0.15 },
  { position: 5, title: 'The time each entry was written, on the page', body: 'Show when each entry was written.\n\nAcceptance criteria\n- [ ] the time beside each entry\n- [ ] a test', lane: 'full', size: 'm', after: [1, 2, 3, 4], minutes: 30, costUsd: 0.80 },
];
const RUNNING_STATES: readonly PlanItem['state'][] = ['landed', 'needs_approval', 'running', 'ready', 'waiting'];

export const RUNNING_PLAN_ID = 'plan-2';
export const DONE_PLAN_ID = 'plan-0';

export function otherPlans(now: Date, owner = LEAD_OWNER): { readonly running: Plan; readonly paused: Plan; readonly done: Plan } {
  const items: PlanItem[] = OTHER_ITEMS.map(({ minutes, costUsd, ...item }, index) => ({
    ...item, estimate: { minutes, costUsd, weekPercent: null, samples: 2 }, ticket: `LOCAL-${201 + index}`, state: RUNNING_STATES[index] ?? 'waiting',
  }));
  const running: Plan = {
    id: RUNNING_PLAN_ID, goal: 'goal-12', title: 'Make the guestbook ready for a small team',
    summary: 'A JSON route, trimmed entries, the port in the log, a Troubleshooting section, then the time of each entry.',
    items, maxParallel: 2, totals: { minutes: 42, costUsd: 1.70, weekPercent: null, samples: 2 }, state: 'approved',
    proposedAt: minutesBefore(now, 760).toISOString(), approvedAt: minutesBefore(now, 755).toISOString(), approvedBy: owner,
  };
  const done: Plan = {
    id: DONE_PLAN_ID, goal: 'goal-4', title: 'Newest entries first',
    summary: 'The list shows the newest entry first, and the README says so.',
    items: [
      { position: 1, title: 'The list shows the newest entry first', body: 'Order the entries newest first.\n\nAcceptance criteria\n- [ ] newest first\n- [ ] a test', lane: 'full', size: 's', after: [], estimate: { minutes: 12, costUsd: 0.30, weekPercent: null, samples: 0 }, ticket: 'LOCAL-158', state: 'landed' },
      { position: 2, title: 'The README says the newest entry comes first', body: 'One sentence in the README.\n\nAcceptance criteria\n- [ ] the sentence', lane: 'fast', size: 'xs', after: [1], estimate: { minutes: 5, costUsd: 0.15, weekPercent: null, samples: 0 }, ticket: 'LOCAL-159', state: 'landed' },
    ],
    maxParallel: 2, totals: { minutes: 17, costUsd: 0.45, weekPercent: null, samples: 0 }, state: 'done',
    proposedAt: minutesBefore(now, 1500).toISOString(), approvedAt: minutesBefore(now, 1495).toISOString(), approvedBy: owner,
  };
  return { running, paused: { ...running, state: 'paused' }, done };
}

// The thread and the state while the lead's question waits: lane 1's
// thread up to the question, the question still waiting, and the state
// naming it as pending.
export function waitingForAnswer(fixture: LeadFixture): { readonly state: LeadState; readonly messages: readonly LeadMessage[] } {
  const messages = fixture.messages.slice(0, 3).map((m) => (m.question ? { ...m, question: { ...m.question, state: 'waiting' as const } } : m));
  const asked = messages.find((m) => m.question)?.question;
  return {
    messages,
    state: { ...fixture.state, phase: 'working', pendingQuestion: asked ? { sessionId: asked.sessionId, requestId: asked.requestId } : null },
  };
}

// A stand-in for the lead's and the plans' routes, as the service answers
// them once lanes 5 and 7 run: the tests and the visual loop hand it to the
// app as its DataSource (fixtures/source.ts, lane 1's, refuses every write).
// An owner's message is added to the thread and answers the pending question
// unless it is a goal, as lane 5's engine does; approve, pause, resume and
// reject move the plan as lane 7's routes do, and a gesture the plan's state
// does not allow is a 409. What was asked is kept in `calls`.
export type LeadCall = { readonly method: string; readonly path: string; readonly user: string; readonly body: unknown };
export type LeadSource = DataSource & { readonly calls: LeadCall[]; readonly plans: Plan[]; state(): LeadState; messages(): readonly LeadMessage[] };

function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = '';
    request.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
    request.on('end', () => { try { resolve(text ? JSON.parse(text) : null); } catch { resolve(undefined); } });
    request.on('error', () => resolve(undefined));
  });
}

export function leadSource(start: {
  readonly state: LeadState;
  readonly messages: readonly LeadMessage[];
  readonly memory: LeadMemory;
  readonly plans: readonly Plan[];
  readonly inbox?: readonly PlanItemInbox[];
  readonly releases?: readonly ReleaseItem[];                   // the trains the thread shows (lane 22)
}, options: { readonly now?: () => Date } = {}): LeadSource {
  const now = options.now ?? (() => new Date());
  const calls: LeadCall[] = [];
  const plans = start.plans.map((plan) => ({ ...plan }));
  let state = start.state;
  const messages = start.messages.map((m) => ({ ...m }));
  const add = (message: Omit<LeadMessage, 'seq'>): LeadMessage => {
    const added = { seq: (messages.at(-1)?.seq ?? 0) + 1, ...message };
    messages.push(added);
    return added;
  };
  const after = (request: IncomingMessage, url: URL): number => {
    const from = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0);
    return Number.isInteger(from) && from >= 0 ? from : 0;
  };
  const move = (plan: Plan, to: Plan['state']): Plan => {
    const items = to !== 'approved' || plan.state !== 'proposed' ? plan.items : plan.items.map((item, index) => {
      const ticket = `LOCAL-${301 + index}`;
      const started = item.after.length === 0 && plan.items.slice(0, index).filter((i) => i.after.length === 0).length < plan.maxParallel;
      return { ...item, ticket, state: started ? 'running' as const : 'waiting' as const };
    });
    const moved: Plan = { ...plan, items, state: to, ...(plan.state === 'proposed' && to === 'approved' ? { approvedAt: now().toISOString(), approvedBy: LEAD_OWNER } : {}) };
    plans[plans.indexOf(plan)] = moved;
    return moved;
  };
  const allowed: Readonly<Record<string, { readonly from: Plan['state']; readonly to: Plan['state'] }>> = {
    approve: { from: 'proposed', to: 'approved' }, reject: { from: 'proposed', to: 'rejected' },
    pause: { from: 'approved', to: 'paused' }, resume: { from: 'paused', to: 'approved' },
  };

  async function handle(request: IncomingMessage, response: ServerResponse, method: string, url: URL, user: string): Promise<void> {
    const parts = url.pathname.split('/').slice(2);              // after '/api'
    const [collection, id, action] = parts;
    if (method === 'GET') {
      if (collection === 'inbox' && parts.length === 1) {
        const items = (start.inbox ?? []).map((item) => ({ ...item, state: plans.find((p) => p.id === item.planId)?.state === 'proposed' ? 'waiting' : 'handled' }));
        return sendJson(response, 200, [...items, ...(start.releases ?? [])]);
      }
      if (collection === 'lead' && parts.length === 1) return sendJson(response, 200, state);
      if (collection === 'lead' && id === 'messages' && parts.length === 2) return sendJson(response, 200, messages.filter((m) => m.seq > after(request, url)));
      if (collection === 'lead' && id === 'memory' && parts.length === 2) return sendJson(response, 200, start.memory);
      if (collection === 'lead' && id === 'stream' && parts.length === 2) {
        const from = after(request, url);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        for (const message of messages) if (message.seq > from) response.write(leadFrame({ kind: 'message', message }));
        response.write(leadFrame({ kind: 'state', state }));
        return void response.end();
      }
      if (collection === 'plans' && parts.length === 1) return sendJson(response, 200, plans);
      if (collection === 'plans' && parts.length === 2) {
        const plan = plans.find((p) => p.id === id);
        return plan ? sendJson(response, 200, plan) : sendJson(response, 404, { error: 'no such plan' });
      }
      return sendJson(response, 404, { error: 'not in the fixtures' });
    }
    if (method !== 'POST') return sendJson(response, 405, { error: 'method not allowed' });
    const body = await readBody(request);
    calls.push({ method, path: url.pathname, user, body });
    const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (collection === 'lead' && id === 'messages' && parts.length === 2) {
      if (typeof record.text !== 'string' || !record.text.trim()) return sendJson(response, 400, { error: 'text must be a non-empty text' });
      if (record.goal !== undefined && record.goal !== true) return sendJson(response, 400, { error: 'goal is true or absent' });
      const pending = record.goal === true ? null : state.pendingQuestion;
      if (pending) {
        const asked = messages.findIndex((m) => m.question?.requestId === pending.requestId);
        const question = messages[asked];
        if (question?.question) messages[asked] = { ...question, question: { ...question.question, state: 'handled' } };
        state = { ...state, pendingQuestion: null };
      }
      return sendJson(response, 200, add({ at: now().toISOString(), by: 'owner', user, text: record.goal === true ? `Goal: ${record.text}` : record.text, kind: 'message' }));
    }
    if (collection === 'plans' && id && action && parts.length === 3 && allowed[action]) {
      const plan = plans.find((p) => p.id === id);
      if (!plan) return sendJson(response, 404, { error: 'no such plan' });
      const rule = allowed[action] as { from: Plan['state']; to: Plan['state'] };
      if (plan.state !== rule.from) return sendJson(response, 409, { error: `the plan is ${plan.state}` });
      return sendJson(response, 200, move(plan, rule.to));
    }
    sendJson(response, 404, { error: 'not in the fixtures' });
  }

  return {
    kind: 'fixtures', calls, plans,
    state: () => state,
    messages: () => messages,
    forward(request, response, forward) {
      handle(request, response, forward.method, new URL(forward.path, 'http://fixtures'), forward.user.id).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
        else response.destroy();
      });
    },
  };
}
