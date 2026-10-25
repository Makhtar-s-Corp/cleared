// What the train asks of one service's lock (docs/v2/milestone-2-plan.md,
// decision 21): each service of a workspace of several has its own release
// broker, with its own state folder (its secret, its merge.lock, its
// validations and its review reports) and the ledger they all share. The
// real one is approval/service.ts serviceLocks(); the flow's tests use fakes.
import type { ReviewRecord } from '../modules/registry.ts';
import type { TicketId } from '../tickets/contract.ts';
import type { UserId } from '../session/contract.ts';

// What a lock answered a merge (`request_release` without --ask): merged;
// not now (a check still runs, the host is busy, another release goes on);
// refused for good, with merge-pr.ts's reason; or the lock could not be asked.
export type MergeOutcome = { readonly outcome: 'merged' | 'queued' | 'refused' | 'unavailable'; readonly message: string };

export type Head = { readonly pr: number; readonly head: string };

export interface ServiceLock {
  readonly service: string;
  // The passing review of this service's pull request, where its merge-pr.ts
  // reads it: a runs row of the shared ledger and the report in its own
  // state folder. `session` names the run, so two pull requests of the same
  // number in two repositories get two runs.
  recordReview(review: ReviewRecord & { readonly commit: string; readonly verdictPhrase: string }): Promise<void>;
  // `request_release --ask` on its broker: ask-validation.ts keeps the
  // shown head in its own validations record. The request time it kept.
  ask(input: { readonly ticket: TicketId; readonly pr: number; readonly request: string }): Promise<{ readonly requestedAt: string }>;
  // Why its record no longer holds exactly this request; undefined when it does.
  check(input: { readonly ticket: TicketId; readonly requestedAt: string; readonly head: Head }): string | undefined;
  // The owner's move to go, signed, bound to its own record (approval_context),
  // which its merge-pr.ts reads. Throws when the record is not the one shown.
  sign(input: { readonly ticket: TicketId; readonly by: UserId; readonly requestedAt: string; readonly heads: readonly Head[] }): Promise<void>;
  release(input: { readonly ticket: TicketId; readonly pr: number; readonly announcement: string }): Promise<MergeOutcome>;
  // `request_rollback` on its broker, accepted from the configured human
  // account (the setup names the service's account as human_user).
  rollback(input: { readonly ticket: TicketId }): Promise<{ readonly ok: boolean; readonly message: string }>;
}

// The run name of a service's review: the session's id cut, then the
// service, within the 64 characters the recorder accepts.
export function reviewRun(session: string, service: string): string {
  return `${session.replace(/[^A-Za-z0-9]/g, '').slice(0, 22)}-${service}`.slice(0, 64);
}
