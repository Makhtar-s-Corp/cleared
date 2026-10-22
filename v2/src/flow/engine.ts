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
// After the approval (docs/v2/milestone-2-plan.md, decision 12) the tick
// follows the landing: a merge the lock queued is asked again every
// CLEARED_V2_MERGE_RETRY_SECONDS, the `watch` step runs from the merge to
// the release watch's verdict (read from the ledger, ledger.ts), and a
// landed ticket is Done. A new engine stops what the last process left
// running (recover). Everything that happens is said on the event bus
// (events.ts, subscribe), after it is written.
//
// Where the steps are filed: the events of a session belong to that
// session, so `workspace`, `author` and `waiting_human` go to the author's,
// `review`, `release` and `approval` to the reviewer's (the last session of
// the ticket), and `watch` with them. `workspace` is written after the
// adapter has started the session, with the time it began, because the
// session's id does not exist before.
//
// A ticket of a workspace of several services (docs/v2/milestone-2-plan.md,
// decision 21, lane 16) has a checkout per service it touches, under
// <workdirs>/<ticket>/<service>, the author working in the first one's; a
// pass publishes one pull request per service on the same branch, records
// the review and asks the approval on each service's own lock, and the
// release item carries the train, which release/train.ts lands. A ticket of
// a one-service workspace runs as in milestone 1.
import { posix } from 'node:path';
import type { PermissionItem, ReleaseItem, SessionDetail, SessionSummary } from '../api/types.ts';
import { LOGIN_FILE_MOUNT, WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { InboxStore } from '../inbox/store.ts';
import type { Registry } from '../modules/registry.ts';
import type { Answer, Briefing, Decision, Role, SessionAdapter, SessionHandle, SessionId, StartInput, UserId } from '../session/contract.ts';
import { readToolInput, readToolOutput, type AgUiEvent, type SessionEvent, type SessionPhase, type StepName } from '../session/events.ts';
import { DEFAULT_SAFE_COMMANDS, type Policy } from '../session/policy.ts';
import type { Store } from '../store/db.ts';
import type { Actor, Ticket, TicketId } from '../tickets/contract.ts';
import { ticketBranch } from '../workspace/checkout.ts';
import type { Published } from '../workspace/publish.ts';
import { serviceLocks } from '../approval/service.ts';
import { changesReport, flags } from '../release/flags.ts';
import { reviewRun, type MergeOutcome, type ServiceLock } from '../release/lock.ts';
import { compatibility, landingOrder } from '../release/order.ts';
import { TrainStore, view, type Stop } from '../release/store.ts';
import { TrainRunner } from '../release/train.ts';
import type { ServiceConfig, WorkspaceConfig } from '../workspace/config.ts';
import { workspaceOf, type FlowConfig, type ProjectSettings } from './config.ts';
import type { FlowEvent, FlowListener, Origin, PutBackReason } from './events.ts';
import { atOrAfter, landingOf, type Landing } from './ledger.ts';
import { authorPrompt, lastReport, parseVerdict, reviewPrompt, reviewRequestMessage } from './prompts.ts';
import { foldState } from './state.ts';

export type { ProjectSettings } from './config.ts';
export type { FlowEvent, FlowListener, Origin, PutBackReason } from './events.ts';
// What the lock answered a merge (effects.ts mergeRelease, release/lock.ts).
export type { MergeOutcome } from '../release/lock.ts';

// What the flow does outside this process. `service` names the service of
// a workspace of several the call is for; absent, the one-service
// workspace's (its first service, which the milestone 1 fields name).
export type FlowEffects = {
  settings(service?: ServiceConfig): Promise<ProjectSettings>;    // the service's settings at its base branch
  refreshProject(service?: ServiceConfig): Promise<void>;         // projectCheckout: fetch the forge, so publish sees the base as it is now (issue 141)
  // The ticket's checkout: <workdirs>/<ticket>, or <workdirs>/<ticket>/<service> for a service of a workspace of several.
  prepareWorkdir(input: { readonly ticket: Ticket; readonly role: Role; readonly service?: ServiceConfig }): Promise<{ readonly workdir: string; readonly briefing: Briefing }>;
  captureHandover(input: { readonly workdir: string; readonly role: Role; readonly model: string; readonly ticket: TicketId; readonly sessionId: SessionId }): Promise<string | null>;
  publish(input: { readonly ticket: TicketId; readonly workdir: string; readonly branch: string; readonly report: string; readonly service?: ServiceConfig }): Promise<Published>;
  // The lock's `--ask` request; the request time the lock recorded, when it says one.
  requestRelease(input: { readonly ticket: TicketId; readonly pr: number; readonly announcement: string }): Promise<{ readonly requestedAt?: string }>;
  prChecks(pr: number, service?: ServiceConfig): Promise<ReleaseItem['pr']['checks']>;   // the pull request's checks on the forge now
  // The lock's merge (`request_release` without --ask), after the human's approval.
  mergeRelease(input: { readonly ticket: TicketId; readonly pr: number; readonly announcement: string }): Promise<MergeOutcome>;
  // What a published head changes against the base: its files, and the diff
  // the release card's flags are read from (release/flags.ts). Absent: none.
  changes?(input: { readonly ticket: TicketId; readonly head: string; readonly service?: ServiceConfig }): Promise<{ readonly files: readonly string[]; readonly diff: string }>;
};

export type FlowDeps = {
  readonly store: Pick<Store, 'db' | 'events' | 'sessions' | 'policyRules'>;
  readonly inbox: InboxStore;
  readonly registry: Registry;
  readonly config: FlowConfig;
  readonly effects: FlowEffects;
  readonly now?: () => Date;
  // Applied to every text the flow writes to a ticket or a session from an
  // error (paths, tokens): the cleaner of the service. Identity by default.
  readonly clean?: (text: string) => string;
  // The lock of each service of a workspace of several (release/lock.ts):
  // its broker, its validations, its review reports. Built from the
  // environment when absent (approval/service.ts serviceLocks).
  readonly locks?: (service: ServiceConfig) => ServiceLock;
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
// Decision 15 of milestone 2: a plan item the lead puts in the fast lane is
// a ticket with this label, and its author is Haiku (unless Haiku reviews).
export const QUICK_LABEL = 'Quick';
export const QUICK_MODEL = 'claude-haiku-5-5';
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

// A release the tick follows from the approval to its landing.
// `inFlight`: a call to the lock, or the ticket's move at the end, is running.
// `refused`: the lock refused the merge for good; what is left is the put back.
type Following = { nextAttempt: number; inFlight: boolean; mergedAt?: string; refused?: string };
type Candidate = {
  readonly item: string; readonly ticket: TicketId; readonly status: string; readonly session: SessionId;
  readonly pr: number; readonly announcement: string; readonly since: string;
};

const LIVE_PHASES: ReadonlySet<string> = new Set(['starting', 'working', 'waiting_human', 'reviewing']);
const CHECKS_MS = 60_000;                                           // the forge is asked for a release's checks at most this often
const LANDING_HORIZON_MS = 2 * 24 * 3600_000;                       // a Done ticket's release is followed for so long after its approval

// A path the ticket changed, relative to the workdir; undefined outside it.
function ticketPath(path: string): string | undefined {
  const rel = posix.isAbsolute(path) ? posix.relative(WORKDIR_MOUNT, path) : posix.normalize(path);
  return rel === '' || rel === '.' || rel.startsWith('..') || posix.isAbsolute(rel) ? undefined : rel;
}

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
  #listeners = new Set<FlowListener>();
  #following = new Map<string, Following>();                        // by release item
  #landed = new Set<string>();                                      // release items whose watch is closed: final
  #checked = new Map<string, number>();                             // when a release's checks were last read
  #files = new Map<SessionId, { seq: number; open: Map<string, string>; files: string[] }>();
  #workspace: WorkspaceConfig;
  #trains: TrainStore;
  #runner: TrainRunner;
  #locks: ((service: ServiceConfig) => ServiceLock) | undefined;
  #workdirs = new Map<TicketId, Map<string, string>>();             // a train ticket's checkout per service, as prepared

  constructor(deps: FlowDeps) {
    this.registry = deps.registry;
    this.inbox = deps.inbox;
    this.config = deps.config;
    this.#store = deps.store;
    this.#effects = deps.effects;
    this.#now = deps.now ?? (() => new Date());
    this.#clean = deps.clean ?? ((text) => text);
    this.#workspace = workspaceOf(deps.config);
    this.#locks = deps.locks;
    this.#trains = new TrainStore(deps.store.db, this.#now);
    this.#runner = new TrainRunner({
      db: deps.store.db, trains: this.#trains, tickets: this.registry.ticketStore, project: this.config.project, retryMs: this.config.mergeRetryMs,
      lock: (name) => this.#lockOf(this.#service(name)), now: this.#now, clean: this.#clean, emit: (event) => this.#emit(event),
      card: (item, train) => this.inbox.setTrain(item, train), putBack: (ticket, note, reason) => this.#putBack(ticket, note, reason),
      track: (promise) => this.#track(promise),
    });
    // A new engine has no live session: requests left by the last process are closed.
    this.inbox.handleRequests('system');
  }

  // ---- the workspace's services -----------------------------------------------

  // True when the workspace has several services: its tickets land as trains.
  get #several(): boolean {
    return this.#workspace.services.length > 1;
  }

  #service(name: string): ServiceConfig {
    const service = this.#workspace.services.find((s) => s.name === name);
    if (!service) throw new FlowError('invalid', `${name} is not a service of workspace ${this.#workspace.id}`);
    return service;
  }

  // The services a ticket touches, in the order it names them; a ticket that
  // names none is on the workspace's first service.
  #servicesOf(ticket: Ticket): ServiceConfig[] {
    const named = (ticket.services ?? []).map((s) => this.#service(s.name));
    return named.length > 0 ? named : [this.#workspace.services[0] as ServiceConfig];
  }

  #lockOf(service: ServiceConfig): ServiceLock {
    this.#locks ??= serviceLocks(this.#store.db, this.#workspace);
    return this.#locks(service);
  }

  // The checkouts of a ticket: one per service of a train ticket, the
  // author and the reviewer working in the first one's.
  async #prepare(ticket: Ticket, role: Role): Promise<{ readonly workdir: string; readonly briefing: Briefing }> {
    if (!this.#several) return this.#effects.prepareWorkdir({ ticket, role });
    const services = this.#servicesOf(ticket);
    const workdirs = this.#workdirs.get(ticket.id) ?? new Map<string, string>();
    this.#workdirs.set(ticket.id, workdirs);
    let first: { readonly workdir: string; readonly briefing: Briefing } | undefined;
    for (const service of services) {
      const prepared = await this.#effects.prepareWorkdir({ ticket, role, service });
      workdirs.set(service.name, prepared.workdir);
      first ??= prepared;
    }
    return first as { readonly workdir: string; readonly briefing: Briefing };
  }

  async #settings(ticket: Ticket): Promise<ProjectSettings> {
    return this.#several ? this.#effects.settings(this.#servicesOf(ticket)[0]) : this.#effects.settings();
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

  // The idle stop, the notice that a release was approved, and the
  // landing of what was approved. A session that waits for the human is
  // not idle: the request in the inbox would be lost with it, and the wait
  // is the human's.
  async tick(): Promise<void> {
    const now = this.#now().getTime();
    for (const live of [...this.#live.values()]) {
      if (live.closed || this.inbox.waitingFor(live.id) > 0) continue;
      if (now - live.lastActivity < this.config.idleMs) continue;
      const minutes = Math.round(this.config.idleMs / 60_000);
      await this.#stopTicket(live, 'idle', `No activity for ${minutes} minutes: the session was stopped.`,
        `The session stopped after ${minutes} minutes without activity. Move the ticket to Todo to start it again.`, 'stopped', 'idle');
    }
    const tickets = this.registry.ticketStore;
    for (const release of this.inbox.waitingReleases()) {
      const ticket = await tickets.get(release.ticket);
      if (ticket && ticket.status === tickets.states.validate) {
        // The card says whether the checks are green: the lock queues a
        // release whose checks still run, so the owner waits for them.
        // Asked once a minute per release, not at every tick (issue 157).
        if (now - (this.#checked.get(release.id) ?? -Infinity) < CHECKS_MS) continue;
        this.#checked.set(release.id, now);
        const checks = await this.#checksOf(release);
        if (checks && checks !== release.pr.checks) this.inbox.setReleaseChecks(release.id, checks);
        continue;
      }
      this.#checked.delete(release.id);
      // The human's move to go since the request, whatever the ticket's
      // state now: the lock may have merged and moved it to Done before
      // this tick.
      const history = ticket ? await tickets.history(ticket.id) : [];
      const approval = history.filter((h) => h.status === tickets.states.go && h.by.kind === 'human' && atOrAfter(h.at, release.requestedAt)).at(-1);
      const by = history.at(-1)?.by;
      const approvedBy = approval?.by.id;
      if (this.#settleRelease(release.id, release.ticket, release.project, approvedBy ?? (by?.kind === 'human' ? by.id : 'system')) && approvedBy)
        this.#emit({ type: 'release_approved', at: this.#at(), project: release.project, ticket: release.ticket, item: release.id, pr: release.pr.number, by: approvedBy });
    }
    for (const candidate of await this.#landings()) this.#follow(candidate);
    this.#runner.tick();
  }

  // A release's checks; a train's are failed when one service's are, else
  // pending while one service's are.
  async #checksOf(release: ReleaseItem): Promise<ReleaseItem['pr']['checks'] | undefined> {
    const read = (pr: number, service?: ServiceConfig) => this.#effects.prChecks(pr, service).catch((error: unknown) => {
      console.error(`cleared-v2: the checks of pull request #${pr} could not be read (${error instanceof Error ? error.name : typeof error})`);
      return undefined;
    });
    if (!release.train) return read(release.pr.number);
    const all: (ReleaseItem['pr']['checks'] | undefined)[] = [];
    for (const stop of release.train.services) {
      const service = this.#workspace.services.find((s) => s.name === stop.service);
      if (stop.pr) all.push(service ? await read(stop.pr.number, service) : undefined);
    }
    if (all.includes(undefined)) return undefined;
    return all.includes('failed') ? 'failed' : all.includes('pending') ? 'pending' : 'passed';
  }

  // A release item ends when its approval does, or when a newer one replaces
  // it: its approval step closes on the session it started on.
  #settleRelease(id: string, ticket: TicketId, project: string, by: UserId | 'system'): boolean {
    if (!this.inbox.handle(id, by)) return false;
    const sessionId = this.inbox.releaseSession(id);
    if (!sessionId) return true;
    this.#step({ id: sessionId, ticket, project }, 'STEP_FINISHED', 'approval');
    this.#snapshot(sessionId, ticket);
    return true;
  }

  // ---- the landing ---------------------------------------------------------

  // The releases to follow: the last release item of each ticket in the go
  // state, and of each ticket the lock already put in Done (merge-pr.sh does
  // at the merge, before the watch has said anything) if it was approved
  // within the horizon. Read from the tables at every tick, so that a new
  // engine goes on where the last one stopped; the `watch` step on the
  // release's session says how far it went.
  async #landings(): Promise<Candidate[]> {
    const tickets = this.registry.ticketStore;
    const project = this.config.project;
    const latest = new Map<TicketId, Record<string, unknown>>();
    const since = new Date(this.#now().getTime() - LANDING_HORIZON_MS).toISOString();
    const recent = this.#store.db.prepare("SELECT * FROM flow_inbox WHERE kind = 'release' AND project = ? AND state = 'handled' AND handled_at > ? ORDER BY since, id").all(project, since) as Record<string, unknown>[];
    for (const row of recent) latest.set(String(row.ticket), row);
    const last = this.#store.db.prepare("SELECT * FROM flow_inbox WHERE kind = 'release' AND ticket = ? AND state = 'handled' ORDER BY since DESC, id DESC LIMIT 1");
    for (const ticket of await tickets.list({ status: tickets.states.go, project })) {
      const row = last.get(ticket.id) as Record<string, unknown> | undefined;
      if (row) latest.set(ticket.id, row);
    }
    const out: Candidate[] = [];
    for (const [id, row] of latest) {
      if (this.#trains.has(String(row.id))) continue;              // a train lands through release/train.ts
      const ticket = await tickets.get(id);
      if (!ticket || (ticket.status !== tickets.states.go && ticket.status !== tickets.states.done)) continue;
      const approval = (await tickets.history(id)).filter((h) => h.status === tickets.states.go && h.by.kind === 'human').at(-1);
      const session = String(row.request_id);
      if (!approval || !session) continue;
      const payload = JSON.parse(String(row.payload)) as Pick<ReleaseItem, 'pr' | 'announcement'>;
      out.push({ item: String(row.id), ticket: id, status: ticket.status, session, pr: payload.pr.number, announcement: payload.announcement, since: approval.at });
    }
    return out;
  }

  // One step of a release's landing. Everything up to the journal is
  // synchronous, and `inFlight` covers what is not, so two calls never ask
  // the lock, open or close the watch twice.
  #follow(c: Candidate): void {
    if (this.#landed.has(c.item)) return;
    const tickets = this.registry.ticketStore;
    const steps = this.#store.events.after(c.session).flatMap(({ event }) => (event.type === 'STEP_STARTED' || event.type === 'STEP_FINISHED') && event.stepName === 'watch' ? [event.type] : []);
    if (steps.includes('STEP_FINISHED')) {
      this.#following.delete(c.item);
      this.#landed.add(c.item);
      return;
    }
    let state = this.#following.get(c.item);
    if (!state) this.#following.set(c.item, (state = { nextAttempt: this.#now().getTime() + this.config.mergeRetryMs, inFlight: false }));
    if (state.inFlight) return;
    if (state.refused !== undefined) {
      // A put back that failed is made again; the lock is not asked again.
      const refused = state.refused;
      state.inFlight = true;
      void this.#track(this.#putBack(c.ticket, refused, 'merge_refused').then((moved) => {
        state.inFlight = false;
        if (moved) this.#following.delete(c.item);
      }));
      return;
    }
    const landing = landingOf(this.#store.db, { ticket: c.ticket, pr: c.pr, since: c.since, ...(state.mergedAt ? { mergedHere: state.mergedAt } : {}) });
    if (landing.state === 'waiting') {
      // Lane 8's approval asks the lock first; the flow asks again one
      // interval after it first saw the approval, then at every interval.
      if (steps.length > 0 || c.status !== tickets.states.go || this.#now().getTime() < state.nextAttempt) return;
      state.inFlight = true;
      void this.#track(this.#merge(c, state));
      return;
    }
    const session = { id: c.session, ticket: c.ticket, project: this.config.project };
    if (steps.length === 0) {
      this.#step(session, 'STEP_STARTED', 'watch', new Date(landing.mergedAt));
      this.#snapshot(c.session, c.ticket);
      this.#emit({ type: 'release_merged', at: landing.mergedAt, project: this.config.project, ticket: c.ticket, pr: c.pr });
    }
    if (landing.state === 'merged') return;
    state.inFlight = true;
    void this.#track(this.#settleLanding(c, landing).then((closed) => {
      state.inFlight = false;
      if (closed) {
        this.#following.delete(c.item);
        this.#landed.add(c.item);
      }
    }));
  }

  // The end of a landing: the ticket's move first, then the `watch` step
  // and the events. A read or a move that fails leaves the watch open, so the next
  // tick makes it again (the ticket stays a candidate while it is in go or
  // Done). True when the landing is closed.
  async #settleLanding(c: Candidate, landing: Extract<Landing, { at: string }>): Promise<boolean> {
    const tickets = this.registry.ticketStore;
    const base = { at: landing.at, project: this.config.project, ticket: c.ticket, pr: c.pr };
    try {
      // A read that fails is retried like a move; a ticket that is gone has nothing to move.
      const status = (await tickets.get(c.ticket))?.status;
      if (landing.state === 'landed') {
        // merge-pr.sh moves the card to Done when every shown pull request is merged; the flow does when it did not.
        if (status === tickets.states.go) await tickets.move(c.ticket, tickets.states.done, SERVICE);
      } else if (landing.state === 'rolled_back') {
        if (status === tickets.states.go || status === tickets.states.done) await tickets.move(c.ticket, tickets.states.todo, SERVICE);
        const note = `Pull request #${c.pr} was rolled back by the release watch (${landing.note}): the change is no longer live, and the ticket is back in Todo.`;
        await tickets.comment(c.ticket, this.#clean(note), SERVICE).catch(() => undefined);
      } else {
        await tickets.comment(c.ticket, this.#clean(`Pull request #${c.pr} is live, but its release watch did not end healthy: ${landing.note}. Nothing was reverted: look at the release and decide.`), SERVICE);
      }
    } catch (error) {
      console.error(`cleared-v2: the end of the landing of ${c.ticket} failed, the next tick tries again (${error instanceof Error ? error.name : typeof error})`);
      return false;
    }
    this.#step({ id: c.session, ticket: c.ticket, project: this.config.project }, 'STEP_FINISHED', 'watch', new Date(landing.at));
    this.#snapshot(c.session, c.ticket);
    if (landing.state === 'landed') this.#emit({ type: 'release_landed', ...base, health: landing.health });
    else if (landing.state === 'unhealthy') this.#emit({ type: 'release_unhealthy', ...base, note: this.#clean(landing.note) });
    else {
      const note = this.#clean(landing.note);
      this.#emit({ type: 'rolled_back', ...base, note });
      this.#emit({ type: 'ticket_put_back', at: this.#at(), project: this.config.project, ticket: c.ticket, reason: 'rolled_back', note: `Pull request #${c.pr} was rolled back by the release watch (${note}).` });
    }
    return true;
  }

  async #merge(c: Candidate, state: Following): Promise<void> {
    let merge: MergeOutcome;
    try {
      merge = await this.#effects.mergeRelease({ ticket: c.ticket, pr: c.pr, announcement: c.announcement });
    } catch (error) {
      merge = { outcome: 'unavailable', message: name(error) };
    }
    state.inFlight = false;
    state.nextAttempt = this.#now().getTime() + this.config.mergeRetryMs;
    if (merge.outcome === 'merged') {
      state.mergedAt = this.#now().toISOString();
      this.#follow(c);
    } else if (merge.outcome === 'refused') {
      state.refused = `The lock refused to merge pull request #${c.pr}: ${merge.message || 'no reason given'}`;
      state.inFlight = true;
      if (await this.#putBack(c.ticket, state.refused, 'merge_refused')) this.#following.delete(c.item);
      state.inFlight = false;
    }
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

  // ---- the event bus -----------------------------------------------------

  // `listener` hears every FlowEvent from now on; the function returned stops it.
  subscribe(listener: FlowListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #emit(event: FlowEvent): void {
    const failed = (error: unknown) => console.error(`cleared-v2: a flow listener failed on ${event.type} (${error instanceof Error ? error.name : typeof error})`);
    for (const listener of [...this.#listeners]) {
      try {
        const result = listener(event);
        if (result instanceof Promise) result.catch(failed);
      } catch (error) {
        failed(error);
      }
    }
  }

  #at(): string {
    return this.#now().toISOString();
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
  // The caller is a person (the API routes), or the plan runner for the
  // person who approved the plan (`origin`): the service moving a ticket to
  // Todo itself, when it puts one back, never starts anything.
  async start(ticketId: TicketId, by: UserId, origin?: Origin): Promise<void> {
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
      const settings = await this.#settings(ticket);
      const prepared = await this.#prepare(ticket, 'author');
      const workspaceDone = this.#now();
      const prompt = origin?.note ? `${authorPrompt(ticket)}\n\n${origin.note}` : authorPrompt(ticket);
      const live = await this.#launch(adapter, ticket, 'author', this.#authorModel(ticket), prepared.workdir, prepared.briefing, settings, prompt);
      const session = { id: live.id, ticket: ticketId, project: this.config.project };
      this.#step(session, 'STEP_STARTED', 'workspace', began);
      this.#step(session, 'STEP_FINISHED', 'workspace', workspaceDone);
      this.#step(session, 'STEP_STARTED', 'author', workspaceDone);
      this.#snapshot(live.id, ticketId);
      const comment = origin ? `Started by the lead for plan ${origin.plan} (item ${origin.item}), approved by ${by}.` : `Started by ${by}.`;
      await tickets.comment(ticketId, comment, SERVICE).catch(() => undefined);
      this.#emit({ type: 'ticket_started', at: this.#at(), project: this.config.project, ticket: ticketId, by, origin: origin ?? null, session: live.id });
      this.#supervise(live, 0);
    } catch (error) {
      await this.#putBack(ticketId, `The flow could not start: ${name(error)}`, 'start_failed');
      throw error;
    }
  }

  #authorModel(ticket: Ticket): string {
    return ticket.labels.includes(QUICK_LABEL) && this.config.reviewerModel !== QUICK_MODEL ? QUICK_MODEL : this.config.authorModel;
  }

  // start() in the background, for the routes: a person's click does not
  // wait for a clone. A failure becomes a note on the ticket (start wrote it).
  begin(ticketId: TicketId, by: UserId, origin?: Origin): Promise<void> {
    return this.#track(this.start(ticketId, by, origin).catch(() => undefined));
  }

  // ---- after a restart -----------------------------------------------------

  // What the last process left running cannot go on: its sessions died
  // with it (the adapter keeps no StartInput to resume them). Each author or
  // reviewer session of this project still marked live, and not live here,
  // is stopped with a RUN_ERROR `restart` and its requests are handled; each
  // ticket left In Progress or In Review that this engine does not run goes
  // back to Todo with a note. The lead's sessions are the lead engine's.
  // Run once by the runtime after it builds the engine; a second run finds
  // nothing.
  async recover(): Promise<void> {
    const tickets = this.registry.ticketStore;
    const project = this.config.project;
    const note = 'The service restarted while this ticket ran: its sessions were stopped, and the ticket is back in Todo. Move it to Todo to start it again.';
    const back = new Set<TicketId>();
    for (const row of this.#store.sessions.list()) {
      if (row.project !== project || (row.role !== 'author' && row.role !== 'reviewer')) continue;
      if (!LIVE_PHASES.has(row.status) || this.#live.has(row.id)) continue;
      const session = { id: row.id, ticket: row.ticket, project };
      const waits = this.#store.events.after(row.id).filter(({ event }) => (event.type === 'STEP_STARTED' || event.type === 'STEP_FINISHED') && event.stepName === 'waiting_human');
      if (waits.at(-1)?.event.type === 'STEP_STARTED') this.#step(session, 'STEP_FINISHED', 'waiting_human');
      this.#journal(session, { type: 'RUN_ERROR', message: 'The service restarted: this session was stopped.', code: 'restart' });
      this.#store.sessions.put({ ...row, status: 'stopped', updatedAt: this.#at() });
      this.inbox.handleSession(row.id, 'system');
      this.#snapshot(row.id, row.ticket);
      this.#emit({ type: 'session_stopped', at: this.#at(), project, ticket: row.ticket, session: row.id, role: row.role, phase: 'stopped', reason: 'restart' });
      back.add(row.ticket);
    }
    for (const status of [tickets.states.progress, tickets.states.review])
      for (const ticket of await tickets.list({ status, project })) back.add(ticket.id);
    for (const id of back) {
      if (this.#active.has(id)) continue;
      const ticket = await tickets.get(id);
      if (!ticket || ticket.project !== project || (ticket.status !== tickets.states.progress && ticket.status !== tickets.states.review)) continue;
      await this.#putBack(id, note, 'restart');
    }
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

  // The policy of a session at each evaluation (decision 11), which the
  // runtime gives the adapters: the "Always in this project" answers as they
  // are now, and the files the ticket's sessions edited so far, so that the
  // deletion rule knows them. The lead's is its own (lane 5).
  policyFor(input: StartInput): Policy {
    if (input.role === 'lead' || input.project !== this.config.project) return input.policy;
    return { ...input.policy, learned: this.#store.policyRules.learned(input.project), ticketFiles: this.#ticketFiles(input.ticket) };
  }

  // An edit counts once its result says it was made: a refused or failed
  // edit changed nothing. Read incrementally, since this runs at every tool call.
  #ticketFiles(ticket: TicketId): string[] {
    const out = new Set<string>();
    for (const row of this.#store.sessions.list({ ticket })) {
      if (row.role === 'lead') continue;
      let seen = this.#files.get(row.id);
      if (!seen) this.#files.set(row.id, (seen = { seq: 0, open: new Map(), files: [] }));
      for (const { seq, event } of this.#store.events.after(row.id, seen.seq)) {
        seen.seq = seq;
        if (event.type === 'TOOL_CALL_ARGS') {
          const input = readToolInput(event);
          const path = input?.kind === 'edit' ? ticketPath(input.path) : undefined;
          if (path) seen.open.set(event.toolCallId, path);
        } else if (event.type === 'TOOL_CALL_RESULT') {
          const path = seen.open.get(event.toolCallId);
          if (path === undefined) continue;
          seen.open.delete(event.toolCallId);
          const output = readToolOutput(event);
          const failed = output.kind === 'execute' ? output.isError : 'ok' in output && output.ok === false;
          if (!failed && !seen.files.includes(path)) seen.files.push(path);
        }
      }
      for (const path of seen.files) out.add(path);
    }
    return [...out];
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
            await this.#stopTicket(live, 'error', `The flow failed: ${name(error)}`, `The flow failed on this ticket: ${name(error)}`, 'stopped', 'failed').catch(() => undefined);
          }));
        }
        if (!live.closed) await this.#stopTicket(live, 'error', 'The session ended without finishing its turn.', 'The session ended without finishing its turn.', 'failed', 'failed');
      } catch (error) {
        if (!live.closed) await this.#stopTicket(live, 'error', `The session's stream failed: ${name(error)}`, `The session's stream failed: ${name(error)}`, 'failed', 'failed').catch(() => undefined);
      }
    })();
    void run;
  }

  async #onEvent(live: Live, stored: SessionEvent): Promise<void> {
    const event = stored.event;
    const session = { id: live.id, ticket: live.input.ticket, project: live.input.project };
    if (event.type === 'CUSTOM') {
      switch (event.name) {
        case 'cleared.permission_request': {
          const item = this.inbox.addPermission({ ticket: session.ticket, project: session.project, sessionId: live.id, requestId: event.value.requestId, tool: event.value.tool, input: event.value.input, suggestion: event.value.suggestion });
          this.#waitStarts(live);
          this.#emit({ type: 'permission_raised', at: this.#at(), project: session.project, ticket: session.ticket, session: live.id, requestId: event.value.requestId, item: item.id, tool: event.value.tool });
          return;
        }
        case 'cleared.question': {
          const item = this.inbox.addQuestion({ ticket: session.ticket, project: session.project, sessionId: live.id, requestId: event.value.requestId, questions: event.value.questions });
          this.#waitStarts(live);
          this.#emit({ type: 'question_raised', at: this.#at(), project: session.project, ticket: session.ticket, session: live.id, requestId: event.value.requestId, item: item.id });
          return;
        }
        case 'cleared.permission_answered':
        case 'cleared.answered': {
          // A request the inbox never saw (a policy deny the adapter reports alone) is ignored.
          const item = this.inbox.find(live.id, event.value.requestId);
          const handled = item ? this.inbox.handle(item.id, event.value.by) : false;
          this.#waitEnds(live);
          if (item && handled) this.#answered(item.id, session.ticket, live.id, event.value.requestId, event.value.by);
          return;
        }
        default:
          return;
      }
    }
    if (event.type === 'RUN_ERROR') {
      await this.#stopTicket(live, undefined, undefined, `The session failed: ${event.message}`, 'failed', 'failed');
      return;
    }
    if (event.type !== 'RUN_FINISHED') return;

    const budget = this.config.budgetUsd;
    const spent = this.#spent(session.ticket);
    if (budget !== undefined && spent > budget) {
      await this.#stopTicket(live, 'budget', `The ticket's budget of $${budget} is spent.`,
        `The ticket's budget of $${budget} is spent ($${spent.toFixed(2)}). The sessions were stopped. Raise the budget or reduce the ticket, then move it to Todo.`, 'stopped', 'budget');
      return;
    }
    if (event.outcome.type === 'cancelled') {
      this.#setPhase(live, 'waiting_human');
      return;
    }
    if (event.result.stopReason !== 'end_turn') {
      await this.#stopTicket(live, undefined, undefined, `The session stopped with "${event.result.stopReason}" before it finished.`, 'failed', 'failed');
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

  #answered(item: string, ticket: TicketId, session: SessionId, requestId: string, by: UserId | 'policy' | 'system'): void {
    this.#emit({ type: 'request_answered', at: this.#at(), project: this.config.project, ticket, session, requestId, item, by });
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

  async #close(live: Live, phase: 'done' | 'stopped' | 'failed', reason = ''): Promise<void> {
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
    if (phase !== 'done')
      this.#emit({ type: 'session_stopped', at: this.#at(), project: live.input.project, ticket: live.input.ticket, session: live.id, role: live.input.role, phase, reason: this.#clean(reason) });
  }

  // The ticket cannot go on: every live session of it stops, the reason is
  // written to the session and to the ticket, and the ticket goes back to
  // Todo. `code` is the RUN_ERROR code the session screen shows; undefined
  // when the adapter already wrote its own RUN_ERROR.
  async #stopTicket(from: Live, code: string | undefined, runMessage: string | undefined, note: string, phase: 'stopped' | 'failed', reason: PutBackReason): Promise<void> {
    const ticket = from.input.ticket;
    for (const live of [...this.#live.values()].filter((l) => l.input.ticket === ticket)) {
      if (live.closed) continue;
      if (code !== undefined && runMessage !== undefined)
        this.#journal({ id: live.id, ticket, project: live.input.project }, { type: 'RUN_ERROR', message: this.#clean(runMessage), code });
      await this.#close(live, live.id === from.id ? phase : 'stopped', note);
    }
    await this.#putBack(ticket, note, reason);
  }

  // True when the ticket was moved: `ticket_put_back` is said only then.
  async #putBack(ticket: TicketId, note: string, reason: PutBackReason): Promise<boolean> {
    const tickets = this.registry.ticketStore;
    this.#active.delete(ticket);
    await tickets.comment(ticket, this.#clean(note), SERVICE).catch(() => undefined);
    try {
      await tickets.move(ticket, tickets.states.todo, SERVICE);
    } catch (error) {
      console.error(`cleared-v2: ${ticket} could not be put back in Todo (${error instanceof Error ? error.name : typeof error})`);
      return false;
    }
    this.#emit({ type: 'ticket_put_back', at: this.#at(), project: this.config.project, ticket, reason, note: this.#clean(note) });
    return true;
  }

  // ---- the author is done: the review starts ------------------------------

  async #authorDone(author: Live): Promise<void> {
    const { ticket: id, project } = author.input;
    const session = { id: author.id, ticket: id, project };
    this.#step(session, 'STEP_FINISHED', 'author');
    await this.#close(author, 'done');
    this.#emit({ type: 'author_done', at: this.#at(), project, ticket: id, session: author.id });
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
      const settings = await this.#settings(ticket);
      const prepared = this.#several
        ? await this.#effects.prepareWorkdir({ ticket, role: 'reviewer', service: this.#servicesOf(ticket)[0] as ServiceConfig })
        : await this.#effects.prepareWorkdir({ ticket, role: 'reviewer' });
      const live = await this.#launch(adapter, ticket, 'reviewer', this.config.reviewerModel, prepared.workdir || workdir, prepared.briefing, settings,
        reviewPrompt({ ticket, base: this.config.base, verdict: settings.verdict }));
      this.#step({ id: live.id, ticket: ticket.id, project: ticket.project ?? this.config.project }, 'STEP_STARTED', 'review', began);
      this.#snapshot(live.id, ticket.id);
      this.#supervise(live, 0);
    } catch (error) {
      await this.#putBack(ticket.id, `The review could not start: ${name(error)}`, 'review_failed');
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
      await this.#putBack(id, 'The review gave no verdict (no "Verdict:" line in its report), so nothing was published. Move the ticket to Todo to run it again.', 'no_verdict');
      return;
    }
    const round = this.#flowRows(id).filter((row) => row.role === 'reviewer').length;
    this.#journal(session, { type: 'CUSTOM', name: 'cleared.review_verdict', value: { session: reviewer.id, verdict: parsed.verdict, round } });
    this.#emit({ type: 'review_verdict', at: this.#at(), project, ticket: id, session: reviewer.id, verdict: parsed.verdict, round });
    if (parsed.verdict === 'pass') return this.#publishAndAsk(reviewer, report, round);
    if (round >= this.config.maxReviewRounds) {
      await this.#putBack(id, `The review still asked for changes after ${round} review rounds, so the ticket goes back to Todo. The last report:\n\n${report}`, 'too_many_rounds');
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
    if (!ticket || !adapter) {
      await this.#putBack(id, 'The author could not be reopened: the ticket or the adapter is gone.', 'reopen_failed');
      return;
    }
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
      const settings = kept?.settings ?? (await this.#settings(ticket));
      const prepared = await this.#prepare(ticket, 'author');
      const live = await this.#launch(adapter, ticket, 'author', this.#authorModel(ticket), prepared.workdir, prepared.briefing, settings, `${authorPrompt(ticket)}\n\n${message}`);
      this.#step({ id: live.id, ticket: id, project: live.input.project }, 'STEP_STARTED', 'author', began);
      this.#snapshot(live.id, id);
      this.#supervise(live, 0);
    } catch (error) {
      await this.#putBack(id, `The author could not be reopened after the review: ${name(error)}`, 'reopen_failed');
    }
  }

  // ---- a pass: publish, record, ask the lock -------------------------------

  async #publishAndAsk(reviewer: Live, report: string, round: number): Promise<void> {
    const { ticket: id, project, workdir, model } = reviewer.input;
    const session = { id: reviewer.id, ticket: id, project };
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(id);
    if (!ticket) return;
    if (this.#several) return this.#publishTrain(reviewer, ticket, report, round);
    this.#step(session, 'STEP_STARTED', 'release');
    let published: Published;
    try {
      // The project checkout is fetched first: publish reads the base as the
      // checkout last saw it (issue 141).
      await this.#effects.refreshProject();
      published = await this.#effects.publish({ ticket: id, workdir, branch: ticketBranch(id), report });
    } catch (error) {
      this.#step(session, 'STEP_FINISHED', 'release');
      await this.#putBack(id, `The branch was not published: ${name(error)}`, 'publish_refused');
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
      await this.#putBack(id, `The release could not be requested: ${name(error)}`, 'release_refused');
      return;
    }
    for (const old of this.inbox.waitingReleases().filter((item) => item.ticket === id)) this.#settleRelease(old.id, id, project, 'system');
    const changed = await this.#changes(id, published.head);
    const card = flags({ diff: changed?.diff ?? '', ...this.#report(id) });
    const item = this.inbox.addRelease({
      ticket: id, project, title: ticket.title, announcement, requestedAt,
      pr: { number: published.number, url: published.url, checks: 'pending' },
      heads: [{ pr: published.number, head: published.head }],
      captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } },
      sessions: this.#releaseSessions(id, round), groups: card.groups, flags: card.flags,
    }, reviewer.id);
    // The lock has the request: the flow is over. What follows is the human's, and a person
    // may send the ticket back from the inbox, which starts a new flow.
    this.#active.delete(id);
    this.#step(session, 'STEP_FINISHED', 'release');
    this.#step(session, 'STEP_STARTED', 'approval');
    this.#emit({ type: 'release_requested', at: this.#at(), project, ticket: id, session: reviewer.id, item: item.id, pr: published.number, url: published.url });
  }

  // What a published head changes, for the card's flags and the
  // compatibility check; undefined when it cannot be read.
  async #changes(ticket: TicketId, head: string, service?: ServiceConfig): Promise<{ readonly files: readonly string[]; readonly diff: string } | undefined> {
    if (!this.#effects.changes) return undefined;
    try {
      return await this.#effects.changes({ ticket, head, ...(service ? { service } : {}) });
    } catch (error) {
      console.error(`cleared-v2: what ${ticket} changes could not be read (${error instanceof Error ? error.name : typeof error})`);
      return undefined;
    }
  }

  // The author's report of its changes: the last `cleared.changes` event of its last session.
  #report(ticket: TicketId): { report?: NonNullable<ReturnType<typeof changesReport>> } {
    const author = this.#lastSession(ticket, 'author');
    const report = author ? changesReport(this.#store.events.after(author.id)) : undefined;
    return report ? { report } : {};
  }

  // ---- a pass of a ticket of several services: the train ------------------

  // One pull request per service the ticket changed, on the same branch, in
  // landing order; each review recorded and each approval asked on that
  // service's own lock; the card blocked when a contract changes without its
  // consumer. A service whose branch has no commit of its own is not in the
  // train. The approval and the landing are the train's (release/train.ts).
  async #publishTrain(reviewer: Live, ticket: Ticket, report: string, round: number): Promise<void> {
    const { ticket: id, project, model } = reviewer.input;
    const session = { id: reviewer.id, ticket: id, project };
    const tickets = this.registry.ticketStore;
    this.#step(session, 'STEP_STARTED', 'release');
    const fail = async (note: string, reason: PutBackReason) => {
      this.#step(session, 'STEP_FINISHED', 'release');
      await this.#putBack(id, note, reason);
    };
    const order = landingOrder(this.#workspace.services, this.#servicesOf(ticket).map((s) => s.name)).map((name) => this.#service(name));
    const published: { service: ServiceConfig; pr: Published; files: readonly string[] | null; diff: string }[] = [];
    const skipped: string[] = [];
    for (const service of order) {
      try {
        await this.#effects.refreshProject(service);
        const workdir = this.#workdirs.get(id)?.get(service.name) ?? posix.join(this.config.workdirRoot, id, service.name);
        const pr = await this.#effects.publish({ ticket: id, workdir, branch: ticketBranch(id), report, service });
        const changed = await this.#changes(id, pr.head, service);
        published.push({ service, pr, files: changed?.files ?? null, diff: changed?.diff ?? '' });
      } catch (error) {
        if ((error as { code?: unknown }).code === 'empty') { skipped.push(service.name); continue; }
        return fail(`The branch was not published on ${service.name}: ${name(error)}`, 'publish_refused');
      }
    }
    if (published.length === 0) return fail(`The branch was not published: no service of the ticket (${order.map((s) => s.name).join(', ')}) has a commit of its own.`, 'publish_refused');
    const announcement = [
      `Ticket ${id}: ${ticket.title}`,
      '',
      ...published.map((p) => `Pull request on ${p.service.name}: ${p.pr.url}`),
      `Reviewed by ${model} in ${round} round${round === 1 ? '' : 's'}: ${report.split('\n').filter((line) => /verdict\s*:/i.test(line)).at(-1)?.trim() ?? 'passed'}`,
    ].join('\n');
    const compat = this.#compatibility(published);
    const stops: Stop[] = [];
    try {
      const reviewedAt = this.#now().toISOString();
      for (const p of published) {
        const lock = this.#lockOf(p.service);
        const verdictPhrase = (await this.#effects.settings(p.service)).verdict;
        await lock.recordReview({ ticket: id, pr: p.pr.number, session: reviewRun(reviewer.id, p.service.name), model, verdict: 'pass', round, report, at: reviewedAt, commit: p.pr.head, verdictPhrase });
      }
      for (const p of published) {
        const asked = await this.#lockOf(p.service).ask({ ticket: id, pr: p.pr.number, request: announcement });
        stops.push({ service: p.service.name, pr: { number: p.pr.number, url: p.pr.url }, head: p.pr.head, requestedAt: asked.requestedAt, state: 'waiting', at: null, note: null, signed: false, askedAt: null, mergedAt: null, next: null });
      }
      // The real lock moves the card itself when it asks; a store it did not move gets the move here.
      if ((await tickets.history(id)).at(-1)?.status !== tickets.states.validate) await tickets.move(id, tickets.states.validate, SERVICE);
    } catch (error) {
      return fail(`The release could not be requested: ${name(error)}`, 'release_refused');
    }
    if (skipped.length > 0) await tickets.comment(id, `Not in the release: ${skipped.join(', ')}, whose branch has no commit of its own.`, SERVICE).catch(() => undefined);
    for (const old of this.inbox.waitingReleases().filter((item) => item.ticket === id)) this.#settleRelease(old.id, id, project, 'system');
    const first = stops[0] as Stop;
    const card = flags({ diff: published.map((p) => p.diff).join(''), ...this.#report(id) });
    const train = {
      ticket: id, project, state: compat.blocked ? 'blocked' as const : 'waiting' as const, stops, compatibility: compat.line, blocked: compat.blocked, announcement,
    };
    const item = this.inbox.addRelease({
      ticket: id, project, title: ticket.title, announcement, requestedAt: first.requestedAt,
      pr: { number: first.pr.number, url: first.pr.url, checks: 'pending' },
      heads: stops.map((stop) => ({ pr: stop.pr.number, head: stop.head })),
      captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } },
      sessions: this.#releaseSessions(id, round), train: view({ ...train, item: '', approver: null }), groups: card.groups, flags: card.flags,
    }, reviewer.id);
    this.#trains.add({ ...train, item: item.id });
    this.#active.delete(id);
    this.#step(session, 'STEP_FINISHED', 'release');
    this.#step(session, 'STEP_STARTED', 'approval');
    this.#emit({ type: 'release_requested', at: this.#at(), project, ticket: id, session: reviewer.id, item: item.id, pr: first.pr.number, url: first.pr.url });
  }

  // The compatibility check of the card. What a provider changes that could
  // not be read is not taken as compatible: with a consumer the ticket does
  // not change, the card is blocked until the ticket is published again.
  #compatibility(published: readonly { readonly service: ServiceConfig; readonly files: readonly string[] | null }[]): ReturnType<typeof compatibility> {
    const said = compatibility(this.#workspace.services, Object.fromEntries(published.map((p) => [p.service.name, p.files ?? []])));
    if (said.blocked) return said;
    const touched = new Set(published.map((p) => p.service.name));
    const unread = published.filter((p) => p.files === null && p.service.contract
      && this.#workspace.services.some((other) => other.consumes.includes(p.service.name) && !touched.has(other.name)));
    if (unread.length === 0) return said;
    const names = unread.map((p) => p.service.name).join(', ');
    return {
      ...said,
      blocked: {
        reason: `What this ticket changes on ${names} could not be read, so whether it changes the contract a service it does not change consumes is not known.`,
        proposal: 'Send the ticket back and start it again, so that it is published and read again; or ask the lead to add a step on the services that consume it.',
      },
    };
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
    if (this.inbox.handle(item.id, by)) this.#answered(item.id, item.ticket, id, requestId, by);
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
