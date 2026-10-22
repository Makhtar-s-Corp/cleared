// The routes of a question to the code (docs/v2/milestone-2-plan.md,
// decision 28): POST /api/asks, GET /api/asks/:id and POST
// /api/asks/:id/follow, registered by the sessions module. Guarded as the
// lead's are: the app's proof first, then a running reader, then for a
// write a user the service knows.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../api/types.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { UserId } from '../session/contract.ts';
import type { ReaderService } from './service.ts';
import { ReaderError } from './target.ts';

export type ReaderRouteDeps = {
  // The reader, or undefined when the service runs no flow.
  readonly reader: (registry: Registry) => ReaderService | undefined;
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

const STATUS: Record<ReaderError['kind'], number> = { invalid: 400, not_found: 404, conflict: 409 };

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  response.end(text);
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
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

const text = (body: Record<string, unknown>, key: string, optional: boolean): string | undefined => {
  const value = body[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `${key} is a text${optional ? ' or absent' : ''}`);
  return value;
};

export function readerRoutes(deps: ReaderRouteDeps): Route[] {
  function guarded(write: boolean, run: (reader: ReaderService, user: UserId | undefined, context: RouteContext) => Promise<void>): Route['handle'] {
    return async (context) => {
      const { request, response } = context;
      try {
        if (!sameProof(header(request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
        const reader = deps.reader(context.registry);
        if (!reader) throw new HttpError(503, 'questions to the code are not answered: CLEARED_V2_PROJECT is unset, or the flow has no adapter');
        let user: UserId | undefined;
        if (write) {
          const given = header(request, SERVICE_USER_HEADER);
          if (!given || !(await context.registry.users.get(given))) throw new HttpError(403, 'unknown user');
          user = given;
        }
        await run(reader, user, context);
      } catch (error) {
        if (error instanceof HttpError) send(response, error.status, { error: error.message });
        else if (error instanceof ReaderError) send(response, STATUS[error.kind], { error: error.message });
        else throw error;
      }
    };
  }

  return [
    {
      method: 'POST', path: '/api/asks',
      handle: guarded(true, async (reader, user, c) => {
        const body = await readJson(c.request);
        const question = text(body, 'question', false) as string;
        const service = text(body, 'service', true);
        const target = text(body, 'target', true);
        send(c.response, 200, await reader.ask({ question, ...(service === undefined ? {} : { service }), ...(target === undefined ? {} : { target }) }, user as UserId));
      }),
    },
    {
      method: 'GET', path: '/api/asks/:id',
      handle: guarded(false, async (reader, _user, c) => {
        const ask = reader.get(c.params.id ?? '');
        if (!ask) throw new HttpError(404, 'no such ask');
        send(c.response, 200, ask);
      }),
    },
    {
      method: 'POST', path: '/api/asks/:id/follow',
      handle: guarded(true, async (reader, user, c) => {
        const body = await readJson(c.request);
        send(c.response, 200, await reader.follow(c.params.id ?? '', text(body, 'question', false) as string, user as UserId));
      }),
    },
  ];
}
