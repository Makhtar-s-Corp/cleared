// The lead's fixture: the thread and the plan of lead-and-plan.png, made by
// playing the fake adapter's scripted lead (exampleLeadScript) into an
// in-memory store, with host tools that record what the lead commits and
// proposes, as lanes 5 and 7 will in their tables. The thread, the plan,
// the commitments and the context share are read back from what was played.
// Names are neutral: the project is the example guestbook, and the plan is
// the capture's shape (2 after 1, 3 after 2, two fast lane items) with the
// guestbook's content.
import type { Estimate, LeadCommitment, LeadMemory, LeadMessage, LeadState, Plan, PlanItem, PlanItemInbox, SessionSummary } from '../../src/api/types.ts';
import { LEAD_TICKET, bindLeadTools } from '../../src/lead/contract.ts';
import { createFakeAdapter, exampleLeadScript } from '../../src/session/adapters/fake.ts';
import type { CustomValue, SessionPhase } from '../../src/session/events.ts';
import { DEFAULT_SAFE_COMMANDS } from '../../src/session/policy.ts';
import { openStore, type Store } from '../../src/store/db.ts';
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
