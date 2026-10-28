// The service's HTTP and server-sent events API, as the app lanes (6, 9, 10)
// build against it and lane 7 implements it. Changing this file after wave 1
// is a lane of its own (docs/v2/milestone-1-plan.md, section 10). Milestone
// 2 adds the lead, its thread and the plans (docs/v2/milestone-2-plan.md,
// sections 5.1 and 7.1), implemented by lanes 5 and 7. The replanned
// milestone 2 adds the workspace and its services, and the shapes of wave 6
// (the release train, the preview route), written by lane 14 one wave ahead
// (docs/v2/milestone-2-plan.md, section 4: decisions 18, 20 and 21), and
// those of waves 7 and 8 (the session plan, the release's groups and flags,
// the sensitivity, the paused session, the files and the takeover), written
// by lane 16 (decisions 22, 23, 24 and 30), and those of waves 9 to 11
// (the ticket's steps, the contract and knowledge items, the questions to
// the code, the recipes and the schedules, the web terminal and the
// editor's save), written by lane 17 (decisions 26 to 29, 32 and 33).
//
// The app calls the service on loopback, forwarding /api/service/* to these
// routes. Every request carries the shared proof the service checks
// (SERVICE_PROOF_HEADER) and, when a person acts, their user id
// (SERVICE_USER_HEADER). A request without the proof is refused before
// anything else; an approval also needs the user id.
import type { LeversChange } from '../consumption/levers.ts';
import type { TicketCost } from '../consumption/ticket-cost.ts';
import type { Consumption, HarnessConsumption, LeverChoices, Projection, Quota } from '../consumption/usage.ts';
import type { ServiceMap, ServiceMapDatabase, ServiceMapLink, ServiceMapPlace, ServiceMapProblem, ServiceMapService } from '../map/build.ts';
import type { Impact, ImpactCaller, ServiceImpact } from '../map/impact.ts';
import type { WeekFigures, WeekService, WeekTicket } from '../consumption/week.ts';
import type { Decision, Harness, Role, SessionId, UserId } from '../session/contract.ts';
import type { ContextShare, Question, SessionEvent, SessionPhase, SessionState, ToolInput } from '../session/events.ts';
import type { Verdict } from '../session/policy.ts';
import type { SessionVersions } from '../profiles/types.ts';
import type { Ticket, TicketId } from '../tickets/contract.ts';

// A session the owner took over (decision 30) is paused until Give back:
// the flow leaves it alone, and `takenOver` says by whom and since when.
// Lane 20 writes it. `phase` keeps the harness's phases in this wave: the
// screens map every phase, so the `paused` phase (ApiSessionPhase) joins
// SessionSummary.phase with the screens that show it (lanes 20 and 22).
export type ApiSessionPhase = SessionPhase | 'paused';
export type TakenOver = { readonly by: UserId; readonly at: string };

export const SERVICE_USER_HEADER = 'x-cleared-user';
export const SERVICE_PROOF_HEADER = 'x-cleared-proof';

export type ApiError = { readonly error: string };

export type SessionSummary = {
  readonly id: SessionId;
  readonly project: string;
  readonly ticket: TicketId;
  readonly role: Role;
  readonly harness: Harness;
  readonly model: string;
  readonly phase: SessionPhase;
  readonly status: string;                                  // the current status phrase
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly lastSeq: number;                                 // the seq of its last stored event
  readonly service?: string;                                // the workspace service it works on; absent before lane 15 starts sessions per service
  readonly takenOver?: TakenOver | null;                    // who took it over (decision 30, lane 20); absent or null otherwise
  readonly dormant?: true;                                  // stopped by the watchdog while it waited for a person: the answer resumes it, and it can be handed over (B6.3)
  readonly versions?: SessionVersions;                      // the agent profile's and the environment's versions it started on (issue #452); an author's or a reviewer's only
};

// The session plan an author proposes before writing code (decision 22,
// lane 17): its steps, the files it means to change, its confidence and
// why. `go` says who let it start and when: the owner (a user id), the
// delay of [session] plan_go_minutes, or the lead for an item of a plan the
// owner approved; null while it waits.
export type SessionPlanConfidence = 'low' | 'medium' | 'high';
export type SessionPlan = {
  readonly steps: readonly string[];
  readonly files: readonly string[];
  readonly confidence: SessionPlanConfidence;
  readonly reason: string;
  readonly proposedAt: string;
  readonly go: { readonly by: UserId | 'delay' | 'lead'; readonly at: string } | null;
};

// The session's state as the API shows it: the harness's, with the session
// plan (lane 17) and the takeover (lane 20).
export type ApiSessionState = SessionState & {
  readonly plan?: SessionPlan | null;
  readonly takenOver?: TakenOver | null;
};

// previewKey: the unguessable segment of the session's preview address
// (decision 20), issued by the service when the session's containers start
// (lane 15); absent or null while the session has no preview.
export type SessionDetail = SessionSummary & { readonly state: ApiSessionState; readonly previewKey?: string | null };

type InboxBase = {
  readonly id: string;
  readonly ticket: TicketId;                                // LEAD_TICKET (lead/contract.ts) for a plan or a question of the lead
  readonly project: string;
  readonly since: string;                                   // when it started waiting
  readonly state: 'waiting' | 'handled';
};

