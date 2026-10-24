// A ticket runs in steps (docs/v2/milestone-2-plan.md, decision 26, lane 23):
//
//   - the contract step, a session on the providing service that changes
//     only its contract file, and ends with the contract's diff proposed
//     as an inbox `contract` item (Approve, Send back with a message that
//     reopens the step);
//   - the service steps, one per service the ticket names, after it, in
//     parallel, each with the other services as fakes built from the
//     validated contract;
//   - the integration step, last, on the consuming service, with every
//     sibling real from the ticket branch; its tests are the ticket's
//     criteria.
//
// A one-service ticket has one `service` step and runs as before. The steps
// are `ticket_steps` rows, the truth of where each one stands: a ticket put
// back keeps its done steps, and starts again from the first that is not.
// A plan item gives its steps (Origin.steps); a ticket that comes with none
// gets the ones deriveSteps answers.
//
// This file holds the steps' table, their default, the siblings each kind
// of step runs with, and the three routes; the engine (flow/engine.ts) runs
// the steps, since it owns the sessions.
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type TicketStep } from '../api/types.ts';
import type { SiblingSpec } from '../container/services.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import { landingOrder } from '../release/order.ts';
import type { SessionId, UserId } from '../session/contract.ts';
import type { TicketId } from '../tickets/contract.ts';
import type { ServiceConfig } from '../workspace/config.ts';
import { FlowError, type FlowEngine } from './engine.ts';
import type { StepSpec } from './events.ts';

export type { StepSpec } from './events.ts';
export type StepKind = StepSpec['kind'];
export type StepState = TicketStep['state'];

export const STEP_KINDS: readonly StepKind[] = ['contract', 'service', 'integration'];

export const STEPS_TABLE = `CREATE TABLE IF NOT EXISTS ticket_steps (
  id TEXT PRIMARY KEY, ticket TEXT NOT NULL, project TEXT NOT NULL, kind TEXT NOT NULL, service TEXT NOT NULL,
  position INTEGER NOT NULL, after TEXT NOT NULL, state TEXT NOT NULL, session TEXT, sessions TEXT NOT NULL,
  cost REAL, minutes REAL, note TEXT, contract TEXT, blob TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (ticket, position)
)`;

// The steps of a ticket that names `named` when no plan item gives them:
// one service step for one service. For several, a contract step for each
// named service with a contract that another named service consumes; a
// step per named service, in landing order (providers first), after the
// contract steps; and an integration step on each named service that
// consumes another named one, after every service step.
export function deriveSteps(services: readonly ServiceConfig[], named: readonly string[]): StepSpec[] {
  if (named.length < 2) return named.slice(0, 1).map((service) => ({ kind: 'service', service, after: [] }));
  const order = landingOrder(services, named);
  const of = (name: string) => services.find((s) => s.name === name) as ServiceConfig;
  const providers = order.filter((name) => of(name).contract && order.some((other) => of(other).consumes.includes(name)));
  const consumers = order.filter((name) => of(name).consumes.some((provider) => order.includes(provider)));
  const steps: StepSpec[] = providers.map((service) => ({ kind: 'contract', service, after: [] }));
  const contracts = steps.map((_, i) => i + 1);
  for (const service of order) steps.push({ kind: 'service', service, after: contracts });
  const serviceSteps = order.map((_, i) => contracts.length + i + 1);
  for (const service of consumers) steps.push({ kind: 'integration', service, after: serviceSteps });
  return steps;
}

export type StepSiblings = {
  readonly kind: StepKind;
  readonly own: string;                                      // the step's service
  readonly validated: ReadonlyMap<string, string>;           // a provider's validated contract, as a host file
  readonly urls?: Readonly<Record<string, string>>;          // the own service's [session] service_urls
};

