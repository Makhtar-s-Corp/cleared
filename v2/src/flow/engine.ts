// The ticket's path in the service (docs/v2/milestone-1-plan.md, lane 7):
//
//   Todo -> workspace -> author session -> review session (another model,
//   read-only policy, same branch) -> on a pass: refresh the project, publish
//   the branch, record the review, ask the lock for the human's approval ->
//   the inbox shows the release until the ticket reaches the go state.
//   A requested change reopens the author with the report, and the author's
//   answer reopens the same reviewer: the ticket's review channel (issue
//   291, flow/channel.ts), bounded by FlowConfig.maxReviewRounds; a ticket
//   that cannot go on (idle, over budget, a failed run, a refused publish,
//   no verdict, too many rounds) goes back to Todo with a note.
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
//
// With the author's host tools (decisions 22 and 23, lane 17;
// FlowConfig.authorTools), the author's first turn ends with its session
// plan and the flow holds it until a Go (flow/plan-gate.ts): `workspace`,
// `author`, `plan_gate`, then `author` again from the Go. The engine also
// applies two sensitivities of the ticket's services (decision 24): a
// `reviewer:<model>` names the reviewer, and `full` keeps a Quick ticket
// off Haiku.
//
// A ticket of several services runs in steps (decision 26, lane 23,
// flow/steps.ts; FlowConfig.steps): a contract step on the providing
// service, whose diff the owner validates in the inbox, then a step per
// service in parallel (at most the plan's maxParallel at once), then the
// integration on the consumer, each an author session in its service's
// checkout with the siblings its kind wants; once every step is done, the
// review, the publish and the train follow as above. A step that fails puts
// the ticket back and keeps the steps that are done.
//
// The owner can take an author's session over (decision 30, lane 20,
// flow/takeover.ts): the turn is interrupted, what waited for the human is
// settled as cancelled, and the session is paused, said by `takenOver` on
// its summary and its state, until Give back resumes it. The flow leaves a
// paused session alone: no idle stop, no Go of the delay, no review, no
// message; a restart stops it as any live session.
//
// A plan must not freeze on a person (issue #290): a team's question has
// its own delay (FlowConfig.questionTimeoutMs, from when it was asked),
// past which the lead is asked to decide, then the answer the session
// declared (flow/questions.ts) is applied, or the ticket is parked. The
// idle watchdog (session/watchdog.ts) stops, through idleStop, a session
// that waits for a person: its containers go, its question stays, and the
// answer resumes it in a new container from its volume (#wake).
//
// A release whose checks fail is repaired (issue #273, flow/ci-repair.ts):
// a failure read on the card's own head, while a one-service ticket waits
// for the owner's approval, handles the card and reopens the ticket's
// author on the ticket branch with what failed, as a new flow;
// its commit goes through the review and the publish as any change, and
// the new card carries the attempt. At most CI_REPAIR_ATTEMPTS attempts;
// then the card says the checks still fail and the owner decides. A train
// is not repaired.
import { posix } from 'node:path';
import type { CiRepair, InboxItem, PermissionItem, QuestionItem, QuestionTimeout, ReleaseItem, SessionDetail, SessionPlan, SessionSummary, TakenOver, TicketStep } from '../api/types.ts';
import { isSessionId } from '../container/docker.ts';
import type { SiblingSpec } from '../container/services.ts';
import { LOGIN_FILE_MOUNT, WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { InboxStore } from '../inbox/store.ts';
import type { Registry } from '../modules/registry.ts';
import { HostToolRefused, type Answer, type Briefing, type Decision, type HostTool, type Role, type SessionAdapter, type SessionHandle, type SessionId, type StartInput, type UserId } from '../session/contract.ts';
import { readToolInput, readToolOutput, type AgUiEvent, type Question, type SessionEvent, type SessionPhase, type StepName } from '../session/events.ts';
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
import { AUTHOR_TOOLS, bindAuthorTools, readChangesReport, readSessionPlan } from './author-tools.ts';
import { PLAN_GO_MINUTES, QUESTION_LEAD_MINUTES, QUESTION_TIMEOUT_MINUTES, workspaceOf, type FlowConfig, type ProjectSettings } from './config.ts';
import { answerLines, asked, defaultAnswers } from './questions.ts';
import { duration } from '../lead/plans/estimates.ts';
import { ledgerEvent } from '../store/ledger-events.ts';
import type { FlowEvent, FlowListener, Origin, PutBackReason } from './events.ts';
import { atOrAfter, landingOf, type Landing } from './ledger.ts';
import { NOT_AGAIN, NOT_NOW, PROPOSED, changeMessage, goMessage, noPlanNote, type Gate, type GoBy } from './plan-gate.ts';
import type { LeverReader } from '../consumption/levers.ts';
import { GIVEN_BACK, GIVEN_BACK_REVIEW, TAKEN_OVER } from './takeover.ts';
import { NO_ANSWER, answerMessage, channelOf, channelPrompt, lastSaid, verdictsOf, type ChannelMessage } from './channel.ts';
import { testComment, testLine, testRunOf } from './review-tests.ts';
import { CI_REPAIR_ATTEMPTS, onBase, repairComment, repairMessage, type CiFailures } from './ci-repair.ts';
import { authorPrompt, contractSendBackMessage, fileDiff, lastReport, parseVerdict, reviewPrompt, reviewRequestMessage, stepPrompt, withoutFile, type ReviewContract, type ReviewService } from './prompts.ts';
import { humanEdits } from './human-edits.ts';
import { StepStore, deriveSteps, publicStep, stepName, stepSiblings, type Step, type StepSpec } from './steps.ts';
import { foldState, sessionPlanOf } from './state.ts';

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
  // The head the pull request's checks ran on and the ones that failed,
  // with their logs' last lines when the forge gives them (issue #273).
  // Absent: a repair starts on the checks' state alone, told nothing of them.
  ciFailures?(input: { readonly pr: number; readonly service?: ServiceConfig }): Promise<CiFailures>;
  // The lock's merge (`request_release` without --ask), after the human's approval.
  mergeRelease(input: { readonly ticket: TicketId; readonly pr: number; readonly announcement: string }): Promise<MergeOutcome>;
  // What a published head changes against the base: its files, and the diff
  // the release card's flags are read from (release/flags.ts). Absent: none.
  changes?(input: { readonly ticket: TicketId; readonly head: string; readonly service?: ServiceConfig }): Promise<{ readonly files: readonly string[]; readonly diff: string }>;
  // What the runtime plans as the siblings of a session on `service`
  // (container/services.ts planSiblings), which a step adapts to its kind
  // (flow/steps.ts stepSiblings). Absent: the runtime plans them itself.
  siblings?(input: { readonly ticket: TicketId; readonly service: ServiceConfig; readonly workdir: string }): Promise<readonly SiblingSpec[]>;
  // What a step's branch changes against the service's base, read as publish
  // reads a branch (never with git in the session's checkout): its files,
  // and for a service with a contract, the contract file's diff and blob id;
  // with `snapshot` (a folder), the contract as committed, copied into it.
  stepChanges?(input: { readonly ticket: TicketId; readonly service: ServiceConfig; readonly workdir: string; readonly snapshot?: string }): Promise<StepChanges>;
  // What the ticket branch of a service changes against its base, read out
  // of <workdirs>/<ticket>/<service> as a step's branch is: its files and its
  // diff, none when the ticket has no checkout of it. The reviewer of a
  // ticket of several services is given it (owner decision of 2026-10-22
  // 20:33). Absent: the reviewer is told the change could not be read.
  branchChanges?(input: { readonly ticket: TicketId; readonly service: ServiceConfig }): Promise<{ readonly files: readonly string[]; readonly diff: string }>;
};

