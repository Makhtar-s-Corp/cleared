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
// by lane 16 (decisions 22, 23, 24 and 30).
//
// The app calls the service on loopback, forwarding /api/service/* to these
// routes. Every request carries the shared proof the service checks
// (SERVICE_PROOF_HEADER) and, when a person acts, their user id
// (SERVICE_USER_HEADER). A request without the proof is refused before
// anything else; an approval also needs the user id.
import type { Decision, Harness, Role, SessionId, UserId } from '../session/contract.ts';
import type { ContextShare, Question, SessionEvent, SessionPhase, SessionState, ToolInput } from '../session/events.ts';
import type { Verdict } from '../session/policy.ts';
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

export type PermissionItem = InboxBase & {
  readonly kind: 'permission';
  readonly sessionId: SessionId;
  readonly requestId: string;
  readonly tool: string;
  readonly input: ToolInput;
  readonly suggestion: Verdict;
};

export type QuestionItem = InboxBase & {
  readonly kind: 'question';
  readonly sessionId: SessionId;
  readonly requestId: string;
  readonly questions: readonly Question[];
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
};

// The author's report of its changes (`report_changes`, decision 23), kept
// as the session's `cleared.changes` journal event: lane 17 writes it.
export type ChangesReport = { readonly groups: readonly { readonly intent: string; readonly files: readonly string[] }[] };

// One group of the release card: an intent and its files. The files no
// group names go to "Other changes".
export type ReleaseGroup = { readonly intent: string; readonly files: readonly string[] };

// A chip on the release card, from the diff (decision 23). Never a block,
// except `contract` on an untouched consumer (the train's `blocked`).
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
  readonly contract: { readonly format: 'openapi'; readonly path: string } | null; // OpenAPI 3 only in milestone 2
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

export type InboxItem = PermissionItem | QuestionItem | ReleaseItem | PlanItemInbox;
export type NextInboxItem = InboxItem | SessionPlanItem;

// ---------------------------------------------------------------- milestone 2: plans

export type PlanItemState = 'waiting' | 'ready' | 'running' | 'needs_approval' | 'landed' | 'put_back' | 'held' | 'cancelled';

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
export type CreateTicketBody = { readonly title: string; readonly body?: string; readonly labels?: readonly string[]; readonly project: string; readonly services?: readonly string[] };
export type MoveTicketBody = { readonly status: string };
export type ApproveBody = { readonly requestedAt: string; readonly heads: readonly { readonly pr: number; readonly head: string }[] };
export type LeadMessageBody = { readonly text: string; readonly goal?: true };   // goal: the text is a goal
export type RejectPlanBody = { readonly message: string };
export type ChangeSessionPlanBody = { readonly message: string };   // what the author is to change in its plan

// The Editor tab (decision 30, lane 20): the files the session changed, and
// one file of its checkout, cut at 400 lines (`cut` says so), with the hash
// of what was read, which a save (decision 33, lane 17's shapes) sends back.
export type SessionFiles = { readonly files: readonly { readonly path: string; readonly added: number; readonly removed: number }[] };
export type SessionFile = { readonly path: string; readonly text: string; readonly lines: number; readonly cut: boolean; readonly hash: string };

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
  'POST /api/tickets/:id/approve': { readonly body: ApproveBody; readonly response: { readonly accepted: true; readonly by: UserId } };
  'GET /api/inbox': { readonly body: null; readonly response: InboxItem[] };
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
  'POST /api/sessions/:id/takeover': { readonly body: null; readonly response: { readonly accepted: true; readonly by: UserId } };
  'POST /api/sessions/:id/giveback': { readonly body: null; readonly response: { readonly accepted: true } };
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
  'POST /api/tickets/:id/approve': true,
  'GET /api/inbox': true,
  'GET /api/workspace': true,
  'GET /api/sessions/:id/preview/*': true,
  'POST /api/sessions/:id/plan/go': true,
  'POST /api/sessions/:id/plan/change': true,
  'GET /api/sessions/:id/files': true,
  'GET /api/sessions/:id/files/*': true,
  'POST /api/sessions/:id/takeover': true,
  'POST /api/sessions/:id/giveback': true,
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
} satisfies Record<ApiRoute, true>;
export const API_ROUTES = Object.keys(routes) as ApiRoute[];

// The preview route: lane 15 serves it (container/preview.ts), not the flow's API.
export const SESSION_PREVIEW_ROUTE: ApiRoute = 'GET /api/sessions/:id/preview/*';

// The routes of waves 7 and 8 written ahead of their servers (lane 16):
// the plan's Go and Change are lane 17's (flow/plan-gate.ts), the files,
// takeover and giveback lane 20's (flow/files.ts, flow/takeover.ts).
export const SESSION_PLAN_ROUTES: readonly ApiRoute[] = ['POST /api/sessions/:id/plan/go', 'POST /api/sessions/:id/plan/change'];
export const SESSION_TABS_ROUTES: readonly ApiRoute[] = ['GET /api/sessions/:id/files', 'GET /api/sessions/:id/files/*', 'POST /api/sessions/:id/takeover', 'POST /api/sessions/:id/giveback'];

// The routes milestone 2 adds: the lead module's (lanes 5 and 7), not the flow's.
export const MILESTONE_2_ROUTES: readonly ApiRoute[] = API_ROUTES.filter((route) => route.includes('/api/lead') || route.includes('/api/plans'));

// One stored event as one server-sent event: its seq as the id, its AG-UI
// type as the event name, the envelope as JSON on one data line.
export function sseFrame(event: SessionEvent): string {
  return `id: ${event.seq}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
