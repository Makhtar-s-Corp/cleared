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
// A one-service ticket may start with 2 to 4 variants (issue #271,
// flow/variants.ts): as many authors on the same ticket, each in its own
// clone of the ticket branch, at most the Consumption screen's lanes at
// once (3 by default). A variant that fails fails alone. Once one is done,
// the inbox compares them; the owner's choice stops the others, releases
// their containers and networks at once, and the review runs on the chosen
// one's checkout, which is the ticket's from then on. A harness pick
// (issue #329, flow/harness-pick.ts) runs one variant per harness named and,
// once all have ended, keeps by itself the cheapest whose own tests passed,
// through the same choice; a harness at the week stop starts no variant.
//
// A release whose checks fail is repaired (issue #273, flow/ci-repair.ts):
// a failure read on the card's own head, while a one-service ticket waits
// for the owner's approval, handles the card and reopens the ticket's
// author on the ticket branch with what failed, as a new flow;
// its commit goes through the review and the publish as any change, and
// the new card carries the attempt. At most CI_REPAIR_ATTEMPTS attempts;
// then the card says the checks still fail and the owner decides. A train
// is not repaired.
//
// A Quick ticket is on the fast lane kept from v1 (matrix B2.2,
// flow/fast-lane.ts): its author is Haiku, and v1's rules judge its real
// diff after each author session and at the head it publishes. A rule it
// breaks, a question its team asks the owner, or several services send it
// back to the full circuit for good: its card says why, the lead is told,
// and its later authors run on the full model, never a resumed Haiku.
import { posix } from 'node:path';
import { VARIANT_DIFF_MAX, VARIANTS_MAX, VARIANTS_MIN, type CiRepair, type InboxItem, type PermissionItem, type CaptureChoice, type ProductionCheck, type QuestionItem, type QuestionTimeout, type FastLane, type ReleaseItem, type SessionDetail, type SessionPlan, type SessionSummary, type TakenOver, type TicketStep, type TicketVariant } from '../api/types.ts';
import { isSessionId } from '../container/docker.ts';
import type { SiblingSpec } from '../container/services.ts';
import { LOGIN_FILE_MOUNT, WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { InboxStore } from '../inbox/store.ts';
import type { Registry } from '../modules/registry.ts';
import { HostToolRefused, type Answer, type Briefing, type Decision, type Harness, type HostTool, type Role, type SessionAdapter, type SessionHandle, type SessionId, type StartInput, type UserId } from '../session/contract.ts';
import { handoverNote, refuseTarget } from '../session/handover.ts';
import { readToolInput, readToolOutput, type AgUiEvent, type Question, type SessionEvent, type SessionPhase, type StepName } from '../session/events.ts';
import { skillTicketService } from '../knowledge/store.ts';
import { skillPath } from '../knowledge/skill.ts';
import { DEFAULT_SAFE_COMMANDS, type Policy } from '../session/policy.ts';
import type { Store } from '../store/db.ts';
import type { Actor, Ticket, TicketId } from '../tickets/contract.ts';
import { replayBranch, ticketBranch } from '../workspace/checkout.ts';
import type { Published } from '../workspace/publish.ts';
import { serviceLocks } from '../approval/service.ts';
import { changesReport, flags } from '../release/flags.ts';
import { reviewRun, type MergeOutcome, type ServiceLock } from '../release/lock.ts';
import { compatibility, landingOrder } from '../release/order.ts';
import { TrainStore, view, type Stop } from '../release/store.ts';
import { TrainRunner } from '../release/train.ts';
import type { ServiceConfig, WorkspaceConfig } from '../workspace/config.ts';
import { AUTHOR_TOOLS, bindAuthorTools, readChangesReport, readSessionPlan } from './author-tools.ts';
import { STEP_NOTE_TOOL, notesLeft, notesRead, notesText, readStepNote, type StepNote } from './notes.ts';
import { PLAN_GO_MINUTES, QUESTION_LEAD_MINUTES, QUESTION_TIMEOUT_MINUTES, workspaceOf, type FlowConfig, type ProjectSettings } from './config.ts';
import { answerLines, asked, defaultAnswers } from './questions.ts';
import { duration } from '../lead/plans/estimates.ts';
import { ledgerEvent } from '../store/ledger-events.ts';
import type { FlowEvent, FlowListener, Origin, PutBackReason } from './events.ts';
import { atOrAfter, landingOf, type Landing } from './ledger.ts';
import { NOT_AGAIN, NOT_NOW, PROPOSED, changeMessage, goMessage, noPlanNote, type Gate, type GoBy } from './plan-gate.ts';
import type { LeverReader } from '../consumption/levers.ts';
import { QUOTA_WINDOWS, latestQuota } from '../consumption/quota.ts';
import { sessionsCost } from '../consumption/ticket-cost.ts';
import { GIVEN_BACK, GIVEN_BACK_REVIEW, TAKEN_OVER } from './takeover.ts';
import { NO_ANSWER, answerMessage, channelOf, channelPrompt, lastSaid, verdictsOf, type ChannelMessage } from './channel.ts';
import { testComment, testLine, testRunOf } from './review-tests.ts';
import type { ProductionCapture, ProofCapture } from './proof-capture.ts';
import { CaptureChoiceStore } from './capture-choice.ts';
import { captureNeed, type CaptureChoiceName, type CaptureNeed } from './capture-need.ts';
import { PRODUCTION_FILE, PROOF_FILES } from './proof-capture.ts';
import { productionChecksOf, productionComment } from './production.ts';
import type { ReceiptCapture, ReceiptData, ReceiptTest } from './receipt.ts';
import { ticketCost } from '../consumption/ticket-cost.ts';
import { CI_REPAIR_ATTEMPTS, onBase, repairComment, repairMessage, type CiFailures } from './ci-repair.ts';
import { FastLaneStore, cardLane, fallbackComment, type FastVerdict } from './fast-lane.ts';
import { ENV_CHECK_ROUNDS, EnvCheckStore, envCheckComment, envCheckGiveUp, envCheckRequest, isEnvironmentTicket, type EnvCheck } from './env-setup.ts';
import type { PrClose } from './pr-close.ts';
import { authorPrompt, contractSendBackMessage, fileDiff, handoverMessage, lastReport, parseVerdict, reviewPrompt, reviewRequestMessage, stepPrompt, withoutFile, type ReviewContract, type ReviewService } from './prompts.ts';
import { humanEdits } from './human-edits.ts';
import { ReplayStore, replayPrompt, stepCommit, type Checkpoint, type Replay } from './replay.ts';
import { StepStore, deriveSteps, publicStep, stepName, stepSiblings, type Step, type StepSpec } from './steps.ts';
import { foldState, sessionPlanOf } from './state.ts';
import { VARIANT_PARALLEL, VariantStore, diffLines, publicVariant, variantPrompt, type Variant, type VariantKey } from './variants.ts';
import { PICK_DEFAULT, PICK_STOP_PERCENT, pickPrompt, pickWinner, ticketType, type PickMeasure } from './harness-pick.ts';
import { profileVersions, recordSessionVersions, sessionVersions, type ProfileVersions } from '../profiles/store.ts';
import { DEFAULT_ENVIRONMENT, DEFAULT_PROFILE, type AgentEnvironment, type AgentProfile } from '../profiles/types.ts';

export type { ProjectSettings } from './config.ts';
export type { FlowEvent, FlowListener, Origin, PutBackReason } from './events.ts';
// What the lock answered a merge (effects.ts mergeRelease, release/lock.ts).
export type { MergeOutcome } from '../release/lock.ts';
export type { FastVerdict } from './fast-lane.ts';
export type { EnvCheck } from './env-setup.ts';

// What the flow does outside this process. `service` names the service of
// a workspace of several the call is for; absent, the one-service
// workspace's (its first service, which the milestone 1 fields name).
// The receipts' captures, under the checkouts' root, a folder no ticket is named.
export const PROOF_FOLDER = '.proof';
export const PROOF_TIMEOUT_MS = 90_000;

export type FlowEffects = {
  settings(service?: ServiceConfig): Promise<ProjectSettings>;    // the service's settings at its base branch
  refreshProject(service?: ServiceConfig): Promise<void>;         // projectCheckout: fetch the forge, so publish sees the base as it is now (issue 141)
  // The ticket's checkout: <workdirs>/<ticket>, or <workdirs>/<ticket>/<service> for a service of a workspace of several,
  // or <workdirs>/<ticket>.variant-<round>-<position> for a variant (flow/variants.ts variantFolder).
  // `branch`: the branch of a ticket resumed from a step (issue #272); ticketBranch's by default.
  prepareWorkdir(input: { readonly ticket: Ticket; readonly role: Role; readonly service?: ServiceConfig; readonly variant?: VariantKey; readonly branch?: string }): Promise<{ readonly workdir: string; readonly briefing: Briefing }>;
  // `contract`: the service whose contract a step builds against, when its session has one: its lessons for the contract are filed there.
  captureHandover(input: { readonly workdir: string; readonly role: Role; readonly model: string; readonly ticket: TicketId; readonly sessionId: SessionId; readonly contract?: string }): Promise<string | null>;
  // `receipt`: the facts of the proof receipt at the top of the body (P210, flow/receipt.ts).
  publish(input: { readonly ticket: TicketId; readonly workdir: string; readonly branch: string; readonly report: string; readonly service?: ServiceConfig; readonly receipt?: ReceiptData }): Promise<Published>;
  // The proof receipt's captures of `service` (P210, flow/proof-capture.ts):
  // the page of what its base runs, the page of the session's trial
  // environment and a video of the flow on it, written in `dir`, while the
  // author's session still runs. Never throws in the real one; a throw here
  // is journaled as failed. Absent: no capture is taken.
  captureProof?(input: { readonly ticket: TicketId; readonly session: SessionId; readonly service: ServiceConfig; readonly dir: string }): Promise<ProofCapture>;
  // The paths the author's branch commits against the service's base, read
  // as a step's branch is (stepChanges), a folder service's in its folder
  // only: what the capture rule reads (P226, flow/capture-need.ts) before a
  // browser starts. Absent: every author's work is captured, as before the rule.
  changedPaths?(input: { readonly ticket: TicketId; readonly service: ServiceConfig; readonly workdir: string }): Promise<readonly string[]>;
  // The production page at `url`, the service's [release] production_url,
  // captured in `dir` once a release the human approved is deployed (by the
  // human or their CI) and its watch ended healthy (P218,
  // flow/proof-capture.ts captureProduction): its requests are reads of its
  // own origin. Never throws in the real one. Absent: nothing is captured.
  // Cleared has no effect that deploys (test/flow/never-deploys.test.ts).
  captureProduction?(input: { readonly url: string; readonly dir: string }): Promise<ProductionCapture>;
  // The lock's `--ask` request; the request time the lock recorded, when it says one.
  requestRelease(input: { readonly ticket: TicketId; readonly pr: number; readonly announcement: string }): Promise<{ readonly requestedAt?: string }>;
  prChecks(pr: number, service?: ServiceConfig): Promise<ReleaseItem['pr']['checks']>;   // the pull request's checks on the forge now
  // The head the pull request's checks ran on and the ones that failed,
  // with their logs' last lines when the forge gives them (issue #273).
  // Absent: a repair starts on the checks' state alone, told nothing of them.
  ciFailures?(input: { readonly pr: number; readonly service?: ServiceConfig }): Promise<CiFailures>;
  // A Close closes the ticket's pull request on the forge, with `reason` in
  // its comment, and never deletes the branch (issue #249, P114, pr-close.ts).
  // Only a pull request on one of `branches` is closed; one already closed or
  // merged is left alone; a failure throws. Absent: the forge is left as it is.
  closePullRequest?(input: { readonly pr: number; readonly branches: readonly string[]; readonly reason: string; readonly service?: ServiceConfig }): Promise<PrClose>;
  // The lock's merge (`request_release` without --ask), after the human's approval.
  mergeRelease(input: { readonly ticket: TicketId; readonly pr: number; readonly announcement: string }): Promise<MergeOutcome>;
  // After a merge: the project pages of the workspace's services are made
  // again from their new base (issue #274). Absent: none. A failure is
  // logged and never stops the flow.
  updateProjectPages?(input: { readonly ticket: TicketId; readonly pr: number }): Promise<void>;
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
  // The branch a checkout is on and its commit, read from its files without
  // git (issue #272, workspace/checkout.ts readTip). Absent: no checkpoint
  // is journaled, and no step can be resumed from.
  head?(input: { readonly workdir: string }): Promise<Checkpoint | undefined>;
  // A one-service ticket resumed from a step (issue #272): the ticket's
  // checkout is moved aside, its branch `previous` fetched into the
  // service's own checkout and kept there, and a new checkout made on
  // `branch` at `commit`, which must be in that branch's history. Absent:
  // no ticket is resumed from a step.
  replay?(input: { readonly ticket: TicketId; readonly n: number; readonly commit: string; readonly branch: string; readonly previous: string }): Promise<{ readonly previousHead: string; readonly aside: string }>;
  // Before anything stops: the ticket has a checkout whose branch `previous`
  // holds `commit` in its history, read as replay reads it; throws otherwise.
  replayCheck?(input: { readonly ticket: TicketId; readonly commit: string; readonly previous: string }): Promise<void>;
  // What a variant's ticket branch changes against the base (issue #271),
  // read out of its checkout as a step's branch is: committed changes only.
  // Absent: the variants item says the change could not be read.
  variantChanges?(input: { readonly ticket: TicketId; readonly workdir: string; readonly variant: VariantKey }): Promise<{ readonly files: readonly string[]; readonly diff: string }>;
  // The fast lane's rules on a Quick ticket's change (matrix B2.2,
  // flow/fast-lane.ts): the session's branch in `workdir`, or a published
  // `head`, against the base. Absent: no Quick ticket is judged, and no card
  // says a lane.
  fastLane?(input: { readonly ticket: TicketId; readonly service?: ServiceConfig; readonly workdir?: string; readonly head?: string }): Promise<FastVerdict>;
  // The setup session's check (matrix C4, flow/env-setup.ts): the image of
  // the session's branch in `workdir` built as the service's prepared image
  // would be once merged, and the service's declared check run in it.
  // Absent: no ticket of the environment template is checked.
  envCheck?(input: { readonly ticket: TicketId; readonly service?: ServiceConfig; readonly workdir: string }): Promise<EnvCheck>;
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
  // The share of a quota window at which no variant of a harness pick starts
  // (CLEARED_V2_WEEK_STOP_PERCENT, the plans' stop); PICK_STOP_PERCENT when absent.
  readonly weekStopPercent?: number;
};

export type FlowErrorKind = 'not_found' | 'conflict' | 'invalid' | 'unavailable';

// What a handover answers: the session that carries on (B6.3).
export type HandedOver = { readonly session: SessionId; readonly harness: Harness; readonly model: string };

export class FlowError extends Error {
  override name = 'FlowError';
  readonly kind: FlowErrorKind;
  constructor(kind: FlowErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

const HARNESS = 'claude-code' as const;
// B6.3 (P150): the model a session handed over to Codex runs on, unless the owner names one (adapters.md: the account's default).
export const CODEX_MODEL = 'gpt-6-luna';
// Decision 15 of milestone 2: a plan item the lead puts in the fast lane is
// a ticket with this label, and its author is Haiku (unless Haiku reviews).
export const QUICK_LABEL = 'Quick';
export const QUICK_MODEL = 'claude-haiku-5-5';
export const CLOSE_REASON_MAX = 2000;                              // the longest reason a Close gives
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
  // The restart recovery the runtime started, so that what must follow it can wait (the schedules' first tick).
  recovered: Promise<void> = Promise.resolve();
  #trains: TrainStore;
  #runner: TrainRunner;
  #locks: ((service: ServiceConfig) => ServiceLock) | undefined;
  #release: FlowDeps['release'];
  #levers: LeverReader | undefined;
  #weekStop: number;
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
  #variants: VariantStore;                                          // the ticket's variants (issue #271)
  #variantOf = new Map<SessionId, string>();                        // the variant an author session works on
  #variantDirs = new Set<string>();                                 // the variants' checkouts, whose edits are their own
  #picking = new Set<string>();                                     // the variants items a harness pick is deciding (issue #329)
  // Sessions the watchdog stopped while they waited for a person (issue
  // #290): their ticket's flow goes on, what they wait for stays in the
  // inbox, and the answers given since are told to them when they resume.
  #dormant = new Map<SessionId, Live>();
  #told = new Map<SessionId, string[]>();
  #repairing = new Set<TicketId>();                                 // tickets whose failed checks are being read or a repair started
  #repairs = new Map<TicketId, CiRepair>();                         // the repair a ticket's flow runs for, until its card is published
  #replays: ReplayStore;                                            // the tickets resumed from a step (issue #272)
  #replaying = new Set<TicketId>();                                 // tickets whose resume is under way
  #tips = new Map<SessionId, string>();                             // the last commit journaled as an author's checkpoint
  #fastLanes: FastLaneStore;                                        // the Quick tickets the rules kept fast or sent back (B2.2)
  #captureChoices: CaptureChoiceStore;                              // the human's choice of the receipt's captures, by ticket (P226)
  #envChecks: EnvCheckStore;                                        // the setup sessions' checks, by ticket (C4)
  #envRuns = new Map<TicketId, string>();                           // when each ticket's run started: its checks' rounds count from there
  #profiles: ProfileVersions;                                       // the agent profile's and the environment's versions (issue #452)

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
    this.#weekStop = deps.weekStopPercent ?? PICK_STOP_PERCENT;
    this.#trains = new TrainStore(deps.store.db, this.#now);
    this.#steps = new StepStore(deps.store.db, this.#now);
    this.#variants = new VariantStore(deps.store.db, this.#now);
    this.#replays = new ReplayStore(deps.store.db, this.#now);
    this.#fastLanes = new FastLaneStore(deps.store.db);
    this.#captureChoices = new CaptureChoiceStore(deps.store.db);
    this.#envChecks = new EnvCheckStore(deps.store.db);
    this.#profiles = profileVersions(deps.store.db, this.#now);
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
    if (!this.#several) return this.#effects.prepareWorkdir({ ticket, role, ...this.#chosenVariant(ticket.id), branch: this.#branchOf(ticket.id) });
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

  // The branch of a one-service ticket: its newest resume's (issue #272), else its own.
  #branchOf(ticket: TicketId): string {
    return this.#replays.latest(ticket)?.branch ?? ticketBranch(ticket);
  }

  // A ticket whose variant was chosen works in that variant's checkout from then on.
  #chosenVariant(ticket: TicketId): { readonly variant?: VariantKey } {
    const chosen = this.#variants.chosen(ticket);
    return chosen ? { variant: { round: chosen.round, position: chosen.position } } : {};
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
    for (const { live, item, minutes } of this.#duePermissions(now)) await this.#parkPermission(live, item, minutes);
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
        // A repair resumes or starts a container: it runs beside the tick, which goes on.
        if (checks === 'failed') void this.#track(this.#checksFailed(release, ticket).catch((error: unknown) => console.error(`cleared-v2: the repair of ${ticket.id}'s checks failed (${error instanceof Error ? error.name : typeof error})`)));
        // Green after a repair, or after the owner ran a job again once the attempts were spent.
        else if (checks === 'passed' && (release.repair?.state === 'pushed' || release.repair?.state === 'gave_up')) await this.#repairSaid(release, { ...release.repair, state: 'repaired', at: this.#at() });
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
  // A close keeps its reason on the card (`closed`).
  #settleRelease(id: string, ticket: TicketId, project: string, by: UserId | 'system', closed?: string): boolean {
    if (!(closed === undefined ? this.inbox.handle(id, by) : this.inbox.closeRelease(id, by, closed))) return false;
    const sessionId = this.inbox.releaseSession(id);
    if (!sessionId) return true;
    this.#step({ id: sessionId, ticket, project }, 'STEP_FINISHED', 'approval');
    this.#snapshot(sessionId, ticket);
    return true;
  }

  // ---- the repair of failed checks (issue #273) ----------------------------

  // The checks of a waiting release failed. Read again once a minute, so
  // each step below happens once (#repairing is set before the first await):
  // a failure on another head than the card's (the push's checks not
  // reported yet) waits for the next reading.
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
      if (onBase(this.#branchOf(id), this.config.base))
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
    const authorRow = this.#store.sessions.list({ ticket: id }).filter((row) => row.role === 'author').at(-1);
    const adapter = this.registry.sessionAdapters[authorRow ? this.#harnessOf(authorRow.id) : HARNESS];
    if (!adapter) return;
    this.#settleRelease(release.id, id, release.project, 'system');
    this.#checked.delete(release.id);
    await this.#repairSaid(release, repair);
    this.#active.add(id);
    this.#flows.set(id, new Set(authorRow ? [authorRow.id] : []));
    this.#channels.delete(id);
    this.#repairs.set(id, repair);
    try {
      await tickets.move(id, tickets.states.progress, SERVICE);
      await this.#reopenWith(ticket, adapter, authorRow, repairMessage({ repair, pr: release.pr.number, branch: this.#branchOf(id), ...(failures ? { failures } : {}) }));
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
  // state, and of each ticket the lock already put in Done (merge-pr.ts does
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
        // merge-pr.ts moves the card to Done when every shown pull request is merged; the flow does when it did not.
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
    // A merge, one-service or of a train, makes the project pages again (issue #274).
    if (event.type === 'release_merged') this.#pagesAfter(event.ticket, event.pr);
    // A landing opens the production page each service configures (P218).
    if (event.type === 'release_landed') this.#productionAfter(event);
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

  #pagesAfter(ticket: TicketId, pr: number): void {
    const pages = this.#effects.updateProjectPages;
    if (!pages) return;
    void this.#track(Promise.resolve().then(() => pages.call(this.#effects, { ticket, pr }))
      .catch((error) => { console.error(`cleared-v2: the project pages were not made again after pull request #${pr} (${name(error)})`); }));
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
    const versions = sessionVersions(this.#store.db, id, row.role);
    // The service and the preview key the runtime stored when the session's
    // containers started (lane 15), when its row holds them; the session
    // plan of an author that proposed one (lane 17); who took it over (lane 20).
    return {
      id: row.id, project: row.project, ticket: row.ticket, role: row.role, harness: row.harness, model: row.model,
      phase, status: state.status, startedAt: row.createdAt, updatedAt: row.updatedAt, lastSeq: events.at(-1)?.seq ?? 0,
      state: { ...state, ...(plan ? { plan } : {}), ...(takenOver ? { takenOver } : {}) },
      ...(row.service ? { service: row.service } : {}), ...(row.previewKey ? { previewKey: row.previewKey } : {}), ...(takenOver ? { takenOver } : {}),
      ...(this.#dormant.has(id) ? { dormant: true as const } : {}),
      ...(versions ? { versions } : {}),
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
  // In the order the flow started them: two sessions started in the same
  // millisecond (a handover) are not told apart by the table's order.
  #flowRows(ticket: TicketId) {
    const rows = new Map(this.#store.sessions.list({ ticket }).map((row) => [row.id, row]));
    return [...this.#flowOf(ticket)].flatMap((id) => rows.get(id) ?? []);
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
  // `variants`: 2 to 4 authors at once (issue #271); absent or 1, one. A
  // list of harnesses is a harness pick (issue #329): a variant on each.
  // A profile on `harness: auto` (issue #452) makes a ticket that names
  // neither a number of variants nor harnesses a harness pick on the
  // harnesses enabled, when there are two at least.
  async start(ticketId: TicketId, by: UserId, origin?: Origin, asked?: number | readonly Harness[]): Promise<void> {
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(ticketId);
    if (!ticket) throw new FlowError('not_found', `unknown ticket ${ticketId}`);
    const variants = asked ?? this.#autoHarnesses();
    const count = typeof variants === 'object' ? variants.length : variants ?? 1;
    const refused = count === 1 && typeof variants !== 'object' ? undefined : this.variantsRefusal(variants as number | readonly Harness[]);
    if (refused) throw new FlowError('invalid', refused);
    if (ticket.project !== this.config.project) throw new FlowError('invalid', `ticket ${ticketId} belongs to project ${ticket.project ?? 'none'}, and this service runs ${this.config.project}`);
    if (this.#active.has(ticketId)) throw new FlowError('conflict', `ticket ${ticketId} already runs`);
    if (ticket.status !== tickets.states.todo) throw new FlowError('conflict', `ticket ${ticketId} is in ${ticket.status}: only a ticket in ${tickets.states.todo} starts`);
    const adapter = this.registry.sessionAdapters[HARNESS];
    if (!adapter) throw new FlowError('unavailable', `no adapter for ${HARNESS} is registered`);
    this.#active.add(ticketId);
    this.#flows.set(ticketId, new Set());
    this.#envRuns.set(ticketId, this.#at());
    this.#channels.delete(ticketId);
    if (origin) this.#origins.set(ticketId, origin);
    else this.#origins.delete(ticketId);
    this.#finishing.delete(ticketId);
    const began = this.#now();
    try {
      await tickets.move(ticketId, tickets.states.progress, SERVICE);
      if (count > 1) {
        await this.#startVariants(ticket, by, origin, typeof variants === 'object' ? variants : count);
        return;
      }
      const steps = this.#stepPlan(ticket, origin);
      if (steps && steps.length > 1) {
        await this.#startSteps(ticket, by, origin, steps);
        return;
      }
      const live = await this.#startAuthor(adapter, ticket, began, (first) => (origin?.note ? `${first}\n\n${origin.note}` : first));
      const comment = origin ? `Started by the lead for plan ${origin.plan} (item ${origin.item}), approved by ${by}.` : `Started by ${by}.`;
      await tickets.comment(ticketId, comment, SERVICE).catch(() => undefined);
      this.#emit({ type: 'ticket_started', at: this.#at(), project: this.config.project, ticket: ticketId, by, origin: origin ?? null, session: live.id });
      this.#authorStep(ticketId, steps, live);
      this.#supervise(live, 0);
    } catch (error) {
      await this.#putBack(ticketId, `The flow could not start: ${name(error)}`, 'start_failed');
      throw error;
    }
  }

  // The author of a one-service ticket (start, replay): its checkout, its
  // session told `prompt` of the ticket's first prompt, the workspace's and
  // the author's steps, and the branch's first checkpoint, read before the
  // session starts (issue #272).
  async #startAuthor(adapter: SessionAdapter, ticket: Ticket, began: Date, prompt: (first: string) => string): Promise<Live> {
    const settings = await this.#settings(ticket);
    const prepared = await this.#prepare(ticket, 'author');
    const workspaceDone = this.#now();
    const tools = this.config.authorTools === true;
    const tip = await this.#tipOf(prepared.workdir);
    const live = await this.#launch(adapter, ticket, 'author', this.#authorModel(ticket), prepared.workdir, prepared.briefing, settings, prompt(authorPrompt(ticket, { plan: tools, report: tools })), tools ? 'plan' : undefined);
    const session = { id: live.id, ticket: ticket.id, project: this.config.project };
    this.#step(session, 'STEP_STARTED', 'workspace', began);
    this.#step(session, 'STEP_FINISHED', 'workspace', workspaceDone);
    this.#step(session, 'STEP_STARTED', 'author', workspaceDone);
    this.#snapshot(live.id, ticket.id);
    if (tip) this.#journalTip(live, tip);
    return live;
  }

  // A one-service ticket's one step is its author's (lane 23): nothing else changes.
  #authorStep(ticket: TicketId, steps: readonly StepSpec[] | undefined, live: Live): void {
    if (!steps) return;
    const step = this.#steps.ensure(ticket, this.config.project, steps)[0] as Step;
    this.#steps.resume(ticket);
    this.#steps.update(step.id, { state: 'running', session: live.id });
    this.#stepOf.set(live.id, step.id);
  }

  // ---- a step's commit (issue #272, flow/replay.ts) ---------------------------

  // The tip of a one-service ticket's checkout; none in a workspace of several services, which is not resumed from a step.
  async #tipOf(workdir: string): Promise<Checkpoint | undefined> {
    if (this.#several || !this.#effects.head) return undefined;
    return this.#effects.head({ workdir }).catch(() => undefined);
  }

  #journalTip(live: Live, tip: Checkpoint): void {
    if (this.#tips.get(live.id) === tip.commit) return;
    this.#tips.set(live.id, tip.commit);
    this.#journal({ id: live.id, ticket: live.input.ticket, project: live.input.project }, { type: 'CUSTOM', name: 'cleared.checkpoint', value: { commit: tip.commit, branch: tip.branch } });
  }

  // After an author's tool call and at the end of its turn: the tip, when it moved.
  async #checkpoint(live: Live): Promise<void> {
    if (live.input.role !== 'author' || live.closed) return;
    const tip = await this.#tipOf(live.input.workdir);
    if (tip && !live.closed) this.#journalTip(live, tip);
  }

  // Resume from here (POST /api/sessions/:id/replay): the ticket's sessions
  // stop and what of it waits in the inbox is settled, as Set aside does;
  // the effect keeps the ticket's checkout and branch aside and makes a new
  // checkout on a new branch at the commit the step began from (stepCommit);
  // a new author starts there, told the owner's corrected instruction. The
  // session left keeps every event, and both sessions get `cleared.replay`.
  // The ticket keeps its plan item, its budget and its one step. Nothing is
  // pushed: the next publish pushes the new branch, and opens its own pull
  // request. A ticket of several services, approved, done, landing, taken
  // over or already resuming is refused.
  async replay(id: SessionId, seq: number, message: string, by: UserId): Promise<Replay> {
    const row = this.#store.sessions.get(id);
    if (!row || row.project !== this.config.project) throw new FlowError('not_found', `unknown session ${id}`);
    if (row.role !== 'author') throw new FlowError('invalid', `session ${id} is the ${row.role}'s: a ticket is resumed from a step of an author's session`);
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(row.ticket);
    if (!ticket || ticket.project !== this.config.project) throw new FlowError('not_found', `unknown ticket ${row.ticket}`);
    if (this.#several) throw new FlowError('conflict', `${ticket.id} is a ticket of a workspace of several services: in this version only a ticket of one service is resumed from a step`);
    if (this.#variants.list(ticket.id).length > 0) throw new FlowError('conflict', `${ticket.id} ran variants (issue #271): in this version a ticket with variants is not resumed from a step`);
    if (ticket.status === tickets.states.go || ticket.status === tickets.states.done) throw new FlowError('conflict', `${ticket.id} is in “${ticket.status}”: it is not resumed from a step`);
    if (this.#trains.latest(ticket.id)?.state === 'landing') throw new FlowError('conflict', `the train of ${ticket.id} is landing: it is not resumed from a step`);
    if ([...this.#paused.keys()].some((session) => this.#live.get(session)?.input.ticket === ticket.id)) throw new FlowError('conflict', `a session of ${ticket.id} is taken over: give it back first`);
    if (this.#replaying.has(ticket.id)) throw new FlowError('conflict', `${ticket.id} is already being resumed`);
    const adapter = this.registry.sessionAdapters[HARNESS];
    if (!adapter) throw new FlowError('unavailable', `no adapter for ${HARNESS} is registered`);
    if (!this.#effects.replay || !this.#effects.replayCheck) throw new FlowError('unavailable', 'this service cannot make a resume branch');
    const step = stepCommit(this.#store.events.after(id), seq);
    if (!step) throw new FlowError('invalid', `no commit of session ${id} is known at its event ${seq}: a step is resumed from once the flow journaled its branch`);
    const text = this.#clean(message.trim());
    if (text === '') throw new FlowError('invalid', 'Resume from here says what to do instead');
    this.#replaying.add(ticket.id);
    const began = this.#now();
    try {
      // Checked while the ticket's sessions still run: a step whose commit
      // the branch no longer holds (one of a continuation a resume left)
      // stops nothing.
      try {
        await this.#effects.replayCheck({ ticket: ticket.id, commit: step.commit, previous: this.#branchOf(ticket.id) });
      } catch (error) {
        throw new FlowError('conflict', this.#clean(`the ticket cannot be resumed from that step: ${name(error)}`));
      }
      await this.#stopAll(ticket.id, by, 'The owner resumed the ticket from an earlier step: this session was stopped.', 'replayed', `The owner resumed the ticket from a step of ${id}.`);
      this.#channels.delete(ticket.id);
      this.#finishing.delete(ticket.id);
      const n = (this.#replays.latest(ticket.id)?.n ?? 0) + 1;
      const previous = this.#branchOf(ticket.id);
      const branch = replayBranch(ticket.id, n);
      let made: { readonly previousHead: string; readonly aside: string };
      try {
        made = await this.#effects.replay({ ticket: ticket.id, n, commit: step.commit, branch, previous });
      } catch (error) {
        await this.#putBack(ticket.id, `The ticket could not be resumed from a step of ${id}: ${name(error)}. Its branch ${previous} is as it was.`, 'start_failed');
        throw new FlowError('conflict', this.#clean(`the ticket could not be resumed from that step: ${name(error)}`));
      }
      const replay = this.#replays.add({ ticket: ticket.id, n, project: this.config.project, session: id, seq, commit: step.commit, branch, previous, previousHead: made.previousHead, aside: made.aside, message: text, by });
      this.#active.add(ticket.id);
      this.#flows.set(ticket.id, new Set());
      try {
        if (ticket.status !== tickets.states.progress) await tickets.move(ticket.id, tickets.states.progress, SERVICE);
        const live = await this.#startAuthor(adapter, ticket, began, (first) => replayPrompt(first, { commit: step.commit, branch, message: text }));
        this.#replays.resumed(ticket.id, n, live.id);
        const value = { from: id, to: live.id, seq, commit: step.commit, branch, previous, by, message: text };
        this.#journal({ id, ticket: ticket.id, project: row.project }, { type: 'CUSTOM', name: 'cleared.replay', value });
        this.#journal({ id: live.id, ticket: ticket.id, project: this.config.project }, { type: 'CUSTOM', name: 'cleared.replay', value });
        await tickets.comment(ticket.id, `Resumed by ${by} from a step of session ${id}: a new author works on ${branch}, from commit ${step.commit.slice(0, 12)}. The branch ${previous} is kept as it was, at ${made.previousHead.slice(0, 12)}.`, SERVICE).catch(() => undefined);
        const origin = this.#origins.get(ticket.id);
        this.#emit({ type: 'ticket_started', at: this.#at(), project: this.config.project, ticket: ticket.id, by, origin: origin ?? null, session: live.id });
        this.#authorStep(ticket.id, this.#stepPlan(ticket, origin), live);
        this.#supervise(live, 0);
        return { ...replay, resumed: live.id };
      } catch (error) {
        await this.#putBack(ticket.id, `The ticket resumed on ${branch} could not start: ${name(error)}`, 'start_failed');
        throw error;
      }
    } finally {
      this.#replaying.delete(ticket.id);
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
    const prepared = await this.#effects.prepareWorkdir({ ticket, role: 'author', ...(scoped ? { service: scoped } : { branch: this.#branchOf(id) }) });
    const workdirs = this.#workdirs.get(id) ?? new Map<string, string>();
    this.#workdirs.set(id, workdirs);
    workdirs.set(service.name, prepared.workdir);
    const workspaceDone = this.#now();
    const steps = this.#steps.list(id);
    const validated = new Map(steps.flatMap((s) => (s.kind === 'contract' && s.state === 'done' && s.contract ? [[s.service, s.contract] as const] : [])));
    const contract = this.#stepContract(step, steps);
    const tools = this.config.authorTools === true;
    const note = this.#origins.get(id)?.note;
    const handed = this.#notesFor(step, new Set());
    const prompt = [
      authorPrompt(ticket, { plan: tools, report: tools }),
      stepPrompt({ kind: step.kind, service: step.service, position: step.position, count, ...(contract ? { contract } : {}), ...(step.note ? { note: step.note } : {}) }),
      ...(handed.length > 0 ? [notesText(handed, (n) => this.#noteSource(id, n))] : []),
      ...(note ? [note] : []),
    ].join('\n\n');
    const planned = this.#effects.siblings ? await this.#effects.siblings({ ticket: id, service, workdir: prepared.workdir }) : undefined;
    const siblings = planned ? stepSiblings(planned, { kind: step.kind, own: service.name, validated, ...(settings.serviceUrls ? { urls: settings.serviceUrls } : {}) }) : undefined;
    const live = await this.#launch(adapter, ticket, 'author', this.#authorModel(ticket), prepared.workdir, prepared.briefing, settings, prompt, tools ? 'plan' : undefined,
      { service: service.name, ...(siblings ? { siblings } : {}), ...(this.#several ? { note: this.#noteTool(ticket.id, step) } : {}) });
    if (handed.length > 0) this.#journal({ id: live.id, ticket: id, project: this.config.project }, { type: 'CUSTOM', name: 'cleared.step_notes_read', value: { ids: handed.map((n) => n.id) } });
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

  // ---- notes between the steps' sessions (M4) -----------------------------------

  // The tool a step's session leaves a note with: journaled, cleaned, on
  // the session, and said to the lead.
  #noteTool(ticket: TicketId, step: Step): HostTool {
    return {
      ...STEP_NOTE_TOOL, inputSchema: STEP_NOTE_TOOL.inputSchema,
      handle: async (input, context) => {
        const text = this.#clean(readStepNote(input));
        const n = notesLeft(this.#store.events.after(context.sessionId)).length + 1;
        const note: StepNote = { id: `${context.sessionId}:${n}`, step: step.position, service: step.service, text };
        this.#journal({ id: context.sessionId, ticket, project: this.config.project }, { type: 'CUSTOM', name: 'cleared.step_note', value: note });
        this.#emit({ type: 'step_note', at: this.#at(), project: this.config.project, ticket, session: context.sessionId, step: step.position, service: step.service, text });
        return 'Your note is kept: the sessions of the ticket\'s other steps are handed it at their next turn.';
      },
    };
  }

  // The notes the sessions of the ticket's other steps left, in step order,
  // that `seen` does not hold.
  #notesFor(step: Step, seen: ReadonlySet<string>): StepNote[] {
    return this.#steps.list(step.ticket)
      .filter((other) => other.id !== step.id)
      .flatMap((other) => other.sessions.flatMap((session) => notesLeft(this.#store.events.after(session))))
      .filter((note) => !seen.has(note.id));
  }

  // How a note's step is said: "step 1 of 4 (the contract step of filter-api)".
  #noteSource(ticket: TicketId, note: StepNote): string {
    const steps = this.#steps.list(ticket);
    return stepName({ position: note.step, kind: steps.find((s) => s.position === note.step)?.kind ?? 'service', service: note.service }, steps.length);
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
    if (step.kind !== 'contract') await this.#captureProof(live, this.#service(step.service));
    await this.#close(live, 'done');
    this.#stepOf.delete(live.id);
    this.#emit({ type: 'author_done', at: this.#at(), project, ticket: id, session: live.id });
    try {
      // The contract its step builds against (M4): its lessons for the contract are filed in that one's memory.
      const builds = this.#several ? this.#stepContract(step, this.#steps.list(id))?.service : undefined;
      await this.#effects.captureHandover({ workdir: live.input.workdir, role: 'author', model: live.input.model, ticket: id, sessionId: live.id, ...(builds ? { contract: builds } : {}) });
    } catch (error) {
      await this.registry.ticketStore.comment(id, this.#clean(`The author's handover could not be stored: ${name(error)}`), SERVICE).catch(() => undefined);
    }
    if (!this.#active.has(id)) return;
    const steps = this.#steps.list(id);
    const validated = step.kind === 'contract' ? null : steps.find((s) => s.kind === 'contract' && s.service === step.service && s.state === 'done')?.blob ?? null;
    let read: StepChanges | undefined;
    if (step.kind === 'contract' || validated !== null) {
      if (!this.#effects.stepChanges) return this.#failStep(step, 'what it changed cannot be read: the flow has no reader of a step\'s branch');
      // The round counts the contract step's items, whichever step proposes the next (a service step may reopen it).
      const owner = step.kind === 'contract' ? step : steps.find((s) => s.kind === 'contract' && s.service === step.service) as Step;
      const proposed = [...this.inbox.contracts({ ticket: id }), ...this.inbox.contracts({ ticket: id, state: 'handled' })];
      const round = proposed.filter((item) => item.step === owner.id).length + 1;
      try {
        read = await this.#effects.stepChanges({
          ticket: id, service: this.#service(step.service), workdir: live.input.workdir,
          snapshot: posix.join(this.config.workdirRoot, id, '.validated', `step-${owner.position}-${round}`),
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
      if (validated !== null && read?.contract && read.contract.blob !== validated) return this.#reopenContract(live, step, steps, read.contract, cost, minutes);
      this.#steps.update(step.id, { state: 'done', cost, minutes });
    }
    await this.#runSteps(id);
  }

  // A service step changed the contract that was validated (M4): the change
  // goes through the contract step again, with the owner's approval, as a
  // new contract item on that step. The ticket is not put back: the other
  // sessions ran on the old contract, so they are stopped and wait; the step
  // that asked waits as the contract step does, and every step that ran on
  // the old contract runs again once the new one is approved
  // (approveContract).
  async #reopenContract(live: Live, step: Step, steps: readonly Step[], contract: NonNullable<StepChanges['contract']>, cost: number | null, minutes: number): Promise<void> {
    const { ticket: id, project } = live.input;
    const owner = steps.find((s) => s.kind === 'contract' && s.service === step.service) as Step;
    const note = this.#clean(`${this.#stepNote(step, 'it changed the validated contract')} ${contract.path} of ${step.service}. The change goes through the contract step again, and waits for the owner's approval.`);
    for (const other of [...this.#live.values()].filter((l) => l.input.ticket === id && l.id !== live.id)) await this.#close(other, 'stopped', note);
    this.#steps.hold(id);
    this.#steps.update(owner.id, { state: 'validating', contract: contract.snapshot, blob: contract.blob });
    this.#steps.update(step.id, {
      state: 'waiting', cost, minutes,
      note: `You changed the contract ${contract.path} of ${step.service}. The change was sent to the owner as a new proposal of the contract step: when it is validated, build against the contract as validated.`,
    });
    this.inbox.addContract({ ticket: id, project, sessionId: live.id, step: owner.id, service: owner.service, path: contract.path, diff: this.#clean(contract.diff) });
    await this.registry.ticketStore.comment(id, note, SERVICE).catch(() => undefined);
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
    // A contract reopened after steps ran on the old one (#reopenContract): those steps run again against the new.
    this.#steps.rerun(step.ticket, step.position);
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
  // The mirror of a tracker (tickets/mirror.ts, P232) gives its own words:
  // a person moved the ticket there.
  async setAside(id: TicketId, by: UserId, words?: { readonly note: string; readonly message: string }): Promise<{ readonly sessions: number; readonly items: number }> {
    const note = words?.note ?? 'The owner set this ticket aside: its sessions were stopped and nothing of it waits in the inbox. Move it to Todo to start it again.';
    const message = words?.message ?? 'The owner set the ticket aside: this session was stopped.';
    return this.#takeOut(id, by, { message, code: 'set_aside', reason: 'set_aside', note, refusal: 'it is not set aside' });
  }

  // Close (POST /api/tickets/:id/close, issue #249): a ticket that should
  // never ship, closed with the reason the owner gives. It is set aside
  // (the same service side, #takeOut) and also says why: the release card
  // is handled with an outcome holding the reason, who and when, so it
  // stays in the history, and the comment on the ticket keeps the reason.
  // It never merges or deploys. A done ticket has shipped: it is refused.
  async closeTicket(id: TicketId, reason: string, by: UserId): Promise<{ readonly sessions: number; readonly items: number }> {
    const given = reason.trim();
    if (given === '') throw new FlowError('invalid', 'a Close says why');
    if (given.length > CLOSE_REASON_MAX) throw new FlowError('invalid', `a Close’s reason is at most ${CLOSE_REASON_MAX} characters`);
    const note = `The owner closed this ticket (${by}): ${given}\nIts sessions were stopped and nothing of it waits in the inbox. Move it to Todo to start it again.`;
    const pulls = this.#pullRequestsOf(id);
    const result = await this.#takeOut(id, by, { message: 'The owner closed the ticket: this session was stopped.', code: 'closed', reason: 'closed', note, refusal: 'it is not closed', closed: given, refuseDone: true });
    await this.#closePullRequests(id, pulls, given);
    return result;
  }

  // The pull requests of the ticket's release cards, each once: the cards
  // Cleared made from what it published (a repair reuses the pull request).
  // Read before the Close settles the cards.
  #pullRequestsOf(id: TicketId): { readonly pr: number; readonly service?: ServiceConfig }[] {
    const found = new Map<string, { pr: number; service?: ServiceConfig }>();
    for (const item of this.inbox.items()) {
      if (item.kind !== 'release' || item.ticket !== id) continue;
      if (item.train) {
        for (const stop of item.train.services) {
          const service = this.#workspace.services.find((s) => s.name === stop.service);
          if (stop.pr && service) found.set(`${service.name}#${stop.pr.number}`, { pr: stop.pr.number, service });
        }
      } else found.set(`#${item.pr.number}`, { pr: item.pr.number });
    }
    return [...found.values()];
  }

  // After a Close (issue #249, P114): the pull requests are closed on the
  // forge with the reason. The ticket is closed whatever happens here; what
  // could not be closed is said on the ticket, for the owner to do by hand.
  async #closePullRequests(id: TicketId, pulls: readonly { readonly pr: number; readonly service?: ServiceConfig }[], reason: string): Promise<void> {
    const close = this.#effects.closePullRequest;
    if (!close || pulls.length === 0) return;
    const branches = [...new Set([this.#branchOf(id), ticketBranch(id)])];
    const failed: string[] = [];
    for (const { pr, service } of pulls) {
      try {
        await close.call(this.#effects, { pr, branches, reason, ...(service ? { service } : {}) });
      } catch (error) {
        console.error(`cleared-v2: the pull request #${pr} of ${id} was not closed (${error instanceof Error ? error.name : typeof error})`);
        const said = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 300) : 'unknown error';
        failed.push(`#${pr}${service && this.#several ? ` of ${service.name}` : ''} (${said})`);
      }
    }
    if (failed.length > 0)
      await this.registry.ticketStore.comment(id, this.#clean(`The ticket is closed, but the pull request ${failed.join(', ')} was not closed on GitHub: close it by hand if it should be. The branch was not touched.`), SERVICE).catch(() => undefined);
  }

  async #takeOut(id: TicketId, by: UserId, how: {
    readonly message: string; readonly code: string; readonly reason: PutBackReason; readonly note: string; readonly refusal: string;
    readonly closed?: string; readonly refuseDone?: boolean;
  }): Promise<{ readonly sessions: number; readonly items: number }> {
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(id);
    if (!ticket || ticket.project !== this.config.project) throw new FlowError('not_found', `unknown ticket ${id}`);
    if (ticket.status === tickets.states.go) throw new FlowError('conflict', `${id} is in “${ticket.status}”: ${how.refusal}`);
    if (how.refuseDone && ticket.status === tickets.states.done) throw new FlowError('conflict', `${id} is in “${ticket.status}”: ${how.refusal}`);
    if (this.#trains.latest(id)?.state === 'landing') throw new FlowError('conflict', `the train of ${id} is landing: ${how.refusal}`);
    const done = ticket.status === tickets.states.done;
    const { sessions, items } = await this.#stopAll(id, by, how.message, how.code, how.note, how.closed);
    if (done) return { sessions, items };
    if (ticket.status !== tickets.states.todo) await this.#putBack(id, how.note, how.reason);
    else {
      this.#origins.delete(id);
      this.#steps.hold(id);
      this.#dropVariants(id, how.note);
      await tickets.comment(id, how.note, SERVICE).catch(() => undefined);
    }
    return { sessions, items };
  }

  // Every session of the ticket stops, `message` on each live one's thread
  // under `code`, and everything of it that waits in the inbox is settled; a
  // train not yet approved is halted (Set aside, Resume from here).
  async #stopAll(id: TicketId, by: UserId, message: string, code: string, note: string, closed?: string): Promise<{ readonly sessions: number; readonly items: number }> {
    // No step of it starts while its sessions stop.
    this.#active.delete(id);
    let sessions = 0;
    for (const live of [...this.#live.values()].filter((l) => l.input.ticket === id && !l.closed)) {
      this.#journal({ id: live.id, ticket: id, project: live.input.project }, { type: 'RUN_ERROR', message, code });
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
      if (item.kind === 'release' ? this.#settleRelease(item.id, id, item.project, by, closed) : this.inbox.handle(item.id, by)) items++;
    }
    this.#trains.haltActive(id);
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
    // The notes of the other steps this session has not read (M4).
    const handed = this.#notesFor(step, notesRead(this.#store.events.after(step.session)));
    try {
      await handle.send({ text: handed.length > 0 ? `${text}\n\n${notesText(handed, (n) => this.#noteSource(step.ticket, n))}` : text, by });
      if (handed.length > 0) this.#journal({ id: step.session, ticket: step.ticket, project: live.input.project }, { type: 'CUSTOM', name: 'cleared.step_notes_read', value: { ids: handed.map((n) => n.id) } });
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

  // ---- a ticket in variants (issue #271) ------------------------------------

  // Why `count` variants, or a harness pick on these harnesses, cannot run
  // on this workspace; undefined when they can. The route asks before it
  // creates the ticket, start() again.
  variantsRefusal(spec: number | readonly Harness[]): string | undefined {
    if (typeof spec === 'object') {
      if (spec.length < VARIANTS_MIN || spec.length > VARIANTS_MAX) return `a harness pick names ${VARIANTS_MIN} to ${VARIANTS_MAX} harnesses, one per variant`;
      const enabled = (this.config.pickHarnesses ?? PICK_DEFAULT).map((p) => p.harness);
      for (const harness of spec) {
        if (!enabled.includes(harness))
          return `${String(harness)} is not enabled for the harness pick: CLEARED_V2_PICK_HARNESSES names ${enabled.join(', ')} (the real Codex and Cursor wait for the owner's trials)`;
        if (!this.registry.sessionAdapters[harness]) return `no adapter for ${harness} is registered`;
      }
    } else if (!Number.isInteger(spec) || spec < VARIANTS_MIN || spec > VARIANTS_MAX) return `variants is a whole number from ${VARIANTS_MIN} to ${VARIANTS_MAX}`;
    if (this.#several) return `variants run on a workspace of one service, and ${this.#workspace.id} has ${this.#workspace.services.length}`;
    return undefined;
  }

  async #startVariants(ticket: Ticket, by: UserId, origin: Origin | undefined, spec: number | readonly Harness[]): Promise<void> {
    const pick = typeof spec === 'object';
    const count = pick ? spec.length : spec;
    this.#variants.create(ticket.id, this.config.project, pick ? { harnesses: spec, kind: ticketType(ticket.labels) } : count);
    const how = pick ? `${count} variants, one per harness: ${spec.join(', ')}` : `${count} variants`;
    const comment = origin
      ? `Started by the lead for plan ${origin.plan} (item ${origin.item}), approved by ${by}, in ${how}.`
      : `Started by ${by} in ${how}.`;
    await this.registry.ticketStore.comment(ticket.id, comment, SERVICE).catch(() => undefined);
    await this.#runVariants(ticket.id, by);
  }

  // The flow's tick of a ticket in variants: each waiting variant starts,
  // in position order, while fewer than the lanes run (the Consumption
  // screen's, else VARIANT_PARALLEL). The sessions are watched once all of
  // them have started, as a ticket's steps are. Every variant failed: the
  // ticket goes back to Todo.
  async #runVariants(id: TicketId, by?: UserId): Promise<void> {
    const started: Live[] = [];
    for (;;) {
      if (!this.#active.has(id)) break;
      const variants = this.#variants.list(id);
      if (variants.length === 0 || variants.some((v) => v.state === 'chosen')) break;
      const limit = Math.max(1, this.#levers?.read().maxLanes ?? VARIANT_PARALLEL);
      if (variants.filter((v) => v.state === 'running').length >= limit) break;
      const next = variants.find((v) => v.state === 'waiting');
      if (!next) break;
      // A harness at the week stop starts no variant of a pick; the others go on.
      const stop = next.pick ? this.#quotaStop(next.harness) : undefined;
      if (stop) {
        const note = this.#clean(`Variant ${next.position} of ${variants.length} (${next.harness}) not started: ${stop}`);
        this.#variants.update(next.id, { state: 'failed', note });
        await this.registry.ticketStore.comment(id, note, SERVICE).catch(() => undefined);
        this.#showVariants(id);
        continue;
      }
      // Running before the first wait, so a second tick never starts it too.
      this.#variants.update(next.id, { state: 'running' });
      try {
        started.push(await this.#launchVariant(id, next, variants.length, by && started.length === 0 && this.#flowOf(id).size === 0 ? by : undefined));
      } catch (error) {
        const note = this.#clean(`Variant ${next.position} of ${variants.length} failed: its session could not start: ${name(error)}`);
        this.#variants.update(next.id, { state: 'failed', note });
        await this.registry.ticketStore.comment(id, note, SERVICE).catch(() => undefined);
        this.#showVariants(id);
      }
    }
    for (const live of started) if (!live.closed) this.#supervise(live, 0);
    const variants = this.#variants.list(id);
    if (this.#active.has(id) && variants.length > 0 && variants.every((v) => v.state === 'failed'))
      await this.#putBack(id, `Every variant of the ticket failed:\n${variants.map((v) => `- ${v.note ?? `variant ${v.position} failed`}`).join('\n')}`, 'variants_failed');
    else await this.#pickIfEnded(id);
  }

  // Why a harness starts no variant now: one of its windows at or above the
  // week stop, the seven-day one first; undefined when it may start.
  #quotaStop(harness: Harness): string | undefined {
    for (const window of QUOTA_WINDOWS) {
      const quota = latestQuota(this.#store.db, { project: this.config.project, window, now: this.#now(), harness });
      if (quota && quota.usedPercent >= this.#weekStop)
        return `the ${window === 'seven_day' ? 'seven-day' : 'five-hour'} window of ${harness} is at ${quota.usedPercent} %, at or above the stop of ${this.#weekStop} %.`;
    }
    return undefined;
  }

  // A harness pick whose variants have all ended keeps, by itself, the
  // cheapest of those whose tests passed (flow/harness-pick.ts), through the
  // owner's own choice; with none green, the owner chooses in the inbox.
  async #pickIfEnded(id: TicketId): Promise<void> {
    if (!this.#active.has(id)) return;
    const variants = this.#variants.list(id);
    const round = variants[0]?.round;
    if (round === undefined || !variants[0]?.pick || variants.some((v) => v.state === 'waiting' || v.state === 'running' || v.state === 'chosen')) return;
    if (!variants.some((v) => v.state === 'done')) return;
    const item = this.inbox.variants({ ticket: id }).find((i) => i.round === round);
    if (!item || this.#picking.has(item.id)) return;
    this.#picking.add(item.id);
    const done = variants.filter((v) => v.state === 'done');
    // Green: its tests passed and it committed a change, so a variant that changes nothing never wins by spending least.
    const green = (v: Variant) => v.tests === 'passed' && v.files.length > 0;
    const winner = pickWinner(done.map((v) => ({ position: v.position, harness: v.harness, green: green(v), tokens: v.tokens, workMs: v.workMs ?? 0 })));
    if (!winner) {
      const declared = done.find((v) => v.session)?.session;
      const command = declared ? this.#inputs.get(declared)?.settings.testCommand : undefined;
      const why = command
        ? `No variant committed a change and passed \`${command.join(' ')}\` in its own session: the harness pick keeps none, and the owner chooses in the inbox.`
        : 'The service declares no test command, so no variant can pass its tests: the harness pick keeps none, and the owner chooses in the inbox.';
      await this.registry.ticketStore.comment(id, why, SERVICE).catch(() => undefined);
      return;
    }
    const chosen = done.find((v) => v.position === winner.position) as Variant;
    const command = chosen.session ? this.#inputs.get(chosen.session)?.settings.testCommand?.join(' ') : undefined;
    const passed = done.filter(green).length;
    const measure = winner.measure === 'tokens' ? 'the fewest tokens' : 'the shortest agent time';
    const why = passed === 1 ? 'and it was the only one to pass' : `and it used ${measure} of the ${passed} that passed`;
    await this.#keep(item.id, id, variants, chosen, SERVICE.id, (stopped) =>
      `Variant ${chosen.position} of ${variants.length} (${chosen.harness}) kept by the harness pick: its \`${command ?? 'tests'}\` passed, ${why}${stopped.length > 0 ? `; ${stopped.length === 1 ? 'variant' : 'variants'} ${stopped.join(', ')} stopped` : ''}.`,
      winner.measure);
  }

  // A variant's session, in its own checkout, told it is one of several,
  // on its harness and that harness's model.
  async #launchVariant(id: TicketId, variant: Variant, count: number, by: UserId | undefined): Promise<Live> {
    const adapter = this.registry.sessionAdapters[variant.harness];
    if (!adapter) throw new FlowError('unavailable', `no adapter for ${variant.harness} is registered`);
    const ticket = await this.#ticketOf(id);
    const began = this.#now();
    const settings = await this.#settings(ticket);
    const prepared = await this.#effects.prepareWorkdir({ ticket, role: 'author', variant: { round: variant.round, position: variant.position } });
    const workspaceDone = this.#now();
    // A Codex or Cursor author has no host tools (their adapters take none), as in a handover.
    const tools = this.config.authorTools === true && variant.harness === HARNESS;
    const note = this.#origins.get(id)?.note;
    const prompt = [authorPrompt(ticket, { plan: tools, report: tools }), variantPrompt(variant.position, count), ...(variant.pick ? [pickPrompt(settings.testCommand)] : []), ...(note ? [note] : [])].join('\n\n');
    this.#variantDirs.add(prepared.workdir);
    const live = await this.#launch(adapter, ticket, 'author', this.#variantModel(ticket, variant.harness), prepared.workdir, prepared.briefing, settings, prompt, tools ? 'plan' : undefined, undefined, variant.harness);
    const session = { id: live.id, ticket: id, project: this.config.project };
    // Read again after the waits: a choice, a put back or a set aside may
    // have dropped the variant while its checkout and its session started.
    // Its session stops at once, and its containers go with it.
    const now = this.#variants.get(variant.id);
    if (now?.state !== 'running') {
      this.#variants.update(variant.id, { session: live.id, workdir: prepared.workdir });
      this.#flowOf(id).delete(live.id);
      const why = now?.note ?? 'This variant was dropped while it started: its session was stopped.';
      this.#journal(session, { type: 'RUN_ERROR', message: why, code: 'variant_dropped' });
      await this.#close(live, 'stopped', why);
      await this.#releaseNow([live.id]);
      return live;
    }
    this.#variants.update(variant.id, { session: live.id, workdir: prepared.workdir });
    this.#variantOf.set(live.id, variant.id);
    this.#step(session, 'STEP_STARTED', 'workspace', began);
    this.#step(session, 'STEP_FINISHED', 'workspace', workspaceDone);
    this.#step(session, 'STEP_STARTED', 'author', workspaceDone);
    this.#snapshot(live.id, id);
    if (by) this.#emit({ type: 'ticket_started', at: this.#at(), project: this.config.project, ticket: id, by, origin: this.#origins.get(id) ?? null, session: live.id });
    return live;
  }

  // The model of a variant on `harness`: the author's on Claude Code; on
  // another, the one CLEARED_V2_PICK_HARNESSES names, else Codex's default.
  #variantModel(ticket: Ticket, harness: Harness): string {
    if (harness === HARNESS) return this.#authorModel(ticket);
    const named = (this.config.pickHarnesses ?? []).find((p) => p.harness === harness)?.model;
    if (named) return named;
    if (harness === 'codex') return CODEX_MODEL;
    throw new FlowError('invalid', `CLEARED_V2_PICK_HARNESSES names no model for ${harness}`);
  }

  // A variant's author ended its work: what its branch changes is read and
  // shown with the others for the owner's choice, and the next one starts.
  // In a harness pick, its own last run of the tests and its cost are kept.
  async #variantDone(live: Live, variant: Variant): Promise<void> {
    const { ticket: id, project } = live.input;
    this.#step({ id: live.id, ticket: id, project }, 'STEP_FINISHED', 'author');
    await this.#close(live, 'done');
    this.#emit({ type: 'author_done', at: this.#at(), project, ticket: id, session: live.id });
    let read: { readonly files: readonly string[]; readonly diff: string } = { files: [], diff: '' };
    let note: string | null = null;
    if (!this.#effects.variantChanges) note = 'What it changed cannot be read: the flow has no reader of a variant\'s branch.';
    else {
      try {
        read = await this.#effects.variantChanges({ ticket: id, workdir: live.input.workdir, variant: { round: variant.round, position: variant.position } });
      } catch (error) {
        note = this.#clean(`What it changed could not be read: ${name(error)}`);
      }
    }
    const diff = this.#clean(read.diff);
    this.#variants.update(variant.id, {
      state: 'done', files: [...read.files], ...diffLines(diff), diff: diff.slice(0, VARIANT_DIFF_MAX), cut: diff.length > VARIANT_DIFF_MAX,
      cost: this.#stepCost({ sessions: [live.id] }), minutes: this.#stepMinutes({ sessions: [live.id] }), note,
      ...(variant.pick ? this.#pickFacts(live) : {}),
    });
    if (!this.#active.has(id)) return;
    this.#showVariants(id);
    await this.#runVariants(id);
  }

  // A pick's variant as the ranking reads it: its own last run of the
  // declared test command, from the ledger, and its tokens and agent time
  // (P211's sessionsCost); no tokens when its harness reports none.
  #pickFacts(live: Live): Pick<Variant, 'tests' | 'tokens' | 'workMs'> {
    const events = this.#store.events.after(live.id);
    const cost = sessionsCost([events]);
    return {
      tests: testRunOf(events, live.settings.testCommand)?.outcome ?? 'not_run',
      tokens: cost.tokens !== null && cost.tokens > 0 ? cost.tokens : null,
      workMs: cost.workMs,
    };
  }

  // A variant's session that cannot go on fails its variant alone; the
  // ticket's other variants go on.
  async #failVariant(from: Live, variant: Variant, code: string | undefined, runMessage: string | undefined, note: string, phase: 'stopped' | 'failed'): Promise<void> {
    const id = from.input.ticket;
    if (code !== undefined && runMessage !== undefined)
      this.#journal({ id: from.id, ticket: id, project: from.input.project }, { type: 'RUN_ERROR', message: this.#clean(runMessage), code });
    await this.#close(from, phase, note);
    const why = this.#clean(`Variant ${variant.position} of ${this.#variants.list(id, variant.round).length} failed: ${note}`);
    this.#variants.update(variant.id, { state: 'failed', note: why, cost: this.#stepCost({ sessions: [from.id] }), minutes: this.#stepMinutes({ sessions: [from.id] }) });
    await this.registry.ticketStore.comment(id, why, SERVICE).catch(() => undefined);
    if (!this.#active.has(id)) return;
    this.#showVariants(id);
    await this.#runVariants(id);
  }

  // The variants item of the ticket's run: added once a variant is done,
  // then kept as the variants are.
  #showVariants(id: TicketId): void {
    const variants = this.#variants.list(id);
    const round = variants[0]?.round;
    if (round === undefined || !variants.some((v) => v.state === 'done')) return;
    const shown = variants.map(publicVariant);
    const item = this.inbox.variants({ ticket: id }).find((i) => i.round === round);
    if (item) this.inbox.setVariants(item.id, shown);
    else this.inbox.addVariants({ ticket: id, project: this.config.project, round, variants: shown, ...(variants[0]?.pick ? { pick: true } : {}) });
  }

  // A ticket that leaves the flow drops what of its variants was open, and
  // its variants item no longer waits.
  #dropVariants(id: TicketId, note: string): void {
    this.#variants.drop(id, this.#clean(note));
    for (const item of this.inbox.variants({ ticket: id })) this.inbox.handle(item.id, 'system');
  }

  // The ticket's last run of variants (GET /api/tickets/:id/variants): none
  // for a ticket that never ran in variants, undefined for an unknown ticket.
  async ticketVariants(id: TicketId): Promise<TicketVariant[] | undefined> {
    const variants = this.#variants.list(id);
    if (variants.length === 0 && !(await this.registry.ticketStore.get(id))) return undefined;
    return variants.map(publicVariant);
  }

  // Choose (POST /api/variants/:id/choose): the variant at `position`, done,
  // is the one reviewed. The others stop now, whether they still run, wait
  // for a lane or are done, and their containers and networks are released
  // at once, by session; `released` counts what was removed. The review
  // starts in the background, since a click does not wait for a container.
  async chooseVariant(itemId: string, position: number, by: UserId): Promise<{ readonly released: number }> {
    const item = this.inbox.item(itemId);
    if (!item || item.kind !== 'variants') throw new FlowError('not_found', `unknown variants item ${itemId}`);
    if (item.state !== 'waiting') throw new FlowError('conflict', `variants item ${itemId} is already answered`);
    const id = item.ticket;
    const variants = this.#variants.list(id, item.round);
    const chosen = variants.find((v) => v.position === position);
    if (!chosen) throw new FlowError('invalid', `the ticket ${id} has no variant ${position}`);
    if (chosen.state !== 'done') throw new FlowError('conflict', `variant ${position} of ${id} is ${chosen.state}: only a variant that is done is chosen`);
    if (!this.#active.has(id)) throw new FlowError('conflict', `ticket ${id} no longer runs`);
    return this.#keep(itemId, id, variants, chosen, by, (stopped) =>
      `Variant ${position} of ${variants.length} chosen by ${by} for review${stopped.length > 0 ? `; ${stopped.length === 1 ? 'variant' : 'variants'} ${stopped.join(', ')} stopped` : ''}.`);
  }

  // The variant kept, by the owner or by a harness pick (`measure`): the
  // others stop now and their containers and networks go, and the review
  // starts in the background.
  async #keep(itemId: string, id: TicketId, variants: readonly Variant[], chosen: Variant, by: UserId, comment: (stopped: readonly number[]) => string, measure?: PickMeasure): Promise<{ readonly released: number }> {
    const position = chosen.position;
    // Written before the first wait, so a second choice is refused.
    const note = measure
      ? `The harness pick kept variant ${position} of ${variants.length}: this variant was stopped.`
      : `The owner chose variant ${position} of ${variants.length}: this variant was stopped.`;
    const others = variants.filter((v) => v.id !== chosen.id);
    for (const v of others) if (v.state !== 'failed') this.#variants.update(v.id, { state: 'dropped', note });
    this.#variants.update(chosen.id, { state: 'chosen', won: measure !== undefined });
    this.inbox.setVariants(itemId, this.#variants.list(id, chosen.round).map(publicVariant));
    if (!this.inbox.handleVariants(itemId, by, position, measure)) throw new FlowError('conflict', `variants item ${itemId} is already answered`);
    const dropped: SessionId[] = [];
    for (const v of others) {
      if (!v.session) continue;
      const live = this.#live.get(v.session);
      if (live && !live.closed) {
        this.#journal({ id: live.id, ticket: id, project: live.input.project }, { type: 'RUN_ERROR', message: note, code: 'variant_dropped' });
        await this.#close(live, 'stopped', note);
      }
      const dormant = this.#dormant.get(v.session);
      if (dormant) this.#endDormant(dormant, 'stopped');
      this.#flowOf(id).delete(v.session);
      dropped.push(v.session);
    }
    const released = await this.#releaseNow(dropped);
    await this.registry.ticketStore.comment(id, comment(others.map((v) => v.position)), SERVICE).catch(() => undefined);
    this.#background(this.#reviewVariant(id, chosen), id);
    return { released };
  }

  // The containers and networks of variants that stop, released now rather
  // than at the next tick; how many were removed. A failure is said and the flow goes on.
  async #releaseNow(sessions: readonly SessionId[]): Promise<number> {
    const named = sessions.filter(isSessionId);
    if (!this.#release || named.length === 0) return 0;
    try {
      const { containers, networks } = await this.#release(named);
      return containers.length + networks.length;
    } catch (error) {
      console.error(`cleared-v2: the containers and networks of the variants not chosen could not be released (${error instanceof Error ? error.name : typeof error})`);
      return 0;
    }
  }

  // The chosen variant's handover is stored, and its review starts in its checkout.
  async #reviewVariant(id: TicketId, chosen: Variant): Promise<void> {
    const tickets = this.registry.ticketStore;
    const ticket = await tickets.get(id);
    if (!ticket || !this.#active.has(id)) return;
    const kept = chosen.session ? this.#inputs.get(chosen.session) : undefined;
    if (chosen.session && chosen.workdir) {
      try {
        await this.#effects.captureHandover({ workdir: chosen.workdir, role: 'author', model: kept?.input.model ?? this.#authorModel(ticket), ticket: id, sessionId: chosen.session });
      } catch (error) {
        await tickets.comment(id, this.#clean(`The author's handover could not be stored: ${name(error)}`), SERVICE).catch(() => undefined);
      }
    }
    await tickets.move(id, tickets.states.review, SERVICE);
    await this.#startReview(ticket, chosen.workdir ?? '');
  }

  // Haiku for a Quick ticket, unless Haiku reviews it or a service it
  // touches is `full` (decision 24), which refuses the fast lane.
  #authorModel(ticket: Ticket): string {
    if (!ticket.labels.includes(QUICK_LABEL) || this.#fastLanes.demoted(ticket.id) || this.#reviewerModel(ticket) === QUICK_MODEL) return this.#chosenModel(ticket);
    return this.#servicesOf(ticket).some((service) => service.sensitivity === 'full') ? this.#chosenModel(ticket) : QUICK_MODEL;
  }

  // The configured author model, or the one the owner chose on the Consumption
  // screen, unless the ticket's reviewer is on that model: the reviewer is another one.
  // Then the profile's (issue #452), under the same rule; the Consumption
  // screen's choice is the owner's switch of the moment, and comes first.
  #chosenModel(ticket: Ticket): string {
    const reviewer = this.#reviewerModel(ticket);
    for (const chosen of [this.#levers?.read().model, this.#profiles.profile.current().body.authorModel]) if (chosen && chosen !== reviewer) return chosen;
    return this.config.authorModel;
  }

  // The reviewer a `reviewer:<model>` sensitivity names, on the first service
  // of the ticket that names one (decision 24); else the configured one. The
  // workspace's configuration refuses one naming the author model. Then
  // the profile's (issue #452), which names another than its author's.
  #reviewerModel(ticket: Ticket): string {
    for (const service of this.#servicesOf(ticket)) if (service.sensitivity.startsWith('reviewer:')) return service.sensitivity.slice('reviewer:'.length);
    return this.#profiles.profile.current().body.reviewerModel ?? this.config.reviewerModel;
  }

  // The harnesses of a pick a profile on auto asks for: the ones enabled
  // whose adapter is registered, on a workspace of one service; fewer than
  // two, none, and the ticket runs on Claude Code as before.
  #autoHarnesses(): readonly Harness[] | undefined {
    if (this.#profiles.profile.current().body.harness !== 'auto' || this.#several) return undefined;
    const enabled = (this.config.pickHarnesses ?? PICK_DEFAULT).map((p) => p.harness).filter((harness) => this.registry.sessionAdapters[harness]);
    return enabled.length >= VARIANTS_MIN ? enabled.slice(0, VARIANTS_MAX) : undefined;
  }

  // start() in the background, for the routes: a person's click does not
  // wait for a clone. A failure becomes a note on the ticket (start wrote it).
  begin(ticketId: TicketId, by: UserId, origin?: Origin, variants?: number | readonly Harness[]): Promise<void> {
    return this.#track(this.start(ticketId, by, origin, variants).catch(() => undefined));
  }

  // start() in the background for the batches' runner (requirement C6,
  // flow/batch.ts): waited for by settled() as begin is, its failure handed
  // back to the caller, which says it on the batch's item.
  launch(ticketId: TicketId, by: UserId): Promise<void> {
    return this.#track(this.start(ticketId, by));
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

  // The harness a session runs on, from its row: a session handed over to Codex is resumed by Codex's adapter, not Claude's (B6.3).
  #harnessOf(id: SessionId): Harness {
    return this.#store.sessions.get(id)?.harness ?? HARNESS;
  }

  // The reviewer of a ticket that changed harness is the other harness than
  // its last author's, so that no harness judges its own work (B6.3, P154);
  // a ticket that never changed harness keeps Claude Code's reviewer, and so
  // does one whose last author is Codex or Cursor (a pick's kept variant,
  // issue #329). The variants not kept have left the flow, so their
  // harnesses count for nothing here.
  #reviewerHarness(ticket: TicketId): Harness {
    const authors = this.#flowRows(ticket).filter((row) => row.role === 'author');
    if (!authors.some((row) => row.harness !== HARNESS)) return HARNESS;
    return authors.at(-1)?.harness === HARNESS ? 'codex' : HARNESS;
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
  async #launch(adapter: SessionAdapter, ticket: Ticket, role: Role, model: string, workdir: string, briefing: Briefing, settings: ProjectSettings, prompt: string, author?: 'plan' | 'report', step?: { readonly service: string; readonly siblings?: readonly SiblingSpec[]; readonly note?: HostTool }, harness: Harness = HARNESS): Promise<Live> {
    // A train ticket's session works on the first service the ticket names (decision 20, lane 15's runtime), a step's on its own.
    const service = step?.service ?? (this.#several ? this.#servicesOf(ticket)[0]?.name : undefined);
    const given = [...(author ? this.#authorTools(ticket, author === 'plan') : []), ...(step?.note ? [step.note] : [])];
    const tools = given.length > 0 ? given : undefined;
    // The profile's and the environment's current versions (issue #452), read
    // before any wait, as the caller read the model from the same version.
    const profile = this.#profiles.profile.current();
    const environment = this.#profiles.environment.current();
    const rolePrompt = role === 'author' ? profile.body.rolePrompts.author : role === 'reviewer' ? profile.body.rolePrompts.reviewer : '';
    const limits = { ...(environment.body.cpus ? { cpus: environment.body.cpus } : {}), ...(environment.body.memory ? { memory: environment.body.memory } : {}) };
    const input: StartInput = {
      project: this.config.project, ticket: ticket.id, role, harness, model, workdir, briefing,
      policy: this.#policy(role, settings, tools, author === 'plan', profile.body, environment.body), prompt: rolePrompt ? `${prompt}\n\n${rolePrompt}` : prompt,
      services: settings.services, ...(service ? { service } : {}), ...(tools ? { tools } : {}),
      ...(step?.siblings ? { siblings: step.siblings } : {}),
      ...(environment.body.image ? { image: environment.body.image } : {}), ...(Object.keys(limits).length > 0 ? { limits } : {}),
    };
    const handle = await adapter.start(input);
    // The fake adapter plays a first turn's host calls inside start(): the gate may exist already.
    if (author === 'plan' && !this.#gates.has(handle.id)) this.#gates.set(handle.id, { phase: 'planning', stepOpen: false });
    const at = this.#now().toISOString();
    this.#store.sessions.put({ id: handle.id, project: input.project, ticket: ticket.id, role, harness, model, status: role === 'reviewer' ? 'reviewing' : 'working', createdAt: at, updatedAt: at });
    recordSessionVersions(this.#store.db, handle.id, { profile: profile.version, environment: environment.version, auto: profile.body.harness === 'auto' });
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
  // An author whose session plan waits for its Go is `planning` (plan.before_go):
  // from its start, before its gate exists, until the Go, and again after a Change.
  // The session is found by its policy object, which an adapter's copy of the input keeps.
  policyFor(input: StartInput): Policy {
    if (input.role === 'lead' || input.project !== this.config.project) return input.policy;
    const live = input.role === 'author' ? [...this.#live.values()].find((candidate) => candidate.input.policy === input.policy) : undefined;
    const gate = live ? this.#gates.get(live.id) : undefined;
    const planning = input.role === 'author' && (gate ? gate.phase !== 'working' : input.policy.planning === true);
    const skill = input.role === 'author' ? skillTicketService(this.#store.db, input.ticket) : undefined;
    return {
      ...input.policy, planning, learned: [...this.#store.policyRules.learned(input.project), ...toolRules(input.tools)], ticketFiles: this.#ticketFiles(input.ticket, input.workdir),
      ...(skill ? { skillFile: skillPath(skill) } : {}),
    };
  }

  // An edit counts once its result says it was made: a refused or failed
  // edit changed nothing. Read incrementally, since this runs at every tool call.
  // A variant's session counts only the sessions of its own checkout: its
  // siblings' files are not in it (issue #271).
  #ticketFiles(ticket: TicketId, workdir?: string): string[] {
    const out = new Set<string>();
    const own = workdir !== undefined && this.#variantDirs.has(workdir);
    for (const row of this.#store.sessions.list({ ticket })) {
      if (row.role === 'lead') continue;
      if (own && this.#inputs.get(row.id)?.input.workdir !== workdir) continue;
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

  // The profile's allowed commands after the project's; the environment's
  // hosts after the project's, or none past the model API and the registry
  // on a model-only network (issue #452).
  #policy(role: Role, settings: ProjectSettings, tools?: readonly HostTool[], planning = false, profile: AgentProfile = DEFAULT_PROFILE, environment: AgentEnvironment = DEFAULT_ENVIRONMENT): Policy {
    return {
      role, ...(planning ? { planning } : {}), base: this.config.base, workdir: WORKDIR_MOUNT, scripts: settings.scripts, credentialFile: LOGIN_FILE_MOUNT,
      safeCommands: [...DEFAULT_SAFE_COMMANDS, ...settings.safeCommands, ...profile.allowedTools],
      allowedHosts: environment.network === 'model-only' ? [] : [...settings.hosts, ...environment.allowedHosts], forbiddenHosts: [],
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
    if (event.type === 'TOOL_CALL_RESULT' || event.type === 'RUN_FINISHED') await this.#checkpoint(live);
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
          if (live.input.role === 'author') await this.#askedOnFastLane(session.ticket, session.project);
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
      // The end of a turn interrupted by a handover can be read after the session was stopped: it stays stopped.
      if (!live.closed) this.#setPhase(live, 'waiting_human');
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
    // A variant fails alone; a spent budget is the ticket's, and stops them all (issue #271).
    const variantId = this.#variantOf.get(from.id);
    const variant = variantId ? this.#variants.get(variantId) : undefined;
    if (variant && variant.state === 'running' && reason !== 'budget') return this.#failVariant(from, variant, code, runMessage, note, phase);
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
    this.#dropVariants(ticket, note);
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
    const variantId = this.#variantOf.get(author.id);
    const variant = variantId ? this.#variants.get(variantId) : undefined;
    if (variant && variant.state === 'running') return this.#variantDone(author, variant);
    const stepId = this.#stepOf.get(author.id);
    const step = stepId ? this.#steps.get(stepId) : undefined;
    if (step && step.state === 'running' && this.#steps.list(id).length > 1) return this.#stepDone(author, step);
    const session = { id: author.id, ticket: id, project };
    this.#step(session, 'STEP_FINISHED', 'author');
    await this.#captureProof(author, step ? this.#service(step.service) : this.#workspace.services[0] as ServiceConfig);
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
    await this.#judgeFast(ticket, { workdir: author.input.workdir });
    if (!(await this.#environmentChecked(ticket, author))) return;
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
  // author's answer, is journaled on it, unless `journaled`: a reviewer
  // resumed took it before its send failed.
  async #startReview(ticket: Ticket, workdir: string, channel?: readonly ChannelMessage[], journaled = false): Promise<void> {
    const harness = this.#reviewerHarness(ticket.id);
    const adapter = this.registry.sessionAdapters[harness];
    const began = this.#now();
    try {
      if (!adapter) throw new FlowError('unavailable', `no adapter for ${harness} is registered`);
      const settings = await this.#settings(ticket);
      const prepared = this.#several
        ? await this.#effects.prepareWorkdir({ ticket, role: 'reviewer', service: this.#servicesOf(ticket)[0] as ServiceConfig })
        : await this.#effects.prepareWorkdir({ ticket, role: 'reviewer', ...this.#chosenVariant(ticket.id), branch: this.#branchOf(ticket.id) });
      // The files a person changed in the author's checkouts (decision 33): every author session of the flow, a ticket in steps having several.
      const edits = this.#flowRows(ticket.id).filter((row) => row.role === 'author').flatMap((row) => humanEdits({ events: this.#store.events.after(row.id) }));
      // The reviewer's git commands name its own service's base.
      const base = this.#several ? (this.#servicesOf(ticket)[0] as ServiceConfig).base : this.config.base;
      const prompt = reviewPrompt({ ticket, base, verdict: settings.verdict, humanEdits: edits, ...(await this.#reviewServices(ticket)), ...(settings.testCommand ? { testCommand: settings.testCommand } : {}) });
      const live = await this.#launch(adapter, ticket, 'reviewer', harness === HARNESS ? this.#reviewerModel(ticket) : CODEX_MODEL, prepared.workdir || workdir, prepared.briefing, settings,
        channel ? `${prompt}\n\n${channelPrompt(channel)}` : prompt, undefined, undefined, harness);
      this.#step({ id: live.id, ticket: ticket.id, project: ticket.project ?? this.config.project }, 'STEP_STARTED', 'review', began);
      const answer = channel?.at(-1);
      if (answer && !journaled) this.#journal({ id: live.id, ticket: ticket.id, project: live.input.project }, { type: 'CUSTOM', name: 'cleared.review_channel', value: answer });
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
    const adapter = this.registry.sessionAdapters[authorRow ? this.#harnessOf(authorRow.id) : HARNESS];
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
  // start throws is the caller's. `journal`: written on the author's session,
  // once: on the resumed one, else (resume failed) on the new one, but not
  // again on the new one when the resumed one took it and its send failed.
  async #reopenWith(ticket: Ticket, adapter: SessionAdapter, authorRow: { readonly id: SessionId } | undefined, message: string, journal?: AgUiEvent): Promise<void> {
    const id = ticket.id;
    const kept = authorRow ? this.#inputs.get(authorRow.id) : undefined;
    const began = this.#now();
    const lastSeq = authorRow ? (this.#store.events.after(authorRow.id).at(-1)?.seq ?? 0) : 0;
    let journaled = false;
    // A ticket sent back to the full circuit is not answered by its light author (B2.2).
    const light = kept?.input.model === QUICK_MODEL && this.#fastLanes.demoted(id);
    if (authorRow && kept && !light) {
      let handle: SessionHandle | undefined;
      try { handle = await this.#resume(adapter, authorRow.id); } catch { handle = undefined; }
      if (handle) {
        const live: Live = { id: authorRow.id, input: kept.input, settings: kept.settings, handle, lastActivity: this.#now().getTime(), closed: false, waitOpen: false, turnFrom: lastSeq };
        this.#live.set(live.id, live);
        this.#setPhase(live, 'working');
        this.#step({ id: live.id, ticket: id, project: live.input.project }, 'STEP_STARTED', 'author', began);
        if (journal) this.#journal({ id: live.id, ticket: id, project: live.input.project }, journal);
        journaled = true;
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
    // A Codex author has no host tools: it is started again on Codex, with none (B6.3).
    // Another harness than Claude Code keeps the last author's model: Codex's
    // after a handover, the one CLEARED_V2_PICK_HARNESSES named after a pick (issue #329).
    const harness = authorRow ? this.#harnessOf(authorRow.id) : HARNESS;
    const tools = this.config.authorTools === true && harness === HARNESS;
    const model = harness === HARNESS ? this.#authorModel(ticket) : (authorRow ? this.#store.sessions.get(authorRow.id)?.model : undefined) ?? CODEX_MODEL;
    const live = await this.#launch(adapter, ticket, 'author', model, prepared.workdir, prepared.briefing, settings,
      `${authorPrompt(ticket, { plan: false, report: tools })}\n\n${message}`, tools ? 'report' : undefined, undefined, harness);
    this.#step({ id: live.id, ticket: id, project: live.input.project }, 'STEP_STARTED', 'author', began);
    if (journal && !journaled) this.#journal({ id: live.id, ticket: id, project: live.input.project }, journal);
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
    const adapter = this.registry.sessionAdapters[this.#harnessOf(open.reviewer)];
    const kept = this.#inputs.get(open.reviewer);
    const began = this.#now();
    let journaled = false;
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
        journaled = true;
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
    // (journaled already on a reviewer resumed whose send failed: the new
    // reviewer is given it in its prompt, and it is not journaled twice).
    const channel = this.#flowRows(id).filter((row) => row.role === 'reviewer').flatMap((row) => channelOf(this.#store.events.after(row.id)))
      .filter((m) => !(m.from === 'author' && m.round === answer.round));
    await this.#startReview(ticket, author.input.workdir, [...channel, answer], journaled);
  }

  // ---- the proof receipt (P210, issue #326) --------------------------------

  // The captures of `service`, taken while the author's session and its
  // trial environment still run, journaled on the session. A capture that
  // throws, or still runs at the cap, loses the captures, never the ticket.
  // First the rule (P226): a change no person sees, or the human's Off on
  // the ticket, takes none, and no browser starts; the journal says why.
  async #captureProof(live: Live, service: ServiceConfig): Promise<void> {
    const capture = this.#effects.captureProof;
    if (!capture) return;
    const { ticket: id, project } = live.input;
    const need = await this.#captureNeed(live, service);
    const reason = need ? { need } : {};
    if (need && !need.take) {
      this.#journal({ id: live.id, ticket: id, project }, { type: 'CUSTOM', name: 'cleared.proof_captured', value: { service: service.name, missing: [], ...reason } });
      return;
    }
    const failed: ProofCapture = { missing: (['before', 'after', 'video'] as const).map((part) => ({ part, reason: 'failed' as const })) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let got: ProofCapture;
    try {
      // A browser that hangs is given up after the cap: the ticket goes on without its captures.
      const late = new Promise<ProofCapture>((resolve) => { timer = setTimeout(() => resolve(failed), this.config.proofTimeoutMs ?? PROOF_TIMEOUT_MS); });
      got = await Promise.race([capture({ ticket: id, session: live.id, service, dir: this.#proofDir(id, service.name) }), late]);
    } catch {
      got = failed;
    } finally {
      clearTimeout(timer);
    }
    this.#journal({ id: live.id, ticket: id, project }, { type: 'CUSTOM', name: 'cleared.proof_captured', value: { service: service.name, ...got, ...reason } });
  }

  // Whether the author's change needs captures: the paths its branch
  // commits, and the human's choice on the ticket. Undefined without a
  // reader of the diff; a read that fails is said by its code only.
  async #captureNeed(live: Live, service: ServiceConfig): Promise<CaptureNeed | undefined> {
    const read = this.#effects.changedPaths;
    if (!read) return undefined;
    const { ticket, workdir } = live.input;
    const choice = this.#captureChoices.get(ticket).choice;
    let paths: readonly string[] | undefined;
    try { paths = await read({ ticket, service, workdir }); } catch { paths = undefined; }
    return captureNeed(paths, choice);
  }

  // The human's choice of the receipt's captures on a ticket (GET and POST
  // /api/tickets/:id/captures): undefined for a ticket the store does not
  // know. It counts from the next author that ends its work.
  async captureChoice(ticket: TicketId): Promise<CaptureChoice | undefined> {
    if (!(await this.registry.ticketStore.get(ticket))) return undefined;
    return this.#captureChoices.get(ticket);
  }

  async chooseCaptures(ticket: TicketId, choice: CaptureChoiceName, by: UserId): Promise<CaptureChoice> {
    const known = await this.registry.ticketStore.get(ticket);
    if (!known) throw new FlowError('not_found', `unknown ticket ${ticket}`);
    return this.#captureChoices.set(ticket, known.project ?? this.config.project, choice, by, this.#at());
  }

  #proofDir(ticket: TicketId, service: string): string {
    return posix.join(this.config.workdirRoot, PROOF_FOLDER, ticket, service);
  }

  // The receipt's facts, from the ledger only: each review round's run of
  // the declared tests and the last captures of each service, in the
  // current flow; the tokens, the dollars and the time of the ticket as its
  // card says them (consumption/ticket-cost.ts, P211): every session of
  // every run, from the ticket's first stored event to its last.
  #receipt(id: TicketId, reviewer: Live): ReceiptData {
    const tests: ReceiptTest[] = [];
    const captures = new Map<string, ReceiptCapture>();
    for (const row of this.#flowRows(id))
      for (const { event } of this.#store.events.after(row.id)) {
        if (event.type !== 'CUSTOM') continue;
        if (row.role === 'reviewer' && event.name === 'cleared.review_verdict' && event.value.tests)
          tests.push({ round: event.value.round, command: event.value.tests.command, outcome: event.value.tests.outcome });
        if (row.role === 'author' && event.name === 'cleared.proof_captured') captures.set(event.value.service, event.value);
      }
    const cost = ticketCost(this.#store.db, { project: reviewer.input.project, ticket: id });
    const versions = this.#flowRows(id).map((row) => sessionVersions(this.#store.db, row.id, row.role)).filter((v) => v !== undefined);
    const distinct = (pick: (v: { profile: number; environment: number }) => number) => [...new Set(versions.map(pick))].sort((a, b) => a - b);
    return {
      ticket: id,
      tests: tests.sort((a, b) => a.round - b.round),
      testsDeclared: (reviewer.settings.testCommand?.length ?? 0) > 0,
      tokens: cost.tokens,
      costUsd: cost.costUsd,
      elapsedMs: cost.elapsedMs,
      captures: [...captures.values()],
      ...(this.config.linkBase ? { linkBase: this.config.linkBase } : {}),
      ...(versions.length > 0 ? { versions: { profile: distinct((v) => v.profile), environment: distinct((v) => v.environment) } } : {}),
    };
  }

  // A capture of the receipt as a file, for the app's link
  // (GET /api/tickets/:id/proof/:service/:file): one of the three names, or
  // the production page's (P218), of a
  // service of the workspace, of a ticket the store knows; a plain file.
  async proofFile(ticket: TicketId, service: string, file: string): Promise<string | undefined> {
    if (!(Object.values(PROOF_FILES) as string[]).includes(file) && file !== PRODUCTION_FILE) return undefined;
    if (!this.#workspace.services.some((s) => s.name === service)) return undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(ticket) || !(await this.registry.ticketStore.get(ticket))) return undefined;
    return posix.join(this.#proofDir(ticket, service), file);
  }

  // ---- the production page after a landing (P218, issue #334) -------------

  // A release landed: the human approved it, the lock merged it, the human
  // or their CI deployed it, and its watch read the deployed version. Each
  // of its services that configures a [release] production_url has that
  // page captured, once its own watch ended healthy; with no health check,
  // nothing says the deploy is done, and no page is opened. Cleared deploys
  // nothing here: it opens a page and reads it.
  #productionAfter(event: Extract<FlowEvent, { type: 'release_landed' }>): void {
    const { ticket } = event;
    const row = this.#store.db.prepare("SELECT request_id FROM flow_inbox WHERE kind = 'release' AND ticket = ? AND state = 'handled' ORDER BY since DESC, id DESC LIMIT 1").get(ticket) as { request_id?: unknown } | undefined;
    const session = row?.request_id ? String(row.request_id) : '';
    if (!session) return;
    let landed: { readonly service: ServiceConfig; readonly pr: number; readonly health: 'healthy' | 'unwatched' | undefined }[];
    try {
      landed = event.services
        ? (this.#trains.latest(ticket)?.stops ?? []).map((stop) => {
          const landing = landingOf(this.#store.db, { ticket, pr: stop.pr.number, since: stop.askedAt ?? stop.mergedAt ?? event.at, ...(stop.mergedAt ? { mergedHere: stop.mergedAt } : {}) });
          return { service: this.#service(stop.service), pr: stop.pr.number, health: landing.state === 'landed' ? landing.health : undefined };
        })
        : [{ service: this.#workspace.services[0] as ServiceConfig, pr: event.pr, health: event.health }];
    } catch (error) {
      console.error(`cleared-v2: the production page of ${ticket} was not checked (${error instanceof Error ? error.name : typeof error})`);
      return;
    }
    for (const one of landed) {
      void this.#track(this.#checkProduction({ id: session, ticket, project: event.project }, one)
        .catch((error: unknown) => { console.error(`cleared-v2: the production page of ${one.service.name} was not checked after pull request #${one.pr} (${error instanceof Error ? error.name : typeof error})`); }));
    }
  }

  async #checkProduction(session: { readonly id: SessionId; readonly ticket: TicketId; readonly project: string }, landed: { readonly service: ServiceConfig; readonly pr: number; readonly health: 'healthy' | 'unwatched' | undefined }): Promise<void> {
    const { service, pr, health } = landed;
    if (health === undefined) return;
    const filed = this.#store.events.after(session.id).some(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.production_checked' && event.value.service === service.name);
    if (filed) return;
    const url = (await this.#effects.settings(this.#several ? service : undefined)).productionUrl;
    const capture = this.#effects.captureProduction;
    if (!url || !capture) return;
    let got: ProductionCapture | { readonly missing: 'unwatched' };
    if (health === 'unwatched') got = { missing: 'unwatched' };
    else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A browser that hangs is given up after the cap, as the receipt's is.
        const late = new Promise<ProductionCapture>((resolve) => { timer = setTimeout(() => resolve({ missing: 'failed' }), this.config.proofTimeoutMs ?? PROOF_TIMEOUT_MS); });
        got = await Promise.race([capture({ url, dir: this.#proofDir(session.ticket, service.name) }), late]);
      } catch {
        got = { missing: 'failed' };
      } finally {
        clearTimeout(timer);
      }
    }
    const address = new URL(url);
    const check: ProductionCheck = {
      service: service.name, pr, url: `${address.origin}${address.pathname}`, at: this.#at(),
      file: 'file' in got ? PRODUCTION_FILE : null, missing: 'missing' in got ? got.missing : null,
    };
    this.#journal(session, { type: 'CUSTOM', name: 'cleared.production_checked', value: check });
    await this.registry.ticketStore.comment(session.ticket, this.#clean(productionComment(check)), SERVICE).catch(() => undefined);
  }

  // The last check of each service of the ticket, in the workspace's order;
  // undefined for a ticket the store does not know.
  async productionChecks(ticket: TicketId): Promise<ProductionCheck[] | undefined> {
    if (!(await this.registry.ticketStore.get(ticket))) return undefined;
    return productionChecksOf(this.#store, ticket, this.#workspace.services.map((s) => s.name));
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
      published = await this.#effects.publish({ ticket: id, workdir, branch: this.#branchOf(id), report, receipt: this.#receipt(id, reviewer) });
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
      await this.registry.reviewRecorder.record({
        ticket: id, pr: published.number, session: reviewer.id, model, verdict: 'pass', round, report, at: reviewedAt,
        commit: published.head, verdictPhrase: reviewer.settings.verdict,
      });
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
    const lane = await this.#judgeFast(ticket, { head: published.head });
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
      sessions: this.#releaseSessions(id, round), groups: card.groups, flags: card.flags, ...(repair ? { repair } : {}), ...this.#cardLane(ticket, lane),
    }, reviewer.id);
    if (repair) await this.#repairSaid(item, repair);
    // The lock has the request: the flow is over. What follows is the human's, and a person
    // may send the ticket back from the inbox, which starts a new flow.
    this.#active.delete(id);
    this.#step(session, 'STEP_FINISHED', 'release');
    this.#step(session, 'STEP_STARTED', 'approval');
    this.#emit({ type: 'release_requested', at: this.#at(), project, ticket: id, session: reviewer.id, item: item.id, pr: published.number, url: published.url });
  }

  // ---- the setup session (matrix C4, flow/env-setup.ts) ---------------------

  // A ticket of the environment template, before its review: its branch's
  // image built and the declared check run in it. True: the review may
  // start. A failure goes back to the author, resumed, until the last
  // round, which puts the ticket back in Todo, as a check that cannot run.
  async #environmentChecked(ticket: Ticket, author: Live): Promise<boolean> {
    const check = this.#effects.envCheck;
    if (!check || !isEnvironmentTicket(ticket.labels)) return true;
    const id = ticket.id;
    const service = this.#several && author.input.service ? this.#service(author.input.service) : undefined;
    // The run the check is for: a ticket set aside or closed while it ran,
    // and maybe started again, is not this run's any more.
    const run = this.#flows.get(id);
    const ours = () => this.#active.has(id) && this.#flows.get(id) === run;
    const since = this.#envRuns.get(id) ?? '';
    let result: EnvCheck;
    try {
      result = await check({ ticket: id, ...(service ? { service } : {}), workdir: author.input.workdir });
    } catch (error) {
      if (ours()) await this.#putBack(id, `The environment check could not run: ${name(error)}`, 'env_check_failed');
      return false;
    }
    const round = this.#envChecks.add(id, ticket.project ?? this.config.project, since, result, this.#at());
    if (!ours()) return false;
    await this.registry.ticketStore.comment(id, this.#clean(envCheckComment(result, round)), SERVICE)
      .catch((error: unknown) => console.error(`cleared-v2: the environment check could not be said on ${id} (${error instanceof Error ? error.name : typeof error})`));
    if (result.outcome === 'passed' || result.outcome === 'no_check') return true;
    const failures = this.#envChecks.failures(id, since);
    if (failures >= ENV_CHECK_ROUNDS) {
      await this.#putBack(id, envCheckGiveUp(result, failures), 'env_check_failed');
      return false;
    }
    const authorRow = this.#lastSession(id, 'author');
    const adapter = this.registry.sessionAdapters[authorRow ? this.#harnessOf(authorRow.id) : HARNESS];
    try {
      if (!adapter) throw new FlowError('unavailable', 'the author\'s adapter is gone');
      await this.#reopenWith(ticket, adapter, authorRow, this.#clean(envCheckRequest(result, failures, ENV_CHECK_ROUNDS)));
    } catch (error) {
      await this.#putBack(id, `The author could not be reopened after the environment check: ${name(error)}`, 'reopen_failed');
    }
    return false;
  }

  // ---- the fast lane (matrix B2.2, flow/fast-lane.ts) ------------------------

  // A Quick ticket's change judged by v1's rules: the session's branch in
  // `workdir`, or the published `head`. Undefined when nothing was read: no
  // label, no reading of the rules here, a ticket already sent back, or one
  // of several services, which is sent back without a reading.
  async #judgeFast(ticket: Ticket, at?: { readonly workdir: string } | { readonly head: string }): Promise<FastVerdict | undefined> {
    const judge = this.#effects.fastLane;
    if (!judge || !ticket.labels.includes(QUICK_LABEL) || this.#fastLanes.demoted(ticket.id)) return undefined;
    const project = ticket.project ?? this.config.project;
    const services = this.#servicesOf(ticket);
    if (services.length > 1) {
      await this.#fallback(ticket.id, project, { reasons: ['several_services'] });
      return undefined;
    }
    if (!at) return undefined;
    let verdict: FastVerdict;
    try {
      verdict = await judge({ ticket: ticket.id, ...(this.#several ? { service: services[0] as ServiceConfig } : {}), ...at });
    } catch (error) {
      console.error(`cleared-v2: the fast lane's rules could not read ${ticket.id} (${error instanceof Error ? error.name : typeof error})`);
      verdict = { state: 'full', reasons: ['unreadable'], keep: false };
    }
    if (verdict.problem) console.error(`cleared-v2: the fast lane of ${ticket.id}: ${this.#clean(verdict.problem)}`);
    if (verdict.state === 'fast') this.#fastLanes.kept(ticket.id, project, verdict, this.#at());
    else if (verdict.keep) await this.#fallback(ticket.id, project, verdict);
    return verdict;
  }

  // A team that asks the owner leaves the fast lane (docs/fast-lane.md, "What qualifies").
  async #askedOnFastLane(id: TicketId, project: string): Promise<void> {
    if (!this.#effects.fastLane || this.#fastLanes.demoted(id)) return;
    const ticket = await this.registry.ticketStore.get(id);
    if (ticket?.labels.includes(QUICK_LABEL)) await this.#fallback(id, project, { reasons: ['asked'] });
  }

  // Sent back for good: written, said on the ticket, then on the bus, once.
  async #fallback(id: TicketId, project: string, verdict: Pick<FastVerdict, 'reasons' | 'head' | 'lines' | 'files' | 'first'>): Promise<void> {
    if (!this.#fastLanes.demote(id, project, verdict, this.#at())) return;
    await this.registry.ticketStore.comment(id, fallbackComment(verdict.reasons), SERVICE).catch(() => undefined);
    this.#emit({
      type: 'fast_lane_fallback', at: this.#at(), project, ticket: id, reasons: verdict.reasons,
      head: verdict.head ?? null, lines: verdict.lines ?? null, files: verdict.files ?? null, first: verdict.first ? this.#clean(verdict.first) : null,
    });
  }

  // The card's lane, for a Quick ticket the rules follow.
  #cardLane(ticket: Ticket, verdict: FastVerdict | undefined): { fastLane?: FastLane } {
    if (!this.#effects.fastLane || !ticket.labels.includes(QUICK_LABEL)) return {};
    return { fastLane: cardLane(this.#fastLanes.get(ticket.id), verdict) };
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
    const receipt = this.#receipt(id, reviewer);
    const published: { service: ServiceConfig; pr: Published; files: readonly string[] | null; diff: string }[] = [];
    const skipped: string[] = [];
    for (const service of order) {
      try {
        await this.#effects.refreshProject(service);
        const workdir = this.#workdirs.get(id)?.get(service.name) ?? posix.join(this.config.workdirRoot, id, service.name);
        const pr = await this.#effects.publish({ ticket: id, workdir, branch: ticketBranch(id), report, service, receipt });
        const changed = await this.#changes(id, pr.head, service);
        published.push({ service, pr, files: changed?.files ?? null, diff: changed?.diff ?? '' });
      } catch (error) {
        if ((error as { code?: unknown }).code === 'empty') { skipped.push(service.name); continue; }
        return fail(`The branch was not published on ${service.name}: ${name(error)}`, 'publish_refused');
      }
    }
    if (published.length === 0) return fail(`The branch was not published: no service of the ticket (${order.map((s) => s.name).join(', ')}) has a commit of its own.`, 'publish_refused');
    // A ticket of one service of several publishes one pull request, whose head is judged as a one-service ticket's.
    const lane = await this.#judgeFast(ticket, published.length === 1 ? { head: (published[0] as (typeof published)[number]).pr.head } : undefined);
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
      sessions: this.#releaseSessions(id, round), train: view({ ...train, item: '', approver: null }), groups: card.groups, flags: card.flags, ...this.#cardLane(ticket, lane),
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

  // A permission request has no answer to declare and the lead does not
  // decide it: past the questions' delay (issue #299) the ticket is parked,
  // the request neither allowed nor rejected for the owner. Without this a
  // session suspended on a permission kept its slot of the plan for ever.
  #duePermissions(now: number): { live: Live; item: PermissionItem; minutes: number }[] {
    const due: { live: Live; item: PermissionItem; minutes: number }[] = [];
    for (const item of this.inbox.waitingPermissions(this.config.project)) {
      const live = this.#live.get(item.sessionId) ?? this.#dormant.get(item.sessionId);
      if (!live || this.#paused.has(live.id)) continue;
      const wait = live.settings.questionTimeoutMinutes !== undefined ? live.settings.questionTimeoutMinutes * 60_000 : this.config.questionTimeoutMs ?? QUESTION_TIMEOUT_MINUTES * 60_000;
      if (now >= Date.parse(item.since) + wait) due.push({ live, item, minutes: Math.round((now - Date.parse(item.since)) / 60_000) });
    }
    return due;
  }

  async #parkPermission(live: Live, item: PermissionItem, minutes: number): Promise<void> {
    const waited = `The permission to use ${item.tool} waited ${duration(minutes)} with no answer from the owner`;
    ledgerEvent(this.#store.db, { at: this.#at(), kind: 'permission_parked', ticket: item.ticket, source: 'flow', detail: { session: item.sessionId, requestId: item.requestId, item: item.id, tool: item.tool, minutes } });
    await this.#stopTicket(live, 'parked', `${waited}: the session was stopped and its ticket parked.`,
      `${waited}: the ticket is parked, its session stopped with what a resume needs. The rest of the plan goes on; start it again once the permission is settled.`, 'stopped', 'parked');
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
    const adapter = this.registry.sessionAdapters[this.#harnessOf(dormant.id)];
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
    const adapter = this.registry.sessionAdapters[this.#harnessOf(id)];
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

  // ---- hand over to the other harness (B6.3, P150 to P154) -----------------

  // The owner hands a live author's work to the other harness of the
  // contract (claude-code or codex; Cursor stays out of the flows, P87): the
  // session is taken over first, so that the end of its interrupted turn is
  // not taken for the end of the work (no review, no put back), then it
  // gives up a note of its work, the target starts as a new author in the
  // same checkout (its uncommitted changes kept) and is told that note, both
  // sessions journal `cleared.handed_over`, and the source is stopped. A
  // target that cannot start gives the source back. A step's or a variant's
  // session, one whose plan waits for its Go, and one taken over are not
  // handed over in this version.
  //
  // A session the watchdog stopped while it waited for a person (dormant:
  // its containers are gone, its volume and its journal are not) is handed
  // over too, and it is the stuck session the proof means: there is nothing
  // to interrupt, its note is read from the journal, what it waited for is
  // settled, and a target that does not start leaves it dormant.
  async handOver(id: SessionId, by: UserId, to: { readonly harness: Harness; readonly model?: string }): Promise<HandedOver> {
    const dormant = this.#dormant.get(id);
    const live = dormant ?? this.#liveSession(id);
    if (live.input.role !== 'author') throw new FlowError('conflict', `session ${id} is the ${live.input.role}'s: only an author's session is handed over`);
    if (this.#paused.has(id)) throw new FlowError('conflict', `session ${id} is taken over: give it back first`);
    if (this.#stepOf.has(id) || this.#variantOf.has(id)) throw new FlowError('conflict', `session ${id} works on a step or a variant of its ticket: it is not handed over in this version`);
    if (this.#holds(id)) throw new FlowError('conflict', `the plan of session ${id} waits for its Go: give it a Go or a Change first`);
    const ticket = await this.#ticketOf(live.input.ticket);
    const target = { harness: to.harness, model: to.model ?? (to.harness === HARNESS ? this.#authorModel(ticket) : CODEX_MODEL) };
    try {
      refuseTarget(live.input.harness, target);
    } catch (error) {
      throw new FlowError('invalid', name(error));
    }
    const next = this.registry.sessionAdapters[target.harness];
    if (!next) throw new FlowError('unavailable', `no adapter for ${target.harness} is registered`);
    const kept = this.#inputs.get(id);
    if (!kept) throw new FlowError('conflict', `session ${id} belongs to another process: it is not handed over`);
    if (!dormant) await this.takeOver(id, by);
    const back = async (reason: string): Promise<never> => {
      if (!dormant) await this.giveBack(id).catch(() => undefined);
      throw new FlowError('unavailable', reason);
    };
    let note: string;
    try {
      note = this.#clean(dormant ? handoverNote(this.#store.events.after(id)) : (await live.handle.handover(target)).note);
    } catch (error) {
      return back(`session ${id} could not give up its work: ${name(error)}`);
    }
    const began = this.#now();
    let fresh: Live;
    try {
      // A Codex author has no host tools (its adapter takes none): the report of changes is Claude's.
      const tools = this.config.authorTools === true && target.harness === HARNESS;
      fresh = await this.#launch(next, ticket, 'author', target.model, kept.input.workdir, kept.input.briefing, kept.settings,
        `${authorPrompt(ticket, { plan: false, report: tools })}\n\n${handoverMessage({ from: live.input.harness, fromModel: live.input.model, to: target.harness, note })}`,
        tools ? 'report' : undefined, undefined, target.harness);
    } catch (error) {
      return back(`the ${target.harness} session could not be started: ${name(error)}`);
    }
    const value = {
      from: { session: id, harness: live.input.harness, model: live.input.model },
      to: { session: fresh.id, harness: target.harness, model: target.model },
      by,
    };
    this.#journal({ id, ticket: ticket.id, project: live.input.project }, { type: 'CUSTOM', name: 'cleared.handed_over', value });
    this.#journal({ id: fresh.id, ticket: ticket.id, project: fresh.input.project }, { type: 'CUSTOM', name: 'cleared.handed_over', value });
    this.#step({ id: fresh.id, ticket: ticket.id, project: fresh.input.project }, 'STEP_STARTED', 'author', began);
    this.#snapshot(fresh.id, ticket.id);
    this.#supervise(fresh, 0);
    if (dormant) {
      this.#told.delete(id);
      this.#endDormant(dormant, 'stopped');
    } else await this.#close(live, 'stopped', `Handed over to ${target.harness} (${fresh.id}).`);
    return { session: fresh.id, harness: target.harness, model: target.model };
  }
}
