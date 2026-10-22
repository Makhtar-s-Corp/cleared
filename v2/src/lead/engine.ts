// The project lead (docs/v2/milestone-2-plan.md, section 4): one permanent
// Claude Code session whose context never inflates and never loses a
// commitment.
//
//   A generation is one session of the lead, briefed from the tables: its
//   rules, the open commitments, the last handover record and the memory
//   (briefing.ts). It is fed turns one at a time, never while one runs: the
//   owner's lines from the thread first, then the flow's events batched over
//   CLEARED_V2_LEAD_BATCH_SECONDS. Its share of the context is measured after
//   every turn and tool call; at the handover point the next turn asks for
//   the handover, at the threshold the running turn is interrupted first.
//   The handover stored (or written by the service when the lead did not),
//   the session is stopped and the next generation starts. The owner sees
//   one thread, with a grey line where the generation changed.
//
// The engine owns the lead's lifecycle: the flow's idle rule never applies
// to it (the flow supervises only the sessions it starts), and after a
// service restart the live generation's row is ended and a new one starts,
// never a resume: the old context is what a refresh removes.
//
// What it uses of the flow is a narrow port (LeadFlow), so lane 7 and the
// tests can build it without the rest of the service.
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LeadMemory, LeadMessage, LeadPhase, LeadState, LeadStreamFrame, Plan, SessionDetail, SessionSummary } from '../api/types.ts';
import { LOGIN_FILE_MOUNT, WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { FlowEngine } from '../flow/engine.ts';
import type { FlowListener } from '../flow/events.ts';
import type { Runtime } from '../flow/runtime.ts';
import type { InboxStore } from '../inbox/store.ts';
import type { Registry } from '../modules/registry.ts';
import { cleanText, secretValues } from '../session/clean.ts';
import { HostToolRefused, type Decision, type HostCallContext, type SessionAdapter, type SessionHandle, type SessionId, type StartInput, type UserId } from '../session/contract.ts';
import type { ContextShare, CustomValue, Question, SessionEvent } from '../session/events.ts';
import type { Policy } from '../session/policy.ts';
import type { Store } from '../store/db.ts';
import { HANDOVER_LIMITS, commitmentLine, realLeadEffects, renderLeadBriefing, type LeadEffects, type LeadEffectsConfig, type MemoryHit } from './briefing.ts';
import { loadLeadConfig, type LeadConfig } from './config.ts';
import { LEAD_TICKET, bindLeadTools, capAnswer, type LeadHandlers } from './contract.ts';
import { HANDOVER_REQUEST, againTurn, commitmentDue, describeFlowEvent, earlierAnswer, eventTurn, goalTurn, openingPrompt, serviceTurn } from './prompts.ts';
import { LeadStore, type HandoverRecord } from './store.ts';
import { leadHandlers } from './tools.ts';

export type { LeadEffects, MemoryHit } from './briefing.ts';

// What the lead uses of the flow (flow/engine.ts). `stopSession` is
// optional: the flow has no public stop yet, and the lead's stop_session
// refuses until it has one.
export type LeadFlow = {
  subscribe(listener: FlowListener): () => void;
  sessions(): SessionSummary[];
  sessionDetail(id: SessionId): SessionDetail | undefined;
  eventsAfter(id: SessionId, seq?: number): SessionEvent[];
  send(id: SessionId, text: string, by: UserId): Promise<void>;
  answer(id: SessionId, requestId: string, decision: Decision, by: UserId): Promise<void>;
  stopSession?(id: SessionId, reason: string, by: 'lead'): Promise<void>;
  readonly registry: Pick<Registry, 'ticketStore'>;
};

// The port over the flow's engine. A public `stopSession` the engine may
// gain later is picked up by name.
export function flowPort(engine: FlowEngine): LeadFlow {
  const stop = (engine as unknown as { stopSession?: LeadFlow['stopSession'] }).stopSession;
  return {
    subscribe: (listener) => engine.subscribe(listener),
    sessions: () => engine.sessions(),
    sessionDetail: (id) => engine.sessionDetail(id),
    eventsAfter: (id, seq) => engine.eventsAfter(id, seq),
    send: (id, text, by) => engine.send(id, text, by),
    answer: (id, requestId, decision, by) => engine.answer(id, requestId, decision, by),
    ...(typeof stop === 'function' ? { stopSession: (id: SessionId, reason: string, by: 'lead') => stop.call(engine, id, reason, by) } : {}),
    registry: engine.registry,
  };
}

// What another lane adds to the lead without editing this file (section
// 10): lane 7's tools (propose_plan, start_ticket), its lines of the
// compact state, and its sections of the handover's structured record.
export type LeadExtensions = {
  readonly tools?: LeadHandlers;
  readonly state?: readonly (() => string)[];
  readonly handover?: readonly (() => string)[];
};

export type LeadDeps = {
  readonly store: Pick<Store, 'db' | 'events' | 'sessions'>;
  readonly inbox: InboxStore;
  readonly flow: LeadFlow;
  readonly adapter: SessionAdapter;
  readonly config: LeadConfig;
  readonly project: { readonly name: string; readonly base: string; readonly workdir: string };
  readonly effects: LeadEffects;
  readonly now?: () => Date;
  readonly clean?: (text: string) => string;
  readonly settleMs?: number;             // how long the end of a turn waits for its measure (the runner sends it after the result)
  readonly retryMs?: number;              // a generation that could not start is tried again after this long
  readonly extensions?: LeadExtensions;
};

type RefreshReason = CustomValue['cleared.lead_refreshed']['reason'];
type TurnKind = 'opening' | 'owner' | 'service' | 'event' | 'handover';

type Turn = { readonly kind: TurnKind; readonly seq?: number; readonly texts: string[] };

// The lead's question that waits for the owner, and its inbox item.
type Pending = { readonly sessionId: SessionId; readonly requestId: string; readonly questions: readonly Question[]; readonly item: string };

type Generation = {
  readonly number: number;
  readonly id: SessionId;
  readonly handle: SessionHandle;
  readonly startedAt: string;
  turn: Turn | undefined;
  seq: number;                             // the last event read
  served: number;                          // turns ended after the opening
  sawRun: boolean;                         // a RUN_STARTED was seen: the harness plays its turns
  refresh: RefreshReason | undefined;      // a refresh is due: at the end of the turn, or now
  interrupting: boolean;
  handoverId: string | undefined;
  settle: NodeJS.Timeout | undefined;
  ending: boolean;
  readonly texts: Map<string, { role: string; text: string }>;
};

const HARNESS = 'claude-code' as const;
const MESSAGES_IN_HANDOVER = 10;

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

export class LeadEngine {
  readonly store: LeadStore;
  #deps: LeadDeps;
  #now: () => Date;
  #clean: (text: string) => string;
  #gen: Generation | undefined;
  #starting = false;
  #refreshing = false;
  #nextReason: RefreshReason | undefined;
  #retryAt = 0;
  #context: ContextShare | null = null;
  #closed = false;
  #started = false;
  #tracked = new Set<Promise<unknown>>();
  #watchers = new Set<(frame: LeadStreamFrame) => void>();
  #unsubscribe: (() => void) | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: LeadDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    this.#clean = deps.clean ?? ((text) => text);
    this.store = new LeadStore(deps.store.db, deps.project.name, this.#now);
  }

  // ---- lifecycle -----------------------------------------------------------

  // Listens to the flow, puts straight what a stopped process left (a live
  // generation's row), and starts a generation. Never throws: a generation
  // that cannot start leaves the lead down until a tick starts it.
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#unsubscribe = this.#deps.flow.subscribe((event) => {
      if (event.ticket === LEAD_TICKET || event.project !== this.#deps.project.name) return;
      const line = describeFlowEvent(event);
      if (line) this.store.enqueue('flow', this.#clean(line));
    });
    const live = this.store.liveGeneration();
    if (live) {
      // The process that ran it is gone, and its context with it.
      const handover = this.#machineHandover(live.number);
      this.#markStopped(live.sessionId);
      this.#journalRefreshed(live.sessionId, live.number + 1, 'restart', handover.id);
      this.store.endGeneration(live.number, 'restart', handover.id);
      this.#nextReason = 'restart';
    }
    await this.#startGeneration();
  }

  // Ticks every `ms` until close(); the timer never keeps the process alive.
  startTimer(ms = 5000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick().catch((error) => console.error(`cleared-v2: lead tick failed (${errorName(error)})`)); }, ms);
    this.#timer.unref();
  }

  // Stops listening. The live generation stays as it is in the tables: a
  // new engine (a restart) ends it.
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    if (this.#gen?.settle) clearTimeout(this.#gen.settle);
    await Promise.allSettled([...this.#tracked]);
  }

  // A generation that could not start is tried again; commitments whose
  // time came wake the lead; the next turn is sent if one waits.
  async tick(): Promise<void> {
    if (this.#closed) return;
    if (!this.#gen && !this.#starting && this.#started && this.#now().getTime() >= this.#retryAt) await this.#startGeneration();
    for (const commitment of this.store.due(this.#now())) {
      this.store.enqueue('commitment', commitmentDue(commitment.id, commitment.text, commitment.due as string), true);
      this.store.woken(commitment.id);
    }
    this.#pump();
  }

  // Waits until every stored event of the live generation is read and
  // nothing the engine started is running. For the tests and a clean stop.
  async settled(): Promise<void> {
    for (let i = 0; i < 10_000; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#tracked.size > 0) {
        await Promise.allSettled([...this.#tracked]);
        continue;
      }
      const gen = this.#gen;
      if (this.#starting || (gen && (gen.settle !== undefined || this.#deps.store.events.after(gen.id, gen.seq).length > 0))) continue;
      return;
    }
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#tracked.add(promise);
    const done = () => { this.#tracked.delete(promise); };
    promise.then(done, done);
    return promise;
  }

  // ---- reading -----------------------------------------------------------------

  state(): LeadState {
    const gen = this.#gen;
    const last = this.store.lastGeneration();
    const number = gen?.number ?? last?.number ?? 0;
    const phase: LeadPhase = this.#refreshing ? 'refreshing' : this.#starting ? 'starting' : !gen ? 'down' : gen.turn ? 'working' : 'idle';
    const pending = this.#pendingQuestion();
    return {
      generation: number,
      sessionId: gen?.id ?? null,
      phase,
      model: this.#deps.config.model,
      context: this.#context,
      highestPercent: this.store.highestPercent(),
      refreshedAt: gen && gen.number > 1 ? gen.startedAt : null,
      refreshCount: Math.max(0, number - 1),
      openCommitments: this.store.openCommitments().length,
      pendingQuestion: pending ? { sessionId: pending.sessionId, requestId: pending.requestId } : null,
    };
  }

  // The thread after `after`, a question with the state of its inbox item.
  messages(after = 0): LeadMessage[] {
    return this.store.messages(after).map((message) => this.#withQuestionState(message));
  }

  #withQuestionState(message: LeadMessage): LeadMessage {
    if (!message.question) return message;
    const item = this.#deps.inbox.find(message.question.sessionId, message.question.requestId);
    return { ...message, question: { ...message.question, state: item?.state === 'waiting' ? 'waiting' : 'handled' } };
  }

  memory(): LeadMemory {
    const last = this.store.lastHandover();
    return {
      handover: last ? { id: last.id, generation: last.generation, at: last.at, summary: last.summary, machine: last.machine } : null,
      commitments: this.store.commitments(),
    };
  }

  // The stream's listener: every thread message, every state change, every
  // plan frame (lane 7), from now on. The function returned stops it.
  watch(listener: (frame: LeadStreamFrame) => void): () => void {
    this.#watchers.add(listener);
    return () => { this.#watchers.delete(listener); };
  }

  #frame(frame: LeadStreamFrame): void {
    for (const watcher of [...this.#watchers]) {
      try { watcher(frame); }
      catch (error) { console.error(`cleared-v2: a lead stream listener failed (${errorName(error)})`); }
    }
  }

  #publish(): void {
    this.#frame({ kind: 'state', state: this.state() });
  }

  #say(message: Parameters<LeadStore['addMessage']>[0]): LeadMessage {
    const stored = this.#withQuestionState(this.store.addMessage(message));
    this.#frame({ kind: 'message', message: stored });
    return stored;
  }

  // ---- what the owner and the other lanes do ---------------------------------------

  // An owner's line in the thread. While the lead's question waits, the line
  // is its answer (decision 8); otherwise it is the next owner turn, a goal
  // with its id (goal-<seq>) when `goal` is set.
  async post(text: string, user: UserId, goal = false): Promise<LeadMessage> {
    const pending = goal ? undefined : this.#pendingQuestion();
    if (pending) {
      const live = this.#gen?.id === pending.sessionId;
      const message = this.#say(live
        ? { by: 'owner', user, text, kind: 'message' }
        : { by: 'owner', user, text, kind: 'message', turn: earlierAnswer(pending.questions, text) });
      await this.#answerPending(pending, Object.fromEntries(pending.questions.map((q) => [q.question, text])), user, live);
      this.#publish();
      this.#pump();
      return message;
    }
    const message = this.#say({ by: 'owner', user, text, kind: 'message', turn: text });
    if (goal) this.store.setTurnText(message.seq, goalTurn(`goal-${message.seq}`, text));
    this.#publish();
    this.#pump();
    return message;
  }

  // The answer to the lead's pending question, as the session answer route
  // would give it (keyed by question text). For the seam that route needs.
  async answer(sessionId: SessionId, requestId: string, answers: Readonly<Record<string, string>>, user: UserId): Promise<void> {
    const pending = this.#pendingQuestion();
    if (!pending || pending.sessionId !== sessionId || pending.requestId !== requestId) throw new LeadError('not_found', `no question ${requestId} of the lead waits`);
    const live = this.#gen?.id === sessionId;
    this.#say(live
      ? { by: 'owner', user, text: Object.values(answers).join('\n'), kind: 'message' }
      : { by: 'owner', user, text: Object.values(answers).join('\n'), kind: 'message', turn: earlierAnswer(pending.questions, Object.values(answers).join('\n')) });
    await this.#answerPending(pending, answers, user, live);
    this.#publish();
    this.#pump();
  }

  // A line the service adds for an owner's gesture ("Plan P approved"):
  // in the thread, and a turn the lead answers there.
  serviceLine(text: string): LeadMessage {
    const message = this.#say({ by: 'system', text, kind: 'message', turn: serviceTurn(text) });
    this.#pump();
    return message;
  }

  // An event for the next event turn (lane 7's plan events).
  enqueue(text: string, urgent = false): void {
    this.store.enqueue('plan', this.#clean(text), urgent);
    if (urgent) this.#pump();
  }

  // A thread line that shows a plan (lane 7).
  planLine(planId: string, text: string): LeadMessage {
    return this.#say({ by: 'lead', text, kind: 'plan', planId });
  }

  publishPlan(plan: Plan): void {
    this.#frame({ kind: 'plan', plan });
  }

  // ---- generations ---------------------------------------------------------------

  async #startGeneration(): Promise<void> {
    if (this.#starting || this.#gen || this.#closed) return;
    this.#starting = true;
    this.#publish();
    try {
      const number = (this.store.lastGeneration()?.number ?? 0) + 1;
      const workdir = await this.#deps.effects.prepareWorkdir();
      let memory: Awaited<ReturnType<LeadEffects['memory']>> = [];
      let memoryError: string | undefined;
      try {
        memory = await this.#deps.effects.memory();
      } catch (error) {
        memoryError = this.#clean(error instanceof Error ? error.message : String(error)).slice(0, 300);
      }
      const at = this.#now().toISOString();
      const briefing = renderLeadBriefing({
        generation: number, at, commitments: this.store.openCommitments(), handover: this.store.lastHandover() ?? null, memory,
        ...(memoryError === undefined ? {} : { memoryError }),
      });
      await this.#deps.effects.writeBriefing(workdir, briefing);
      const of = (type: string) => memory.filter((entry) => entry.type === type).map((entry) => entry.content);
      const input: StartInput = {
        project: this.#deps.project.name, ticket: LEAD_TICKET, role: 'lead', harness: HARNESS, model: this.#deps.config.model, workdir,
        briefing: { projectPage: of('project')[0] ?? '', decisions: of('decision'), glossary: of('glossary'), lessons: of('lesson'), lastHandover: this.store.lastHandover()?.summary ?? null },
        policy: this.#policy(), prompt: openingPrompt(number, number > 1), services: [], tools: this.#tools(),
      };
      const handle = await this.#deps.adapter.start(input);
      const started = this.#now().toISOString();
      this.#deps.store.sessions.put({ id: handle.id, project: input.project, ticket: LEAD_TICKET, role: 'lead', harness: HARNESS, model: input.model, status: 'working', createdAt: started, updatedAt: started });
      this.store.startGeneration({ number, sessionId: handle.id, briefingBytes: Buffer.byteLength(briefing) });
      const gen: Generation = {
        number, id: handle.id, handle, startedAt: started, turn: { kind: 'opening', texts: [] }, seq: 0, served: 0, sawRun: false,
        refresh: undefined, interrupting: false, handoverId: undefined, settle: undefined, ending: false, texts: new Map(),
      };
      this.#gen = gen;
      if (number > 1) this.#say({ by: 'system', kind: 'refresh', generation: number, text: refreshText(this.#nextReason) });
      this.#nextReason = undefined;
      this.#supervise(gen);
    } catch (error) {
      console.error(`cleared-v2: a generation of the lead could not start (${errorName(error)}); it is tried again in a minute`);
      this.#retryAt = this.#now().getTime() + (this.#deps.retryMs ?? 60_000);
    } finally {
      this.#starting = false;
      this.#publish();
    }
  }

  #policy(): Policy {
    return {
      role: 'lead', base: this.#deps.project.base, workdir: WORKDIR_MOUNT, scripts: [], credentialFile: LOGIN_FILE_MOUNT,
      safeCommands: [], allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [],
    };
  }

  // The host tools of a generation: lane 5's handlers and the extensions',
  // each refusing a call from a session that is not the live generation.
  #tools() {
    const host = {
      flow: this.#deps.flow, store: this.store, inbox: this.#deps.inbox,
      searchMemory: (query: string) => this.#deps.effects.searchMemory(query),
      clean: (text: string) => this.#clean(text),
      generation: () => this.#gen?.number ?? 0,
      turnKind: () => this.#gen?.turn?.kind,
      compactState: () => this.compactState(),
      acceptHandover: (summary: string) => this.#acceptHandover(summary),
      tellOwner: (text: string) => this.#say({ by: 'lead', text: this.#clean(text), kind: 'message' }).seq,
    };
    const handlers: Record<string, (input: unknown, context: HostCallContext) => Promise<unknown>> = { ...leadHandlers(host), ...this.#deps.extensions?.tools } as never;
    const guarded = Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (input: unknown, context: HostCallContext) => {
      if (context.sessionId !== this.#gen?.id || this.#gen.ending) throw new HostToolRefused('This call comes from a session that is not the live generation of the lead: it is not taken.');
      return handler(input, context);
    }]));
    return bindLeadTools(guarded as LeadHandlers);
  }

  #supervise(gen: Generation): void {
    void (async () => {
      try {
        for await (const stored of gen.handle.events(0)) {
          if (this.#closed || gen.ending || this.#gen !== gen) break;
          gen.seq = stored.seq;
          this.#onEvent(gen, stored);
        }
      } catch (error) {
        console.error(`cleared-v2: the lead's event stream failed (${errorName(error)})`);
      }
      if (!this.#closed && !gen.ending && this.#gen === gen) this.#failed(gen);
    })();
  }

  #onEvent(gen: Generation, stored: SessionEvent): void {
    const event = stored.event;
    switch (event.type) {
      case 'RUN_STARTED':
        gen.sawRun = true;
        return;
      case 'TEXT_MESSAGE_START':
        gen.texts.set(event.messageId, { role: event.role, text: '' });
        return;
      case 'TEXT_MESSAGE_CONTENT': {
        const open = gen.texts.get(event.messageId);
        if (open) open.text += event.delta;
        return;
      }
      case 'TEXT_MESSAGE_END': {
        const open = gen.texts.get(event.messageId);
        gen.texts.delete(event.messageId);
        if (open?.role === 'assistant' && open.text.trim() && gen.turn) gen.turn.texts.push(open.text.trim());
        return;
      }
      case 'RUN_FINISHED':
        this.#turnEnded(gen, event.outcome.type === 'cancelled');
        return;
      case 'RUN_ERROR':
        this.#failed(gen);
        return;
      case 'CUSTOM':
        if (event.name === 'cleared.context_usage') this.#measured(gen, event.value);
        else if (event.name === 'cleared.question') this.#asked(gen, event.value);
        else if (event.name === 'cleared.permission_answered' || event.name === 'cleared.answered') this.#settledRequest(gen, event.value.requestId, event.name === 'cleared.permission_answered' ? event.value.decision : 'answer', event.value.by);
        return;
      default:
        return;
    }
  }

  // A measure of the context. The opening's own share (the rules, the
  // briefing, the harness's prompt) never refreshes a generation: a refresh
  // would start from the same share. Past the threshold during a turn, the
  // turn is interrupted here, before anything else runs: the fake adapter
  // and the runner go on after one turn of the event loop.
  #measured(gen: Generation, value: CustomValue['cleared.context_usage']): void {
    this.#context = { percent: value.percent, totalTokens: value.totalTokens, maxTokens: value.maxTokens };
    this.store.noteContext(gen.number, value.percent);
    const { contextPercent, handoverPercent } = this.#deps.config;
    if (gen.turn?.kind === 'opening' && !gen.sawRun) {
      // A harness that plays no opening turn (a scripted lead): the measure says it is ready.
      gen.turn = undefined;
      this.#publish();
      this.#pump();
      return;
    }
    const counts = gen.served > 0 || (gen.turn !== undefined && gen.turn.kind !== 'opening');
    if (counts && value.percent >= handoverPercent && gen.refresh === undefined) gen.refresh = value.percent >= contextPercent ? 'threshold' : 'handover_point';
    if (counts && value.percent >= contextPercent && gen.turn && gen.turn.kind !== 'handover' && gen.turn.kind !== 'opening' && !gen.interrupting) {
      gen.refresh = 'threshold';
      gen.interrupting = true;
      gen.handle.interrupt().catch((error) => console.error(`cleared-v2: the lead's turn could not be interrupted (${errorName(error)})`));
    }
    this.#publish();
    if (gen.settle) {
      clearTimeout(gen.settle);
      gen.settle = undefined;
      this.#decide(gen);
    }
  }

  #asked(gen: Generation, value: CustomValue['cleared.question']): void {
    this.#deps.inbox.addQuestion({ ticket: LEAD_TICKET, project: this.#deps.project.name, sessionId: gen.id, requestId: value.requestId, questions: value.questions });
    this.#say({ by: 'lead', kind: 'question', text: value.questions.map((q) => q.question).join('\n'), question: { sessionId: gen.id, requestId: value.requestId, questions: value.questions } });
    this.#publish();
  }

  // A request of the lead's session settled. An interrupt for a refresh
  // cancels what waits, but the owner's question stays in the inbox: its
  // answer goes to the next generation (section 3.3).
  #settledRequest(gen: Generation, requestId: string, decision: string, by: string): void {
    const item = this.#deps.inbox.find(gen.id, requestId);
    if (!item || item.state !== 'waiting') return;
    if (decision === 'cancelled' && gen.refresh !== undefined) return;
    this.#deps.inbox.handle(item.id, by as UserId);
    this.#publish();
  }

  #pendingQuestion(): Pending | undefined {
    for (const message of this.store.questions()) {
      const question = message.question;
      if (!question) continue;
      const item = this.#deps.inbox.find(question.sessionId, question.requestId);
      if (item?.state === 'waiting') return { sessionId: question.sessionId, requestId: question.requestId, questions: question.questions, item: item.id };
    }
    return undefined;
  }

  async #answerPending(pending: Pending, answers: Readonly<Record<string, string>>, user: UserId, live: boolean): Promise<void> {
    const gen = this.#gen;
    if (live && gen) {
      this.#deps.inbox.handle(pending.item, user);
      await gen.handle.answer(pending.requestId, { decision: { kind: 'answer', answers }, by: user });
    } else {
      // Asked by a generation that is gone: the answer is the next owner turn.
      this.#deps.inbox.handle(pending.item, 'system');
    }
  }

  #turnEnded(gen: Generation, cancelled: boolean): void {
    const turn = gen.turn;
    gen.turn = undefined;
    gen.interrupting = false;
    if (turn && turn.kind !== 'opening') gen.served++;
    if (turn && (turn.kind === 'owner' || turn.kind === 'service') && turn.seq !== undefined && !cancelled) {
      const reply = turn.texts.at(-1);
      if (reply) this.#say({ by: 'lead', text: this.#clean(reply), kind: 'message' });
      this.store.setTurn(turn.seq, 'done');
    }
    this.#publish();
    if (turn?.kind === 'handover') {
      void this.#track(this.#refresh(gen, gen.refresh ?? 'handover_point'));
      return;
    }
    // The runner measures after the turn's result: wait for that measure
    // before the next turn, so the handover comes at the end of this one.
    gen.settle = setTimeout(() => {
      gen.settle = undefined;
      this.#decide(gen);
    }, this.#deps.settleMs ?? 2000);
  }

  #decide(gen: Generation): void {
    if (gen.ending || this.#gen !== gen || gen.turn) return;
    if (gen.refresh !== undefined) {
      if (gen.handoverId !== undefined) void this.#track(this.#refresh(gen, gen.refresh));
      else this.#send(gen, { kind: 'handover', texts: [] }, HANDOVER_REQUEST, 'cleared');
      return;
    }
    this.#pump();
  }

  // The next turn, if the live generation is free: the owner's lines
  // first, then the events, once the oldest has waited the batch time (a
  // due commitment does not wait).
  #pump(): void {
    const gen = this.#gen;
    if (!gen || gen.turn || gen.settle || gen.refresh !== undefined || gen.ending || this.#closed) return;
    const owner = this.store.ownerTurns()[0];
    if (owner) {
      const text = owner.state === 'sent' ? againTurn(owner.text) : owner.text;
      this.store.setTurn(owner.seq, 'sent');
      this.#send(gen, { kind: owner.by === 'owner' ? 'owner' : 'service', seq: owner.seq, texts: [] }, text, owner.by === 'owner' && owner.user ? owner.user : 'cleared');
      return;
    }
    const pending = this.store.pending();
    const oldest = pending[0];
    if (!oldest) return;
    if (!pending.some((event) => event.urgent) && this.#now().getTime() - Date.parse(oldest.at) < this.#deps.config.batchMs) return;
    this.store.markSent(pending.map((event) => event.id));
    this.#send(gen, { kind: 'event', texts: [] }, eventTurn(pending.map((event) => event.text), this.compactState()), 'cleared');
  }

  #send(gen: Generation, turn: Turn, text: string, by: UserId): void {
    gen.turn = turn;
    this.#publish();
    void this.#track(gen.handle.send({ text, by }).catch((error) => {
      console.error(`cleared-v2: a turn could not be sent to the lead (${errorName(error)})`);
      this.#failed(gen);
    }));
  }

  #failed(gen: Generation): void {
    if (gen.ending || this.#gen !== gen) return;
    void this.#track(this.#refresh(gen, 'failed'));
  }

  // ---- handovers and refreshes ------------------------------------------------------

  #acceptHandover(summary: string): string {
    const gen = this.#gen;
    if (!gen) throw new HostToolRefused('No generation of the lead is live.');
    if (gen.handoverId !== undefined) throw new HostToolRefused('A handover is accepted once per generation: yours is stored.');
    const record = this.#record(gen.number, capAnswer(this.#clean(summary), HANDOVER_LIMITS.summary), false);
    gen.handoverId = record.id;
    gen.refresh ??= 'handover_point';
    return record.id;
  }

  #machineHandover(generation: number): HandoverRecord {
    return this.#record(generation, 'The lead did not write its account: the service wrote this record from its tables. Read the structured record and the thread\'s last messages; the lead did not write its account.', true);
  }

  // The structured parts, built from the tables now: they win over the summary.
  #record(generation: number, summary: string, machine: boolean): HandoverRecord {
    const sections = (this.#deps.extensions?.handover ?? []).map((section) => section()).filter(Boolean);
    const parts = [
      `Written at ${this.#now().toISOString()}.`,
      ...sections,
      `Live sessions:\n${this.#liveLines().join('\n') || '- none'}`,
      `Open commitments:\n${this.store.openCommitments().map(commitmentLine).join('\n') || '- none'}`,
      `Questions to the owner still waiting:\n${this.#questionLines().join('\n') || '- none'}`,
    ].join('\n\n');
    return this.store.addHandover({
      id: `h${generation}-${randomUUID().slice(0, 8)}`, generation, summary, machine, parts,
      messages: this.store.lastMessages(MESSAGES_IN_HANDOVER).map((message) => this.#withQuestionState(message)),
    });
  }

  async #refresh(gen: Generation, reason: RefreshReason): Promise<void> {
    if (gen.ending) return;
    gen.ending = true;
    if (gen.settle) clearTimeout(gen.settle);
    gen.settle = undefined;
    this.#refreshing = true;
    this.#publish();
    try {
      const handoverId = gen.handoverId ?? this.#machineHandover(gen.number).id;
      await gen.handle.stop().catch((error) => console.error(`cleared-v2: the lead's session could not be stopped (${errorName(error)})`));
      this.#markStopped(gen.id);
      this.#journalRefreshed(gen.id, gen.number + 1, reason, handoverId);
      this.store.endGeneration(gen.number, reason, handoverId);
      if (this.#gen === gen) this.#gen = undefined;
      this.#nextReason = reason;
    } finally {
      this.#refreshing = false;
    }
    // A session that fails before it served a turn would fail again at
    // once: the next generation waits the retry delay, started by a tick.
    if (reason === 'failed' && gen.served === 0) {
      this.#retryAt = this.#now().getTime() + (this.#deps.retryMs ?? 60_000);
      this.#publish();
      return;
    }
    await this.#startGeneration();
  }

  #markStopped(id: SessionId): void {
    const row = this.#deps.store.sessions.get(id);
    if (row) this.#deps.store.sessions.put({ ...row, status: 'stopped', updatedAt: this.#now().toISOString() });
  }

  #journalRefreshed(id: SessionId, generation: number, reason: RefreshReason, handoverId: string): void {
    this.#deps.store.events.append({
      at: this.#now().toISOString(), sessionId: id, ticket: LEAD_TICKET, project: this.#deps.project.name,
      event: { type: 'CUSTOM', name: 'cleared.lead_refreshed', value: { generation, reason, handoverId } },
    });
  }

  // ---- the compact state -------------------------------------------------------

  #liveLines(): string[] {
    const live = new Set(['starting', 'working', 'waiting_human', 'reviewing']);
    const waiting = this.#deps.inbox.list().filter((item) => item.state === 'waiting');
    return this.#deps.flow.sessions().filter((s) => s.role !== 'lead' && live.has(s.phase)).map((s) => {
      const waits = waiting.flatMap((item) => (item.kind === 'permission' && item.sessionId === s.id ? [`waits for a permission (${item.tool})`]
        : item.kind === 'question' && item.sessionId === s.id ? ['waits for an answer to its question'] : []));
      return `- ${s.ticket} ${s.role} ${s.id}: ${s.phase}, ${s.status}${waits.length ? `, ${waits.join(', ')}` : ''}`;
    });
  }

  #questionLines(): string[] {
    const pending = this.#pendingQuestion();
    return pending ? pending.questions.map((q) => `- ${q.question}`) : [];
  }

  // What the state tool answers and an event turn carries: plans (lane 7's
  // lines), live sessions with what each waits for, the inbox by kind, the
  // open commitments. bindLeadTools cuts the tool's answer at 2 KB.
  compactState(): string {
    const waiting = this.#deps.inbox.list().filter((item) => item.state === 'waiting');
    const count = (kind: string) => waiting.filter((item) => item.kind === kind).length;
    const extra = (this.#deps.extensions?.state ?? []).map((line) => line()).filter(Boolean);
    return [
      `Now: ${this.#now().toISOString()}.`,
      ...(extra.length ? extra : ['Plans: none yet.']),
      `Live sessions:\n${this.#liveLines().join('\n') || '- none'}`,
      `Inbox waiting: ${count('permission')} permission, ${count('question')} question, ${count('release')} release, ${count('plan')} plan.`,
      `Open commitments:\n${this.store.openCommitments().map(commitmentLine).join('\n') || '- none'}`,
    ].join('\n');
  }
}

