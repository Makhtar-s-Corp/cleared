// The ticket's path in the service (docs/v2/milestone-1-plan.md, lane 7):
//
//   Todo -> workspace -> author session -> review session (another model,
//   read-only policy, same branch) -> on a pass: refresh the project, publish
//   the branch, record the review, ask the lock for the human's approval ->
//   the inbox shows the release until the ticket reaches the go state.
//   A requested change reopens the author with the report; a ticket that
//   cannot go on (idle, over budget, a failed run, a refused publish, no
//   verdict, too many rounds) goes back to Todo with a note.
//
// The engine owns what the plan gives lane 7: the inbox items and their
// state, the measured steps, the idle stop and the budget stop. Everything
// that leaves the process is injected (FlowEffects, the registry's adapters,
// ticket store and recorders), so the tests run a whole ticket on the fake
// adapter without git, gh, Docker or the broker.
//
// Where the steps are filed: the events of a session belong to that
// session, so `workspace`, `author` and `waiting_human` go to the author's,
// `review`, `release` and `approval` to the reviewer's (the last session of
// the ticket). `workspace` is written after the adapter has started the
// session, with the time it began, because the session's id does not exist
// before.
import type { PermissionItem, ReleaseItem, SessionDetail, SessionSummary } from '../api/types.ts';
import { LOGIN_FILE_MOUNT, WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { InboxStore } from '../inbox/store.ts';
import type { Registry } from '../modules/registry.ts';
import type { Answer, Briefing, Decision, Role, SessionAdapter, SessionHandle, SessionId, StartInput, UserId } from '../session/contract.ts';
import type { AgUiEvent, SessionEvent, SessionPhase, StepName } from '../session/events.ts';
import { DEFAULT_SAFE_COMMANDS, type Policy } from '../session/policy.ts';
import type { Store } from '../store/db.ts';
import type { Actor, Ticket, TicketId } from '../tickets/contract.ts';
import { ticketBranch } from '../workspace/checkout.ts';
import type { Published } from '../workspace/publish.ts';
import type { FlowConfig, ProjectSettings } from './config.ts';
import { authorPrompt, lastReport, parseVerdict, reviewPrompt, reviewRequestMessage } from './prompts.ts';
import { foldState } from './state.ts';

export type { ProjectSettings } from './config.ts';

// What the flow does outside this process.
export type FlowEffects = {
  settings(): Promise<ProjectSettings>;                           // the project's settings at the base branch
  refreshProject(): Promise<void>;                                // projectCheckout: fetch the forge, so publish sees the base as it is now (issue 141)
  prepareWorkdir(input: { readonly ticket: Ticket; readonly role: Role }): Promise<{ readonly workdir: string; readonly briefing: Briefing }>;
  captureHandover(input: { readonly workdir: string; readonly role: Role; readonly model: string; readonly ticket: TicketId; readonly sessionId: SessionId }): Promise<string | null>;
  publish(input: { readonly ticket: TicketId; readonly workdir: string; readonly branch: string; readonly report: string }): Promise<Published>;
  // The lock's `--ask` request; the request time the lock recorded, when it says one.
  requestRelease(input: { readonly ticket: TicketId; readonly pr: number; readonly announcement: string }): Promise<{ readonly requestedAt?: string }>;
  prChecks(pr: number): Promise<ReleaseItem['pr']['checks']>;      // the pull request's checks on the forge now
};

export type FlowDeps = {
  readonly store: Pick<Store, 'events' | 'sessions' | 'policyRules'>;
  readonly inbox: InboxStore;
  readonly registry: Registry;
  readonly config: FlowConfig;
  readonly effects: FlowEffects;
  readonly now?: () => Date;
  // Applied to every text the flow writes to a ticket or a session from an
  // error (paths, tokens): the cleaner of the service. Identity by default.
  readonly clean?: (text: string) => string;
};

export type FlowErrorKind = 'not_found' | 'conflict' | 'invalid' | 'unavailable';

export class FlowError extends Error {
  override name = 'FlowError';
  readonly kind: FlowErrorKind;
  constructor(kind: FlowErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const HARNESS = 'claude-code' as const;
const SERVICE: Actor = { kind: 'agents', id: 'cleared-v2' };
const FLOW_USER = 'cleared';                                       // the author of the message that reopens a session

type Live = {
  readonly id: SessionId;
  readonly input: StartInput;
  readonly settings: ProjectSettings;
  handle: SessionHandle;
  lastActivity: number;
  closed: boolean;
  waitOpen: boolean;                                                // a waiting_human step is open
};

type Watcher = { wait(ms: number): Promise<void>; close(): void };

const name = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// What "Always in this project" remembers for a request: the thing asked.
function patternOf(item: PermissionItem): string | undefined {
  const input = item.input;
  switch (input.kind) {
    case 'execute': return input.command;
    case 'read': case 'edit': case 'delete': case 'move': return input.path;
    case 'fetch': return input.target;
    case 'search': return input.pattern;
    default: return undefined;
  }
}

export class FlowEngine {
  readonly registry: Registry;
  readonly inbox: InboxStore;
  readonly config: FlowConfig;
  #store: FlowDeps['store'];
  #effects: FlowEffects;
  #now: () => Date;
  #clean: (text: string) => string;
  #live = new Map<SessionId, Live>();
  #inputs = new Map<SessionId, { input: StartInput; settings: ProjectSettings }>();   // kept for a reopen of the author
  #active = new Set<TicketId>();                                    // tickets whose flow has not ended
  #flows = new Map<TicketId, Set<SessionId>>();                     // the sessions of a ticket's current flow: rounds and times count from its start
  #handlers = new Set<Promise<unknown>>();
  #watchers = new Map<SessionId, Set<{ wake: () => void }>>();
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: FlowDeps) {
    this.registry = deps.registry;
    this.inbox = deps.inbox;
    this.config = deps.config;
    this.#store = deps.store;
    this.#effects = deps.effects;
    this.#now = deps.now ?? (() => new Date());
    this.#clean = deps.clean ?? ((text) => text);
    // A new engine has no live session: requests left by the last process are closed.
    this.inbox.handleRequests('system');
  }

  // ---- the periodic work -------------------------------------------------

  // Runs tick() every `ms` until close(); the timer never keeps the process alive.
  startTimer(ms = 30_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick().catch((error) => console.error(`cleared-v2: flow tick failed (${error instanceof Error ? error.name : typeof error})`)); }, ms);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    for (const set of this.#watchers.values()) for (const watcher of set) watcher.wake();
  }

  // The idle stop, and the notice that a release was approved. A session
  // that waits for the human is not idle: the request in the inbox would be
  // lost with it, and the wait is the human's.
  async tick(): Promise<void> {
    const now = this.#now().getTime();
    for (const live of [...this.#live.values()]) {
      if (live.closed || this.inbox.waitingFor(live.id) > 0) continue;
      if (now - live.lastActivity < this.config.idleMs) continue;
      const minutes = Math.round(this.config.idleMs / 60_000);
      await this.#stopTicket(live, 'idle', `No activity for ${minutes} minutes: the session was stopped.`,
        `The session stopped after ${minutes} minutes without activity. Move the ticket to Todo to start it again.`);
    }
    for (const release of this.inbox.waitingReleases()) {
      const ticket = await this.registry.ticketStore.get(release.ticket);
      if (ticket && ticket.status === this.registry.ticketStore.states.validate) {
        // The card says whether the checks are green: the lock queues a
        // release whose checks still run, so the owner waits for them.
        const checks = await this.#effects.prChecks(release.pr.number).catch(() => undefined);
        if (checks && checks !== release.pr.checks) this.inbox.setReleaseChecks(release.id, checks);
        continue;
      }
      const history = ticket ? await this.registry.ticketStore.history(ticket.id) : [];
      const by = history.at(-1)?.by;
      this.#settleRelease(release.id, release.ticket, release.project, by?.kind === 'human' ? by.id : 'system');
    }
  }

  // A release item ends when its approval does, or when a newer one replaces
  // it: its approval step closes on the session it started on.
  #settleRelease(id: string, ticket: TicketId, project: string, by: UserId | 'system'): void {
    if (!this.inbox.handle(id, by)) return;
    const sessionId = this.inbox.releaseSession(id);
    if (!sessionId) return;
    this.#step({ id: sessionId, ticket, project }, 'STEP_FINISHED', 'approval');
    this.#snapshot(sessionId, ticket);
  }

  // Waits until no event is being handled. For tests and for a clean stop.
  async settled(): Promise<void> {
    while (this.#handlers.size > 0) await Promise.allSettled([...this.#handlers]);
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#handlers.add(promise);
    const done = () => { this.#handlers.delete(promise); };
    promise.then(done, done);
    return promise;
  }

  // ---- reading -----------------------------------------------------------

  eventsAfter(id: SessionId, seq = 0): SessionEvent[] {
    return this.#store.events.after(id, seq);
  }

  hasSession(id: SessionId): boolean {
    return this.#store.sessions.get(id) !== undefined;
  }

  sessionSummary(id: SessionId): SessionSummary | undefined {
    return this.sessionDetail(id);
  }

  sessionDetail(id: SessionId): SessionDetail | undefined {
    const row = this.#store.sessions.get(id);
    if (!row) return undefined;
    const events = this.#store.events.after(id);
    const phase = row.status as SessionPhase;
    const state = foldState(events, phase);
    return {
      id: row.id, project: row.project, ticket: row.ticket, role: row.role, harness: row.harness, model: row.model,
      phase, status: state.status, startedAt: row.createdAt, updatedAt: row.updatedAt, lastSeq: events.at(-1)?.seq ?? 0, state,
    };
  }

  sessions(): SessionSummary[] {
    return this.#store.sessions.list().map((row) => this.sessionDetail(row.id) as SessionDetail);
  }

  // The server-sent stream's listener: wait() resolves when the session
  // has a new event, after `ms`, or when the watcher is closed.
  watch(id: SessionId): Watcher {
    let wake = () => {};
    const entry = { wake: () => wake() };
    const set = this.#watchers.get(id) ?? new Set();
    set.add(entry);
    this.#watchers.set(id, set);
    return {
      wait: (ms) => new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => { clearTimeout(timer); resolve(); };
      }),
      close: () => {
        wake();
        set.delete(entry);
        if (set.size === 0) this.#watchers.delete(id);
      },
    };
  }

  watchers(id: SessionId): number {
    return this.#watchers.get(id)?.size ?? 0;
  }

  #notify(id: SessionId): void {
    for (const watcher of this.#watchers.get(id) ?? []) watcher.wake();
  }

  isActive(ticket: TicketId): boolean {
    return this.#active.has(ticket);
  }

  // ---- journal -----------------------------------------------------------

  #journal(session: { readonly id: SessionId; readonly ticket: string; readonly project: string }, event: AgUiEvent, at: Date = this.#now()): void {
    this.#store.events.append({ at: at.toISOString(), sessionId: session.id, ticket: session.ticket, project: session.project, event });
    this.#notify(session.id);
  }

  #step(session: { readonly id: SessionId; readonly ticket: string; readonly project: string }, type: 'STEP_STARTED' | 'STEP_FINISHED', stepName: StepName, at?: Date): void {
    this.#journal(session, { type, stepName }, at);
  }

  #snapshot(id: SessionId, ticket: string): void {
    const row = this.#store.sessions.get(id);
    if (!row) return;
    this.#journal({ id, ticket, project: row.project }, { type: 'STATE_SNAPSHOT', snapshot: foldState(this.#store.events.after(id), row.status as SessionPhase) });
  }

  #setPhase(live: Live, phase: SessionPhase): void {
    const row = this.#store.sessions.get(live.id);
    if (row) this.#store.sessions.put({ ...row, status: phase, updatedAt: this.#now().toISOString() });
  }

  #flowOf(ticket: TicketId): Set<SessionId> {
    let sessions = this.#flows.get(ticket);
    if (!sessions) this.#flows.set(ticket, (sessions = new Set()));
    return sessions;
  }

  // The sessions of the ticket's current flow: a ticket put back and started
  // again by a person begins again at round 1, with nothing of the old flow.
  #flowRows(ticket: TicketId) {
    const mine = this.#flowOf(ticket);
    return this.#store.sessions.list({ ticket }).filter((row) => mine.has(row.id));
  }

  #lastSession(ticket: TicketId, role: Role): { id: SessionId; ticket: string; project: string } | undefined {
    const row = this.#flowRows(ticket).filter((r) => r.role === role).at(-1);
    return row ? { id: row.id, ticket: row.ticket, project: row.project } : undefined;
  }

  // ---- starting a ticket --------------------------------------------------

  // Starts the flow of a ticket in Todo: the workspace, then the author.
  // The caller is a person (the API routes): the service moving a ticket to
  // Todo itself, when it puts one back, never starts anything.
  async start(ticketId: TicketId, by: UserId): Promise<void> {
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(ticketId);
    if (!ticket) throw new FlowError('not_found', `unknown ticket ${ticketId}`);
    if (ticket.project !== this.config.project) throw new FlowError('invalid', `ticket ${ticketId} belongs to project ${ticket.project ?? 'none'}, and this service runs ${this.config.project}`);
    if (this.#active.has(ticketId)) throw new FlowError('conflict', `ticket ${ticketId} already runs`);
    if (ticket.status !== tickets.states.todo) throw new FlowError('conflict', `ticket ${ticketId} is in ${ticket.status}: only a ticket in ${tickets.states.todo} starts`);
    const adapter = this.registry.sessionAdapters[HARNESS];
    if (!adapter) throw new FlowError('unavailable', `no adapter for ${HARNESS} is registered`);
    this.#active.add(ticketId);
    this.#flows.set(ticketId, new Set());
    const began = this.#now();
    try {
      await tickets.move(ticketId, tickets.states.progress, SERVICE);
      const settings = await this.#effects.settings();
      const prepared = await this.#effects.prepareWorkdir({ ticket, role: 'author' });
      const workspaceDone = this.#now();
      const live = await this.#launch(adapter, ticket, 'author', this.config.authorModel, prepared.workdir, prepared.briefing, settings, authorPrompt(ticket));
      const session = { id: live.id, ticket: ticketId, project: this.config.project };
      this.#step(session, 'STEP_STARTED', 'workspace', began);
      this.#step(session, 'STEP_FINISHED', 'workspace', workspaceDone);
      this.#step(session, 'STEP_STARTED', 'author', workspaceDone);
      this.#snapshot(live.id, ticketId);
      await tickets.comment(ticketId, `Started by ${by}.`, SERVICE).catch(() => undefined);
      this.#supervise(live, 0);
    } catch (error) {
      this.#active.delete(ticketId);
      await tickets.comment(ticketId, this.#clean(`The flow could not start: ${name(error)}`), SERVICE).catch(() => undefined);
      await tickets.move(ticketId, tickets.states.todo, SERVICE).catch(() => undefined);
      throw error;
    }
  }

  // start() in the background, for the routes: a person's click does not
  // wait for a clone. A failure becomes a note on the ticket (start wrote it).
  begin(ticketId: TicketId, by: UserId): Promise<void> {
    return this.#track(this.start(ticketId, by).catch(() => undefined));
  }

  async #launch(adapter: SessionAdapter, ticket: Ticket, role: Role, model: string, workdir: string, briefing: Briefing, settings: ProjectSettings, prompt: string): Promise<Live> {
    const input: StartInput = {
      project: this.config.project, ticket: ticket.id, role, harness: HARNESS, model, workdir, briefing,
      policy: this.#policy(role, settings), prompt, services: settings.services,
    };
    const handle = await adapter.start(input);
    const at = this.#now().toISOString();
    this.#store.sessions.put({ id: handle.id, project: input.project, ticket: ticket.id, role, harness: HARNESS, model, status: role === 'reviewer' ? 'reviewing' : 'working', createdAt: at, updatedAt: at });
    const live: Live = { id: handle.id, input, settings, handle, lastActivity: this.#now().getTime(), closed: false, waitOpen: false };
    this.#live.set(live.id, live);
    this.#inputs.set(live.id, { input, settings });
    this.#flowOf(ticket.id).add(live.id);
    return live;
  }

  #policy(role: Role, settings: ProjectSettings): Policy {
    return {
      role, base: this.config.base, workdir: WORKDIR_MOUNT, scripts: settings.scripts, credentialFile: LOGIN_FILE_MOUNT,
      safeCommands: [...DEFAULT_SAFE_COMMANDS, ...settings.safeCommands], allowedHosts: settings.hosts, forbiddenHosts: [],
      ticketFiles: [], learned: this.#store.policyRules.learned(this.config.project),
    };
  }

  // ---- watching a session -------------------------------------------------

  #supervise(live: Live, after: number): void {
    const run = (async () => {
      try {
        for await (const event of live.handle.events(after)) {
          if (live.closed) break;
          live.lastActivity = this.#now().getTime();
          this.#notify(live.id);
          await this.#track(this.#onEvent(live, event).catch(async (error) => {
            await this.#stopTicket(live, 'error', `The flow failed: ${name(error)}`, `The flow failed on this ticket: ${name(error)}`).catch(() => undefined);
          }));
        }
        if (!live.closed) await this.#stopTicket(live, 'error', 'The session ended without finishing its turn.', 'The session ended without finishing its turn.', 'failed');
      } catch (error) {
        if (!live.closed) await this.#stopTicket(live, 'error', `The session's stream failed: ${name(error)}`, `The session's stream failed: ${name(error)}`, 'failed').catch(() => undefined);
      }
    })();
    void run;
  }

  async #onEvent(live: Live, stored: SessionEvent): Promise<void> {
    const event = stored.event;
    const session = { id: live.id, ticket: live.input.ticket, project: live.input.project };
    if (event.type === 'CUSTOM') {
      switch (event.name) {
        case 'cleared.permission_request':
          this.inbox.addPermission({ ticket: session.ticket, project: session.project, sessionId: live.id, requestId: event.value.requestId, tool: event.value.tool, input: event.value.input, suggestion: event.value.suggestion });
          this.#waitStarts(live);
          return;
        case 'cleared.question':
          this.inbox.addQuestion({ ticket: session.ticket, project: session.project, sessionId: live.id, requestId: event.value.requestId, questions: event.value.questions });
          this.#waitStarts(live);
          return;
        case 'cleared.permission_answered':
        case 'cleared.answered': {
          // A request the inbox never saw (a policy deny the adapter reports alone) is ignored.
          const item = this.inbox.find(live.id, event.value.requestId);
          if (item) this.inbox.handle(item.id, event.value.by);
          this.#waitEnds(live);
          return;
        }
        default:
          return;
      }
    }
    if (event.type === 'RUN_ERROR') {
      await this.#stopTicket(live, undefined, undefined, `The session failed: ${event.message}`, 'failed');
      return;
    }
    if (event.type !== 'RUN_FINISHED') return;

    const budget = this.config.budgetUsd;
    const spent = this.#spent(session.ticket);
    if (budget !== undefined && spent > budget) {
      await this.#stopTicket(live, 'budget', `The ticket's budget of $${budget} is spent.`,
        `The ticket's budget of $${budget} is spent ($${spent.toFixed(2)}). The sessions were stopped. Raise the budget or reduce the ticket, then move it to Todo.`);
      return;
    }
    if (event.outcome.type === 'cancelled') {
      this.#setPhase(live, 'waiting_human');
      return;
    }
    if (event.result.stopReason !== 'end_turn') {
      await this.#stopTicket(live, undefined, undefined, `The session stopped with "${event.result.stopReason}" before it finished.`, 'failed');
      return;
    }
    // A turn that ends while the inbox still holds a request of this session is not the end of the work.
    if (this.inbox.waitingFor(live.id) > 0) return;
    if (live.input.role === 'author') await this.#authorDone(live);
    else if (live.input.role === 'reviewer') await this.#reviewDone(live);
  }

  #spent(ticket: TicketId): number {
    let total = 0;
    for (const row of this.#store.sessions.list({ ticket }))
      for (const { event } of this.#store.events.after(row.id)) if (event.type === 'RUN_FINISHED') total += event.result.total_cost_usd ?? 0;
    return total;
  }

  #waitStarts(live: Live): void {
    if (!live.waitOpen) {
      live.waitOpen = true;
      this.#step({ id: live.id, ticket: live.input.ticket, project: live.input.project }, 'STEP_STARTED', 'waiting_human');
    }
    this.#setPhase(live, 'waiting_human');
    this.#snapshot(live.id, live.input.ticket);
  }

  #waitEnds(live: Live): void {
    if (this.inbox.waitingFor(live.id) > 0 || !live.waitOpen) return;
    live.lastActivity = this.#now().getTime();
    live.waitOpen = false;
    this.#step({ id: live.id, ticket: live.input.ticket, project: live.input.project }, 'STEP_FINISHED', 'waiting_human');
    this.#setPhase(live, live.input.role === 'reviewer' ? 'reviewing' : 'working');
    this.#snapshot(live.id, live.input.ticket);
  }

  // ---- ending a session ---------------------------------------------------

  async #close(live: Live, phase: 'done' | 'stopped' | 'failed'): Promise<void> {
    if (live.closed) return;
    live.closed = true;
    this.#live.delete(live.id);
    if (live.waitOpen) {
      live.waitOpen = false;
      this.#step({ id: live.id, ticket: live.input.ticket, project: live.input.project }, 'STEP_FINISHED', 'waiting_human');
    }
    this.#setPhase(live, phase);
    this.inbox.handleSession(live.id, 'system');
    await live.handle.stop().catch(() => undefined);
    this.#notify(live.id);
  }

  // The ticket cannot go on: every live session of it stops, the reason is
  // written to the session and to the ticket, and the ticket goes back to
  // Todo. `code` is the RUN_ERROR code the session screen shows; undefined
  // when the adapter already wrote its own RUN_ERROR.
  async #stopTicket(from: Live, code: string | undefined, runMessage: string | undefined, note: string, phase: 'stopped' | 'failed' = 'stopped'): Promise<void> {
    const ticket = from.input.ticket;
    for (const live of [...this.#live.values()].filter((l) => l.input.ticket === ticket)) {
      if (live.closed) continue;
      if (code !== undefined && runMessage !== undefined)
        this.#journal({ id: live.id, ticket, project: live.input.project }, { type: 'RUN_ERROR', message: this.#clean(runMessage), code });
      await this.#close(live, live.id === from.id ? phase : 'stopped');
    }
    await this.#putBack(ticket, note);
  }

  async #putBack(ticket: TicketId, note: string): Promise<void> {
    const tickets = this.registry.ticketStore;
    this.#active.delete(ticket);
    await tickets.comment(ticket, this.#clean(note), SERVICE).catch(() => undefined);
    await tickets.move(ticket, tickets.states.todo, SERVICE).catch(() => undefined);
  }

  // ---- the author is done: the review starts ------------------------------

  async #authorDone(author: Live): Promise<void> {
    const { ticket: id, project } = author.input;
    const session = { id: author.id, ticket: id, project };
    this.#step(session, 'STEP_FINISHED', 'author');
    await this.#close(author, 'done');
    try {
      await this.#effects.captureHandover({ workdir: author.input.workdir, role: 'author', model: author.input.model, ticket: id, sessionId: author.id });
    } catch (error) {
      await this.registry.ticketStore.comment(id, this.#clean(`The author's handover could not be stored: ${name(error)}`), SERVICE).catch(() => undefined);
    }
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(id);
    if (!ticket) return;
    await tickets.move(id, tickets.states.review, SERVICE);
    await this.#startReview(ticket, author.input.workdir);
  }

  async #startReview(ticket: Ticket, workdir: string): Promise<void> {
    const adapter = this.registry.sessionAdapters[HARNESS];
    const began = this.#now();
    try {
      if (!adapter) throw new FlowError('unavailable', `no adapter for ${HARNESS} is registered`);
      const settings = await this.#effects.settings();
      const prepared = await this.#effects.prepareWorkdir({ ticket, role: 'reviewer' });
      const live = await this.#launch(adapter, ticket, 'reviewer', this.config.reviewerModel, prepared.workdir || workdir, prepared.briefing, settings,
        reviewPrompt({ ticket, base: this.config.base, verdict: settings.verdict }));
      this.#step({ id: live.id, ticket: ticket.id, project: ticket.project ?? this.config.project }, 'STEP_STARTED', 'review', began);
      this.#snapshot(live.id, ticket.id);
      this.#supervise(live, 0);
    } catch (error) {
      await this.#putBack(ticket.id, `The review could not start: ${name(error)}`);
    }
  }

  // ---- the reviewer is done: verdict ---------------------------------------

  async #reviewDone(reviewer: Live): Promise<void> {
    const { ticket: id, project } = reviewer.input;
    const session = { id: reviewer.id, ticket: id, project };
    const report = lastReport(this.#store.events.after(reviewer.id));
    const parsed = report === undefined ? undefined : parseVerdict(report, reviewer.settings.verdict);
    this.#step(session, 'STEP_FINISHED', 'review');
    await this.#close(reviewer, 'done');
    if (report === undefined || parsed === undefined) {
      await this.#putBack(id, 'The review gave no verdict (no "Verdict:" line in its report), so nothing was published. Move the ticket to Todo to run it again.');
      return;
    }
    const round = this.#flowRows(id).filter((row) => row.role === 'reviewer').length;
    this.#journal(session, { type: 'CUSTOM', name: 'cleared.review_verdict', value: { session: reviewer.id, verdict: parsed.verdict, round } });
    if (parsed.verdict === 'pass') return this.#publishAndAsk(reviewer, report, round);
    if (round >= this.config.maxReviewRounds) {
      await this.#putBack(id, `The review still asked for changes after ${round} review rounds, so the ticket goes back to Todo. The last report:\n\n${report}`);
      return;
    }
    await this.#reopenAuthor(reviewer, report, round);
  }

  async #reopenAuthor(reviewer: Live, report: string, round: number): Promise<void> {
    const id = reviewer.input.ticket;
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(id);
    const authorRow = this.#lastSession(id, 'author');
    const kept = authorRow ? this.#inputs.get(authorRow.id) : undefined;
    const adapter = this.registry.sessionAdapters[HARNESS];
    if (!ticket || !adapter) return this.#putBack(id, 'The author could not be reopened: the ticket or the adapter is gone.');
    await tickets.move(id, tickets.states.progress, SERVICE);
    const message = reviewRequestMessage(report, round);
    const began = this.#now();
    const lastSeq = authorRow ? (this.#store.events.after(authorRow.id).at(-1)?.seq ?? 0) : 0;
    // Reopening is resume, then the request as the next message. Either
    // failing (another process started the session, its container is gone)
    // falls back to a new author below.
    let reopened = false;
    if (authorRow && kept) {
      let handle: SessionHandle | undefined;
      try { handle = await adapter.resume(authorRow.id); } catch { handle = undefined; }
      if (handle) {
        const live: Live = { id: authorRow.id, input: kept.input, settings: kept.settings, handle, lastActivity: this.#now().getTime(), closed: false, waitOpen: false };
        this.#live.set(live.id, live);
        this.#setPhase(live, 'working');
        this.#step({ id: live.id, ticket: id, project: live.input.project }, 'STEP_STARTED', 'author', began);
        this.#supervise(live, lastSeq);
        try {
          await handle.send({ text: message, by: FLOW_USER });
          reopened = true;
        } catch {
          live.closed = true;
          this.#live.delete(live.id);
          await handle.stop().catch(() => undefined);
          this.#setPhase(live, 'done');
        }
      }
    }
    if (reopened) return;
    try {
      const settings = kept?.settings ?? (await this.#effects.settings());
      const prepared = await this.#effects.prepareWorkdir({ ticket, role: 'author' });
      const live = await this.#launch(adapter, ticket, 'author', this.config.authorModel, prepared.workdir, prepared.briefing, settings, `${authorPrompt(ticket)}\n\n${message}`);
      this.#step({ id: live.id, ticket: id, project: live.input.project }, 'STEP_STARTED', 'author', began);
      this.#snapshot(live.id, id);
      this.#supervise(live, 0);
    } catch (error) {
      await this.#putBack(id, `The author could not be reopened after the review: ${name(error)}`);
    }
  }

  // ---- a pass: publish, record, ask the lock -------------------------------

  async #publishAndAsk(reviewer: Live, report: string, round: number): Promise<void> {
    const { ticket: id, project, workdir, model } = reviewer.input;
    const session = { id: reviewer.id, ticket: id, project };
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(id);
    if (!ticket) return;
    this.#step(session, 'STEP_STARTED', 'release');
    let published: Published;
    try {
      // The project checkout is fetched first: publish reads the base as the
      // checkout last saw it (issue 141).
      await this.#effects.refreshProject();
      published = await this.#effects.publish({ ticket: id, workdir, branch: ticketBranch(id), report });
    } catch (error) {
      this.#step(session, 'STEP_FINISHED', 'release');
      await this.#putBack(id, `The branch was not published: ${name(error)}`);
      return;
    }
    const reviewedAt = this.#now().toISOString();
    const announcement = [
      `Ticket ${id}: ${ticket.title}`,
      '',
      `Pull request: ${published.url}`,
      `Reviewed by ${model} in ${round} round${round === 1 ? '' : 's'}: ${report.split('\n').filter((line) => /verdict\s*:/i.test(line)).at(-1)?.trim() ?? 'passed'}`,
    ].join('\n');
    let requestedAt: string;
    try {
      await this.registry.reviewRecorder.record({ ticket: id, pr: published.number, session: reviewer.id, model, verdict: 'pass', round, report, at: reviewedAt });
      const asked = await this.#effects.requestRelease({ ticket: id, pr: published.number, announcement });
      // The real lock moves the card itself when it asks; a store it did not move gets the move here.
      if ((await tickets.history(id)).at(-1)?.status !== tickets.states.validate) await tickets.move(id, tickets.states.validate, SERVICE);
      // The approval is bound to the request time the lock recorded (the approval route
      // compares with it); without one, the time the ticket store holds for the move.
      requestedAt = asked.requestedAt ?? (await tickets.history(id)).at(-1)?.at ?? this.#now().toISOString();
    } catch (error) {
      this.#step(session, 'STEP_FINISHED', 'release');
      await this.#putBack(id, `The release could not be requested: ${name(error)}`);
      return;
    }
    for (const old of this.inbox.waitingReleases().filter((item) => item.ticket === id)) this.#settleRelease(old.id, id, project, 'system');
    this.inbox.addRelease({
      ticket: id, project, title: ticket.title, announcement, requestedAt,
      pr: { number: published.number, url: published.url, checks: 'pending' },
      heads: [{ pr: published.number, head: published.head }],
      captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } },
      sessions: this.#releaseSessions(id, round),
    }, reviewer.id);
    // The lock has the request: the flow is over. What follows is the human's, and a person
    // may send the ticket back from the inbox, which starts a new flow.
    this.#active.delete(id);
    this.#step(session, 'STEP_FINISHED', 'release');
    this.#step(session, 'STEP_STARTED', 'approval');
  }

  #releaseSessions(ticket: TicketId, rounds: number): { role: Role; model: string; minutes: number; rounds?: number }[] {
    const out = new Map<Role, { role: Role; model: string; minutes: number; rounds?: number }>();
    for (const row of this.#flowRows(ticket)) {
      const minutes = Math.max(0, Math.round((Date.parse(row.updatedAt) - Date.parse(row.createdAt)) / 60_000));
      const entry = out.get(row.role) ?? { role: row.role, model: row.model, minutes: 0 };
      out.set(row.role, { ...entry, model: row.model, minutes: entry.minutes + minutes, ...(row.role === 'reviewer' ? { rounds } : {}) });
    }
    return ['author', 'reviewer'].flatMap((role) => out.get(role as Role) ?? []);
  }

  // ---- what a person does --------------------------------------------------

  #liveSession(id: SessionId): Live {
    const live = this.#live.get(id);
    if (live) return live;
    if (this.#store.sessions.get(id)) throw new FlowError('conflict', `session ${id} is stopped: it is not running any more`);
    throw new FlowError('not_found', `unknown session ${id}`);
  }

  async send(id: SessionId, text: string, by: UserId): Promise<void> {
    const live = this.#liveSession(id);
    live.lastActivity = this.#now().getTime();
    await live.handle.send({ text, by });
    if (this.#store.sessions.get(id)?.status === 'waiting_human' && this.inbox.waitingFor(id) === 0) this.#setPhase(live, live.input.role === 'reviewer' ? 'reviewing' : 'working');
  }

  async answer(id: SessionId, requestId: string, decision: Decision, by: UserId): Promise<void> {
    const live = this.#liveSession(id);
    const item = this.inbox.find(id, requestId);
    if (!item || item.state !== 'waiting') throw new FlowError('not_found', `no request ${requestId} is waiting in session ${id}`);
    const asks = item.kind === 'question';
    if (asks !== (decision.kind === 'answer')) throw new FlowError('invalid', asks ? 'a question is answered with an answer' : 'a permission request is answered with allow or reject');
    const answer: Answer = { decision, by };
    await live.handle.answer(requestId, answer);
    this.inbox.handle(item.id, by);
    if (decision.kind === 'allow_always' && item.kind === 'permission') {
      const pattern = patternOf(item);
      if (pattern) this.#store.policyRules.learn({ project: item.project, tool: item.tool, pattern, by, at: this.#now().toISOString() });
    }
    this.#waitEnds(live);
  }

  async interrupt(id: SessionId): Promise<void> {
    await this.#liveSession(id).handle.interrupt();
  }
}
