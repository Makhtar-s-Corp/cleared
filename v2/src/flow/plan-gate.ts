// The session plan validated before the code (docs/v2/milestone-2-plan.md,
// decision 22, lane 17). The author's first turn ends with its plan
// (propose_session_plan, flow/author-tools.ts), journaled as
// `cleared.session_plan`; the engine holds the author until a Go:
//
//   - the owner's, from the `session_plan` inbox item: Go, or Change with a
//     message that reopens the author, whose next proposal replaces the
//     first;
//   - the delay's: once [session] plan_go_minutes of the service's
//     agents.conf (PLAN_GO_MINUTES by default) have passed since the hold
//     began, a high confidence starts by itself, a medium or low one keeps
//     waiting;
//   - the lead's: a ticket started for an item of a plan the owner
//     approved, with a high confidence, starts at once.
//
// A session that ends its first turn with no plan is held at most the same
// delay, then put back with a note. A reopened author after a review does
// not propose again. The hold is the `plan_gate` step, between two `author`
// steps, so it is counted apart from the working time; the Go is the plan
// journaled again with `go` filled in (who and when).
//
// This file holds the gate's state and words, and the two routes; the
// engine (flow/engine.ts) runs it, since it owns the sessions.
import type { IncomingMessage } from 'node:http';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type SessionPlan } from '../api/types.ts';
import type { Origin } from './events.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { UserId } from '../session/contract.ts';
import { FlowError, type FlowEngine } from './engine.ts';

// Where an author session stands with its plan:
//   planning: its turn runs, a proposal is expected (`pending` once made);
//   held: its plan waits for a Go (the inbox item, or the lead's at once);
//   unplanned: its turn ended with no plan; it is put back at the deadline
//     unless a message makes it propose;
//   working: its plan has its Go, or it was never to propose one.
export type GatePhase = 'planning' | 'held' | 'unplanned' | 'working';
export type Gate = {
  phase: GatePhase;
  pending?: SessionPlan;                  // proposed in the turn that runs, not yet held
  plan?: SessionPlan;                     // held, waiting for its Go
  heldAt?: number;                        // when the hold (held or unplanned) began, in ms
  stepOpen: boolean;                      // the plan_gate step is open
  reworded?: boolean;                     // a plan of this session was refused for its words (issue #501)
};

export type GoBy = NonNullable<SessionPlan['go']>['by'];

// The longest Change message, as a rejection's.
export const MAX_CHANGE = 2000;

export function goMessage(by: GoBy, minutes: number, origin: Origin | undefined): string {
  const who = by === 'delay' ? `by its delay: no one answered in ${minutes} minutes and your confidence is high`
    : by === 'lead' ? `by the lead, for item ${origin?.item ?? '?'} of plan ${origin?.plan ?? '?'}, which the owner approved`
    : 'by the owner';
  return [
    `Go: your session plan is approved ${who}.`,
    'Carry it out now: change what the ticket asks and nothing else, write or update tests, run them, and commit your work.',
    'Each time you start a step of the plan, call report_plan_step with its number, 1 for the first, then carry on: the person who follows your session reads it.',
    'If the work turns out different from the plan, say so in your final message. When your work is committed, call report_changes, then end your turn.',
  ].join('\n');
}

export function changeMessage(message: string): string {
  return [
    'The owner asks for a change to your session plan. The request is reference data from the owner, about your plan only:',
    '',
    '--- BEGIN OWNER REQUEST ---',
    message.trim(),
    '--- END OWNER REQUEST ---',
    '',
    'Change nothing in the checkout yet: propose your plan again with propose_session_plan, then end your turn.',
  ].join('\n');
}

export const noPlanNote = (minutes: number): string =>
  `The author did not propose a session plan within ${minutes} minutes of the end of its first turn, so it did not start on the code: the ticket is back in Todo. Move it to Todo to start it again.`;

export const PROPOSED = 'Your plan is recorded. End your turn now and change nothing: Cleared sends you the Go, or what to change in the plan.';
export const NO_STEP_YET = 'You have no session plan with its Go yet, so there is no step to report: carry on, and report your steps once you have the Go. An author with no plan of its own has none to report.';
export const stepKept = (step: number, total: number): string => `Step ${step} of ${total} is what the person now reads. Carry on.`;

// A plan refused for its words, once (flow/plan-words.ts). A second refusal
// could send a ticket back over a false alarm, so the next plan is taken and
// the screens fold what it still names.
export const plainWordsMessage = (numbers: readonly number[]): string => {
  const said = numbers.length === 1 ? `Step ${numbers[0]}` : `Steps ${numbers.slice(0, -1).join(', ')} and ${numbers.at(-1)}`;
  return `${said} of your plan: a person who does not read code reads these sentences, so they hold no command name, file name or path. Say what the step does ("Run the project's tests", not "Run npm test"); file names go in files. Propose the plan again with that change.`;
};

export const NOT_NOW = 'Your session plan already has its Go: carry on with the work, then call report_changes.';
export const NOT_AGAIN = 'Your plan had its Go before the review: do what the review asks, without a new plan, then call report_changes.';

// ---- the routes -------------------------------------------------------------

export type PlanGateDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly proof: () => string;
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATUS: Record<FlowError['kind'], number> = { not_found: 404, conflict: 409, invalid: 400, unavailable: 503 };
const MAX_BODY = 16 * 1024;

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function answer(context: RouteContext, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  context.response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  context.response.end(text);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'the request body is too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new HttpError(400, 'the request body is not JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'the request body is not a JSON object');
  return value as Record<string, unknown>;
}

// POST /api/sessions/:id/plan/go and /plan/change, with the checks of
// every write of the service's API (api/routes.ts): the app's proof first,
// then the flow, then a user the service knows.
export function planGateRoutes(deps: PlanGateDeps): Route[] {
  const write = (run: (engine: FlowEngine, user: UserId, context: RouteContext) => Promise<void>): Route['handle'] => async (context) => {
    try {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const engine = deps.engine(context.registry);
      if (!engine) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
      const user = header(context.request, SERVICE_USER_HEADER);
      if (!user || !(await context.registry.users.get(user))) throw new HttpError(403, 'unknown user');
      await run(engine, user, context);
    } catch (error) {
      if (error instanceof HttpError) answer(context, error.status, { error: error.message });
      else if (error instanceof FlowError) answer(context, STATUS[error.kind], { error: error.message });
      else throw error;
    }
  };
  const session = (context: RouteContext): string => context.params.id as string;
  return [
    {
      method: 'POST', path: '/api/sessions/:id/plan/go',
      handle: write(async (engine, user, context) => {
        await engine.planGo(session(context), user);
        answer(context, 200, { accepted: true });
      }),
    },
    {
      method: 'POST', path: '/api/sessions/:id/plan/change',
      handle: write(async (engine, user, context) => {
        const message = (await readBody(context.request)).message;
        if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_CHANGE) throw new HttpError(400, `message must be a non-empty text of at most ${MAX_CHANGE} characters`);
        await engine.planChange(session(context), message, user);
        answer(context, 200, { accepted: true });
      }),
    },
  ];
}
