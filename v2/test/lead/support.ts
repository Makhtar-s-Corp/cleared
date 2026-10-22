// What the lead tests share: the flow's test harness (a store in memory, the
// in-memory tickets, a scripted flow) with the lead's tables, a lead adapter
// that plays one fake script per generation, and lead effects that record
// the briefing written for each generation instead of cloning or reading
// lib/memory.
import { LEAD_TICKET } from '../../src/lead/contract.ts';
import type { LeadConfig } from '../../src/lead/config.ts';
import { LeadEngine, flowPort, type LeadDeps, type LeadEffects, type LeadFlow } from '../../src/lead/engine.ts';
import { LEAD_TABLES } from '../../src/lead/store.ts';
import { createFakeAdapter, type FakeStep } from '../../src/session/adapters/fake.ts';
import type { HostTool, SessionAdapter, SessionHandle, SessionId, StartInput, UserMessage } from '../../src/session/contract.ts';
import { toolArgs, type AgUiEvent, type CustomValue, type EventLog, type SessionEvent } from '../../src/session/events.ts';
import { applyTables } from '../../src/store/db.ts';
import type { FlowEvent, FlowListener } from '../../src/flow/events.ts';
import { setup, until, type SetupOptions } from '../flow/support.ts';

export { until } from '../flow/support.ts';

export const LEAD_CONFIG: LeadConfig = {
  enabled: true, model: 'claude-opus-5-5', contextPercent: 50, handoverPercent: 40, batchMs: 60_000,
};

// ---- script pieces --------------------------------------------------------

