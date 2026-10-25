// The run module's routes (docs/v2/milestone-5-plan.md, section 8, C18;
// the shapes in run/types.ts).
//
// POST /api/run and GET /api/run/:id take a person's API token as
// `authorization: Bearer <value>`, and nothing else: no proof is read, so a
// call from the app does not reach them, and no other route of the service
// reads that header, so a token reaches nothing else (test/run/rights.test.ts).
// A token that is not a live one is 401 with `www-authenticate: Bearer`; a
// live one whose person is gone is 403.
//
// GET and POST /api/tokens and POST /api/tokens/:id/revoke are the app's:
// the proof first, then a person the service knows, who sees, makes and
// revokes their own tokens only. A token is never one of these credentials.
import type { IncomingMessage } from 'node:http';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../api/types.ts';
import { BatchError } from '../flow/batch.ts';
import type { Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { UserId } from '../session/contract.ts';
import { TicketError } from '../tickets/contract.ts';
import { RunError, type RunLauncher } from './runs.ts';
import { AccessError, type ApiTokens } from './tokens.ts';
import { ACCESS_PATH, RUN_PATH } from './types.ts';

export type RunRoutesDeps = {
  readonly tokens: () => ApiTokens | undefined;                         // undefined: no ledger yet
  readonly launcher: (registry: RouteContext['registry']) => RunLauncher | undefined;   // undefined: the flow is not configured
  readonly proof: () => string;
};

const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function answer(context: RouteContext, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  context.response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store', ...headers });
  context.response.end(text);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'the request body is too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'the request body is not JSON'); }
}

export function runRoutes(deps: RunRoutesDeps): Route[] {
  const store = (): ApiTokens => {
    const tokens = deps.tokens();
    if (!tokens) throw new HttpError(503, 'the run module has no ledger');
    return tokens;
  };

  const answered = (run: (context: RouteContext) => Promise<void>): Route['handle'] => async (context) => {
    try {
      await run(context);
    } catch (error) {
      if (error instanceof HttpError) answer(context, error.status, { error: error.message }, error.status === 401 ? { 'www-authenticate': 'Bearer' } : {});
      else if (error instanceof RunError) answer(context, error.kind === 'not_found' ? 404 : 400, { error: error.message });
      else if (error instanceof AccessError) answer(context, 400, { error: error.message });
      else if (error instanceof BatchError) answer(context, error.kind === 'not_found' ? 404 : 400, { error: error.message });
      else if (error instanceof TicketError) answer(context, 409, { error: error.message });
      else throw error;
    }
  };

  // The token's person, for the two run routes; the token is the only credential read.
  async function bearer(context: RouteContext): Promise<{ readonly user: UserId; readonly via: string }> {
    const given = /^Bearer ([^\s]+)$/.exec(header(context.request, 'authorization') ?? '')?.[1];
    const found = given === undefined ? undefined : store().verify(given);
    if (!found) throw new HttpError(401, 'unauthorized');
    if (!(await context.registry.users.get(found.user))) throw new HttpError(403, 'the token\'s person is not a person of this service');
    return { user: found.user, via: found.id };
  }

  // The person the app names, for the token routes: the proof first, as every route of the app's.
  async function person(context: RouteContext): Promise<UserId> {
    if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
    const user = header(context.request, SERVICE_USER_HEADER);
    if (!user || !(await context.registry.users.get(user))) throw new HttpError(403, 'unknown user');
    return user;
  }

  const launcher = (context: RouteContext): RunLauncher => {
    const made = deps.launcher(context.registry);
    if (!made) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
    return made;
  };

  return [
    {
      method: 'POST', path: RUN_PATH,
      handle: answered(async (context) => {
        const { user, via } = await bearer(context);
        const runs = launcher(context);
        answer(context, 200, await runs.launch(await readBody(context.request), user, via));
      }),
    },
    {
      method: 'GET', path: `${RUN_PATH}/:id`,
      handle: answered(async (context) => {
        await bearer(context);
        const run = await launcher(context).get(context.params.id as string);
        if (!run) throw new RunError('not_found', 'no run of that ticket');
        answer(context, 200, run);
      }),
    },
    {
      method: 'GET', path: ACCESS_PATH,
      handle: answered(async (context) => answer(context, 200, store().list(await person(context)))),
    },
    {
      method: 'POST', path: ACCESS_PATH,
      handle: answered(async (context) => {
        const user = await person(context);
        const body = await readBody(context.request);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'the request body is not a JSON object');
        const { name, ...rest } = body as Record<string, unknown>;
        if (Object.keys(rest).length > 0) throw new HttpError(400, `a token has a name, not ${Object.keys(rest).join(', ')}`);
        if (typeof name !== 'string') throw new HttpError(400, 'a token has a name');
        answer(context, 200, store().make(user, name));
      }),
    },
    {
      method: 'POST', path: `${ACCESS_PATH}/:id/revoke`,
      handle: answered(async (context) => {
        const user = await person(context);
        if (!store().revoke(user, context.params.id as string)) throw new HttpError(404, 'no token of yours has that id');
        answer(context, 200, { revoked: true });
      }),
    },
  ];
}
