// The flow's event bus (docs/v2/milestone-2-plan.md, section 10, "one event
// bus"): what happens to a ticket, said once, after the flow has written it
// (the store, the inbox, the ticket). The lead (lane 5), the notifications
// (lane 6) and the plan runner (lane 7) learn of a ticket's life through
// FlowEngine.subscribe, never by reading the flow's tables.
import type { CiRepair } from '../api/types.ts';
import type { Role, SessionId, UserId } from '../session/contract.ts';
import type { TicketId } from '../tickets/contract.ts';

// Who asked for a ticket to start beyond the person: a plan's item
// (lane 7). `note` is added to the author's prompt, for a ticket put back
// and started again. `steps`: the item's steps, when the lead gave some
// (decision 26, lane 23); `maxParallel`: the plan's limit of sessions at
// once, which the ticket's steps keep to. `budgetUsd`: the ticket's budget
// when a schedule started the plan (decision 29, lane 26), in place of
// CLEARED_V2_BUDGET_USD.
export type Origin = {
  readonly plan: string; readonly item: number; readonly note?: string;
  readonly steps?: readonly StepSpec[]; readonly maxParallel?: number;
  readonly budgetUsd?: number;
};

// A step of a ticket as a plan item or the flow gives it: its kind, its
// service, and the 1-based positions it waits for.
export type StepSpec = { readonly kind: 'contract' | 'service' | 'integration'; readonly service: string; readonly after: readonly number[] };

// Why the flow put a ticket back in Todo.
export type PutBackReason =
  | 'start_failed'          // the workspace or the author could not start
  | 'idle'                  // no activity for CLEARED_V2_IDLE_MINUTES
  | 'budget'                // the ticket's budget is spent
  | 'failed'                // a session failed or ended before its turn did
  | 'no_verdict'            // the review gave no Verdict line
  | 'too_many_rounds'       // the review still asked for changes after the last round
  | 'review_failed'         // the review could not start
  | 'reopen_failed'         // the author could not be reopened after a review
  | 'publish_refused'       // the branch was not published
  | 'release_refused'       // the lock refused the request for approval
  | 'merge_refused'         // the lock refused the merge for good
  | 'rolled_back'           // the release watch reverted the merge
  | 'train_halted'          // a release train could not land its next service (lane 16)
  | 'step_failed'           // a step of the ticket failed; its done steps are kept (lane 23)
  | 'restart'               // the service restarted while the ticket ran
  | 'set_aside'             // the owner set the ticket aside (FlowEngine.setAside)
  | 'parked';               // its question waited past its delay and the lead's, with no declared answer (issue #290)

type Base = { readonly at: string; readonly project: string; readonly ticket: TicketId };
// A ticket of a workspace of several services lands as a train (lane 16):
// its landing events name the service; absent for one service.
type OfService = { readonly service?: string };

export type FlowEvent =
  | Base & { readonly type: 'ticket_started'; readonly by: UserId; readonly origin: Origin | null; readonly session: SessionId }
  | Base & { readonly type: 'author_done'; readonly session: SessionId }
  | Base & { readonly type: 'review_verdict'; readonly session: SessionId; readonly verdict: 'pass' | 'changes_requested'; readonly round: number }
  | Base & { readonly type: 'release_requested'; readonly session: SessionId; readonly item: string; readonly pr: number; readonly url: string }
  | Base & { readonly type: 'release_approved'; readonly item: string; readonly pr: number; readonly by: UserId }
  | Base & OfService & { readonly type: 'release_merged'; readonly pr: number }
  // 'unwatched': the project configures no health check, so the release is live at its merge.
  // A train says it once, when its last service landed, with its services in landing order.
  | Base & OfService & { readonly type: 'release_landed'; readonly pr: number; readonly health: 'healthy' | 'unwatched'; readonly services?: readonly string[] }
  // Live, but the watch ended without a healthy verdict and nothing was reverted: the owner decides.
  | Base & OfService & { readonly type: 'release_unhealthy'; readonly pr: number; readonly note: string }
  // A train says it once, naming the service whose watch failed.
  | Base & OfService & { readonly type: 'rolled_back'; readonly pr: number; readonly note: string }
  | Base & { readonly type: 'ticket_put_back'; readonly reason: PutBackReason; readonly note: string }
  // The repair of a release's failed checks (issue #273): each step of it,
  // as the card's `repair` says it.
  | Base & { readonly type: 'ci_repair'; readonly pr: number; readonly attempt: number; readonly limit: number; readonly state: CiRepair['state']; readonly checks: readonly string[] }
  | Base & { readonly type: 'question_raised'; readonly session: SessionId; readonly requestId: string; readonly item: string }
  | Base & { readonly type: 'permission_raised'; readonly session: SessionId; readonly requestId: string; readonly item: string; readonly tool: string }
  | Base & { readonly type: 'request_answered'; readonly session: SessionId; readonly requestId: string; readonly item: string; readonly by: UserId | 'policy' | 'system' }
  | Base & { readonly type: 'session_stopped'; readonly session: SessionId; readonly role: Role; readonly phase: 'stopped' | 'failed'; readonly reason: string }
  // A team's question past its delay (issue #290): `lead`, the lead is asked
  // to decide; `default`, the session's declared answer was applied;
  // `parked`, there was none and the ticket is parked. `minutes`: how long it
  // had waited; `leadMinutes`: the lead's window.
  | Base & {
    readonly type: 'question_timed_out'; readonly session: SessionId; readonly requestId: string; readonly item: string;
    readonly stage: 'lead' | 'default' | 'parked'; readonly minutes: number; readonly leadMinutes: number; readonly questions: readonly string[];
    readonly answers: Readonly<Record<string, string>> | null;
  };

export type FlowEventType = FlowEvent['type'];

export const FLOW_EVENT_TYPES: readonly FlowEventType[] = [
  'ticket_started', 'author_done', 'review_verdict', 'release_requested', 'release_approved', 'release_merged', 'release_landed',
  'release_unhealthy', 'rolled_back', 'ticket_put_back', 'question_raised', 'permission_raised', 'request_answered', 'session_stopped',
  'question_timed_out', 'ci_repair',
];

// A listener is called in the flow's own turn, after the write: it must
// not block. What it throws, or the promise it rejects, is logged and
// dropped; the flow goes on.
export type FlowListener = (event: FlowEvent) => void | Promise<void>;