// Why a request asks, as a code the app translates (docs/v2/ui-overhaul-plan.md,
// 2.5.3, lane 37): a compound the policy does not read word for word, a
// command it does not allow on its own, the network, a new dependency, a path
// outside the session's checkout, or none of these. The policy lane sets it
// beside the verdict's `reason`; absent, or `unknown`, the app shows the reason.
export const REASON_CODES = ['compound', 'not_allowed', 'network', 'dependency', 'outside_checkout', 'unknown'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type PermissionItem = InboxBase & {
  readonly kind: 'permission';
  readonly sessionId: SessionId;
  readonly requestId: string;
  readonly tool: string;
  readonly input: ToolInput;
  readonly suggestion: Verdict;
  readonly reasonCode?: ReasonCode;
};

export type QuestionItem = InboxBase & {
  readonly kind: 'question';
  readonly sessionId: SessionId;
  readonly requestId: string;
  readonly questions: readonly Question[];
  // A team's question (issue #290): at `at` the Lead is asked to decide, by
  // `leadUntil`; then `answers`, the session's declared answer (each
  // question's "(Recommended)" option), apply, or with none the ticket is
  // parked. `leadAt`: when the Lead was asked. The lead's own questions have none.
  readonly timeout?: QuestionTimeout;
};

export type QuestionTimeout = {
  readonly at: string;
  readonly leadUntil: string;
  readonly answers: Readonly<Record<string, string>> | null;
  readonly leadAt?: string;
  // The project's [session] question_default when it is not `recommended`
  // (issue #269): `first`, the answers may be first options the session did
  // not recommend; `park`, there are none.
  readonly rule?: 'first' | 'park';
};

type Capture = { readonly desktop: string | null; readonly phone: string | null };   // image URLs, or none yet

export type ReleaseItem = InboxBase & {
  readonly kind: 'release';
  readonly title: string;
  readonly announcement: string;
  readonly pr: { readonly number: number; readonly url: string; readonly checks: 'pending' | 'passed' | 'failed' };
  readonly heads: readonly { readonly pr: number; readonly head: string }[];   // what the approval is bound to
  readonly requestedAt: string;
  readonly captures: { readonly before: Capture; readonly after: Capture };
  readonly sessions: readonly { readonly role: Role; readonly model: string; readonly minutes: number; readonly rounds?: number }[];
  readonly train?: TrainState;                              // a ticket of a workspace of several services (decision 21, lane 16); absent for one service
  // What the author said it changed, grouped by intent, and the flags the
  // diff raised (decision 23): written at publish by release/flags.ts, whose
  // default (lane 16) gives none; lane 18 fills them.
  readonly groups?: readonly ReleaseGroup[];
  readonly flags?: readonly ReleaseFlag[];
  // The repair of its failed checks (issue #273, flow/ci-repair.ts): absent
  // until a check fails on the card's head; carried by the card a repair
  // publishes, so the attempts count across cards.
  readonly repair?: CiRepair;
  // The owner closed the ticket with this card waiting (issue #249): the reason, who and when.
  readonly outcome?: { readonly decision: 'close'; readonly reason: string; readonly by: UserId; readonly at: string };
  // A Quick ticket's lane at the card's head (matrix B2.2, flow/fast-lane.ts): absent for any other ticket.
  readonly fastLane?: FastLane;
};

// The fast lane of a Quick ticket, judged by v1's rules (lib/fast-lane.ts)
// on what merging its head would land: `fast`, every rule holds; `full`,
// sent back to the full circuit for good, with the rules it broke; `off`,
// not fast at this head and not sent back (the service's [fast_lane] is off
// or unreadable, git could not read the merge).
export type FastLane = { readonly state: 'fast' | 'full' | 'off'; readonly reasons: readonly FastReason[] };

// v1's RULE_REASONS, then what says nothing of the change (unreadable,
// settings, disabled), then v2's own: a ticket of several services is never fast.
export const FAST_REASONS = [
  'empty', 'too_many_files', 'too_many_lines', 'too_large', 'unusual_change', 'binary', 'path_form', 'protected', 'dependency', 'migration',
  'outside_safe', 'file_type', 'content', 'link', 'asked', 'unreadable', 'settings', 'disabled', 'several_services',
] as const;
export type FastReason = (typeof FAST_REASONS)[number];

// `started`: a failed check reopened the author on the ticket branch, the
// card is handled; `pushed`: the attempt's commit is published, its checks
// run; `repaired`: they passed; `gave_up`: they failed again after the last
// attempt, the owner decides; `refused`: the branch is a base branch, so
// nothing was started. `checks`: the names of the checks that failed.
export type CiRepair = {
  readonly attempt: number;
  readonly limit: number;
  readonly state: 'started' | 'pushed' | 'repaired' | 'gave_up' | 'refused';
  readonly checks: readonly string[];
  readonly at: string;
};

// The author's report of its changes (`report_changes`, decision 23), kept
// as the session's `cleared.changes` journal event: lane 17 writes it.
export type ChangesReport = { readonly groups: readonly { readonly intent: string; readonly files: readonly string[] }[] };

// One group of the release card: an intent and its files. The files no
// group names go to "Other changes".
export type ReleaseGroup = { readonly intent: string; readonly files: readonly string[] };

// A chip on the release card, from the diff (decision 23). Never a block,
// except `contract` on an untouched consumer (the train's `blocked`).
// The formats a service's contract can be in (owner decision O11, M11): OpenAPI 3 first, then JSON Schema, protobuf and events (AsyncAPI 2).
export type ContractFormat = 'openapi' | 'jsonschema' | 'protobuf' | 'events';

export type ReleaseFlagKind = 'schema' | 'dependency' | 'config' | 'secret_shape' | 'contract' | 'large';
export type ReleaseFlag = { readonly kind: ReleaseFlagKind; readonly files: readonly string[]; readonly detail: string };

// A session plan waiting for its Go (decision 22, lane 17): Go, or Change
// with a message that reopens the author. It joins InboxItem (as
// NextInboxItem shows) with the inbox screen that renders it (lane 21): the
// screen's model maps every kind of the union.
export type SessionPlanItem = InboxBase & {
  readonly kind: 'session_plan';
  readonly sessionId: SessionId;
  readonly service?: string;
  readonly plan: SessionPlan;
};

// ---------------------------------------------------------------- the workspace (decisions 18 and 21)

// A service of the workspace, as GET /api/workspace shows it: a repository,
// or a folder of a monorepo (`path` inside `repo`). The server's own paths
// (its checkout, its release broker) are not shown.
export type Service = {
  readonly name: string;
  readonly kind: 'repository' | 'folder';
  readonly repo: string;                                    // owner/name
  readonly url: string;
  readonly base: string;                                    // the base branch
  readonly path: string | null;                             // folder only
  readonly healthUrl: string | null;
  readonly sensitivity: ServiceSensitivity;
  readonly consumes: readonly string[];                     // the services it calls: they land before it
  readonly run: { readonly dockerfile: string; readonly port: number } | null;   // how a sibling of it runs (decision 20)
  readonly contract: { readonly format: ContractFormat; readonly path: string } | null;
};

// full: never the fast lane; reviewer:<model>: that model reviews its
// sessions; human:<user>: that user approves its releases (decision 24).
export type ServiceSensitivity = 'normal' | 'full' | `reviewer:${string}` | `human:${string}`;

// A workspace: its id is the `project` value of every row it holds.
export type Workspace = { readonly id: string; readonly name: string; readonly services: readonly Service[] };

// One service of a release train, in landing order: providers before
// consumers (their `consumes`), then their position.
export type TrainServiceState = 'waiting' | 'merged' | 'healthy' | 'failed' | 'reverted';
export type TrainStop = {
  readonly service: string;
  readonly pr: { readonly number: number; readonly url: string } | null;
  readonly state: TrainServiceState;
  readonly at: string | null;                               // when it reached that state
  readonly head?: string | null;                            // the commit shown, which the approval is bound to (lane 16)
  readonly note?: string | null;                            // what went wrong with this service, when something did (lane 16)
};

// The release card's train (decision 21): blocked before approval when the
// ticket changes a contract without a step on every consumer, with the
// proposal; then waiting, landing service by service with the health read
// between landings, landed, or rolled back newest first. `halted`: a
// service could not land, or landed unhealthy with nothing reverted; the
// next services were not landed and the owner decides (lane 16).
export type TrainState = {
  readonly state: 'blocked' | 'waiting' | 'landing' | 'landed' | 'rolled_back' | 'halted';
  readonly services: readonly TrainStop[];
  readonly compatibility: string | null;                    // the line: who consumes whom, and what this ticket changes
  readonly blocked: { readonly reason: string; readonly proposal: string } | null;
};

// Milestone 2, section 5.1: a plan waiting for the owner's approval. It is
// handled when the plan leaves `proposed`.
export type PlanItemInbox = InboxBase & {
  readonly kind: 'plan';
  readonly planId: string;
  readonly title: string;
  readonly summary: string;
  readonly itemCount: number;
  readonly totals: Plan['totals'];
};

// A contract step's change, proposed for the owner's validation (decision
// 26, lane 23): the contract file's diff, Approve, or Send back with a
// message that reopens the step. `outcome` says what the owner did.
export type ContractItem = InboxBase & {
  readonly kind: 'contract';
  readonly sessionId: SessionId;                            // the contract step's session
  readonly step: string;                                    // the ticket step (TicketStep.id)
  readonly service: string;                                 // the providing service, whose contract it is
  readonly path: string;                                    // the contract file, in that service's repository
  readonly diff: string;
  readonly outcome: { readonly decision: 'approve'; readonly by: UserId; readonly at: string }
    | { readonly decision: 'send_back'; readonly message: string; readonly by: UserId; readonly at: string } | null;
};

// Knowledge a handover proposed (decision 27, lane 24), at its memory
// level: the workspace's, a service's or a contract's (named by the service
// that provides it). Approve writes it into the memory at once and queues it
// for the service's skill; Reject writes nothing.
export type KnowledgeLevel = 'workspace' | 'service' | 'contract';
export type KnowledgeItem = InboxBase & {
  readonly kind: 'knowledge';
  readonly sessionId: SessionId;                            // the session whose handover proposed it
  readonly text: string;
  readonly level: KnowledgeLevel;
  readonly service: string | null;                          // null at the workspace's level
  readonly outcome: { readonly decision: 'approve' | 'reject'; readonly by: UserId; readonly at: string } | null;
};

// The variants of one ticket (issue #271): 2 to 4 authors work the same
// ticket at once, each in its own checkout of the ticket branch, and the
// owner compares what each one changed and picks the one to review; the
// others are stopped and their containers released. `diff` is the
// variant's committed change against the base, cut at VARIANT_DIFF_MAX
// (`cut` says so); `note` says why a variant failed or was dropped.
export type VariantState = 'waiting' | 'running' | 'done' | 'failed' | 'chosen' | 'dropped';
export type TicketVariant = {
  readonly position: number;                                // 1-based
  readonly state: VariantState;
  readonly session: SessionId | null;
  readonly files: readonly string[];
  readonly added: number;
  readonly removed: number;
  readonly diff: string;
  readonly cut: boolean;
  readonly costUsd: number | null;
  readonly minutes: number | null;                          // how long its session ran
  readonly note: string | null;
  // The harness pick (issue #329): the variant's harness, its own last run
  // of the declared test command (null before it ended, or in plain
  // variants), and its tokens (null when the harness reports none).
  readonly harness: Harness;
  readonly tests: TestOutcome | null;
  readonly tokens: number | null;
};
export type TestOutcome = 'passed' | 'failed' | 'unclear' | 'not_run';
export const VARIANTS_MIN = 2;
export const VARIANTS_MAX = 4;
export const VARIANT_DIFF_MAX = 64 * 1024;

// The variants waiting for the owner's choice: added once one is done,
// updated as the others end. `outcome` says which one the owner chose; in
// a harness pick (`pick`, issue #329), the one the flow kept by itself,
// `by` the service and `measure` what made it the cheapest.
export type VariantsItem = InboxBase & {
  readonly kind: 'variants';
  readonly round: number;                                   // the ticket's run of variants, from 1
  readonly variants: readonly TicketVariant[];
  readonly pick?: boolean;
  readonly outcome: { readonly chosen: number; readonly by: UserId; readonly at: string; readonly measure?: 'tokens' | 'time' } | null;
};

// The harness pick's wins (issue #329), per ticket type and harness, on the
// Consumption screen: the variants that ran, those whose tests passed, those kept.
export type TicketType = 'bug' | 'review' | 'ci' | 'question' | 'other';
export type HarnessWins = { readonly type: TicketType; readonly harness: Harness; readonly runs: number; readonly green: number; readonly wins: number };

export type InboxItem = PermissionItem | QuestionItem | ReleaseItem | PlanItemInbox;
// The kinds of the replanned milestone 2, which the inbox store keeps and
// GET /api/inbox answers; each joins InboxItem with the inbox screen that
// renders it (lanes 21 and 27), since the screen's model maps every kind.
export type NextInboxItem = InboxItem | SessionPlanItem | ContractItem | KnowledgeItem | VariantsItem;

// ---------------------------------------------------------------- the replanned milestone 2: waves 9 to 11 (lane 17)

// A step of a ticket (decision 26, lane 23): the contract first, on the
// providing service; a step per service, in parallel, after it; the
// integration last, on the consuming service. `after` holds the positions
// it waits for; `costUsd` is what its session spent, null before it runs.
export type TicketStep = {
  readonly id: string;
  readonly ticket: TicketId;
  readonly kind: 'contract' | 'service' | 'integration';
  readonly service: string;
  readonly position: number;                                // 1-based, the order the plan shows
  readonly after: readonly number[];
  readonly state: 'waiting' | 'running' | 'validating' | 'done' | 'failed';
  readonly session: SessionId | null;
  readonly costUsd: number | null;
};

// A read-only question to the code or to the platform (decision 28, lane
// 25): asked on a service's base branch, or on every service's checkout
// when `service` is null; `target` is the `service:path:line` it names.
// Each turn carries its cost; the ask carries the sum, and the week share
// when the seven-day window is measured.
export type AskAnswer = {
  readonly question: string;
  readonly answer: string | null;                           // null while the turn runs
  readonly at: string;
  readonly costUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly citations: readonly AskCitation[];               // the code the answer cites (P215)
};
// A `service/path:line` or `service/path:from-to` an answer writes, checked
// by the service at the commit the reader read (src/reader/citations.ts).
// url is a GitHub link to that commit and those lines, built by the service
// and null when the check failed, problem then saying why.
export type AskCitation = {
  readonly text: string;                                    // the mention as the answer writes it
  readonly service: string;
  readonly path: string;                                    // inside the service
  readonly from: number;
  readonly to: number;
  readonly commit: string | null;                           // null: the service was not in what the reader read
  readonly url: string | null;
  readonly problem: 'no_file' | 'no_line' | 'no_repository' | 'unchecked' | null;
};
export type Ask = {
  readonly id: string;
  readonly question: string;                                // the first question
  readonly service: string | null;
  readonly target: { readonly service: string; readonly path: string; readonly line: number } | null;
  readonly session: SessionId | null;
  readonly state: 'starting' | 'running' | 'answered' | 'stopped' | 'failed';
  readonly turns: readonly AskAnswer[];
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly weekPercent: number | null;
  readonly createdAt: string;
  readonly by: UserId;
};
export type AskBody = { readonly question: string; readonly service?: string; readonly target?: string };   // target: service:path:line
export type AskFollowBody = { readonly question: string };

// A recipe (decision 29, lane 26): `.cleared/recipes/<name>.md` of a
// service's repository, read at its base branch; its body holds
// `{{parameter}}` marks. A ticket recipe runs as a one-item plan, a goal
// recipe as an owner turn to the lead.
export type Recipe = {
  readonly name: string;
  readonly service: string;                                 // the repository it was read from
  readonly kind: 'ticket' | 'goal';
  readonly parameters: readonly { readonly name: string; readonly description?: string; readonly required: boolean }[];
  readonly lane?: 'fast' | 'full';
  readonly size?: PlanItem['size'];
  readonly services: readonly string[];
  readonly body: string;
};
export type RunRecipeBody = { readonly parameters: Readonly<Record<string, string>> };

// A schedule (decision 29, lane 26): a recipe or a goal, run `at` a time or
// `every` period in the server's time zone, with a budget and a week-share
// cap; its creator's approval is the plan's.
export type Schedule = {
  readonly id: string;
  readonly recipe: string | null;
  readonly goal: string | null;
  readonly parameters: Readonly<Record<string, string>>;
  readonly at: string | null;
  readonly every: string | null;                            // for example 'day 03:00'
  readonly budgetUsd: number;
  readonly weekCapPercent: number;
  readonly createdBy: UserId;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly createdAt: string;
};
export type CreateScheduleBody = {
  readonly recipe?: string; readonly goal?: string; readonly parameters?: Readonly<Record<string, string>>;
  readonly at?: string; readonly every?: string; readonly budgetUsd: number; readonly weekCapPercent: number;
};

// The web terminal of a session taken over (decision 32, lane 31): its
// output streams as server-sent events of TerminalChunk (`data`, UTF-8
// text, in order by `seq`), then one TerminalClosed; the input is posted in
// batches of at most TERMINAL_INPUT_MAX_BYTES.
export const TERMINAL_INPUT_MAX_BYTES = 4096;
export type TerminalChunk = { readonly seq: number; readonly data: string };
export type TerminalClosed = { readonly reason: 'give_back' | 'idle' | 'closed' | 'exit' };
// What the terminal runs (owner request of 2026-10-22 17:26): the session's
// own harness, resumed on the session through its adapter (the default), or
// a shell in its container. An open of a harness its adapter cannot resume
// answers 501 with why; an open while one is open answers 409 with the mode
// of the one open, so that a reloaded page attaches to it.
export type TerminalMode = 'harness' | 'shell';
export const TERMINAL_MODES: readonly TerminalMode[] = ['harness', 'shell'];
export type TerminalOpenBody = { readonly cols: number; readonly rows: number; readonly mode?: TerminalMode };
export type TerminalInputBody = { readonly data: string };
export type TerminalResizeBody = { readonly cols: number; readonly rows: number };
export type TerminalOpened = { readonly opened: true; readonly cols: number; readonly rows: number; readonly mode: TerminalMode; readonly name?: string };   // name: the harness's, in the harness mode

// The editor's save (decision 33, lane 31): the text, the hash of the
// version the editor loaded, and, on a second save after a confirmation,
// the one rule it confirms. A refusal names the rule and its reason; a stale
// hash (409) carries the current one; `confirmable` says whether a second
// save carrying the rule would write.
export type ConfirmableRule = 'install.package' | 'scripts.change';
export type FileWrite = { readonly text: string; readonly hash: string; readonly confirm?: ConfirmableRule };
export type FileWriteRefusal = { readonly error: string; readonly rule: string | null; readonly reason: string; readonly hash?: string; readonly confirmable: boolean };
export type FileWritten = { readonly saved: true; readonly hash: string };

// A file a human changed in the session's checkout (decision 33): through
// the editor, or found at Give back after the terminal. Never its content.
export type HumanEdit = {
  readonly path: string;
  readonly by: UserId;
  readonly at: string;
  readonly added: number;
  readonly removed: number;
  readonly before: string | null;                           // the hashes, null for a file created or deleted
  readonly after: string | null;
  readonly via: 'editor' | 'terminal';
};

// ---------------------------------------------------------------- milestone 2: plans

// `parked`: its ticket's question waited past its delay and the lead's,
// with no declared answer (issue #290): its slot is free, the lead starts it again.
export type PlanItemState = 'waiting' | 'ready' | 'running' | 'needs_approval' | 'landed' | 'put_back' | 'held' | 'parked' | 'cancelled';

// An estimate from the project's history (section 5.2): medians of `samples`
// done tickets of the same size and lane, or the defaults below 3 samples.
// weekPercent is null until the harness reports the seven-day window.
export type Estimate = { readonly minutes: number; readonly costUsd: number; readonly weekPercent: number | null; readonly samples: number };

export type PlanItem = {
  readonly position: number;                                // 1-based, the number on the screen
  readonly title: string;
  readonly body: string;                                    // description and criteria, becomes the ticket's body
  readonly lane: 'fast' | 'full';
  readonly size: 'xs' | 's' | 'm' | 'l';
  readonly after: readonly number[];                        // positions this one waits for
  readonly estimate: Estimate;
  readonly ticket: TicketId | null;                         // once the plan is approved
  readonly state: PlanItemState;
  // The services its body names, with their sensitivity (decision 24, lane 18): the plan panel's chips.
  readonly sensitivity?: readonly { readonly service: string; readonly sensitivity: ServiceSensitivity }[];
  // Its steps across services, when the lead gave some (decision 26, lane 23): the item's estimate adds theirs.
  readonly steps?: readonly PlanStep[];
};

// A step of a plan item (decision 26, lane 23): the ticket step it becomes,
// with its estimate by kind; `after` holds the item's step positions it waits for.
export type PlanStep = {
  readonly position: number;
  readonly kind: TicketStep['kind'];
  readonly service: string;
  readonly after: readonly number[];
  readonly estimate: Estimate;
};

export type PlanState = 'proposed' | 'superseded' | 'rejected' | 'approved' | 'paused' | 'done';

export type Plan = {
  readonly id: string;
  readonly goal: string;
  readonly title: string;
  readonly summary: string;
  readonly items: readonly PlanItem[];
  readonly maxParallel: number;                             // 2 by default
  readonly totals: Estimate;                                // minutes: the critical path given `after` and maxParallel, not the sum
  readonly state: PlanState;
  readonly proposedAt: string;
  readonly approvedAt: string | null;
  readonly approvedBy: UserId | null;
};

// ---------------------------------------------------------------- milestone 2: the lead

// starting: a generation is being started; idle: live, waiting for a turn;
// working: in a turn; refreshing: between two generations; down: no
// generation is live and none is starting (the screen shows a danger pill).
export type LeadPhase = 'starting' | 'idle' | 'working' | 'refreshing' | 'down';

export type LeadState = {
  readonly generation: number;                              // 0 before the first
  readonly sessionId: SessionId | null;                     // the live generation's session
  readonly phase: LeadPhase;
  readonly model: string;
  readonly context: ContextShare | null;                    // the last measure, null before the first
  readonly highestPercent: number | null;                   // the highest share reached by any generation (the proof's step 8)
  readonly refreshedAt: string | null;                      // when the live generation started from memory
  readonly refreshCount: number;
  readonly openCommitments: number;
  readonly pendingQuestion: { readonly sessionId: SessionId; readonly requestId: string } | null;
};

// One line of the owner's thread (lead_messages). A refresh is a grey line;
// a question carries what the lead asked, a plan the plan it proposed.
export type LeadMessage = {
  readonly seq: number;
  readonly at: string;
  readonly by: 'owner' | 'lead' | 'system';
  readonly user?: UserId;                                   // the owner who wrote it
  readonly text: string;
  readonly kind: 'message' | 'refresh' | 'question' | 'plan';
  readonly generation?: number;                             // refresh: the generation that starts
  readonly question?: { readonly sessionId: SessionId; readonly requestId: string; readonly questions: readonly Question[]; readonly state: 'waiting' | 'handled' };
  readonly planId?: string;                                 // plan
};

export type LeadCommitment = {
  readonly id: string;
  readonly text: string;
  readonly ticket: TicketId | null;
  readonly due: string | null;
  readonly state: 'open' | 'done';
  readonly createdAt: string;
  readonly fulfilledAt: string | null;
  readonly note: string | null;
};

export type LeadHandover = {
  readonly id: string;
  readonly generation: number;                              // the generation that ended
  readonly at: string;
  readonly summary: string;                                 // the lead's own account
  readonly machine: boolean;                                // written by the service: the lead did not write its account
};

// What "What does the lead remember?" shows.
export type LeadMemory = {
  readonly handover: LeadHandover | null;                   // the last one
  readonly commitments: readonly LeadCommitment[];          // open first, then done, each oldest first
};

// The frames of GET /api/lead/stream. A thread message carries its seq as
// the id, which a reconnect sends back (?after= or Last-Event-ID); a state or
// a plan frame is the whole current value and carries no id.
export type LeadStreamFrame =
  | { readonly kind: 'message'; readonly message: LeadMessage }
  | { readonly kind: 'state'; readonly state: LeadState }
  | { readonly kind: 'plan'; readonly plan: Plan };

export function leadFrame(frame: LeadStreamFrame): string {
  switch (frame.kind) {
    case 'message': return `id: ${frame.message.seq}\nevent: message\ndata: ${JSON.stringify(frame.message)}\n\n`;
    case 'state': return `event: state\ndata: ${JSON.stringify(frame.state)}\n\n`;
    case 'plan': return `event: plan\ndata: ${JSON.stringify(frame.plan)}\n\n`;
  }
}

// ---------------------------------------------------------------- milestone 2: notifications

// The app's own routes (section 6, lane 3), not the service's: GET
// /api/notifications answers this; subscribe and unsubscribe take a Web
// Push subscription. reason says why push is not available: off (no webpush
// adapter configured), insecure (no secure origin), no_subject (no VAPID
// subject), store (the private store could not be read).
export type NotificationStatus = {
  readonly available: boolean;
  readonly reason: 'off' | 'insecure' | 'no_subject' | 'store' | null;
  readonly publicKey: string | null;
  readonly devices: number;
};
export type PushSubscriptionBody = { readonly subscription: { readonly endpoint: string; readonly keys: { readonly p256dh: string; readonly auth: string } } };
export type NotificationRoutes = {
  'GET /api/notifications': { readonly body: null; readonly response: NotificationStatus };
  'POST /api/notifications/subscribe': { readonly body: PushSubscriptionBody; readonly response: { readonly ok: true; readonly devices: number } };
  'POST /api/notifications/unsubscribe': { readonly body: { readonly endpoint: string }; readonly response: { readonly ok: true; readonly removed: boolean; readonly devices: number } };
};

// Request bodies.
export type SendMessageBody = { readonly text: string };
export type AnswerBody = { readonly decision: Decision };
// services: the names of the workspace's services the ticket touches (lane 14).
// `variants`: 2 to 4 authors at once on a one-service ticket (issue #271); absent or 1, one author.
// `harnesses`: the harness pick (issue #329), a variant per harness named, 2 to 4; `variants`, if given, says as many.
export type CreateTicketBody = { readonly title: string; readonly body?: string; readonly labels?: readonly string[]; readonly project: string; readonly services?: readonly string[]; readonly variants?: number; readonly harnesses?: readonly Harness[] };
export type ChooseVariantBody = { readonly variant: number };   // the position of the variant to review

// A batch of tickets (requirement C6, flow/batch.ts): 2 to 20 new tickets
// launched at once, each its own session. At most the Consumption screen's
// lanes run at once (3 when it sets none), counting every ticket in progress
// or in review, and nothing starts at the stop of a subscription window
// (85 % by default); the others wait in line, in the order of the batch.
// `hold` says what holds the line, the quota before the lanes; none when no
// ticket waits. `status` is the ticket's state in the tracker, read when the
// batch is; `note` says why an item did not start.
export const BATCH_MIN = 2;
export const BATCH_MAX = 20;
export type BatchItemState = 'queued' | 'started' | 'failed';
export type BatchHold =
  | { readonly reason: 'lanes'; readonly running: number; readonly lanes: number }
  | { readonly reason: 'quota'; readonly window: 'seven_day' | 'five_hour'; readonly percent: number; readonly stop: number };
export type BatchItem = {
  readonly position: number;                                // 1-based, the order the tickets start in
  readonly ticket: TicketId;
  readonly title: string;
  readonly state: BatchItemState;
  readonly status: string;
  readonly note: string | null;
};
export type Batch = {
  readonly id: string;
  readonly project: string;
  readonly by: UserId;
  readonly at: string;
  readonly lanes: number;                                   // the most tickets in progress or in review at once
  readonly running: number;                                 // the tickets in progress or in review now, whoever started them
  readonly hold: BatchHold | null;
  readonly items: readonly BatchItem[];
};
export type CreateBatchBody = { readonly project: string; readonly tickets: readonly { readonly title: string; readonly body?: string; readonly labels?: readonly string[] }[] };
export type MoveTicketBody = { readonly status: string };
export type ApproveBody = { readonly requestedAt: string; readonly heads: readonly { readonly pr: number; readonly head: string }[] };
export type LeadMessageBody = { readonly text: string; readonly goal?: true };   // goal: the text is a goal
export type RejectPlanBody = { readonly message: string };
export type ChangeSessionPlanBody = { readonly message: string };   // what the author is to change in its plan
export const HANDOVER_MODEL_MAX = 100;
export const HANDOVER_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;   // a model name, never a word of a command
export type HandoverBody = { readonly harness: Harness; readonly model?: string };   // the harness to hand the author's work to; its model, else the default

// The Editor tab (decision 30, lane 20): the files the session changed, and
// one file of its checkout, cut at 400 lines (`cut` says so), with the hash
// of what was read, which a save (decision 33, lane 17's shapes) sends back.
export type SessionFiles = { readonly files: readonly { readonly path: string; readonly added: number; readonly removed: number }[] };
export type SessionFile = { readonly path: string; readonly text: string; readonly lines: number; readonly cut: boolean; readonly hash: string };

// Open in an editor (docs/v2/complement-devin.md item 19, flow/editor.ts):
// the links that open the session's checkout in VS Code or in Cursor, which
// the person's own browser follows. `local`: the editor is on the machine
// the checkout is on; `ssh`: it reaches it over SSH (CLEARED_V2_EDITOR_SSH_HOST).
export const EDITORS = ['vscode', 'cursor'] as const;
export type EditorName = (typeof EDITORS)[number];
// The production page of a service, checked once a release of the ticket
// the human approved was deployed (by the human or their CI) and its watch
// ended healthy (P218, issue #334). `url` is the configured address without
// its query; `file`, the capture GET /api/tickets/:id/proof/:service/:file
// serves; `missing`, why there is none: `unwatched`, the project has no
// health check, so nothing says the deploy is done and no page is opened;
// `no_browser`, no Playwright on the server; `failed`, the page did not
// open or the capture ran past its cap. Cleared never deploys.
export type ProductionCheck = {
  readonly service: string;
  readonly pr: number;
  readonly url: string;
  readonly at: string;
  readonly file: 'production.png' | null;
  readonly missing: 'unwatched' | 'no_browser' | 'failed' | null;
};

// The human's choice of the proof receipt's captures on a ticket (P226,
// issue #368, flow/capture-choice.ts): `auto`, the rule decides from the
// diff (captures only when it changes what a person sees); `on` and `off`
// win over it. `by` and `at` are null while nobody chose.
export type CaptureChoice = { readonly choice: 'auto' | 'on' | 'off'; readonly by: UserId | null; readonly at: string | null };
export type CaptureChoiceBody = { readonly choice: CaptureChoice['choice'] };

export type EditorLinks = { readonly mode: 'local' | 'ssh'; readonly links: readonly { readonly editor: EditorName; readonly url: string }[] };

// Every route: its body (null for none) and its answer. `events` answers
// with a stream of sseFrame() frames, from the seq after `?after=`; the
// browser's Last-Event-ID carries the same number on a reconnect.
export type ApiRoutes = {
  'GET /api/sessions': { readonly body: null; readonly response: SessionSummary[] };
  'GET /api/sessions/:id': { readonly body: null; readonly response: SessionDetail };
  'GET /api/sessions/:id/events': { readonly body: null; readonly response: 'text/event-stream' };
  'POST /api/sessions/:id/messages': { readonly body: SendMessageBody; readonly response: { readonly accepted: true } };
  'POST /api/sessions/:id/requests/:requestId/answer': { readonly body: AnswerBody; readonly response: { readonly accepted: true } };
  'POST /api/sessions/:id/interrupt': { readonly body: null; readonly response: { readonly accepted: true } };
  'GET /api/tickets': { readonly body: null; readonly response: Ticket[] };
  'POST /api/tickets': { readonly body: CreateTicketBody; readonly response: Ticket };
  'GET /api/tickets/:id': { readonly body: null; readonly response: Ticket };
  'POST /api/tickets/:id/move': { readonly body: MoveTicketBody; readonly response: Ticket };
  // The owner sets a ticket aside: out of the flow, nothing of it waiting, in Todo, not started again.
  'POST /api/tickets/:id/set-aside': { readonly body: null; readonly response: { readonly sessions: number; readonly items: number } };
  'POST /api/tickets/:id/close': { readonly body: { readonly reason: string }; readonly response: { readonly sessions: number; readonly items: number } };
  'POST /api/tickets/:id/approve': { readonly body: ApproveBody; readonly response: { readonly accepted: true; readonly by: UserId } };
  // A capture of the ticket's proof receipt (P210, flow/proof-routes.ts): before.png, after.png or flow.webm.
  'GET /api/tickets/:id/proof/:service/:file': { readonly body: null; readonly response: 'image/png' | 'video/webm' };
  'GET /api/inbox': { readonly body: null; readonly response: NextInboxItem[] };   // the replanned kinds included (inbox/store.ts list)
  // The replanned milestone 2: the workspace (lane 14), and the trial
  // environment of a session (decision 20), served by lane 15 from its
  // `run` sibling under the session's previewKey, every answer sandboxed.
  'GET /api/workspace': { readonly body: null; readonly response: Workspace };
  'GET /api/sessions/:id/preview/*': { readonly body: null; readonly response: 'the sibling\'s answer' };
  // Waves 7 and 8, written by lane 16: the session plan's Go and Change
  // (lane 17 serves them), the Editor tab's files and Take over and Give
  // back (lane 20 serves them).
  'POST /api/sessions/:id/plan/go': { readonly body: null; readonly response: { readonly accepted: true } };
  'POST /api/sessions/:id/plan/change': { readonly body: ChangeSessionPlanBody; readonly response: { readonly accepted: true } };
  'GET /api/sessions/:id/files': { readonly body: null; readonly response: SessionFiles };
  'GET /api/sessions/:id/files/*': { readonly body: null; readonly response: SessionFile };
  'GET /api/sessions/:id/editor': { readonly body: null; readonly response: EditorLinks };
  'POST /api/sessions/:id/takeover': { readonly body: null; readonly response: { readonly accepted: true; readonly by: UserId } };
  'POST /api/sessions/:id/giveback': { readonly body: null; readonly response: { readonly accepted: true } };
  // Milestone 3 (B6.3): an author's work handed to the other harness of the contract (flow/takeover.ts).
  'POST /api/sessions/:id/handover': { readonly body: HandoverBody; readonly response: { readonly accepted: true; readonly session: SessionId; readonly harness: Harness; readonly model: string } };
  // Waves 9 to 11, written by lane 17: the ticket's steps and the contract
  // item's Approve and Send back (lane 23), the knowledge items' Approve and
  // Reject and "Update the skill now" (lane 24), the questions to the code
  // (lane 25), the recipes and the schedules (lane 26), the web terminal and
  // the editor's save (lane 31). A contract or a knowledge item is named by
  // its inbox id.
  'GET /api/tickets/:id/steps': { readonly body: null; readonly response: TicketStep[] };
  'POST /api/contracts/:id/approve': { readonly body: null; readonly response: { readonly accepted: true } };
  'POST /api/contracts/:id/sendback': { readonly body: { readonly message: string }; readonly response: { readonly accepted: true } };
  // The variants of a ticket (issue #271): its last run of them, and the
  // owner's choice, named by the variants item's inbox id.
  'GET /api/tickets/:id/variants': { readonly body: null; readonly response: TicketVariant[] };
  'POST /api/variants/:id/choose': { readonly body: ChooseVariantBody; readonly response: { readonly accepted: true; readonly released: number } };
  // Requirement C6: a batch of tickets, newest first in the list.
  'POST /api/batches': { readonly body: CreateBatchBody; readonly response: Batch };
  'GET /api/batches': { readonly body: null; readonly response: Batch[] };
  'GET /api/batches/:id': { readonly body: null; readonly response: Batch };
  'POST /api/knowledge/:id/approve': { readonly body: null; readonly response: { readonly accepted: true } };
  'POST /api/knowledge/:id/reject': { readonly body: null; readonly response: { readonly accepted: true } };
  'POST /api/services/:name/skill': { readonly body: null; readonly response: { readonly accepted: true; readonly ticket: TicketId | null } };   // null: nothing was queued
  'POST /api/asks': { readonly body: AskBody; readonly response: Ask };
  'GET /api/asks/:id': { readonly body: null; readonly response: Ask };
  'POST /api/asks/:id/follow': { readonly body: AskFollowBody; readonly response: Ask };
  'GET /api/recipes': { readonly body: null; readonly response: Recipe[] };
  'POST /api/recipes/:name/run': { readonly body: RunRecipeBody; readonly response: { readonly accepted: true; readonly plan?: string; readonly message?: number } };
  'GET /api/schedules': { readonly body: null; readonly response: Schedule[] };
  'POST /api/schedules': { readonly body: CreateScheduleBody; readonly response: Schedule };
  'DELETE /api/schedules/:id': { readonly body: null; readonly response: { readonly deleted: true } };
  'POST /api/sessions/:id/terminal/open': { readonly body: TerminalOpenBody; readonly response: TerminalOpened };
  'POST /api/sessions/:id/terminal/input': { readonly body: TerminalInputBody; readonly response: { readonly accepted: true } };
  'POST /api/sessions/:id/terminal/resize': { readonly body: TerminalResizeBody; readonly response: { readonly accepted: true } };
  'POST /api/sessions/:id/terminal/close': { readonly body: null; readonly response: { readonly accepted: true } };
  'GET /api/sessions/:id/terminal/stream': { readonly body: null; readonly response: 'text/event-stream' };
  'PUT /api/sessions/:id/files/*': { readonly body: FileWrite; readonly response: FileWritten };
  // Milestone 2. `messages` answers the thread after `?after=<seq>`.
  'GET /api/lead': { readonly body: null; readonly response: LeadState };
  'GET /api/lead/messages': { readonly body: null; readonly response: LeadMessage[] };
  'GET /api/lead/stream': { readonly body: null; readonly response: 'text/event-stream' };
  'POST /api/lead/messages': { readonly body: LeadMessageBody; readonly response: LeadMessage };
  'GET /api/lead/memory': { readonly body: null; readonly response: LeadMemory };
  'GET /api/plans': { readonly body: null; readonly response: Plan[] };
  'GET /api/plans/:id': { readonly body: null; readonly response: Plan };
  'POST /api/plans/:id/approve': { readonly body: null; readonly response: Plan };
  'POST /api/plans/:id/reject': { readonly body: RejectPlanBody; readonly response: Plan };
  'POST /api/plans/:id/pause': { readonly body: null; readonly response: Plan };
  'POST /api/plans/:id/resume': { readonly body: null; readonly response: Plan };
  // The interface overhaul (docs/v2/ui-overhaul-plan.md, U3, lane 34): what
  // changed, as a stream of changeFrame() frames; the app refetches the
  // resource an event names. Last-Event-ID resumes it.
  'GET /api/events': { readonly body: null; readonly response: 'text/event-stream' };
  // Milestone 3, the Consumption screen (O15): `?tz=<IANA zone>` gives the days.
  'GET /api/consumption': { readonly body: null; readonly response: Consumption };
  'POST /api/consumption/levers': { readonly body: LeversChange; readonly response: LeverChoices };
  // Milestone 4, the week's figures (C17, issue #396).
  'GET /api/consumption/week': { readonly body: null; readonly response: WeekFigures };
  // Milestone 3, the cost of a ticket from the ledger (P211, issue #327).
  'GET /api/tickets/:id/cost': { readonly body: null; readonly response: TicketCost };
  // Milestone 3, the production page checked after a release landed (P218, issue #334, flow/proof-routes.ts).
  'GET /api/tickets/:id/production': { readonly body: null; readonly response: ProductionCheck[] };
  // Milestone 3, whether the proof receipt takes captures: the human's choice on the ticket (P226, issue #368, flow/proof-routes.ts).
  'GET /api/tickets/:id/captures': { readonly body: null; readonly response: CaptureChoice };
  'POST /api/tickets/:id/captures': { readonly body: CaptureChoiceBody; readonly response: CaptureChoice };
  // Milestone 4, the service map (M6, issue #397, map/routes.ts): built at the first read; the refresh for a known user.
  'GET /api/service-map': { readonly body: null; readonly response: ServiceMap };
  'POST /api/service-map/refresh': { readonly body: null; readonly response: ServiceMap };
};

export type ApiRoute = keyof ApiRoutes;

// The list of the routes above; tsc checks it names every key once.
const routes = {
  'GET /api/sessions': true,
  'GET /api/sessions/:id': true,
  'GET /api/sessions/:id/events': true,
  'POST /api/sessions/:id/messages': true,
  'POST /api/sessions/:id/requests/:requestId/answer': true,
  'POST /api/sessions/:id/interrupt': true,
  'GET /api/tickets': true,
  'POST /api/tickets': true,
  'GET /api/tickets/:id': true,
  'POST /api/tickets/:id/move': true,
  'POST /api/tickets/:id/set-aside': true,
  'POST /api/tickets/:id/close': true,
  'POST /api/tickets/:id/approve': true,
  'GET /api/tickets/:id/proof/:service/:file': true,
  'POST /api/batches': true,
  'GET /api/batches': true,
  'GET /api/batches/:id': true,
  'GET /api/inbox': true,
  'GET /api/workspace': true,
  'GET /api/sessions/:id/preview/*': true,
  'POST /api/sessions/:id/plan/go': true,
  'POST /api/sessions/:id/plan/change': true,
  'GET /api/sessions/:id/files': true,
  'GET /api/sessions/:id/files/*': true,
  'GET /api/sessions/:id/editor': true,
  'POST /api/sessions/:id/takeover': true,
  'POST /api/sessions/:id/giveback': true,
  'POST /api/sessions/:id/handover': true,
  'GET /api/tickets/:id/steps': true,
  'POST /api/contracts/:id/approve': true,
  'POST /api/contracts/:id/sendback': true,
  'GET /api/tickets/:id/variants': true,
  'POST /api/variants/:id/choose': true,
  'POST /api/knowledge/:id/approve': true,
  'POST /api/knowledge/:id/reject': true,
  'POST /api/services/:name/skill': true,
  'POST /api/asks': true,
  'GET /api/asks/:id': true,
  'POST /api/asks/:id/follow': true,
  'GET /api/recipes': true,
  'POST /api/recipes/:name/run': true,
  'GET /api/schedules': true,
  'POST /api/schedules': true,
  'DELETE /api/schedules/:id': true,
  'POST /api/sessions/:id/terminal/open': true,
  'POST /api/sessions/:id/terminal/input': true,
  'POST /api/sessions/:id/terminal/resize': true,
  'POST /api/sessions/:id/terminal/close': true,
  'GET /api/sessions/:id/terminal/stream': true,
  'PUT /api/sessions/:id/files/*': true,
  'GET /api/lead': true,
  'GET /api/lead/messages': true,
  'GET /api/lead/stream': true,
  'POST /api/lead/messages': true,
  'GET /api/lead/memory': true,
  'GET /api/plans': true,
  'GET /api/plans/:id': true,
  'POST /api/plans/:id/approve': true,
  'POST /api/plans/:id/reject': true,
  'POST /api/plans/:id/pause': true,
  'POST /api/plans/:id/resume': true,
  'GET /api/events': true,
  'GET /api/consumption': true,
  'POST /api/consumption/levers': true,
  'GET /api/consumption/week': true,
  'GET /api/tickets/:id/cost': true,
  'GET /api/tickets/:id/production': true,
  'GET /api/tickets/:id/captures': true,
  'POST /api/tickets/:id/captures': true,
  'GET /api/service-map': true,
  'POST /api/service-map/refresh': true,
} satisfies Record<ApiRoute, true>;
export type { Consumption, HarnessConsumption, LeverChoices, LeversChange, Projection, Quota, TicketCost, WeekFigures, WeekService, WeekTicket };
export type { Impact, ImpactCaller, ServiceImpact, ServiceMap, ServiceMapDatabase, ServiceMapLink, ServiceMapPlace, ServiceMapProblem, ServiceMapService };
export const API_ROUTES = Object.keys(routes) as ApiRoute[];

// The preview route: lane 15 serves it (container/preview.ts), not the flow's API.
export const SESSION_PREVIEW_ROUTE: ApiRoute = 'GET /api/sessions/:id/preview/*';

// The routes of waves 7 and 8 written ahead of their servers (lane 16):
// the plan's Go and Change are lane 17's (flow/plan-gate.ts, registered by
// the flow module), the files, takeover and giveback lane 20's
// (flow/files.ts, flow/takeover.ts).
export const SESSION_PLAN_ROUTES: readonly ApiRoute[] = ['POST /api/sessions/:id/plan/go', 'POST /api/sessions/:id/plan/change'];
export const SESSION_TABS_ROUTES: readonly ApiRoute[] = ['GET /api/sessions/:id/files', 'GET /api/sessions/:id/files/*', 'POST /api/sessions/:id/takeover', 'POST /api/sessions/:id/giveback', 'POST /api/sessions/:id/handover'];

// The routes of waves 9 to 11 written ahead of their servers (lane 17).
export const STEP_ROUTES: readonly ApiRoute[] = ['GET /api/tickets/:id/steps', 'POST /api/contracts/:id/approve', 'POST /api/contracts/:id/sendback'];   // lane 23, flow/
export const VARIANT_ROUTES: readonly ApiRoute[] = ['GET /api/tickets/:id/variants', 'POST /api/variants/:id/choose'];   // issue #271, flow/variants.ts
export const BATCH_ROUTES: readonly ApiRoute[] = ['POST /api/batches', 'GET /api/batches', 'GET /api/batches/:id'];   // requirement C6, flow/batch.ts
export const KNOWLEDGE_ROUTES: readonly ApiRoute[] = ['POST /api/knowledge/:id/approve', 'POST /api/knowledge/:id/reject', 'POST /api/services/:name/skill'];   // lane 24, knowledge/
export const ASK_ROUTES: readonly ApiRoute[] = ['POST /api/asks', 'GET /api/asks/:id', 'POST /api/asks/:id/follow'];   // lane 25, reader/
export const RECIPE_ROUTES: readonly ApiRoute[] = ['GET /api/recipes', 'POST /api/recipes/:name/run', 'GET /api/schedules', 'POST /api/schedules', 'DELETE /api/schedules/:id'];   // lane 26, recipes/ and schedules/
export const TERMINAL_ROUTES: readonly ApiRoute[] = [   // lane 31, terminal/ and flow/files.ts
  'POST /api/sessions/:id/terminal/open', 'POST /api/sessions/:id/terminal/input', 'POST /api/sessions/:id/terminal/resize', 'POST /api/sessions/:id/terminal/close',
  'GET /api/sessions/:id/terminal/stream', 'PUT /api/sessions/:id/files/*',
];

// The routes of the Consumption screen (milestone 3, O15), its week's figures (C17) and a ticket's cost (P211): the lead module's, with the schedules'.
export const CONSUMPTION_ROUTES: readonly ApiRoute[] = ['GET /api/consumption', 'POST /api/consumption/levers', 'GET /api/consumption/week', 'GET /api/tickets/:id/cost'];

// The routes of the service map (milestone 4, M6): the lead module's.
export const MAP_ROUTES: readonly ApiRoute[] = ['GET /api/service-map', 'POST /api/service-map/refresh'];

// The routes milestone 2 adds: the lead module's (lanes 5 and 7), not the flow's.
export const MILESTONE_2_ROUTES: readonly ApiRoute[] = API_ROUTES.filter((route) => route.includes('/api/lead') || route.includes('/api/plans'));

// One stored event as one server-sent event: its seq as the id, its AG-UI
// type as the event name, the envelope as JSON on one data line.
export function sseFrame(event: SessionEvent): string {
  return `id: ${event.seq}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

// The change stream (GET /api/events, lane 34): a thin event says which
// resource changed, never what it holds, so nothing of a session's content
// travels on it. `id` names the session, the ticket or the plan; null for
// the inbox and the lead, which are one resource each. 'plan' is reserved:
// the service says none yet (a plan moves with its tickets' events and the
// lead's, and the app reads plans at the polling interval); the app
// already refetches the plan an event would name.
export type ChangeKind = 'session' | 'ticket' | 'inbox' | 'lead' | 'plan';
export type ChangeEvent = { readonly kind: ChangeKind; readonly id: string | null; readonly at: string };

// One change as one server-sent event: its number as the id, the event on one data line.
export function changeFrame(seq: number, event: ChangeEvent): string {
  return `id: ${seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`;
}
