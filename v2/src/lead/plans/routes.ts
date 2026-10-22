// The plan routes (docs/v2/milestone-2-plan.md, section 7.1): the plans,
// one plan, and the owner's four gestures on a plan. Guarded as the lead's
// routes are: the app's proof first, then a running lead, then for a write
// a user the service knows. Approving is one gesture of the signed-in
// owner, with no signature and no grace: starting a ticket is reversible
// (decision 6).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../api/types.ts';
import type { Registry, Route, RouteContext } from '../../modules/registry.ts';
import { sameProof } from '../../modules/users.ts';
import type { UserId } from '../../session/contract.ts';
import { PlanError, type PlanRunner } from './runner.ts';

export type PlanRouteDeps = {
  // The plans, or undefined when the service runs no lead.
  readonly plans: (registry: Registry) => PlanRunner | undefined;
  readonly proof: () => string;
};

const MAX_BODY = 64 * 1024;
const MAX_MESSAGE = 2000;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATUS: Record<PlanError['kind'], number> = { not_found: 404, conflict: 409, invalid: 400 };

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  response.end(text);
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

// The JSON object of the body, or an empty one when there is no body.
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
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
  try { value = JSON.parse(raw); }
  catch { throw new HttpError(400, 'the request body is not JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'the request body is not a JSON object');
  return value as Record<string, unknown>;
}

export function createPlanRoutes(deps: PlanRouteDeps): Route[] {
  function guarded(write: boolean, run: (plans: PlanRunner, user: UserId | undefined, context: RouteContext) => void | Promise<void>): Route['handle'] {
    return async (context) => {
      const { request, response } = context;
      try {
        if (!sameProof(header(request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
        const plans = deps.plans(context.registry);
        if (!plans) throw new HttpError(503, 'the lead is not running: CLEARED_V2_PROJECT is unset, CLEARED_V2_LEAD_ENABLED is off, or the flow has no adapter');
        let user: UserId | undefined;
        if (write) {
          const given = header(request, SERVICE_USER_HEADER);
          if (!given || !(await context.registry.users.get(given))) throw new HttpError(403, 'unknown user');
          user = given;
        }
        await run(plans, user, context);
      } catch (error) {
        if (error instanceof HttpError) send(response, error.status, { error: error.message });
        else if (error instanceof PlanError) send(response, STATUS[error.kind], { error: error.message });
        else throw error;
      }
    };
  }

  const id = (c: RouteContext) => c.params.id ?? '';
  const gesture = (act: (plans: PlanRunner, id: string, user: UserId) => Promise<unknown>): Route['handle'] =>
    guarded(true, async (plans, user, c) => send(c.response, 200, await act(plans, id(c), user as UserId)));

  return [
    { method: 'GET', path: '/api/plans', handle: guarded(false, (plans, _u, c) => send(c.response, 200, plans.list())) },
    { method: 'GET', path: '/api/plans/:id', handle: guarded(false, (plans, _u, c) => send(c.response, 200, plans.plan(id(c)))) },
    { method: 'POST', path: '/api/plans/:id/approve', handle: gesture((plans, plan, user) => plans.approve(plan, user)) },
    {
      method: 'POST', path: '/api/plans/:id/reject',
      handle: guarded(true, async (plans, user, c) => {
        const body = await readJson(c.request);
        const message = body.message ?? '';
        if (typeof message !== 'string' || message.length > MAX_MESSAGE) throw new HttpError(400, `message is a text of at most ${MAX_MESSAGE} characters`);
        send(c.response, 200, await plans.reject(id(c), user as UserId, message));
      }),
    },
    { method: 'POST', path: '/api/plans/:id/pause', handle: gesture((plans, plan, user) => plans.pause(plan, user)) },
    { method: 'POST', path: '/api/plans/:id/resume', handle: gesture((plans, plan, user) => plans.resume(plan, user)) },
  ];
}