// The siblings of a step's session, from what the runtime plans for a
// session on its service (container/services.ts planSiblings): the
// contract step keeps them; a service step keeps its own service and runs
// every other service with a contract as its fake, from the validated
// contract, leaving out the others (their own steps change their
// checkouts meanwhile); the integration step keeps every sibling real from
// the ticket branch, a fake reading the validated contract. The own
// service's sibling gets the address of each service it names in its
// service_urls.
export function stepSiblings(planned: readonly SiblingSpec[], step: StepSiblings): SiblingSpec[] {
  if (step.kind === 'contract') return [...planned];
  const out: SiblingSpec[] = [];
  for (const sibling of planned) {
    if (sibling.name === step.own) { out.push(sibling); continue; }
    const contract = step.validated.get(sibling.name) ?? sibling.contract;
    if (step.kind === 'service') {
      if (contract !== undefined) out.push({ name: sibling.name, port: sibling.port, contract, ...(sibling.contractFormat ? { contractFormat: sibling.contractFormat } : {}) });
      continue;
    }
    out.push(contract === undefined ? sibling : { ...sibling, contract });
  }
  const own = out.findIndex((sibling) => sibling.name === step.own);
  const env: Record<string, string> = {};
  for (const [service, variable] of Object.entries(step.urls ?? {})) {
    const target = out.find((sibling) => sibling.name === service && sibling.name !== step.own);
    if (target) env[variable] = `http://${target.name}:${target.port}`;
  }
  if (own >= 0 && Object.keys(env).length > 0) {
    const sibling = out[own] as SiblingSpec;
    out[own] = { ...sibling, env: { ...sibling.env, ...env } };
  }
  return out;
}

// ---- the table ----------------------------------------------------------------

// A step as the engine keeps it: the API's shape, and what only the flow
// reads: every session it ran, the note it was sent back or put back with,
// and for a contract step the contract it proposed, as a host file and as
// git's blob id (the validated one once the step is done).
export type Step = Omit<TicketStep, 'costUsd'> & {
  readonly project: string;
  readonly sessions: readonly SessionId[];
  readonly note: string | null;
  readonly contract: string | null;
  readonly blob: string | null;
  readonly cost: number | null;
  readonly minutes: number | null;
};

type Row = Record<string, unknown>;
const str = (row: Row, key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));
const num = (row: Row, key: string): number | null => (row[key] === null || row[key] === undefined ? null : Number(row[key]));

export class StepStore {
  #db: DatabaseSync;
  #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(STEPS_TABLE);
  }

  #step(row: Row): Step {
    return {
      id: String(row.id), ticket: String(row.ticket), project: String(row.project), kind: String(row.kind) as StepKind, service: String(row.service),
      position: Number(row.position), after: JSON.parse(String(row.after)) as number[], state: String(row.state) as StepState,
      session: str(row, 'session'), sessions: JSON.parse(String(row.sessions)) as SessionId[], note: str(row, 'note'),
      contract: str(row, 'contract'), blob: str(row, 'blob'), cost: num(row, 'cost'), minutes: num(row, 'minutes'),
    };
  }

  // The ticket's steps, in position order; none when it has none yet.
  list(ticket: TicketId): Step[] {
    return (this.#db.prepare('SELECT * FROM ticket_steps WHERE ticket = ? ORDER BY position').all(ticket) as Row[]).map((row) => this.#step(row));
  }

  get(id: string): Step | undefined {
    const row = this.#db.prepare('SELECT * FROM ticket_steps WHERE id = ?').get(id) as Row | undefined;
    return row ? this.#step(row) : undefined;
  }

  // Writes the ticket's steps once: a ticket started again keeps the ones it has.
  ensure(ticket: TicketId, project: string, specs: readonly StepSpec[]): Step[] {
    if (this.list(ticket).length === 0) {
      const at = this.#now().toISOString();
      const insert = this.#db.prepare("INSERT OR IGNORE INTO ticket_steps (id, ticket, project, kind, service, position, after, state, sessions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting', '[]', ?, ?)");
      specs.forEach((spec, index) => insert.run(`${ticket}:step-${index + 1}`, ticket, project, spec.kind, spec.service, index + 1, JSON.stringify(spec.after), at, at));
    }
    return this.list(ticket);
  }

  // A step's new state and what goes with it; `session` is added to its sessions.
  update(id: string, change: { readonly state?: StepState; readonly session?: SessionId; readonly note?: string | null; readonly contract?: string | null; readonly blob?: string | null; readonly cost?: number | null; readonly minutes?: number }): Step {
    const step = this.get(id);
    if (!step) throw new FlowError('not_found', `unknown step ${id}`);
    const sessions = change.session && !step.sessions.includes(change.session) ? [...step.sessions, change.session] : step.sessions;
    const pick = <K extends keyof typeof change>(key: K, current: unknown) => (key in change ? change[key] : current);
    this.#db.prepare('UPDATE ticket_steps SET state = ?, session = ?, sessions = ?, note = ?, contract = ?, blob = ?, cost = ?, minutes = ?, updated_at = ? WHERE id = ?').run(
      change.state ?? step.state, change.session ?? step.session, JSON.stringify(sessions), pick('note', step.note) as string | null,
      pick('contract', step.contract) as string | null, pick('blob', step.blob) as string | null, pick('cost', step.cost) as number | null, change.minutes ?? step.minutes,
      this.#now().toISOString(), id,
    );
    return this.get(id) as Step;
  }

  // A ticket put back: its running steps wait again, so its restart runs them.
  hold(ticket: TicketId): void {
    this.#db.prepare("UPDATE ticket_steps SET state = 'waiting', updated_at = ? WHERE ticket = ? AND state = 'running'").run(this.#now().toISOString(), ticket);
  }

  // A ticket started again: what failed or was running waits again; what is
  // done stays done, and a contract waiting for its validation still waits.
  // A ticket whose steps were all done (its review, its release or the owner
  // sent it back) does its service and integration steps again, on the
  // contract as validated.
  resume(ticket: TicketId): void {
    const at = this.#now().toISOString();
    const steps = this.list(ticket);
    if (steps.length > 0 && steps.every((step) => step.state === 'done'))
      this.#db.prepare("UPDATE ticket_steps SET state = 'waiting', updated_at = ? WHERE ticket = ? AND kind != 'contract'").run(at, ticket);
    else this.#db.prepare("UPDATE ticket_steps SET state = 'waiting', updated_at = ? WHERE ticket = ? AND state IN ('running', 'failed')").run(at, ticket);
  }
}