function refreshText(reason: RefreshReason | undefined): string {
  switch (reason) {
    case 'restart': return 'The service restarted: the lead goes on from memory.';
    case 'failed': return 'The lead\'s session stopped: the lead goes on from memory.';
    default: return 'The lead refreshed from memory.';
  }
}

export type LeadErrorKind = 'not_found' | 'conflict' | 'invalid';

export class LeadError extends Error {
  override name = 'LeadError';
  readonly kind: LeadErrorKind;
  constructor(kind: LeadErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

// ---- the runtime of the module -----------------------------------------------------

export type LeadRuntimeOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly flow: Pick<Runtime, 'engine'>;
  readonly effects?: (config: LeadEffectsConfig) => LeadEffects;
  readonly extensions?: LeadExtensions;
};

export type LeadRuntime = {
  attach(deps: { readonly store: Store }): void;
  // The lead, built on the first request that needs it, after the flow's
  // engine (whose constructor handles the requests a dead process left).
  lead(registry: Registry): LeadEngine | undefined;
};

export function createLeadRuntime(options: LeadRuntimeOptions): LeadRuntime {
  const env = options.env ?? process.env;
  let store: Store | undefined;
  let config: LeadConfig | undefined;
  let engine: LeadEngine | undefined;
  return {
    attach(deps) {
      store = deps.store;
      config = loadLeadConfig(env);
    },
    lead(registry) {
      if (engine || !config?.enabled || !store) return engine;
      const flow = options.flow.engine(registry);
      const adapter = registry.sessionAdapters[HARNESS];
      if (!flow || !adapter) return undefined;
      const fc = flow.config;
      const workdir = join(fc.workdirRoot, LEAD_TICKET);
      const servicePaths = [...new Set([env.CLEARED_V2_STATE_DIR, env.HOME ?? homedir(), fc.projectDir, fc.workdirRoot].filter((p): p is string => !!p && p !== '/'))];
      engine = new LeadEngine({
        store, inbox: flow.inbox, flow: flowPort(flow), adapter, config,
        project: { name: fc.project, base: fc.base, workdir },
        effects: (options.effects ?? realLeadEffects)({ projectDir: fc.projectDir, repoUrl: fc.repoUrl, base: fc.base, workdir, env }),
        clean: (text) => cleanText(text, { secrets: secretValues(env), servicePaths }),
        ...(options.extensions ? { extensions: options.extensions } : {}),
      });
      engine.startTimer();
      const started = engine;
      void started.start().catch((error) => console.error(`cleared-v2: the lead could not start (${errorName(error)})`));
      return engine;
    },
  };
}
