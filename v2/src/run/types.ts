// The shapes of the run module's routes (docs/v2/milestone-5-plan.md,
// section 8, C18), imported by the app's API access panel and by the
// `cleared run` command; src/api/types.ts is not edited by milestone 5
// (section 3.1).
//
//   POST /api/run                  a ticket made and started as a batch of one;
//   GET  /api/run/:id              its state: these two take a person's API
//                                  token, `authorization: Bearer <value>`, and
//                                  nothing else;
//   GET  /api/tokens               the person's tokens, by name and dates;
//   POST /api/tokens               one made, its value answered this once;
//   POST /api/tokens/:id/revoke    one revoked: these three are the app's,
//                                  with its proof and the person's id, as
//                                  every other route of the service.
import type { BatchHold } from '../api/types.ts';
import type { SessionId } from '../session/contract.ts';
import type { TicketTemplate } from '../tickets/templates.ts';
import type { TicketId } from '../tickets/contract.ts';

export const RUN_PATH = '/api/run';
export const ACCESS_PATH = '/api/tokens';
// The label every ticket of a run carries, as the chat's carry `chat`.
export const RUN_LABEL = 'run';

// A token as its person sees it in the app: never its value, nor its hash.
export type ApiToken = {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
};

// The answer of POST /api/tokens: the value is in no other answer, ever.
export type MadeApiToken = { readonly token: ApiToken; readonly value: string };

export type MakeApiTokenBody = { readonly name: string };

// POST /api/run. `title` is the ticket's title; `description` its body;
// `service` one service of the workspace; `template` one of the ticket
// templates (P214), which gives the ticket its type label.
export type RunBody = {
  readonly title: string;
  readonly description?: string;
  readonly service?: string;
  readonly template?: TicketTemplate;
};

// Where a run is, read from its batch's item and from the flow's events:
//   queued     it waits for a lane or the week stop (`hold` says which);
//   starting   its batch started it, its session is not open yet;
//   working    its author or its reviewer works on it;
//   approval   its pull request waits for a person's approval in the app;
//   approved   approved, being merged;
//   live       merged, and healthy through the watch when one is declared;
//   put_back   the flow put it back in Todo (`note` says why);
//   failed     it could not start (`note` says why).
export const RUN_STATES = ['queued', 'starting', 'working', 'approval', 'approved', 'live', 'put_back', 'failed'] as const;
export type RunState = (typeof RUN_STATES)[number];

export type Run = {
  readonly ticket: TicketId;
  readonly title: string;
  readonly status: string;                                // the ticket's status in the tracker
  readonly state: RunState;
  readonly hold: BatchHold | null;
  readonly note: string | null;
  readonly address: string | null;                        // the app's page of it: its session, else the Tower; none when the app's address is not known
  readonly session: SessionId | null;
  readonly pullRequest: { readonly number: number; readonly url: string } | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly approvalAt: string | null;                     // when its pull request was put up for approval
  readonly liveAt: string | null;
};