export const context = (percent: number): FakeStep => ({
  context: { totalTokens: Math.round(percent * 2000), maxTokens: 200_000, rawMaxTokens: 200_000, percent, isAutoCompactEnabled: true },
});
export const say = (id: string, text: string): FakeStep[] => [
  { emit: { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' } },
  { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: text } },
  { emit: { type: 'TEXT_MESSAGE_END', messageId: id } },
];
export const call = (toolCallId: string, name: string, input: unknown): FakeStep => ({ hostCall: { toolCallId, name, input } });
const runStarted = (runId: string): FakeStep => ({ emit: { type: 'RUN_STARTED', threadId: 'lead', runId } });
const runFinished = (runId: string): FakeStep => ({
  emit: { type: 'RUN_FINISHED', threadId: 'lead', runId, outcome: { type: 'success' }, usage: [{ model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 100 }], result: { stopReason: 'end_turn', total_cost_usd: 0.05 } },
});

// The turn the adapter plays at start (the generation's opening prompt),
// with the share its briefing takes.
export const opening = (percent = 8): FakeStep[] => [runStarted('opening'), context(percent), runFinished('opening')];
// One turn: it waits for the next message, then plays its steps.
export const turn = (runId: string, ...steps: (FakeStep | FakeStep[])[]): FakeStep[] => [{ awaitMessage: true }, runStarted(runId), ...steps.flat(), runFinished(runId)];
// The answer to the handover request.
export const handsOver = (runId: string, summary: string): FakeStep[] => turn(runId, call(`${runId}-handover`, 'handover', { summary }));

export const question = (requestId: string, text: string): FakeStep => ({
  question: { requestId, questions: [{ question: text, header: 'Question', options: [{ label: 'Yes (Recommended)' }, { label: 'No' }] }] },
});

// ---- the lead's adapter ---------------------------------------------------

export type Generation = { readonly input: StartInput; readonly id: SessionId; readonly stopped: () => boolean };

// One fake script per generation, in order; the last one is played again
// for any generation after it. Each ends waiting for a message, as a lead
// between turns does.
export function leadAdapter(log: EventLog, scripts: readonly (readonly FakeStep[])[], started: Generation[]): SessionAdapter {
  let n = 0;
  return {
    harness: 'claude-code',
    async start(input) {
      // A lead waits for its next turn: a script never ends its session.
      const script = [...(scripts[Math.min(n, scripts.length - 1)] ?? []), { awaitMessage: true } as const];
      n++;
      const handle = await createFakeAdapter({ log, script }).start(input);
      let stopped = false;
      started.push({ input, id: handle.id, stopped: () => stopped });
      return { ...handle, stop: async () => { stopped = true; await handle.stop(); } };
    },
    async resume(id) { throw new Error(`the lead never resumes ${id}`); },
  };
}

// A lead session the test plays by hand: each message the engine sends is
// given to `respond`, which emits what the harness would and calls the host
// tools, as the runner does.
export type Puppet = {
  readonly id: SessionId;
  readonly input: StartInput;
  readonly sent: UserMessage[];
  emit(event: AgUiEvent): void;
  measure(percent: number): void;
  callTool(name: string, input: unknown): Promise<unknown>;
  stopped: boolean;
  interrupted: number;
};

export function puppetAdapter(log: EventLog, respond: (puppet: Puppet, message: UserMessage) => Promise<void>, puppets: Puppet[], openingPercent = 8): SessionAdapter {
  let n = 0;
  return {
    harness: 'claude-code',
    async start(input) {
      const id = `lead-session-${++n}`;
      const wake = new Set<() => void>();
      let closed = false;
      let calls = 0;
      const tools = new Map<string, HostTool>((input.tools ?? []).map((tool) => [tool.name, tool]));
      const puppet: Puppet = {
        id, input, sent: [], stopped: false, interrupted: 0,
        emit(event) {
          log.append({ at: new Date().toISOString(), sessionId: id, ticket: input.ticket, project: input.project, event });
          for (const w of wake) w();
        },
        measure(percent) {
          const value: CustomValue['cleared.context_usage'] = { totalTokens: percent * 2000, maxTokens: 200_000, percent, isAutoCompactEnabled: true };
          puppet.emit({ type: 'CUSTOM', name: 'cleared.context_usage', value });
        },
        async callTool(name, toolInput) {
          const toolCallId = `${id}-call-${++calls}`;
          puppet.emit({ type: 'TOOL_CALL_START', toolCallId, toolCallName: `mcp__cleared__${name}` });
          puppet.emit(toolArgs(toolCallId, { kind: 'other' }));
          puppet.emit({ type: 'TOOL_CALL_END', toolCallId });
          const tool = tools.get(name);
          if (!tool) throw new Error(`no host tool ${name}`);
          return tool.handle(toolInput, { sessionId: id, turn: 'turn' });
        },
      };
      puppets.push(puppet);
      const handle: SessionHandle = {
        id,
        async send(message) {
          if (closed) throw new Error(`session ${id} is stopped`);
          puppet.sent.push(message);
          await respond(puppet, message);
        },
        async *events(afterSeq = 0) {
          let seq = afterSeq;
          for (;;) {
            let w = () => {};
            const waited = new Promise<void>((resolve) => { w = resolve; });
            wake.add(w);
            try {
              const fresh: SessionEvent[] = log.after(id, seq);
              for (const event of fresh) { seq = event.seq; yield event; }
              if (fresh.length > 0) continue;
              if (closed) return;
              await waited;
            } finally { wake.delete(w); }
          }
        },
        async answer() { /* the puppet asks nothing */ },
        async interrupt() { puppet.interrupted++; },
        async stop() { closed = true; puppet.stopped = true; for (const w of wake) w(); },
        async handover() { throw new Error('not in milestone 2'); },
      };
      // The opening turn, as the real adapter plays the prompt.
      puppet.emit({ type: 'RUN_STARTED', threadId: id, runId: 'opening' });
      puppet.measure(openingPercent);
      puppet.emit(finishedEvent('opening'));
      return handle;
    },
    async resume(id) { throw new Error(`the lead never resumes ${id}`); },
  };
}

export const finishedEvent = (runId: string, cancelled = false): AgUiEvent => ({
  type: 'RUN_FINISHED', threadId: 'lead', runId, outcome: cancelled ? { type: 'cancelled' } : { type: 'success' }, usage: [],
  result: { stopReason: cancelled ? 'cancelled' : 'end_turn', total_cost_usd: 0.01 },
});

// ---- the whole harness ----------------------------------------------------

export type LeadSetupOptions = SetupOptions & {
  readonly lead?: readonly (readonly FakeStep[])[];       // one script per generation
  readonly adapter?: (log: EventLog) => SessionAdapter;   // instead of the scripts
  readonly leadConfig?: Partial<LeadConfig>;
  readonly memory?: LeadEffects['memory'];
  readonly prepareWorkdir?: LeadEffects['prepareWorkdir'];
  readonly flow?: false;                                   // no flow engine: the lead alone
  readonly start?: false;                                  // build the engine without starting it
};

export async function leadSetup(options: LeadSetupOptions = {}) {
  const t = await setup(options);
  applyTables(t.store.db, LEAD_TABLES);
  const generations: Generation[] = [];
  const briefings: string[] = [];
  const workdirs: string[] = [];
  const adapter = options.adapter?.(t.store.events) ?? leadAdapter(t.store.events, options.lead ?? [opening(), turn('t1', say('r1', 'Hello.'))], generations);
  const effects: LeadEffects = {
    prepareWorkdir: options.prepareWorkdir ?? (async () => { workdirs.push('/work/lead'); return '/work/lead'; }),
    async writeBriefing(_workdir, text) { briefings.push(text); },
    memory: options.memory ?? (async () => [{ type: 'project', content: 'The guestbook: one page that lists and adds entries.' }]),
    async searchMemory(query) { return [{ id: 'decision-3', type: 'decision', status: 'approved', content: `Entries are shown newest first (${query}).` }]; },
  };
  // The flow's bus as the lead hears it, plus a way to say an event on it.
  const listeners = new Set<FlowListener>();
  const port = flowPort(t.engine);
  const flow: LeadFlow = { ...port, subscribe: (listener) => { listeners.add(listener); const off = port.subscribe(listener); return () => { listeners.delete(listener); off(); }; } };
  const emitFlow = (event: FlowEvent) => { for (const listener of listeners) void listener(event); };
  const deps: LeadDeps = {
    store: t.store, inbox: t.inbox, flow, adapter,
    config: { ...LEAD_CONFIG, ...options.leadConfig },
    project: { name: 'guestbook', base: 'main', workdir: '/work/lead' },
    effects, now: () => new Date(t.clock.now), settleMs: 0,
  };
  const make = () => new LeadEngine(deps);
  const lead = make();
  if (options.start !== false) await lead.start();
  return { ...t, lead, make, deps, generations, briefings, workdirs, adapter, effects, emitFlow };
}

export type LeadSetup = Awaited<ReturnType<typeof leadSetup>>;

// The user messages a session was sent, in order.
export function sentTo(log: EventLog, id: SessionId): string[] {
  const roles = new Map<string, string>();
  const out: string[] = [];
  for (const { event } of log.after(id)) {
    if (event.type === 'TEXT_MESSAGE_START') roles.set(event.messageId, event.role);
    if (event.type === 'TEXT_MESSAGE_CONTENT' && roles.get(event.messageId) === 'user') out.push(event.delta);
  }
  return out;
}

export const flowEvent = (overrides: Partial<FlowEvent> & Pick<FlowEvent, 'type'>): FlowEvent =>
  ({ at: '2026-10-21T10:00:00.000Z', project: 'guestbook', ticket: 'LOCAL-1', session: 's-author', by: 'u1', origin: null, ...overrides }) as FlowEvent;

export { LEAD_TICKET };
