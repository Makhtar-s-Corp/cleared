// The routes of the recipes (docs/v2/milestone-2-plan.md, decision 29):
// GET /api/recipes and POST /api/recipes/:name/run, registered by the lead
// module with the plan runner. Guarded as the lead's are: the app's proof
// first, then the plans running, then for a write a user the service knows.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../api/types.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import { HostToolRefused, type UserId } from '../session/contract.ts';
import { RecipeError } from './recipe.ts';
import type { Recipes } from './service.ts';

export type RecipeRouteDeps = {
  // The recipes, or undefined while the service runs no plans.
  readonly recipes: (registry: Registry) => Pick<Recipes, 'list' | 'run'> | undefined;
  readonly proof: () => string;
};

const MAX_BODY = 64 * 1024;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATUS: Record<RecipeError['kind'], number> = { invalid: 400, not_found: 404, conflict: 409 };

export function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  response.end(text);
}

export const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'the request body is too large');
    chunks.push(chunk as Buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'the request body is not JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'the request body is not a JSON object');
  return value as Record<string, unknown>;
}

// The proof, the target running, then for a write a known user; `run` gets the target and the user.
export function guard<T>(deps: { readonly target: (registry: Registry) => T | undefined; readonly proof: () => string; readonly down: string },
  write: boolean, run: (target: T, user: UserId | undefined, context: RouteContext) => Promise<void>): Route['handle'] {
  return async (context) => {
    const { request, response } = context;
    try {
      if (!sameProof(header(request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const target = deps.target(context.registry);
      if (!target) throw new HttpError(503, deps.down);
      let user: UserId | undefined;
      if (write) {
        const given = header(request, SERVICE_USER_HEADER);
        if (!given || !(await context.registry.users.get(given))) throw new HttpError(403, 'unknown user');
        user = given;
      }
      await run(target, user, context);
    } catch (error) {
      if (error instanceof HttpError) send(response, error.status, { error: error.message });
      else if (error instanceof RecipeError) send(response, STATUS[error.kind], { error: error.message });
      else throw error;
    }
  };
}

const DOWN = 'the plans are not running: CLEARED_V2_PROJECT is unset, CLEARED_V2_LEAD_ENABLED is off, or the flow has no adapter';

export function recipeRoutes(deps: RecipeRouteDeps): Route[] {
  const guarded = (write: boolean, run: (recipes: Pick<Recipes, 'list' | 'run'>, user: UserId | undefined, context: RouteContext) => Promise<void>) =>
    guard({ target: deps.recipes, proof: deps.proof, down: DOWN }, write, run);
  return [
    { method: 'GET', path: '/api/recipes', handle: guarded(false, async (recipes, _user, c) => send(c.response, 200, await recipes.list())) },
    {
      method: 'POST', path: '/api/recipes/:name/run',
      handle: guarded(true, async (recipes, user, c) => {
        const body = await readJson(c.request);
        const parameters = body.parameters ?? {};
        if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters) || Object.values(parameters).some((v) => typeof v !== 'string'))
          throw new HttpError(400, 'parameters are names and their texts');
        try {
          const run = await recipes.run(c.params.name ?? '', parameters as Record<string, string>, user as UserId);
          send(c.response, 200, { accepted: true, ...(run.plan ? { plan: run.plan } : {}), ...(run.message !== undefined ? { message: run.message } : {}) });
        } catch (error) {
          // The plan runner's own refusal of the item (a validation the recipe passed through).
          if (error instanceof HostToolRefused) throw new HttpError(400, error.message);
          throw error;
        }
      }),
    },
  ];
}
