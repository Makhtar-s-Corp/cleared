// The service's HTTP and server-sent events API, as the app lanes (6, 9, 10)
// build against it and lane 7 implements it. Changing this file after wave 1
// is a lane of its own (docs/v2/milestone-1-plan.md, section 10). Milestone
// 2 adds the lead, its thread and the plans (docs/v2/milestone-2-plan.md,
// sections 5.1 and 7.1), implemented by lanes 5 and 7.
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
};

export type SessionDetail = SessionSummary & { readonly state: SessionState };

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
export type CreateTicketBody = { readonly title: string; readonly body?: string; readonly labels?: readonly string[]; readonly project: string };
export type MoveTicketBody = { readonly status: string };
export type ApproveBody = { readonly requestedAt: string; readonly heads: readonly { readonly pr: number; readonly head: string }[] };
export type LeadMessageBody = { readonly text: string; readonly goal?: true };   // goal: the text is a goal
export type RejectPlanBody = { readonly message: string };

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

// The routes milestone 2 adds: the lead module's (lanes 5 and 7), not the flow's.
export const MILESTONE_2_ROUTES: readonly ApiRoute[] = API_ROUTES.filter((route) => route.includes('/api/lead') || route.includes('/api/plans'));

// One stored event as one server-sent event: its seq as the id, its AG-UI
// type as the event name, the envelope as JSON on one data line.
export function sseFrame(event: SessionEvent): string {
  return `id: ${event.seq}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