export type StepChanges = {
  readonly files: readonly string[];
  readonly contract: { readonly path: string; readonly diff: string; readonly blob: string | null; readonly snapshot: string | null } | null;
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
  // Releases the containers and networks of stopped sessions, by name
  // (Docker.releaseStopped): after the restart recovery (issue 265).
  readonly release?: (sessions: readonly SessionId[]) => Promise<{ readonly containers: readonly string[]; readonly networks: readonly string[] }>;
  // The Consumption screen's levers (consumption/levers.ts): the author model
  // of the sessions that start from now on and the most steps run at once.
  // Nothing is overridden when absent.
  readonly levers?: LeverReader;
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
const QUESTION_DEFAULT = 'question_default';                       // the rule of an answer the session declared, applied at its delay's end

type Live = {
  readonly id: SessionId;
  readonly input: StartInput;
  readonly settings: ProjectSettings;
  handle: SessionHandle;
  lastActivity: number;
  closed: boolean;
  waitOpen: boolean;                                                // a waiting_human step is open
  turnFrom?: number;                                                // a resumed session's last seq before its new turn: its verdict or its answer is read after it
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

// A ticket's steps at once when no plan says otherwise: the plans' default (lead/plans/runner.ts).
const STEP_PARALLEL = 2;
const LIVE_PHASES: ReadonlySet<string> = new Set(['starting', 'working', 'waiting_human', 'reviewing']);
// How long after its stop a session's containers and networks are still looked for at each tick.
const RELEASE_WINDOW_MS = 10 * 60_000;
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

// The policy's answer to a session's own host tools: the runner asks the
// policy before every tool call, and an author's mcp__cleared__ tools match
// no row of its role, so they are allowed as learned answers are (the lead
// has its own row, lead.tools).
function toolRules(tools: readonly HostTool[] | undefined): { tool: string; pattern: string }[] {
  return (tools ?? []).filter((tool) => AUTHOR_TOOLS.some((known) => known.name === tool.name)).map((tool) => ({ tool: `mcp__cleared__${tool.name}`, pattern: '*' }));
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
  #release: FlowDeps['release'];
  #levers: LeverReader | undefined;
  #resuming = new Set<SessionId>();                                 // sessions whose container a resume is starting: never released
  #workdirs = new Map<TicketId, Map<string, string>>();             // a train ticket's checkout per service, as prepared
  #gates = new Map<SessionId, Gate>();                              // an author's session plan and its hold (plan-gate.ts)
  #origins = new Map<TicketId, Origin>();                           // the plan item a ticket's current flow runs for
  #paused = new Map<SessionId, TakenOver>();                        // sessions the owner took over, until Give back (lane 20)
  #steps: StepStore;                                                // the ticket's steps (lane 23)
  #stepOf = new Map<SessionId, string>();                           // the step an author session works on
  #launching = new Set<string>();                                   // steps whose session is being started
  #finishing = new Set<TicketId>();                                 // tickets whose last step is done: the review starts once
  #channels = new Map<TicketId, { readonly reviewer: SessionId; readonly round: number }>();   // the review channel waiting for the author's answer (issue 291)
  // Sessions the watchdog stopped while they waited for a person (issue
  // #290): their ticket's flow goes on, what they wait for stays in the
  // inbox, and the answers given since are told to them when they resume.
  #dormant = new Map<SessionId, Live>();
  #told = new Map<SessionId, string[]>();
  #repairing = new Set<TicketId>();                                 // tickets whose failed checks are being read or a repair started
  #repairs = new Map<TicketId, CiRepair>();                         // the repair a ticket's flow runs for, until its card is published

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
    this.#release = deps.release;
    this.#levers = deps.levers;
    this.#trains = new TrainStore(deps.store.db, this.#now);
    this.#steps = new StepStore(deps.store.db, this.#now);
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

  // The idle stop, the notice that a release was approved, the landing of
  // what was approved, and the release of the sessions that stopped. A
  // session that waits for the human is not idle: the request in the inbox
  // would be lost with it, and the wait is the human's.
  async tick(): Promise<void> {
    const now = this.#now().getTime();
    // A session held by its plan, or its want of one, is not idle: its delay decides (#gateTick).
    for (const live of [...this.#live.values()]) {
      if (live.closed || this.#paused.has(live.id) || this.inbox.waitingFor(live.id) > 0 || this.#holds(live.id)) continue;
      if (now - live.lastActivity < this.config.idleMs) continue;
      const minutes = Math.round(this.config.idleMs / 60_000);
      await this.#stopTicket(live, 'idle', `No activity for ${minutes} minutes: the session was stopped.`,
        `The session stopped after ${minutes} minutes without activity. Move the ticket to Todo to start it again.`, 'stopped', 'idle');
    }
    // Scanned synchronously: a tick with nothing due yields as it did before the gate.
    for (const { live, minutes, go } of this.#dueGates(now)) {
      if (go) await this.#go(live, 'delay').catch((error: unknown) => console.error(`cleared-v2: the Go by the delay of ${live.id} failed (${error instanceof Error ? error.name : typeof error})`));
      else await this.#stopTicket(live, 'no_plan', 'The author proposed no session plan: the session was stopped.', noPlanNote(minutes), 'stopped', 'failed');
    }
    // Scanned synchronously too: asking the lead writes and yields nothing.
    for (const { live, item, minutes } of this.#dueQuestions(now)) {
      if (item.timeout?.answers) await this.#applyDeclared(live, item, item.timeout.answers, minutes);
      else await this.#park(live, item, minutes);
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
        if (checks === 'failed') await this.#checksFailed(release, ticket);
        else if (checks === 'passed' && release.repair?.state === 'pushed') await this.#repairSaid(release, { ...release.repair, state: 'repaired', at: this.#at() });
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
    // The sessions that stopped lately leave no container nor network behind
    // (issue 265). Chosen synchronously: a tick with none to release does not yield.
    const stopped = this.#stopped(new Date(now - RELEASE_WINDOW_MS).toISOString());
    if (stopped.length > 0) await this.#releaseStopped(stopped);
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

  // ---- the repair of failed checks (issue #273) ----------------------------

  // The checks of a waiting release failed. Read again once a minute, so
  // each step below happens once: a failure on another head than the card's
  // (the push's checks not reported yet) waits for the next reading.
  async #checksFailed(release: ReleaseItem, ticket: Ticket): Promise<void> {
    const id = ticket.id;
    const last = release.repair;
    if (release.train || last?.state === 'gave_up' || last?.state === 'refused' || this.#repairing.has(id) || this.#active.has(id)) return;
    this.#repairing.add(id);
    try {
      let failures: CiFailures | undefined;
      if (this.#effects.ciFailures) {
        try {
          failures = await this.#effects.ciFailures({ pr: release.pr.number });
        } catch (error) {
          console.error(`cleared-v2: the failed checks of pull request #${release.pr.number} could not be read (${error instanceof Error ? error.name : typeof error})`);
          return;
        }
        if (failures.head !== release.heads[0]?.head || failures.checks.length === 0) return;
        failures = { head: failures.head, checks: failures.checks.map((check) => ({ name: this.#clean(check.name), url: check.url, log: check.log === null ? null : this.#clean(check.log) })) };
      }
      const checks = failures?.checks.map((check) => check.name) ?? [];
      const at = this.#at();
      if (onBase(ticketBranch(id), this.config.base))
        return await this.#repairSaid(release, { attempt: last?.attempt ?? 0, limit: CI_REPAIR_ATTEMPTS, state: 'refused', checks, at });
      if ((last?.attempt ?? 0) >= CI_REPAIR_ATTEMPTS)
        return await this.#repairSaid(release, { attempt: last?.attempt ?? 0, limit: CI_REPAIR_ATTEMPTS, state: 'gave_up', checks, at });
      await this.#repair(release, ticket, { attempt: (last?.attempt ?? 0) + 1, limit: CI_REPAIR_ATTEMPTS, state: 'started', checks, at }, failures);
    } finally {
      this.#repairing.delete(id);
    }
  }

  // The card is handled, so the red head can no longer be approved, and the
  // ticket's last author is reopened with what failed, as a new flow: its
  // review counts its rounds from 1. #publishAndAsk gives the next card the attempt.
  async #repair(release: ReleaseItem, ticket: Ticket, repair: CiRepair, failures: CiFailures | undefined): Promise<void> {
    const id = ticket.id;
    const tickets = this.registry.ticketStore;
    const adapter = this.registry.sessionAdapters[HARNESS];
    if (!adapter) return;
    this.#settleRelease(release.id, id, release.project, 'system');
    this.#checked.delete(release.id);
    await this.#repairSaid(release, repair);
    const authorRow = this.#store.sessions.list({ ticket: id }).filter((row) => row.role === 'author').at(-1);
    this.#active.add(id);
    this.#flows.set(id, new Set(authorRow ? [authorRow.id] : []));
    this.#channels.delete(id);
    this.#repairs.set(id, repair);
    try {
      await tickets.move(id, tickets.states.progress, SERVICE);
      await this.#reopenWith(ticket, adapter, authorRow, repairMessage({ repair, pr: release.pr.number, branch: ticketBranch(id), ...(failures ? { failures } : {}) }));
    } catch (error) {
      await this.#putBack(id, `The repair of the failed checks could not start: ${name(error)}`, 'reopen_failed');
    }
  }

  // A step of a repair, said on the card, on the ticket and on the bus.
  async #repairSaid(release: Pick<ReleaseItem, 'id' | 'ticket' | 'project' | 'pr'>, repair: CiRepair): Promise<void> {
    this.inbox.setReleaseRepair(release.id, repair);
    await this.registry.ticketStore.comment(release.ticket, repairComment(repair, release.pr.number), SERVICE).catch(() => undefined);
    this.#emit({ type: 'ci_repair', at: repair.at, project: release.project, ticket: release.ticket, pr: release.pr.number, attempt: repair.attempt, limit: repair.limit, state: repair.state, checks: repair.checks });
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
    const plan = sessionPlanOf(events);
    const takenOver = this.#paused.get(id);
    // The service and the preview key the runtime stored when the session's
    // containers started (lane 15), when its row holds them; the session
    // plan of an author that proposed one (lane 17); who took it over (lane 20).
    return {
      id: row.id, project: row.project, ticket: row.ticket, role: row.role, harness: row.harness, model: row.model,
      phase, status: state.status, startedAt: row.createdAt, updatedAt: row.updatedAt, lastSeq: events.at(-1)?.seq ?? 0,
      state: { ...state, ...(plan ? { plan } : {}), ...(takenOver ? { takenOver } : {}) },
      ...(row.service ? { service: row.service } : {}), ...(row.previewKey ? { previewKey: row.previewKey } : {}), ...(takenOver ? { takenOver } : {}),
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
    this.#channels.delete(ticketId);
    if (origin) this.#origins.set(ticketId, origin);
    else this.#origins.delete(ticketId);
    this.#finishing.delete(ticketId);
    const began = this.#now();
    try {
      await tickets.move(ticketId, tickets.states.progress, SERVICE);
      const steps = this.#stepPlan(ticket, origin);
      if (steps && steps.length > 1) {
        await this.#startSteps(ticket, by, origin, steps);
        return;
      }
      const settings = await this.#settings(ticket);
      const prepared = await this.#prepare(ticket, 'author');
      const workspaceDone = this.#now();
      const tools = this.config.authorTools === true;
      const first = authorPrompt(ticket, { plan: tools, report: tools });
      const prompt = origin?.note ? `${first}\n\n${origin.note}` : first;
      const live = await this.#launch(adapter, ticket, 'author', this.#authorModel(ticket), prepared.workdir, prepared.briefing, settings, prompt, tools ? 'plan' : undefined);
      const session = { id: live.id, ticket: ticketId, project: this.config.project };
      this.#step(session, 'STEP_STARTED', 'workspace', began);
      this.#step(session, 'STEP_FINISHED', 'workspace', workspaceDone);
      this.#step(session, 'STEP_STARTED', 'author', workspaceDone);
      this.#snapshot(live.id, ticketId);
      const comment = origin ? `Started by the lead for plan ${origin.plan} (item ${origin.item}), approved by ${by}.` : `Started by ${by}.`;
      await tickets.comment(ticketId, comment, SERVICE).catch(() => undefined);
      this.#emit({ type: 'ticket_started', at: this.#at(), project: this.config.project, ticket: ticketId, by, origin: origin ?? null, session: live.id });
      // A one-service ticket's one step is its author's (lane 23): nothing else changes.
      if (steps) {
        const step = this.#steps.ensure(ticketId, this.config.project, steps)[0] as Step;
        this.#steps.resume(ticketId);
        this.#steps.update(step.id, { state: 'running', session: live.id });
        this.#stepOf.set(live.id, step.id);
      }
      this.#supervise(live, 0);
    } catch (error) {
      await this.#putBack(ticketId, `The flow could not start: ${name(error)}`, 'start_failed');
      throw error;
    }
  }

  // ---- a ticket in steps (decision 26, lane 23) ----------------------------

  // The steps of a ticket when the steps are on: the ones it kept from an
  // earlier start, else its plan item's, else deriveSteps'.
  #stepPlan(ticket: Ticket, origin?: Origin): StepSpec[] | undefined {
    if (this.config.steps !== true) return undefined;
    const kept = this.#steps.list(ticket.id);
    if (kept.length > 0) return kept.map(({ kind, service, after }) => ({ kind, service, after }));
    if (origin?.steps && origin.steps.length > 0) return [...origin.steps];
    return deriveSteps(this.#workspace.services, this.#servicesOf(ticket).map((service) => service.name));
  }

  async #startSteps(ticket: Ticket, by: UserId, origin: Origin | undefined, specs: readonly StepSpec[]): Promise<void> {
    this.#steps.ensure(ticket.id, this.config.project, specs);
    this.#steps.resume(ticket.id);
    const comment = origin ? `Started by the lead for plan ${origin.plan} (item ${origin.item}), approved by ${by}.` : `Started by ${by}.`;
    await this.registry.ticketStore.comment(ticket.id, comment, SERVICE).catch(() => undefined);
    await this.#runSteps(ticket.id, by);
  }

  // The flow's tick of a ticket in steps: each waiting step whose steps
  // before it are done starts, in position order, at most the plan's
  // maxParallel sessions at once and never two on one service's checkout;
  // once every step is done, the review. The sessions are watched once all
  // of them have started, so a step that ends at once does not race the
  // start of the next. `by`: the ticket's start, said by its first session.
  async #runSteps(id: TicketId, by?: UserId): Promise<void> {
    const started: Live[] = [];
    let failed: { readonly step: Step; readonly why: string } | undefined;
    for (;;) {
      if (!this.#active.has(id)) break;
      const steps = this.#steps.list(id);
      if (steps.length === 0 || steps.some((step) => step.state === 'failed')) break;
      if (steps.every((step) => step.state === 'done')) {
        await this.#stepsDone(id);
        break;
      }
      const planned = Math.max(1, this.#origins.get(id)?.maxParallel ?? STEP_PARALLEL);
      const limit = Math.min(planned, this.#levers?.read().maxLanes ?? planned);
      if (steps.filter((step) => step.state === 'running').length >= limit) break;
      const next = steps.find((step) => step.state === 'waiting'
        && step.after.every((position) => steps.find((other) => other.position === position)?.state === 'done')
        && !steps.some((other) => other.id !== step.id && other.service === step.service && (other.state === 'running' || other.state === 'validating')));
      if (!next) break;
      // Running before the first wait, so a second tick never starts it too.
      this.#steps.update(next.id, { state: 'running' });
      try {
        started.push(await this.#launchStep(id, next, steps.length, by && started.length === 0 && this.#flowOf(id).size === 0 ? by : undefined));
      } catch (error) {
        failed = { step: next, why: `its session could not start: ${name(error)}` };
        break;
      }
    }
    if (failed) return this.#failStep(failed.step, failed.why);
    for (const live of started) if (!live.closed) this.#supervise(live, 0);
  }

  // A step's session, in its service's checkout, with the siblings its kind
  // wants and the validated contracts, told which step it does.
  async #launchStep(id: TicketId, step: Step, count: number, by: UserId | undefined): Promise<Live> {
    const adapter = this.registry.sessionAdapters[HARNESS];
    if (!adapter) throw new FlowError('unavailable', `no adapter for ${HARNESS} is registered`);
    const ticket = await this.#ticketOf(id);
    const service = this.#service(step.service);
    const began = this.#now();
    const scoped = this.#several ? service : undefined;
    const settings = await this.#effects.settings(scoped);
    const prepared = await this.#effects.prepareWorkdir({ ticket, role: 'author', ...(scoped ? { service: scoped } : {}) });
    const workdirs = this.#workdirs.get(id) ?? new Map<string, string>();
    this.#workdirs.set(id, workdirs);
    workdirs.set(service.name, prepared.workdir);
    const workspaceDone = this.#now();
    const steps = this.#steps.list(id);
    const validated = new Map(steps.flatMap((s) => (s.kind === 'contract' && s.state === 'done' && s.contract ? [[s.service, s.contract] as const] : [])));
    const contract = this.#stepContract(step, steps);
    const tools = this.config.authorTools === true;
    const note = this.#origins.get(id)?.note;
    const prompt = [
      authorPrompt(ticket, { plan: tools, report: tools }),
      stepPrompt({ kind: step.kind, service: step.service, position: step.position, count, ...(contract ? { contract } : {}), ...(step.note ? { note: step.note } : {}) }),
      ...(note ? [note] : []),
    ].join('\n\n');
    const planned = this.#effects.siblings ? await this.#effects.siblings({ ticket: id, service, workdir: prepared.workdir }) : undefined;
    const siblings = planned ? stepSiblings(planned, { kind: step.kind, own: service.name, validated, ...(settings.serviceUrls ? { urls: settings.serviceUrls } : {}) }) : undefined;
    const live = await this.#launch(adapter, ticket, 'author', this.#authorModel(ticket), prepared.workdir, prepared.briefing, settings, prompt, tools ? 'plan' : undefined,
      { service: service.name, ...(siblings ? { siblings } : {}) });
    this.#steps.update(step.id, { state: 'running', session: live.id });
    this.#stepOf.set(live.id, step.id);
    const session = { id: live.id, ticket: id, project: this.config.project };
    this.#step(session, 'STEP_STARTED', 'workspace', began);
    this.#step(session, 'STEP_FINISHED', 'workspace', workspaceDone);
    this.#step(session, 'STEP_STARTED', 'author', workspaceDone);
    this.#snapshot(live.id, id);
    if (by) this.#emit({ type: 'ticket_started', at: this.#at(), project: this.config.project, ticket: id, by, origin: this.#origins.get(id) ?? null, session: live.id });
    return live;
  }

  // The contract a step's prompt names: its own for the contract step and
  // for its provider's service step, else that of a provider it consumes
  // whose contract step the ticket has.
  #stepContract(step: Step, steps: readonly Step[]): { readonly service: string; readonly path: string } | undefined {
    const of = (name: string) => {
      const path = this.#service(name).contract?.path;
      return path ? { service: name, path } : undefined;
    };
    if (step.kind === 'contract') return of(step.service);
    if (step.kind === 'integration') return undefined;
    const contracts = steps.filter((s) => s.kind === 'contract').map((s) => s.service);
    if (contracts.includes(step.service)) return of(step.service);
    const provider = this.#service(step.service).consumes.find((name) => contracts.includes(name));
    return provider ? of(provider) : undefined;
  }

  // A step's author ended its work. The contract step's change is read:
  // the contract file alone, proposed in the inbox, or nothing changed and
  // the step is done; a step on a service whose contract was validated is
  // read too, and refused if it changed it. Then the next steps.
  async #stepDone(live: Live, step: Step): Promise<void> {
    const { ticket: id, project } = live.input;
    this.#step({ id: live.id, ticket: id, project }, 'STEP_FINISHED', 'author');
    await this.#close(live, 'done');
    this.#stepOf.delete(live.id);
    this.#emit({ type: 'author_done', at: this.#at(), project, ticket: id, session: live.id });
    try {
      await this.#effects.captureHandover({ workdir: live.input.workdir, role: 'author', model: live.input.model, ticket: id, sessionId: live.id });
    } catch (error) {
      await this.registry.ticketStore.comment(id, this.#clean(`The author's handover could not be stored: ${name(error)}`), SERVICE).catch(() => undefined);
    }
    if (!this.#active.has(id)) return;
    const steps = this.#steps.list(id);
    const validated = step.kind === 'contract' ? null : steps.find((s) => s.kind === 'contract' && s.service === step.service && s.state === 'done')?.blob ?? null;
    let read: StepChanges | undefined;
    if (step.kind === 'contract' || validated !== null) {
      if (!this.#effects.stepChanges) return this.#failStep(step, 'what it changed cannot be read: the flow has no reader of a step\'s branch');
      const proposed = [...this.inbox.contracts({ ticket: id }), ...this.inbox.contracts({ ticket: id, state: 'handled' })];
      const round = proposed.filter((item) => item.step === step.id).length + 1;
      try {
        read = await this.#effects.stepChanges({
          ticket: id, service: this.#service(step.service), workdir: live.input.workdir,
          ...(step.kind === 'contract' ? { snapshot: posix.join(this.config.workdirRoot, id, '.validated', `step-${step.position}-${round}`) } : {}),
        });
      } catch (error) {
        return this.#failStep(step, `what it changed could not be read: ${name(error)}`);
      }
    }
    const cost = this.#stepCost(step);
    const minutes = this.#stepMinutes(step);
    if (step.kind === 'contract') {
      const contract = read?.contract;
      if (!contract) return this.#failStep(step, `${step.service} has no contract file to change`);
      const others = (read?.files ?? []).filter((file) => file !== contract.path);
      if (others.length > 0)
        return this.#failStep(step, `it changed ${others.join(', ')} besides the contract ${contract.path}. The contract step changes the contract file only: take those changes off the ticket branch before the ticket starts again.`);
      if (contract.diff.trim() === '') {
        this.#steps.update(step.id, { state: 'done', contract: contract.snapshot, blob: contract.blob, cost, minutes });
      } else {
        this.#steps.update(step.id, { state: 'validating', contract: contract.snapshot, blob: contract.blob, cost, minutes });
        this.inbox.addContract({ ticket: id, project, sessionId: live.id, step: step.id, service: step.service, path: contract.path, diff: this.#clean(contract.diff) });
        return;
      }
    } else {
      if (validated !== null && read?.contract && read.contract.blob !== validated)
        return this.#failStep(step, `it changed the validated contract ${read.contract.path} of ${step.service}. A change to the contract goes through the contract step: take it off the ticket branch before the ticket starts again.`);
      this.#steps.update(step.id, { state: 'done', cost, minutes });
    }
    await this.#runSteps(id);
  }

  // Every step is done: the ticket goes to review, once.
  async #stepsDone(id: TicketId): Promise<void> {
    if (this.#finishing.has(id)) return;
    this.#finishing.add(id);
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(id);
    if (!ticket) return;
    await tickets.move(id, tickets.states.review, SERVICE);
    const author = this.#lastSession(id, 'author');
    await this.#startReview(ticket, (author ? this.#inputs.get(author.id)?.input.workdir : undefined) ?? '');
  }

  // A step that cannot go on: it fails with its note, which its next run
  // reads; the ticket's other sessions stop, and the ticket goes back to
  // Todo, keeping the steps that are done.
  async #failStep(step: Step, why: string): Promise<void> {
    const note = this.#clean(this.#stepNote(step, why));
    this.#steps.update(step.id, { state: 'failed', note });
    for (const live of [...this.#live.values()].filter((l) => l.input.ticket === step.ticket)) await this.#close(live, 'stopped', note);
    await this.#putBack(step.ticket, note, 'step_failed');
  }

  #stepNote(step: Step, why: string): string {
    const what = stepName(step, this.#steps.list(step.ticket).length);
    return `${what[0]?.toUpperCase() ?? ''}${what.slice(1)} failed: ${why}`;
  }

  // What a step's sessions spent, to the cent; null before any ran.
  #stepCost(step: Pick<Step, 'sessions'>): number | null {
    if (step.sessions.length === 0) return null;
    let total = 0;
    for (const session of step.sessions)
      for (const { event } of this.#store.events.after(session)) if (event.type === 'RUN_FINISHED') total += event.result.total_cost_usd ?? 0;
    return Math.round(total * 100) / 100;
  }

  // How long a step's sessions ran, the history of the plans' step
  // estimates (lead/plans/estimates.ts): from each one's start to its last change.
  #stepMinutes(step: Pick<Step, 'sessions'>): number {
    let ms = 0;
    for (const id of step.sessions) {
      const row = this.#store.sessions.get(id);
      if (row) ms += Math.max(0, Date.parse(row.updatedAt) - Date.parse(row.createdAt));
    }
    return Math.round(ms / 600) / 100;
  }

  // The ticket's steps (GET /api/tickets/:id/steps): none for a ticket that
  // never ran in steps, undefined for a ticket the store does not know.
  async ticketSteps(id: TicketId): Promise<TicketStep[] | undefined> {
    const steps = this.#steps.list(id);
    if (steps.length === 0 && !(await this.registry.ticketStore.get(id))) return undefined;
    return steps.map((step) => publicStep(step, this.#stepCost(step)));
  }

  // The contract item and its step, or why it cannot be answered.
  #contractItem(id: string): Step {
    const item = this.inbox.item(id);
    if (!item || item.kind !== 'contract') throw new FlowError('not_found', `unknown contract item ${id}`);
    if (item.state !== 'waiting') throw new FlowError('conflict', `contract item ${id} is already answered`);
    const step = this.#steps.get(item.step);
    if (!step || step.ticket !== item.ticket || step.kind !== 'contract') throw new FlowError('conflict', `contract item ${id} names a step its ticket ${item.ticket} does not have`);
    if (step.state !== 'validating') throw new FlowError('conflict', `the contract step of ${item.ticket} is ${step.state}, not waiting for its validation`);
    return step;
  }

  // Approve (POST /api/contracts/:id/approve): the contract is validated as
  // proposed, and the steps after it start if the ticket runs, in the
  // background, since a click does not wait for clones and containers; a
  // ticket put back meanwhile goes on from them when it starts again.
  async approveContract(id: string, by: UserId): Promise<void> {
    const step = this.#contractItem(id);
    if (!this.inbox.handleContract(id, by, { decision: 'approve' })) throw new FlowError('conflict', `contract item ${id} is already answered`);
    this.#steps.update(step.id, { state: 'done' });
    this.#background(this.#runSteps(step.ticket), step.ticket);
  }

  #background(work: Promise<void>, ticket: TicketId): void {
    void this.#track(work.catch((error: unknown) => console.error(`cleared-v2: the steps of ${ticket} could not go on (${error instanceof Error ? error.name : typeof error})`)));
  }

  // Set aside (POST /api/tickets/:id/set-aside): the owner takes a ticket
  // out of the flow without starting it again, which a move to Todo would.
  // Its live sessions stop, everything of it that waits in the inbox is
  // settled, a train not yet approved is halted, its running steps wait,
  // and it is back in Todo with a comment. A done ticket keeps its state:
  // only what of it still waits (a knowledge item its handover proposed) is
  // settled. Nothing is merged or reverted: an approved ticket and a train
  // that lands are refused. The multi-service proof sets its earlier runs'
  // tickets aside, so that each run starts with nothing of theirs open
  // (scripts/proof-base.ts).
  async setAside(id: TicketId, by: UserId): Promise<{ readonly sessions: number; readonly items: number }> {
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(id);
    if (!ticket || ticket.project !== this.config.project) throw new FlowError('not_found', `unknown ticket ${id}`);
    if (ticket.status === tickets.states.go) throw new FlowError('conflict', `${id} is in “${ticket.status}”: it is not set aside`);
    if (this.#trains.latest(id)?.state === 'landing') throw new FlowError('conflict', `the train of ${id} is landing: it is not set aside`);
    const done = ticket.status === tickets.states.done;
    const note = 'The owner set this ticket aside: its sessions were stopped and nothing of it waits in the inbox. Move it to Todo to start it again.';
    // No step of it starts while its sessions stop.
    this.#active.delete(id);
    let sessions = 0;
    for (const live of [...this.#live.values()].filter((l) => l.input.ticket === id && !l.closed)) {
      this.#journal({ id: live.id, ticket: id, project: live.input.project }, { type: 'RUN_ERROR', message: 'The owner set the ticket aside: this session was stopped.', code: 'set_aside' });
      await this.#close(live, 'stopped', note);
      sessions++;
    }
    for (const dormant of [...this.#dormant.values()].filter((d) => d.input.ticket === id)) {
      this.#endDormant(dormant, 'stopped');
      sessions++;
    }
    let items = 0;
    for (const item of this.inbox.items()) {
      if (item.ticket !== id || item.state !== 'waiting') continue;
      if (item.kind === 'release' ? this.#settleRelease(item.id, id, ticket.project, by) : this.inbox.handle(item.id, by)) items++;
    }
    this.#trains.haltActive(id);
    if (done) return { sessions, items };
    if (ticket.status !== tickets.states.todo) await this.#putBack(id, note, 'set_aside');
    else {
      this.#origins.delete(id);
      this.#steps.hold(id);
      await tickets.comment(id, note, SERVICE).catch(() => undefined);
    }
    return { sessions, items };
  }

  // Send back (POST /api/contracts/:id/sendback): the contract step's
  // session is resumed with the message, or, when it cannot be, a new one
  // runs the step with it, in the background; a ticket put back runs it
  // when it starts again.
  async sendBackContract(id: string, message: string, by: UserId): Promise<void> {
    if (message.trim() === '') throw new FlowError('invalid', 'a Send back says what to change in the contract');
    const step = this.#contractItem(id);
    if (!this.inbox.handleContract(id, by, { decision: 'send_back', message })) throw new FlowError('conflict', `contract item ${id} is already answered`);
    if (!this.#active.has(step.ticket)) {
      this.#steps.update(step.id, { state: 'waiting', note: message });
      return;
    }
    this.#steps.update(step.id, { state: 'running', note: message });
    this.#background((async () => {
      if (await this.#reopenStep(step, contractSendBackMessage(message), by)) return;
      this.#steps.update(step.id, { state: 'waiting' });
      await this.#runSteps(step.ticket);
    })(), step.ticket);
  }

  // The step's last session resumed in its container, then told `text`; false when either fails.
  async #reopenStep(step: Step, text: string, by: UserId): Promise<boolean> {
    const adapter = this.registry.sessionAdapters[HARNESS];
    const kept = step.session ? this.#inputs.get(step.session) : undefined;
    if (!adapter || !kept || !step.session) return false;
    let handle: SessionHandle;
    try { handle = await this.#resume(adapter, step.session); } catch { return false; }
    const lastSeq = this.#store.events.after(step.session).at(-1)?.seq ?? 0;
    const live: Live = { id: step.session, input: kept.input, settings: kept.settings, handle, lastActivity: this.#now().getTime(), closed: false, waitOpen: false };
    this.#live.set(live.id, live);
    this.#stepOf.set(live.id, step.id);
    this.#flowOf(step.ticket).add(live.id);
    this.#setPhase(live, 'working');
    this.#step({ id: live.id, ticket: step.ticket, project: live.input.project }, 'STEP_STARTED', 'author');
    this.#snapshot(live.id, step.ticket);
    this.#supervise(live, lastSeq);
    try {
      await handle.send({ text, by });
      return true;
    } catch {
      live.closed = true;
      this.#live.delete(live.id);
      this.#stepOf.delete(live.id);
      await handle.stop().catch(() => undefined);
      this.#setPhase(live, 'done');
      return false;
    }
  }

  // Haiku for a Quick ticket, unless Haiku reviews it or a service it
  // touches is `full` (decision 24), which refuses the fast lane.
  #authorModel(ticket: Ticket): string {
    if (!ticket.labels.includes(QUICK_LABEL) || this.#reviewerModel(ticket) === QUICK_MODEL) return this.#chosenModel(ticket);
    return this.#servicesOf(ticket).some((service) => service.sensitivity === 'full') ? this.#chosenModel(ticket) : QUICK_MODEL;
  }

  // The configured author model, or the one the owner chose on the Consumption
  // screen, unless the ticket's reviewer is on that model: the reviewer is another one.
  #chosenModel(ticket: Ticket): string {
    const chosen = this.#levers?.read().model;
    return chosen && chosen !== this.#reviewerModel(ticket) ? chosen : this.config.authorModel;
  }

  // The reviewer a `reviewer:<model>` sensitivity names, on the first service
  // of the ticket that names one (decision 24); else the configured one. The
  // workspace's configuration refuses one naming the author model.
  #reviewerModel(ticket: Ticket): string {
    for (const service of this.#servicesOf(ticket)) if (service.sensitivity.startsWith('reviewer:')) return service.sensitivity.slice('reviewer:'.length);
    return this.config.reviewerModel;
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
    const stopped = this.#stopped();
    if (stopped.length > 0) await this.#releaseStopped(stopped);
  }

  // A resume starts a container under the session's own names while its
  // row may still say done or stopped: the release leaves it alone.
  async #resume(adapter: SessionAdapter, id: SessionId): Promise<SessionHandle> {
    this.#resuming.add(id);
    try { return await adapter.resume(id); } finally { this.#resuming.delete(id); }
  }

  // The containers and networks of the sessions this ledger says are not
  // live (stopped, done, failed, or just stopped by the recovery): a stop
  // whose removal failed, a session whose container exited, or what the last
  // process left, all of which fill Docker's address pool (issue 265). After
  // the recovery, every such session; at each tick, the ones that stopped in
  // the last RELEASE_WINDOW_MS, so a stop is released within a tick (30 s)
  // and retried for ten minutes. Only the ids of this ledger's own rows are
  // named, so another instance's sessions on the same host are never
  // touched, nor one this engine runs or resumes; the volumes stay. A
  // failure is said and the service goes on.
  #stopped(since?: string): SessionId[] {
    if (!this.#release) return [];
    return this.#store.sessions.list().filter((row) => row.project === this.config.project && !LIVE_PHASES.has(row.status) && !this.#live.has(row.id) && !this.#resuming.has(row.id)
      && (since === undefined || row.updatedAt >= since) && isSessionId(row.id)).map((row) => row.id);
  }

  async #releaseStopped(stopped: readonly SessionId[]): Promise<void> {
    const release = this.#release;
    if (!release) return;
    try {
      const { containers, networks } = await release(stopped);
      if (containers.length + networks.length > 0) console.error(`cleared-v2: released ${containers.length} container(s) and ${networks.length} network(s) of stopped sessions`);
    } catch (error) {
      console.error(`cleared-v2: the stopped sessions' containers and networks could not be released (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  // `author`: the author's host tools, with its session plan to propose
  // first (`plan`), or not again after a review (`report`, lane 17).
  // `step`: the service and the siblings of a step's session (lane 23).
  async #launch(adapter: SessionAdapter, ticket: Ticket, role: Role, model: string, workdir: string, briefing: Briefing, settings: ProjectSettings, prompt: string, author?: 'plan' | 'report', step?: { readonly service: string; readonly siblings?: readonly SiblingSpec[] }): Promise<Live> {
    // A train ticket's session works on the first service the ticket names (decision 20, lane 15's runtime), a step's on its own.
    const service = step?.service ?? (this.#several ? this.#servicesOf(ticket)[0]?.name : undefined);
    const tools = author ? this.#authorTools(ticket, author === 'plan') : undefined;
    const input: StartInput = {
      project: this.config.project, ticket: ticket.id, role, harness: HARNESS, model, workdir, briefing,
      policy: this.#policy(role, settings, tools), prompt, services: settings.services, ...(service ? { service } : {}), ...(tools ? { tools } : {}),
      ...(step?.siblings ? { siblings: step.siblings } : {}),
    };
    const handle = await adapter.start(input);
    // The fake adapter plays a first turn's host calls inside start(): the gate may exist already.
    if (author === 'plan' && !this.#gates.has(handle.id)) this.#gates.set(handle.id, { phase: 'planning', stepOpen: false });
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
    return { ...input.policy, learned: [...this.#store.policyRules.learned(input.project), ...toolRules(input.tools)], ticketFiles: this.#ticketFiles(input.ticket) };
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

  #policy(role: Role, settings: ProjectSettings, tools?: readonly HostTool[]): Policy {
    return {
      role, base: this.config.base, workdir: WORKDIR_MOUNT, scripts: settings.scripts, credentialFile: LOGIN_FILE_MOUNT,
      safeCommands: [...DEFAULT_SAFE_COMMANDS, ...settings.safeCommands], allowedHosts: settings.hosts, forbiddenHosts: [],
      ticketFiles: [], learned: [...this.#store.policyRules.learned(this.config.project), ...toolRules(tools)],
      ...(role === 'reviewer' && settings.testCommand ? { testCommand: settings.testCommand } : {}),
    };
  }

  // ---- the author's host tools and its session plan (lane 17) ------------------

  // The tools of one author session. Its id is the call's: the fake adapter
  // plays a first turn's calls before start() returns, so nothing here reads
  // the session's row or its Live. `plan`: this author proposes its plan
  // first; a new author after a review does not.
  #authorTools(ticket: Ticket, plan: boolean): HostTool[] {
    const project = this.config.project;
    return bindAuthorTools({
      propose_session_plan: async (input, context) => {
        if (!plan) throw new HostToolRefused(NOT_AGAIN);
        const gate = this.#gates.get(context.sessionId) ?? { phase: 'planning' as const, stepOpen: false };
        this.#gates.set(context.sessionId, gate);
        if (gate.phase === 'working') throw new HostToolRefused(NOT_NOW);
        const read = readSessionPlan(input);
        const proposal: SessionPlan = {
          steps: read.steps.map(this.#clean), files: read.files.map(this.#clean), confidence: read.confidence, reason: this.#clean(read.reason),
          proposedAt: this.#at(), go: null,
        };
        // A plan proposed again while the last one waits (the owner wrote to the author) replaces it.
        if (gate.phase === 'held') {
          const waiting = this.inbox.sessionPlan(context.sessionId);
          if (waiting) this.inbox.handle(waiting.id, 'system');
          gate.plan = undefined;
          gate.phase = 'planning';
        }
        gate.pending = proposal;
        this.#journal({ id: context.sessionId, ticket: ticket.id, project }, { type: 'CUSTOM', name: 'cleared.session_plan', value: proposal });
        return PROPOSED;
      },
      report_changes: async (input, context) => {
        const read = readChangesReport(input, this.#ticketFiles(ticket.id));
        const report = { groups: read.groups.map((g) => ({ intent: this.#clean(g.intent), files: g.files.map(this.#clean) })) };
        // On the session that called: the publish step reads the last author's last one (release/flags.ts).
        this.#journal({ id: context.sessionId, ticket: ticket.id, project }, { type: 'CUSTOM', name: 'cleared.changes', value: report });
        const count = report.groups.length;
        return `Your report is kept: ${count} group${count === 1 ? '' : 's'}.`;
      },
    });
  }

  // True while the session's plan, or its want of one, holds it.
  #holds(id: SessionId): boolean {
    const phase = this.#gates.get(id)?.phase;
    return phase === 'held' || phase === 'unplanned';
  }

  // The end of an author's turn while its plan has no Go: the hold begins,
  // or goes on. True when the turn is not the end of the author's work.
  async #gateHolds(live: Live): Promise<boolean> {
    const gate = this.#gates.get(live.id);
    if (!gate || gate.phase === 'working') return false;
    const session = { id: live.id, ticket: live.input.ticket, project: live.input.project };
    if (!gate.stepOpen) {
      this.#step(session, 'STEP_FINISHED', 'author');
      this.#step(session, 'STEP_STARTED', 'plan_gate');
      gate.stepOpen = true;
    }
    const now = this.#now().getTime();
    if (gate.pending) {
      gate.plan = gate.pending;
      gate.pending = undefined;
      gate.phase = 'held';
      gate.heldAt = now;
      if (this.#origins.has(live.input.ticket) && gate.plan.confidence === 'high') {
        await this.#go(live, 'lead');
        return true;
      }
      // The session's own service: a step's, or the ticket's first (#launch).
      const service = this.#several ? live.input.service : undefined;
      this.inbox.addSessionPlan({ ticket: session.ticket, project: session.project, sessionId: live.id, plan: gate.plan, ...(service ? { service } : {}) });
      this.#setPhase(live, 'waiting_human');
      this.#snapshot(live.id, live.input.ticket);
      return true;
    }
    if (gate.phase === 'planning') {
      gate.phase = 'unplanned';
      gate.heldAt = now;
    }
    return true;
  }

  async #ticketOf(id: TicketId): Promise<Ticket> {
    const ticket = await this.registry.ticketStore.get(id);
    if (!ticket) throw new FlowError('not_found', `unknown ticket ${id}`);
    return ticket;
  }

  // What the delay decides at this tick: a high plan that waited its delay
  // gets its Go (`go`); a session that proposed none in its delay is put back.
  #dueGates(now: number): { live: Live; minutes: number; go: boolean }[] {
    const due: { live: Live; minutes: number; go: boolean }[] = [];
    for (const live of [...this.#live.values(), ...this.#dormant.values()]) {
      const gate = this.#gates.get(live.id);
      if ((live.closed && !this.#dormant.has(live.id)) || !gate || gate.heldAt === undefined || this.#paused.has(live.id)) continue;
      const minutes = live.settings.planGoMinutes ?? PLAN_GO_MINUTES;
      if (now < gate.heldAt + minutes * 60_000) continue;
      if (gate.phase === 'held' && gate.plan?.confidence === 'high') due.push({ live, minutes, go: true });
      else if (gate.phase === 'unplanned') due.push({ live, minutes, go: false });
    }
    return due;
  }

  // The Go: the plan journaled again with who and when, the gate closed, the
  // item handled, and the author told to carry the plan out.
  async #go(live: Live, by: GoBy): Promise<void> {
    const gate = this.#gates.get(live.id);
    if (!gate || gate.phase !== 'held' || !gate.plan) throw new FlowError('conflict', `session ${live.id} has no session plan waiting for its Go`);
    const session = { id: live.id, ticket: live.input.ticket, project: live.input.project };
    const plan: SessionPlan = { ...gate.plan, go: { by, at: this.#at() } };
    gate.phase = 'working';
    gate.plan = undefined;
    gate.heldAt = undefined;
    this.#journal(session, { type: 'CUSTOM', name: 'cleared.session_plan', value: plan });
    const waiting = this.inbox.sessionPlan(live.id);
    if (waiting) this.inbox.handle(waiting.id, by === 'delay' || by === 'lead' ? 'system' : by);
    if (gate.stepOpen) {
      this.#step(session, 'STEP_FINISHED', 'plan_gate');
      this.#step(session, 'STEP_STARTED', 'author');
      gate.stepOpen = false;
    }
    this.#setPhase(live, 'working');
    this.#snapshot(live.id, live.input.ticket);
    live.lastActivity = this.#now().getTime();
    const minutes = live.settings.planGoMinutes ?? PLAN_GO_MINUTES;
    const dormant = this.#dormant.get(live.id);
    if (dormant) {
      await this.#wake(dormant, goMessage(by, minutes, this.#origins.get(live.input.ticket)));
      return;
    }
    try {
      await live.handle.send({ text: goMessage(by, minutes, this.#origins.get(live.input.ticket)), by: FLOW_USER });
    } catch (error) {
      await this.#stopTicket(live, 'error', `The Go could not reach the session: ${name(error)}`, `The session plan had its Go, but the session could not be told: ${name(error)}`, 'failed', 'failed');
    }
  }

  // The owner's Go, from the session plan's inbox item (POST /api/sessions/:id/plan/go).
  async planGo(id: SessionId, by: UserId): Promise<void> {
    await this.#go(this.#dormant.get(id) ?? this.#writable(id), by);
  }

  // The owner's Change: the plan's item handled, and the author reopened with
  // the message; its next proposal replaces the plan (POST .../plan/change).
  async planChange(id: SessionId, message: string, by: UserId): Promise<void> {
    if (message.trim() === '') throw new FlowError('invalid', 'a Change says what to change in the plan');
    const dormant = this.#dormant.get(id);
    const live = dormant ?? this.#writable(id);
    const gate = this.#gates.get(id);
    if (!gate || gate.phase !== 'held' || !gate.plan) throw new FlowError('conflict', `session ${id} has no session plan waiting for its Go`);
    const waiting = this.inbox.sessionPlan(id);
    if (waiting) this.inbox.handle(waiting.id, by);
    gate.phase = 'planning';
    gate.plan = undefined;
    gate.heldAt = undefined;
    this.#setPhase(live, 'working');
    this.#snapshot(id, live.input.ticket);
    live.lastActivity = this.#now().getTime();
    if (dormant) await this.#wake(dormant, changeMessage(message), by);
    else await live.handle.send({ text: changeMessage(message), by });
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
          const questions = event.value.questions;
          const item = this.inbox.addQuestion({ ticket: session.ticket, project: session.project, sessionId: live.id, requestId: event.value.requestId, questions, timeout: (since) => this.#questionTimeout(since, questions, live.settings) });
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

    // A schedule's plan gives its tickets the schedule's budget (lane 26).
    const budget = this.#origins.get(session.ticket)?.budgetUsd ?? this.config.budgetUsd;
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
    // Nor one of a session the owner took over: Give back decides what comes next.
    if (this.#paused.has(live.id)) return;
    if (live.input.role === 'author' && await this.#gateHolds(live)) return;
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
    this.#paused.delete(live.id);
    if (live.waitOpen) {
      live.waitOpen = false;
      this.#step({ id: live.id, ticket: live.input.ticket, project: live.input.project }, 'STEP_FINISHED', 'waiting_human');
    }
    // A gate that closes with its session: its step ends; a plan that had
    // its Go is remembered, so that a resumed author does not propose again.
    const gate = this.#gates.get(live.id);
    if (gate?.stepOpen) {
      gate.stepOpen = false;
      this.#step({ id: live.id, ticket: live.input.ticket, project: live.input.project }, 'STEP_FINISHED', 'plan_gate');
    }
    if (gate && gate.phase !== 'working') this.#gates.delete(live.id);
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
  // A step's session that stops so fails its step, named in the note; a
  // failure of its own is the step's (lane 23).
  async #stopTicket(from: Live, code: string | undefined, runMessage: string | undefined, note: string, phase: 'stopped' | 'failed', reason: PutBackReason): Promise<void> {
    const ticket = from.input.ticket;
    const stepId = this.#stepOf.get(from.id);
    const step = stepId ? this.#steps.get(stepId) : undefined;
    if (step && step.state === 'running' && this.#steps.list(ticket).length > 1) {
      note = this.#clean(this.#stepNote(step, note));
      this.#steps.update(step.id, { state: 'failed', note });
      if (reason === 'failed') reason = 'step_failed';
    }
    for (const live of [...this.#live.values()].filter((l) => l.input.ticket === ticket)) {
      if (live.closed) continue;
      if (code !== undefined && runMessage !== undefined)
        this.#journal({ id: live.id, ticket, project: live.input.project }, { type: 'RUN_ERROR', message: this.#clean(runMessage), code });
      await this.#close(live, live.id === from.id ? phase : 'stopped', note);
    }
    // A session the watchdog stopped has no container left: what it waited for goes with it.
    for (const dormant of [...this.#dormant.values()].filter((d) => d.input.ticket === ticket)) {
      if (code !== undefined && runMessage !== undefined)
        this.#journal({ id: dormant.id, ticket, project: dormant.input.project }, { type: 'RUN_ERROR', message: this.#clean(runMessage), code });
      this.#endDormant(dormant, dormant.id === from.id ? phase : 'stopped');
    }
    await this.#putBack(ticket, note, reason);
  }

  // True when the ticket was moved: `ticket_put_back` is said only then.
  async #putBack(ticket: TicketId, note: string, reason: PutBackReason): Promise<boolean> {
    const tickets = this.registry.ticketStore;
    for (const dormant of [...this.#dormant.values()].filter((d) => d.input.ticket === ticket)) this.#endDormant(dormant, 'stopped');
    this.#active.delete(ticket);
    this.#origins.delete(ticket);
    this.#channels.delete(ticket);
    this.#repairs.delete(ticket);
    this.#steps.hold(ticket);
    await tickets.comment(ticket, this.#clean(note), SERVICE)
      .catch((error: unknown) => console.error(`cleared-v2: the ${reason} note could not be written on ${ticket} (${error instanceof Error ? error.name : typeof error})`));
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

  // A step's author of a ticket in steps ends its step (lane 23); a
  // one-service ticket's one step is done with its author.
  async #authorDone(author: Live): Promise<void> {
    const { ticket: id, project } = author.input;
    const stepId = this.#stepOf.get(author.id);
    const step = stepId ? this.#steps.get(stepId) : undefined;
    if (step && step.state === 'running' && this.#steps.list(id).length > 1) return this.#stepDone(author, step);
    const session = { id: author.id, ticket: id, project };
    this.#step(session, 'STEP_FINISHED', 'author');
    await this.#close(author, 'done');
    if (step) this.#steps.update(step.id, { state: 'done', cost: this.#stepCost(step) ?? 0, minutes: this.#stepMinutes(step) });
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
    const open = this.#channels.get(id);
    if (open) {
      this.#channels.delete(id);
      return this.#answerReviewer(ticket, author, open);
    }
    await this.#startReview(ticket, author.input.workdir);
  }

  // `channel`: a reviewer started again because the last one could not be
  // resumed is given the channel so far, and its last message, the
  // author's answer, is journaled on it.
  async #startReview(ticket: Ticket, workdir: string, channel?: readonly ChannelMessage[]): Promise<void> {
    const adapter = this.registry.sessionAdapters[HARNESS];
    const began = this.#now();
    try {
      if (!adapter) throw new FlowError('unavailable', `no adapter for ${HARNESS} is registered`);
      const settings = await this.#settings(ticket);
      const prepared = this.#several
        ? await this.#effects.prepareWorkdir({ ticket, role: 'reviewer', service: this.#servicesOf(ticket)[0] as ServiceConfig })
        : await this.#effects.prepareWorkdir({ ticket, role: 'reviewer' });
      // The files a person changed in the author's checkouts (decision 33): every author session of the flow, a ticket in steps having several.
      const edits = this.#flowRows(ticket.id).filter((row) => row.role === 'author').flatMap((row) => humanEdits({ events: this.#store.events.after(row.id) }));
      // The reviewer's git commands name its own service's base.
      const base = this.#several ? (this.#servicesOf(ticket)[0] as ServiceConfig).base : this.config.base;
      const prompt = reviewPrompt({ ticket, base, verdict: settings.verdict, humanEdits: edits, ...(await this.#reviewServices(ticket)), ...(settings.testCommand ? { testCommand: settings.testCommand } : {}) });
      const live = await this.#launch(adapter, ticket, 'reviewer', this.#reviewerModel(ticket), prepared.workdir || workdir, prepared.briefing, settings,
        channel ? `${prompt}\n\n${channelPrompt(channel)}` : prompt);
      this.#step({ id: live.id, ticket: ticket.id, project: ticket.project ?? this.config.project }, 'STEP_STARTED', 'review', began);
      const answer = channel?.at(-1);
      if (answer) this.#journal({ id: live.id, ticket: ticket.id, project: live.input.project }, { type: 'CUSTOM', name: 'cleared.review_channel', value: answer });
      this.#snapshot(live.id, ticket.id);
      this.#supervise(live, 0);
    } catch (error) {
      await this.#putBack(ticket.id, `The review could not start: ${name(error)}`, 'review_failed');
    }
  }

  // The reviewer of a ticket of several services is given every service's
  // change and the contracts' (owner decision of 2026-10-22 20:33): it works
  // in the first service's checkout, and judges the criteria on the whole.
  // A service whose change cannot be read stops the review from starting
  // (the caller puts the ticket back), so no review runs on half the change.
  async #reviewServices(ticket: Ticket): Promise<{ services?: ReviewService[]; contracts?: ReviewContract[] }> {
    const services = this.#several ? this.#servicesOf(ticket) : [];
    if (services.length < 2) return {};
    const read = this.#effects.branchChanges;
    const approved = this.inbox.contracts({ ticket: ticket.id, state: 'handled' }).filter((item) => item.outcome?.decision === 'approve');
    const out: ReviewService[] = [];
    const contracts: ReviewContract[] = [];
    for (const [n, service] of services.entries()) {
      let change: { files: readonly string[]; diff: string } | null = null;
      if (read) {
        try {
          const got = await read({ ticket: ticket.id, service });
          change = { files: got.files, diff: this.#clean(got.diff) };
        } catch (error) {
          throw new FlowError('unavailable', `the change of ${service.name} could not be read: ${name(error)}`);
        }
      }
      const path = this.#contractPath(service);
      if (change && path && change.files.includes(path)) {
        contracts.push({ service: service.name, path, diff: fileDiff(change.diff, path), validated: approved.some((item) => item.service === service.name && item.path === path) });
        change = { files: change.files, diff: withoutFile(change.diff, path) };
      }
      out.push({ name: service.name, base: service.base, checkout: n === 0, change });
    }
    return { services: out, contracts };
  }

  // A service's contract file as a path of its repository, as a diff names
  // it: a folder service's is inside its folder (release/order.ts).
  #contractPath(service: ServiceConfig): string | undefined {
    if (!service.contract) return undefined;
    return service.kind === 'folder' && service.path ? posix.join(service.path, service.contract.path) : service.contract.path;
  }

  // ---- the reviewer is done: verdict ---------------------------------------

  async #reviewDone(reviewer: Live): Promise<void> {
    const { ticket: id, project } = reviewer.input;
    const session = { id: reviewer.id, ticket: id, project };
    // A resumed reviewer's report is the one of its new turn.
    const report = lastReport(this.#store.events.after(reviewer.id, reviewer.turnFrom ?? 0));
    const parsed = report === undefined ? undefined : parseVerdict(report, reviewer.settings.verdict);
    this.#step(session, 'STEP_FINISHED', 'review');
    await this.#close(reviewer, 'done');
    if (report === undefined || parsed === undefined) {
      await this.#putBack(id, 'The review gave no verdict (no "Verdict:" line in its report), so nothing was published. Move the ticket to Todo to run it again.', 'no_verdict');
      return;
    }
    // A round is a verdict: a resumed reviewer gives several in one session.
    const round = this.#rounds(id) + 1;
    // The declared tests as the session ran them in this turn (issue #268).
    const run = testRunOf(this.#store.events.after(reviewer.id, reviewer.turnFrom ?? 0), reviewer.settings.testCommand);
    const tests = run && { ...run, ...(run.tail === undefined ? {} : { tail: this.#clean(run.tail) }) };
    this.#journal(session, { type: 'CUSTOM', name: 'cleared.review_verdict', value: { session: reviewer.id, verdict: parsed.verdict, round, ...(tests ? { tests } : {}) } });
    this.#emit({ type: 'review_verdict', at: this.#at(), project, ticket: id, session: reviewer.id, verdict: parsed.verdict, round });
    if (tests) await this.registry.ticketStore.comment(id, testComment(tests, round), SERVICE).catch(() => undefined);
    if (parsed.verdict === 'pass') return this.#publishAndAsk(reviewer, tests ? `${report}\n\n${testLine(tests)}` : report, round);
    const limit = this.config.maxReviewRounds;
    if (round >= limit) {
      await this.#putBack(id, `The review still asked for changes after ${round} review round${round === 1 ? '' : 's'}, so the ticket goes back to Todo. The last report:\n\n${report}`, 'too_many_rounds');
      return;
    }
    const request: ChannelMessage = { round, limit, from: 'reviewer', text: this.#clean(tests ? `${report}\n\n${testLine(tests)}` : report) };
    this.#journal(session, { type: 'CUSTOM', name: 'cleared.review_channel', value: request });
    await this.#reopenAuthor(reviewer, report, request);
  }

  // The verdicts the reviewers of the ticket's current flow gave.
  #rounds(ticket: TicketId): number {
    return this.#flowRows(ticket).filter((row) => row.role === 'reviewer').reduce((n, row) => n + verdictsOf(this.#store.events.after(row.id)), 0);
  }

  // The request goes to the author through the channel: the author's
  // session resumed, else a new one; its answer goes back to `reviewer`
  // when its turn ends (#authorDone).
  async #reopenAuthor(reviewer: Live, report: string, request: ChannelMessage): Promise<void> {
    const { round } = request;
    const id = reviewer.input.ticket;
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(id);
    const authorRow = this.#lastSession(id, 'author');
    const adapter = this.registry.sessionAdapters[HARNESS];
    if (!ticket || !adapter) {
      await this.#putBack(id, 'The author could not be reopened: the ticket or the adapter is gone.', 'reopen_failed');
      return;
    }
    await tickets.move(id, tickets.states.progress, SERVICE);
    // Set before the author can answer: a scripted turn ends inside send().
    this.#channels.set(id, { reviewer: reviewer.id, round });
    const message = reviewRequestMessage(report, round, request.limit);
    try {
      await this.#reopenWith(ticket, adapter, authorRow, message, { type: 'CUSTOM', name: 'cleared.review_channel', value: request });
    } catch (error) {
      await this.#putBack(id, `The author could not be reopened after the review: ${name(error)}`, 'reopen_failed');
    }
  }

  // Reopening is resume, then `message` as the next message. Either
  // failing (another process started the session, its container is gone)
  // falls back to a new author, told the ticket and `message`; what that
  // start throws is the caller's. `journal`: written on the author's session.
  async #reopenWith(ticket: Ticket, adapter: SessionAdapter, authorRow: { readonly id: SessionId } | undefined, message: string, journal?: AgUiEvent): Promise<void> {
    const id = ticket.id;
    const kept = authorRow ? this.#inputs.get(authorRow.id) : undefined;
    const began = this.#now();
    const lastSeq = authorRow ? (this.#store.events.after(authorRow.id).at(-1)?.seq ?? 0) : 0;
    if (authorRow && kept) {
      let handle: SessionHandle | undefined;
      try { handle = await this.#resume(adapter, authorRow.id); } catch { handle = undefined; }
      if (handle) {
        const live: Live = { id: authorRow.id, input: kept.input, settings: kept.settings, handle, lastActivity: this.#now().getTime(), closed: false, waitOpen: false, turnFrom: lastSeq };
        this.#live.set(live.id, live);
        this.#setPhase(live, 'working');
        this.#step({ id: live.id, ticket: id, project: live.input.project }, 'STEP_STARTED', 'author', began);
        if (journal) this.#journal({ id: live.id, ticket: id, project: live.input.project }, journal);
        this.#supervise(live, lastSeq);
        try {
          await handle.send({ text: message, by: FLOW_USER });
          return;
        } catch {
          live.closed = true;
          this.#live.delete(live.id);
          await handle.stop().catch(() => undefined);
          this.#setPhase(live, 'done');
        }
      }
    }
    const settings = kept?.settings ?? (await this.#settings(ticket));
    const prepared = await this.#prepare(ticket, 'author');
    const tools = this.config.authorTools === true;
    const live = await this.#launch(adapter, ticket, 'author', this.#authorModel(ticket), prepared.workdir, prepared.briefing, settings,
      `${authorPrompt(ticket, { plan: false, report: tools })}\n\n${message}`, tools ? 'report' : undefined);
    this.#step({ id: live.id, ticket: id, project: live.input.project }, 'STEP_STARTED', 'author', began);
    if (journal) this.#journal({ id: live.id, ticket: id, project: live.input.project }, journal);
    this.#snapshot(live.id, id);
    this.#supervise(live, 0);
  }

  // The author's answer goes back through the channel: to the reviewer
  // that asked, resumed under its own id, which gives its next verdict;
  // else to a new reviewer, given the channel so far.
  async #answerReviewer(ticket: Ticket, author: Live, open: { readonly reviewer: SessionId; readonly round: number }): Promise<void> {
    const id = ticket.id;
    const limit = this.config.maxReviewRounds;
    const answer: ChannelMessage = { round: open.round, limit, from: 'author', text: this.#clean(lastSaid(this.#store.events.after(author.id, author.turnFrom ?? 0)) ?? NO_ANSWER) };
    this.#journal({ id: author.id, ticket: id, project: author.input.project }, { type: 'CUSTOM', name: 'cleared.review_channel', value: answer });
    const adapter = this.registry.sessionAdapters[HARNESS];
    const kept = this.#inputs.get(open.reviewer);
    const began = this.#now();
    if (adapter && kept) {
      const lastSeq = this.#store.events.after(open.reviewer).at(-1)?.seq ?? 0;
      let handle: SessionHandle | undefined;
      try { handle = await this.#resume(adapter, open.reviewer); } catch { handle = undefined; }
      if (handle) {
        const live: Live = { id: open.reviewer, input: kept.input, settings: kept.settings, handle, lastActivity: this.#now().getTime(), closed: false, waitOpen: false, turnFrom: lastSeq };
        const session = { id: live.id, ticket: id, project: live.input.project };
        this.#live.set(live.id, live);
        this.#setPhase(live, 'reviewing');
        this.#step(session, 'STEP_STARTED', 'review', began);
        this.#journal(session, { type: 'CUSTOM', name: 'cleared.review_channel', value: answer });
        this.#snapshot(live.id, id);
        this.#supervise(live, lastSeq);
        try {
          await handle.send({ text: answerMessage(answer.text, open.round, limit), by: FLOW_USER });
          return;
        } catch {
          live.closed = true;
          this.#live.delete(live.id);
          await handle.stop().catch(() => undefined);
          this.#step(session, 'STEP_FINISHED', 'review');
          this.#setPhase(live, 'done');
        }
      }
    }
    // What the ticket's reviewers sent and were sent so far, then the answer
    // (journaled already on a reviewer resumed whose send failed).
    const channel = this.#flowRows(id).filter((row) => row.role === 'reviewer').flatMap((row) => channelOf(this.#store.events.after(row.id)))
      .filter((m) => !(m.from === 'author' && m.round === answer.round));
    await this.#startReview(ticket, author.input.workdir, [...channel, answer]);
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
      // The engine's line of the declared tests, the report's last (issue #268).
      ...report.split('\n').filter((line) => line.startsWith('Tests: ')).slice(-1),
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
    const card = flags({ diff: changed?.diff ?? '', ...this.#report(id), ...this.#guarded(ticket, [reviewer.settings]) });
    // A repair's commit: the new card carries its attempt (issue #273).
    const started = this.#repairs.get(id);
    this.#repairs.delete(id);
    const repair: CiRepair | undefined = started && { ...started, state: 'pushed', at: this.#at() };
    const item = this.inbox.addRelease({
      ticket: id, project, title: ticket.title, announcement, requestedAt,
      pr: { number: published.number, url: published.url, checks: 'pending' },
      heads: [{ pr: published.number, head: published.head }],
      captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } },
      sessions: this.#releaseSessions(id, round), groups: card.groups, flags: card.flags, ...(repair ? { repair } : {}),
    }, reviewer.id);
    if (repair) await this.#repairSaid(item, repair);
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

  // What the card's flags read beside the diff (issue 205): the contract
  // files of the ticket's services, and their `[merge] guarded_paths`.
  #guarded(ticket: Ticket, settings: readonly (ProjectSettings | undefined)[]): { contracts: string[]; guarded: string[] } {
    // As paths of the repository, as the diff's are.
    const contracts = this.#servicesOf(ticket).flatMap((service) => { const path = this.#contractPath(service); return path ? [path] : []; });
    return { contracts: [...new Set(contracts)], guarded: [...new Set(settings.flatMap((s) => s?.guardedPaths ?? []))] };
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
      // The engine's line of the declared tests, the report's last (issue #268).
      ...report.split('\n').filter((line) => line.startsWith('Tests: ')).slice(-1),
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
    const settings = await Promise.all(published.map((p) => this.#effects.settings(p.service).catch(() => undefined)));
    const card = flags({ diff: published.map((p) => p.diff).join(''), ...this.#report(id), ...this.#guarded(ticket, settings) });
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
    this.#trains.haltActive(id);
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
    const dormant = this.#dormant.get(id);
    if (dormant) return this.#wake(dormant, text, by);
    const live = this.#writable(id);
    live.lastActivity = this.#now().getTime();
    await live.handle.send({ text, by });
    if (this.#store.sessions.get(id)?.status === 'waiting_human' && this.inbox.waitingFor(id) === 0) this.#setPhase(live, live.input.role === 'reviewer' ? 'reviewing' : 'working');
  }

  async answer(id: SessionId, requestId: string, decision: Decision, by: UserId): Promise<void> {
    const dormant = this.#dormant.get(id);
    if (dormant) return this.#answerStopped(dormant, requestId, decision, by);
    const live = this.#writable(id);
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

  // ---- a plan that does not freeze on a person (issue #290) -----------------

  // A team's question's delay, from when it was asked, and what its end
  // applies: the asking session's project's own (issue #269, its service's
  // [session] question_timeout_minutes and question_default), else the
  // service's.
  #questionTimeout(since: Date, questions: readonly Question[], settings: ProjectSettings): QuestionTimeout {
    const wait = settings.questionTimeoutMinutes !== undefined ? settings.questionTimeoutMinutes * 60_000 : this.config.questionTimeoutMs ?? QUESTION_TIMEOUT_MINUTES * 60_000;
    const lead = this.config.questionLeadMs ?? QUESTION_LEAD_MINUTES * 60_000;
    const rule = settings.questionDefault ?? 'recommended';
    return {
      at: new Date(since.getTime() + wait).toISOString(), leadUntil: new Date(since.getTime() + wait + lead).toISOString(), answers: defaultAnswers(questions, rule),
      ...(rule === 'recommended' ? {} : { rule }),
    };
  }

  // Each waiting question of a session this engine runs, awake or stopped by
  // the watchdog, past its delay: the lead is asked once, here; past the
  // lead's window, it is due, for its declared answer or its ticket's park.
  // A session the owner took over waits for the owner.
  #dueQuestions(now: number): { live: Live; item: QuestionItem; minutes: number }[] {
    const lead = this.config.questionLeadMs ?? QUESTION_LEAD_MINUTES * 60_000;
    const due: { live: Live; item: QuestionItem; minutes: number }[] = [];
    for (const item of this.inbox.waitingQuestions(this.config.project)) {
      const timeout = item.timeout;
      const live = this.#live.get(item.sessionId) ?? this.#dormant.get(item.sessionId);
      if (!timeout || !live || this.#paused.has(live.id) || now < Date.parse(timeout.at)) continue;
      const minutes = Math.round((now - Date.parse(item.since)) / 60_000);
      if (!timeout.leadAt) this.#questionToLead(item, timeout, now, lead, minutes);
      else if (now >= Date.parse(timeout.leadAt) + lead) due.push({ live, item, minutes });
    }
    return due;
  }

  #questionTimedOut(item: QuestionItem, stage: 'lead' | 'default' | 'parked', minutes: number, answers: Readonly<Record<string, string>> | null): void {
    const at = this.#at();
    const kind = stage === 'lead' ? 'question_to_lead' : stage === 'default' ? 'question_default' : 'question_parked';
    ledgerEvent(this.#store.db, { at, kind, ticket: item.ticket, source: 'flow', detail: { session: item.sessionId, requestId: item.requestId, item: item.id, minutes, ...(stage === 'default' ? { answers } : {}) } });
    this.#emit({
      type: 'question_timed_out', at, project: item.project, ticket: item.ticket, session: item.sessionId, requestId: item.requestId, item: item.id,
      stage, minutes, leadMinutes: Math.round((this.config.questionLeadMs ?? QUESTION_LEAD_MINUTES * 60_000) / 60_000), questions: item.questions.map((q) => q.question), answers,
    });
  }

  // The lead decides now (lead/engine.ts says it in its thread and gives it a turn); the owner still may.
  #questionToLead(item: QuestionItem, timeout: QuestionTimeout, now: number, lead: number, minutes: number): void {
    this.inbox.questionToLead(item.id, new Date(now).toISOString(), new Date(now + lead).toISOString());
    this.#questionTimedOut(item, 'lead', minutes, timeout.answers);
  }

  // The answer the session declared, applied as a policy's answer under
  // QUESTION_DEFAULT and said on the ticket, in the ledger and on the bus.
  async #applyDeclared(live: Live, item: QuestionItem, answers: Readonly<Record<string, string>>, minutes: number): Promise<void> {
    const waited = `${asked(item.questions)} waited ${duration(minutes)} with no answer from the owner or the lead`;
    const first = item.timeout?.rule === 'first';
    await this.registry.ticketStore.comment(item.ticket, this.#clean(`${waited}: ${first ? 'the project\'s default answer applies (the recommended option, else the first)' : 'the answer the session declared applies'}.\n${answerLines(answers)}`), SERVICE)
      .catch((error: unknown) => console.error(`cleared-v2: the declared answer of ${item.id} could not be said on ${item.ticket} (${error instanceof Error ? error.name : typeof error})`));
    this.#questionTimedOut(item, 'default', minutes, answers);
    const answer: Answer = { decision: { kind: 'answer', answers }, by: 'policy', rule: QUESTION_DEFAULT };
    const dormant = this.#dormant.get(live.id);
    if (dormant) {
      if (!this.#settleStopped(dormant, item, answer.decision, 'policy')) return;
      await this.#wake(dormant, `${waited}, so ${first ? 'the project\'s default, the option you recommended else the first one,' : 'the default you declared, the option you recommended,'} applies:\n${answerLines(answers)}\nCarry on with it.`);
      return;
    }
    try {
      await live.handle.answer(item.requestId, answer);
    } catch (error) {
      // The harness lost the request: the ticket cannot be told, so it is parked.
      console.error(`cleared-v2: the declared answer of ${item.id} could not be given (${error instanceof Error ? error.name : typeof error})`);
      await this.#park(live, item, minutes);
      return;
    }
    if (this.inbox.handle(item.id, 'policy')) this.#answered(item.id, item.ticket, live.id, item.requestId, 'policy');
    this.#waitEnds(live);
  }

  // No declared answer: the ticket is parked, its sessions stopped with what
  // a resume needs (the adapter keeps the volume), its slot in the plan free.
  async #park(live: Live, item: QuestionItem, minutes: number): Promise<void> {
    const waited = `${asked(item.questions)} waited ${duration(minutes)} with no answer from the owner or the lead`;
    this.#questionTimedOut(item, 'parked', minutes, null);
    await this.#stopTicket(live, 'parked', `${waited}: the session was stopped and its ticket parked.`,
      `${waited}, and ${item.timeout?.rule === 'park' ? 'the project\'s default is to park' : 'the session declared no answer'}: the ticket is parked, its session stopped with what a resume needs. The rest of the plan goes on; start it again with the answer.`, 'stopped', 'parked');
  }

  // The watchdog's question (session/watchdog.ts): this engine stops a
  // session of its own the watchdog found idle. One that waits for a person
  // is stopped keeping what a resume needs (#suspend); one that waits for
  // nothing is stopped as the idle rule stops it, its ticket put back. One
  // the owner took over is the human's, and one a resume starts is moving.
  // 'unknown': this engine does not run it.
  async idleStop(id: SessionId): Promise<'stopped' | 'skipped' | 'unknown'> {
    if (this.#dormant.has(id)) return 'skipped';
    const live = this.#live.get(id);
    if (!live || live.closed) return 'unknown';
    if (this.#paused.has(id) || this.#resuming.has(id)) return 'skipped';
    if (this.inbox.waitingFor(id) > 0 || this.#holds(id)) {
      await this.#suspend(live);
      return 'stopped';
    }
    const minutes = Math.round(this.config.idleMs / 60_000);
    await this.#stopTicket(live, 'idle', `No activity for ${minutes} minutes: the session was stopped.`,
      `The session stopped after ${minutes} minutes without activity. Move the ticket to Todo to start it again.`, 'stopped', 'idle');
    return 'stopped';
  }

  // Its containers go, its volume, its ticket's flow and what it waits for
  // stay. Closed first, so that the end of its stream is not a failure.
  async #suspend(live: Live): Promise<void> {
    const minutes = Math.round(this.config.idleMs / 60_000);
    live.closed = true;
    this.#live.delete(live.id);
    this.#dormant.set(live.id, live);
    const session = { id: live.id, ticket: live.input.ticket, project: live.input.project };
    this.#journal(session, { type: 'RUN_ERROR', message: `No activity for ${minutes} minutes while it waited for a person: its containers were stopped, with what a resume needs. The answer resumes it.`, code: 'idle' });
    this.#setPhase(live, 'stopped');
    this.#snapshot(live.id, live.input.ticket);
    await live.handle.stop().catch(() => undefined);
    this.#notify(live.id);
    this.#emit({ type: 'session_stopped', at: this.#at(), project: live.input.project, ticket: live.input.ticket, session: live.id, role: live.input.role, phase: 'stopped', reason: `idle ${minutes} minutes while it waited for a person; the answer resumes it` });
  }

  // A stopped session's request answered: the item handled, the answer
  // journaled as the adapter would have, and what to tell the session kept
  // for its resume. False when someone else handled it first.
  #settleStopped(dormant: Live, item: InboxItem, decision: Decision, by: UserId | 'policy'): boolean {
    if (!this.inbox.handle(item.id, by)) return false;
    const session = { id: dormant.id, ticket: dormant.input.ticket, project: dormant.input.project };
    const requestId = item.kind === 'question' || item.kind === 'permission' ? item.requestId : '';
    this.#journal(session, by !== 'policy' && item.kind === 'question'
      ? { type: 'CUSTOM', name: 'cleared.answered', value: { requestId, by } }
      : { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId, decision: decision.kind, by, ...(by === 'policy' ? { rule: QUESTION_DEFAULT } : {}) } });
    this.#answered(item.id, item.ticket, dormant.id, requestId, by);
    return true;
  }

  // The answer from the inbox, the lead or a person to a session the
  // watchdog stopped: once nothing else of it waits, it resumes with what
  // it was answered.
  async #answerStopped(dormant: Live, requestId: string, decision: Decision, by: UserId): Promise<void> {
    const item = this.inbox.find(dormant.id, requestId);
    if (!item || item.state !== 'waiting') throw new FlowError('not_found', `no request ${requestId} is waiting in session ${dormant.id}`);
    const asks = item.kind === 'question';
    if (asks !== (decision.kind === 'answer')) throw new FlowError('invalid', asks ? 'a question is answered with an answer' : 'a permission request is answered with allow or reject');
    if (!this.#settleStopped(dormant, item, decision, by)) return;
    if (decision.kind === 'allow_always' && item.kind === 'permission') {
      const pattern = patternOf(item);
      if (pattern) this.#store.policyRules.learn({ project: item.project, tool: item.tool, pattern, by, at: this.#now().toISOString() });
    }
    const who = by === 'lead' ? 'the lead' : 'the owner';
    const told = this.#told.get(dormant.id) ?? [];
    if (item.kind === 'question' && decision.kind === 'answer') told.push(`${who} answered your question:\n${answerLines(decision.answers)}`);
    else if (item.kind === 'permission') {
      const what = `${item.tool}${patternOf(item) ? `: ${patternOf(item)}` : ''}`;
      told.push(decision.kind === 'reject_once' || decision.kind === 'reject_always'
        ? `${who} refused your request (${what}): ${decision.message}`
        : `${who} allowed your request (${what}): run it again.`);
    }
    this.#told.set(dormant.id, told);
    if (this.inbox.waitingFor(dormant.id) > 0) return;
    this.#told.delete(dormant.id);
    await this.#wake(dormant, `While your session was stopped, ${told.join('\n')}\nCarry on.`);
  }

  // A session the watchdog stopped, resumed from its volume by the
  // harness's resume and told `text`. What it still waited for cannot be
  // answered any more (its harness lost the request): it is settled, and
  // the session is told to ask again. One that cannot be resumed fails its ticket.
  async #wake(dormant: Live, text: string, by: UserId | 'cleared' = FLOW_USER): Promise<void> {
    if (this.#dormant.get(dormant.id) !== dormant) return;
    this.#dormant.delete(dormant.id);
    const session = { id: dormant.id, ticket: dormant.input.ticket, project: dormant.input.project };
    const left = this.inbox.items().filter((i): i is QuestionItem => i.kind === 'question' && i.state === 'waiting' && i.sessionId === dormant.id);
    this.inbox.handleSession(dormant.id, 'system');
    const told = this.#told.get(dormant.id) ?? [];
    this.#told.delete(dormant.id);
    const words = [
      ...(told.length > 0 ? [`While your session was stopped, ${told.join('\n')}`] : []),
      text,
      ...left.map((q) => `Your question ${asked(q.questions)} was not answered while your session was stopped: ask it again if you still need it.`),
    ].join('\n\n');
    const lastSeq = this.#store.events.after(dormant.id).at(-1)?.seq ?? 0;
    const adapter = this.registry.sessionAdapters[HARNESS];
    let handle: SessionHandle;
    try {
      if (!adapter) throw new Error('no session adapter is configured');
      handle = await this.#resume(adapter, dormant.id);
    } catch (error) {
      if (dormant.waitOpen) this.#step(session, 'STEP_FINISHED', 'waiting_human');
      this.#journal(session, { type: 'RUN_ERROR', message: this.#clean(`The session could not be resumed: ${name(error)}`), code: 'error' });
      this.#setPhase(dormant, 'failed');
      this.#snapshot(dormant.id, dormant.input.ticket);
      await this.#stopTicket(dormant, undefined, undefined, `The session stopped while it waited could not be resumed: ${name(error)}`, 'failed', 'failed');
      return;
    }
    const live: Live = { ...dormant, handle, closed: false, lastActivity: this.#now().getTime() };
    this.#live.set(live.id, live);
    this.#waitEnds(live);
    if (!this.#holds(live.id)) this.#setPhase(live, live.input.role === 'reviewer' ? 'reviewing' : 'working');
    this.#snapshot(live.id, live.input.ticket);
    this.#supervise(live, lastSeq);
    try {
      await handle.send({ text: words, by });
    } catch (error) {
      await this.#stopTicket(live, 'error', `The resumed session could not be told: ${name(error)}`, `The session was resumed, but it could not be told: ${name(error)}`, 'failed', 'failed');
    }
  }

  // A stopped session that will not resume: what it waited for goes with it.
  #endDormant(dormant: Live, phase: 'stopped' | 'failed'): void {
    if (!this.#dormant.delete(dormant.id)) return;
    this.#told.delete(dormant.id);
    const session = { id: dormant.id, ticket: dormant.input.ticket, project: dormant.input.project };
    if (dormant.waitOpen) {
      dormant.waitOpen = false;
      this.#step(session, 'STEP_FINISHED', 'waiting_human');
    }
    const gate = this.#gates.get(dormant.id);
    if (gate?.stepOpen) this.#step(session, 'STEP_FINISHED', 'plan_gate');
    if (gate && gate.phase !== 'working') this.#gates.delete(dormant.id);
    this.#setPhase(dormant, phase);
    this.inbox.handleSession(dormant.id, 'system');
    this.#snapshot(dormant.id, dormant.input.ticket);
  }


  // ---- take over and give back (decision 30, lane 20) ---------------------

  // A live session nobody took over: what a message, an answer or a Go needs.
  #writable(id: SessionId): Live {
    const live = this.#liveSession(id);
    if (this.#paused.has(id)) throw new FlowError('conflict', `session ${id} is taken over: give it back first`);
    return live;
  }

  takenOver(id: SessionId): TakenOver | undefined {
    return this.#paused.get(id);
  }

  // The checkout the session works in, as this process started it; undefined
  // for a session of another process (the files route, flow/files.ts).
  sessionWorkdir(id: SessionId): string | undefined {
    return this.#inputs.get(id)?.input.workdir;
  }

  // The owner takes an author's or a reviewer's session over (a step's
  // session, the contract's, a service's or the integration's, is an
  // author's; the reviewer's by the owner's decision of 2026-10-22 22:01):
  // paused first, so that the end of the interrupted turn is not taken for
  // the end of the work or for a verdict; then the turn interrupted, and
  // what still waits for the human settled as cancelled. A session plan
  // waiting for its Go stays in the inbox.
  async takeOver(id: SessionId, by: UserId): Promise<TakenOver> {
    const live = this.#liveSession(id);
    if (live.input.role !== 'author' && live.input.role !== 'reviewer') throw new FlowError('conflict', `session ${id} is the ${live.input.role}'s: only an author's or a reviewer's session is taken over`);
    if (this.#paused.has(id)) throw new FlowError('conflict', `session ${id} is already taken over`);
    const taken: TakenOver = { by, at: this.#at() };
    this.#paused.set(id, taken);
    const from = this.#store.events.after(id).at(-1)?.seq ?? 0;
    try {
      await live.handle.interrupt();
    } catch (error) {
      this.#paused.delete(id);
      throw new FlowError('unavailable', `session ${id} could not be interrupted: ${name(error)}`);
    }
    const session = { id, ticket: live.input.ticket, project: live.input.project };
    // The adapter cancels the request of the turn it interrupts; anything
    // else that waits is cancelled here, once.
    const settled = new Set(this.#store.events.after(id, from).flatMap(({ event }) =>
      event.type === 'CUSTOM' && (event.name === 'cleared.permission_answered' || event.name === 'cleared.answered') ? [event.value.requestId] : []));
    for (const item of this.inbox.items()) {
      if ((item.kind !== 'permission' && item.kind !== 'question') || item.sessionId !== id || item.state !== 'waiting') continue;
      if (!settled.has(item.requestId))
        this.#journal(session, { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: item.requestId, decision: 'cancelled', by: 'policy', rule: TAKEN_OVER } });
      if (this.inbox.handle(item.id, 'policy')) this.#answered(item.id, item.ticket, id, item.requestId, 'policy');
    }
    if (live.waitOpen && this.inbox.waitingFor(id) === 0) {
      live.waitOpen = false;
      this.#step(session, 'STEP_FINISHED', 'waiting_human');
    }
    this.#setPhase(live, 'waiting_human');
    this.#snapshot(id, live.input.ticket);
    return taken;
  }

  // Give back: the session resumed with the harness's resume, in the same
  // container, and told to carry on, unless its plan still waits for a Go,
  // which tells it. A handle that resume made anew replaces the old one,
  // whose reading then stops. The idle rule counts from now.
  async giveBack(id: SessionId): Promise<void> {
    const live = this.#liveSession(id);
    if (!this.#paused.has(id)) throw new FlowError('conflict', `session ${id} is not taken over`);
    const adapter = this.registry.sessionAdapters[HARNESS];
    if (!adapter) throw new FlowError('unavailable', 'no session adapter is configured');
    let handle: SessionHandle;
    try {
      handle = await this.#resume(adapter, id);
    } catch (error) {
      throw new FlowError('unavailable', `session ${id} could not be resumed: ${name(error)}`);
    }
    this.#paused.delete(id);
    let current = live;
    if (handle !== live.handle) {
      live.closed = true;
      current = { ...live, handle, closed: false, lastActivity: this.#now().getTime() };
      this.#live.set(id, current);
      this.#supervise(current, this.#store.events.after(id).at(-1)?.seq ?? 0);
    }
    current.lastActivity = this.#now().getTime();
    if (this.#holds(id)) {
      this.#snapshot(id, live.input.ticket);
      return;
    }
    const reviewer = live.input.role === 'reviewer';
    this.#setPhase(current, reviewer ? 'reviewing' : 'working');
    this.#snapshot(id, live.input.ticket);
    try {
      await current.handle.send({ text: reviewer ? GIVEN_BACK_REVIEW : GIVEN_BACK, by: FLOW_USER });
    } catch (error) {
      await this.#stopTicket(current, 'error', `The session could not be told it was given back: ${name(error)}`, `The session was given back, but it could not be resumed: ${name(error)}`, 'failed', 'failed');
    }
  }
}