// The API's step: what the flow keeps for itself left out, the cost given.
export function publicStep(step: Step, costUsd: number | null): TicketStep {
  return { id: step.id, ticket: step.ticket, kind: step.kind, service: step.service, position: step.position, after: step.after, state: step.state, session: step.session, costUsd };
}

// How a step is named in a note: "step 2 of 4 (the service step of filter-api)".
export function stepName(step: Pick<Step, 'position' | 'kind' | 'service'>, count: number): string {
  const what = step.kind === 'contract' ? `the contract step of ${step.service}` : step.kind === 'service' ? `the service step of ${step.service}` : `the integration step on ${step.service}`;
  return `step ${step.position} of ${count} (${what})`;
}

// ---- the routes -------------------------------------------------------------

export type StepRoutesDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly proof: () => string;
};

// The longest Send back message, as a Change's.
export const MAX_SEND_BACK = 2000;
const MAX_BODY = 16 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATUS: Record<FlowError['kind'], number> = { not_found: 404, conflict: 409, invalid: 400, unavailable: 503 };

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

// GET /api/tickets/:id/steps, and the contract item's POST
// /api/contracts/:id/approve and /sendback, with the checks of the
// service's API (api/routes.ts): the app's proof first, then the flow, then
// for a write a user the service knows. A contract item is named by its
// inbox id.
export function stepRoutes(deps: StepRoutesDeps): Route[] {
  const guarded = (write: boolean, run: (engine: FlowEngine, user: UserId, context: RouteContext) => Promise<void>): Route['handle'] => async (context) => {
    try {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const engine = deps.engine(context.registry);
      if (!engine) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
      const user = header(context.request, SERVICE_USER_HEADER) ?? '';
      if (write && (!user || !(await context.registry.users.get(user)))) throw new HttpError(403, 'unknown user');
      await run(engine, user, context);
    } catch (error) {
      if (error instanceof HttpError) answer(context, error.status, { error: error.message });
      else if (error instanceof FlowError) answer(context, STATUS[error.kind], { error: error.message });
      else throw error;
    }
  };
  const id = (context: RouteContext): string => context.params.id as string;
  return [
    {
      method: 'GET', path: '/api/tickets/:id/steps',
      handle: guarded(false, async (engine, _user, context) => {
        const steps = await engine.ticketSteps(id(context));
        if (!steps) throw new HttpError(404, `unknown ticket ${id(context)}`);
        answer(context, 200, steps);
      }),
    },
    {
      method: 'POST', path: '/api/contracts/:id/approve',
      handle: guarded(true, async (engine, user, context) => {
        await engine.approveContract(id(context), user);
        answer(context, 200, { accepted: true });
      }),
    },
    {
      method: 'POST', path: '/api/contracts/:id/sendback',
      handle: guarded(true, async (engine, user, context) => {
        const message = (await readBody(context.request)).message;
        if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_SEND_BACK) throw new HttpError(400, `message must be a non-empty text of at most ${MAX_SEND_BACK} characters`);
        await engine.sendBackContract(id(context), message, user);
        answer(context, 200, { accepted: true });
      }),
    },
  ];
}
