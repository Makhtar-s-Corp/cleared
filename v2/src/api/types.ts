// The service's HTTP and server-sent events API, as the app lanes (6, 9, 10)
// build against it and lane 7 implements it. Changing this file after wave 1
// is a lane of its own (docs/v2/milestone-1-plan.md, section 10).
//
// The app calls the service on loopback, forwarding /api/service/* to these
// routes. Every request carries the shared proof the service checks
// (SERVICE_PROOF_HEADER) and, when a person acts, their user id
// (SERVICE_USER_HEADER). A request without the proof is refused before
// anything else; an approval also needs the user id.
import type { Decision, Harness, Role, SessionId, UserId } from '../session/contract.ts';
import type { Question, SessionEvent, SessionPhase, SessionState, ToolInput } from '../session/events.ts';
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
  readonly ticket: TicketId;
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

export type InboxItem = PermissionItem | QuestionItem | ReleaseItem;

// Request bodies.
export type SendMessageBody = { readonly text: string };
export type AnswerBody = { readonly decision: Decision };
export type CreateTicketBody = { readonly title: string; readonly body?: string; readonly labels?: readonly string[]; readonly project: string };
export type MoveTicketBody = { readonly status: string };
export type ApproveBody = { readonly requestedAt: string; readonly heads: readonly { readonly pr: number; readonly head: string }[] };

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
} satisfies Record<ApiRoute, true>;
export const API_ROUTES = Object.keys(routes) as ApiRoute[];

// One stored event as one server-sent event: its seq as the id, its AG-UI
// type as the event name, the envelope as JSON on one data line.
export function sseFrame(event: SessionEvent): string {
  return `id: ${event.seq}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
