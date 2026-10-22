// The knowledge routes (decision 27, lane 24): Approve and Reject of a
// knowledge item, named by its inbox id, and "Update the skill now" for a
// service, which the tower's lead card calls. Each has the checks of every
// write of the service's API (api/routes.ts): the app's proof first, then the
// knowledge being set up, then a user the service knows; the owner check is
// the knowledge's own (service.ts).
import type { IncomingMessage } from 'node:http';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../api/types.ts';
import type { Registry, Route, RouteContext, User } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { UserId } from '../session/contract.ts';
import type { TicketId } from '../tickets/contract.ts';
import { KnowledgeError, type Knowledge } from './service.ts';

export type KnowledgeRouteDeps = {
  readonly knowledge: () => Knowledge | undefined;
  readonly proof: () => string;
  // Starts the skill ticket the owner asked for (the flow's start, as a person's).
  readonly start: (registry: Registry, ticket: TicketId, by: UserId) => Promise<void>;
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATUS: Record<KnowledgeError['kind'], number> = { not_found: 404, conflict: 409, forbidden: 403, unavailable: 503 };

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function answer(context: RouteContext, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  context.response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  context.response.end(text);
}

export function knowledgeRoutes(deps: KnowledgeRouteDeps): Route[] {
  const write = (run: (knowledge: Knowledge, user: User, context: RouteContext) => Promise<void>): Route['handle'] => async (context) => {
    try {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const knowledge = deps.knowledge();
      if (!knowledge) throw new HttpError(503, 'the workspace is not configured: see CLEARED_V2_PROJECT in v2/README.md');
      const id = header(context.request, SERVICE_USER_HEADER);
      const user = id ? await context.registry.users.get(id) : undefined;
      if (!user) throw new HttpError(403, 'unknown user');
      await run(knowledge, user, context);
    } catch (error) {
      if (error instanceof HttpError) answer(context, error.status, { error: error.message });
      else if (error instanceof KnowledgeError) answer(context, STATUS[error.kind], { error: error.message });
      else throw error;
    }
  };
  const item = (context: RouteContext): string => context.params.id as string;
  return [
    {
      method: 'POST', path: '/api/knowledge/:id/approve',
      handle: write(async (knowledge, user, context) => {
        await knowledge.approve(item(context), user);
        answer(context, 200, { accepted: true });
      }),
    },
    {
      method: 'POST', path: '/api/knowledge/:id/reject',
      handle: write(async (knowledge, user, context) => {
        await knowledge.reject(item(context), user);
        answer(context, 200, { accepted: true });
      }),
    },
    {
      method: 'POST', path: '/api/services/:name/skill',
      handle: write(async (knowledge, user, context) => {
        const ticket = await knowledge.updateSkill(context.params.name as string, user);
        // The ticket exists whatever its start says: it waits in Todo when the flow cannot start it.
        if (ticket) await deps.start(context.registry, ticket, user.id).catch((error) => console.error(`cleared-v2: the skill ticket ${ticket} could not be started (${error instanceof Error ? error.name : typeof error})`));
        answer(context, 200, { accepted: true, ticket });
      }),
    },
  ];
}
