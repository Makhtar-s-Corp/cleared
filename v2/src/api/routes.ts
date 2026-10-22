// The service's HTTP and server-sent events routes (docs/v2/milestone-1-plan.md,
// lane 7), the handlers of the shapes in types.ts. The approval route
// (POST /api/tickets/:id/approve) is lane 8's and is not declared here, nor
// is a session's preview (GET /api/sessions/:id/preview/*), lane 15's.
//
// Every request is checked for the proof first (SERVICE_PROOF_HEADER): only
// the app holds it, a session's container does not. A request that writes
// also names a user the service knows (SERVICE_USER_HEADER), because every
// message, answer and move is attached to a person.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sameProof } from '../modules/users.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { workspaceOf } from '../flow/config.ts';
import { FlowError, type FlowEngine } from '../flow/engine.ts';
import type { Decision, UserId } from '../session/contract.ts';
import { TicketError } from '../tickets/contract.ts';
import { publicWorkspace } from '../workspace/config.ts';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, sseFrame, type CreateTicketBody } from './types.ts';

export type ApiDeps = {
  // The engine, or undefined when the service is not set up to run tickets.
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly proof: () => string;
};

const MAX_BODY = 64 * 1024;
const KEEPALIVE_MS = 15_000;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  response.end(text);
}

const STATUS: Record<FlowError['kind'], number> = { not_found: 404, conflict: 409, invalid: 400, unavailable: 503 };

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

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

function text(value: unknown, what: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && value.trim() === '') || value.length > max) throw new HttpError(400, `${what} must be a${required ? ' non-empty' : ''} text of at most ${max} characters`);
  return value;
}

function decision(value: unknown): Decision {
  const d = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  switch (d.kind) {
    case 'allow_once': return { kind: 'allow_once' };
    case 'allow_always':
      if (d.scope !== 'project') throw new HttpError(400, 'allow_always has the scope "project"');
      return { kind: 'allow_always', scope: 'project' };
    case 'reject_once':
      return { kind: 'reject_once', message: text(d.message, 'a rejection\'s message', 2000) as string };
    case 'answer': {
      const answers = d.answers;
      if (typeof answers !== 'object' || answers === null || Array.isArray(answers) || Object.values(answers).some((v) => typeof v !== 'string' || v.length > 2000))
        throw new HttpError(400, 'an answer carries its answers as text by question');
      return { kind: 'answer', answers: answers as Record<string, string> };
    }
    default: throw new HttpError(400, 'the decision is not one a person can give');
  }
}

// The services a new ticket names: each a service of the workspace, once.
function serviceNames(value: unknown, engine: FlowEngine): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) throw new HttpError(400, 'services is a list of service names');
  if (value.length === 0) throw new HttpError(400, 'services names at least one service, or is left out');
  const workspace = workspaceOf(engine.config);
  const known = new Set(workspace.services.map((service) => service.name));
  for (const name of value as string[]) if (!known.has(name)) throw new HttpError(400, `${name.slice(0, 100)} is not a service of workspace ${workspace.id}`);
  if (new Set(value).size !== value.length) throw new HttpError(400, 'services names a service more than once');
  return value as string[];
}

export function createApiRoutes(deps: ApiDeps): Route[] {
  // Checks the proof, then the flow, then (for a write) the user, then runs.
  function guarded(write: boolean, run: (engine: FlowEngine, user: UserId | undefined, context: RouteContext) => void | Promise<void>): Route['handle'] {
    return async (context) => {
      const { request, response } = context;
      try {
        if (!sameProof(header(request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
        const engine = deps.engine(context.registry);
        if (!engine) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
        let user: UserId | undefined;
        if (write) {
          const given = header(request, SERVICE_USER_HEADER);
          if (!given || !(await context.registry.users.get(given))) throw new HttpError(403, 'unknown user');
          user = given;
        }
        await run(engine, user, context);
      } catch (error) {
        if (error instanceof HttpError) send(response, error.status, { error: error.message });
        else if (error instanceof FlowError) send(response, STATUS[error.kind], { error: error.message });
        else if (error instanceof TicketError) send(response, 409, { error: error.message });
        else throw error;
      }
    };
  }

  const accepted = (context: RouteContext) => send(context.response, 200, { accepted: true });
  const param = (context: RouteContext, key: string): string => context.params[key] as string;

  const sessionRoutes: Route[] = [
    { method: 'GET', path: '/api/sessions', handle: guarded(false, (engine, _u, c) => send(c.response, 200, engine.sessions())) },
    {
      method: 'GET', path: '/api/sessions/:id',
      handle: guarded(false, (engine, _u, c) => {
        const detail = engine.sessionDetail(param(c, 'id'));
        if (!detail) throw new HttpError(404, 'unknown session');
        send(c.response, 200, detail);
      }),
    },
    { method: 'GET', path: '/api/sessions/:id/events', handle: guarded(false, streamEvents) },
    {
      method: 'POST', path: '/api/sessions/:id/messages',
      handle: guarded(true, async (engine, user, c) => {
        const body = await readJson(c.request);
        const message = text(body.text, 'text', 20_000) as string;
        await engine.send(param(c, 'id'), message, user as UserId);
        accepted(c);
      }),
    },
    {
      method: 'POST', path: '/api/sessions/:id/requests/:requestId/answer',
      handle: guarded(true, async (engine, user, c) => {
        const body = await readJson(c.request);
        await engine.answer(param(c, 'id'), param(c, 'requestId'), decision(body.decision), user as UserId);
        accepted(c);
      }),
    },
    {
      method: 'POST', path: '/api/sessions/:id/interrupt',
      handle: guarded(true, async (engine, _u, c) => {
        await engine.interrupt(param(c, 'id'));
        accepted(c);
      }),
    },
  ];

  const ticketRoutes: Route[] = [
    { method: 'GET', path: '/api/tickets', handle: guarded(false, async (engine, _u, c) => send(c.response, 200, await engine.registry.ticketStore.list())) },
    {
      method: 'POST', path: '/api/tickets',
      handle: guarded(true, async (engine, user, c) => {
        const body = await readJson(c.request);
        const title = text(body.title, 'title', 200) as string;
        const project = text(body.project, 'project', 100) as string;
        const bodyText = text(body.body, 'body', 20_000, false);
        const labels = body.labels;
        if (labels !== undefined && (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string' || l.length > 100)))
          throw new HttpError(400, 'labels is a list of short texts');
        if (project !== engine.config.project) throw new HttpError(400, `this service runs project ${engine.config.project}, not ${project}`);
        const services = serviceNames(body.services, engine);
        const input: CreateTicketBody = {
          title, project, ...(bodyText === undefined ? {} : { body: bodyText }), ...(labels === undefined ? {} : { labels: labels as string[] }),
          ...(services === undefined ? {} : { services }),
        };
        const ticket = await engine.registry.ticketStore.create(input, { kind: 'human', id: user as UserId });
        void engine.begin(ticket.id, user as UserId);
        send(c.response, 200, ticket);
      }),
    },
    {
      method: 'GET', path: '/api/tickets/:id',
      handle: guarded(false, async (engine, _u, c) => {
        const ticket = await engine.registry.ticketStore.get(param(c, 'id'));
        if (!ticket) throw new HttpError(404, 'unknown ticket');
        send(c.response, 200, ticket);
      }),
    },
    {
      method: 'POST', path: '/api/tickets/:id/move',
      handle: guarded(true, async (engine, user, c) => {
        const body = await readJson(c.request);
        const status = text(body.status, 'status', 100) as string;
        const tickets = engine.registry.ticketStore;
        const id = param(c, 'id');
        if (!(await tickets.get(id))) throw new HttpError(404, 'unknown ticket');
        // Between Todo and the approval the flow owns the ticket's state.
        if (engine.isActive(id)) throw new HttpError(409, `ticket ${id} is being worked on: its state follows its sessions`);
        let moved;
        try { moved = await tickets.move(id, status, { kind: 'human', id: user as UserId }); }
        catch (error) {
          if (error instanceof TicketError) throw new HttpError(409, error.message);
          throw error;
        }
        if (status === tickets.states.todo) void engine.begin(id, user as UserId);
        send(c.response, 200, moved);
      }),
    },
  ];

  const inboxRoutes: Route[] = [
    { method: 'GET', path: '/api/inbox', handle: guarded(false, (engine, _u, c) => send(c.response, 200, engine.inbox.list())) },
  ];

  // The tickets module serves it (modules/tickets.ts).
  const workspaceRoutes: Route[] = [
    { method: 'GET', path: '/api/workspace', handle: guarded(false, (engine, _u, c) => send(c.response, 200, publicWorkspace(workspaceOf(engine.config)))) },
  ];

  return [...sessionRoutes, ...ticketRoutes, ...inboxRoutes, ...workspaceRoutes];

  // The event stream: what is stored after the number given, then what
  // comes. The Last-Event-ID of a reconnect wins over a stale ?after.
  async function streamEvents(engine: FlowEngine, _user: UserId | undefined, c: RouteContext): Promise<void> {
    const id = param(c, 'id');
    if (!engine.hasSession(id)) throw new HttpError(404, 'unknown session');
    const query = new URL(c.request.url ?? '/', 'http://localhost').searchParams.get('after');
    const last = header(c.request, 'last-event-id');
    const raw = last !== undefined && last !== '' ? last : query ?? '0';
    if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, 'after is a sequence number');
    let seq = Number(raw);

    const { response, request } = c;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    response.write(': stream open\n\n');
    const watcher = engine.watch(id);
    let open = true;
    const leave = () => { open = false; watcher.close(); };
    request.on('close', leave);
    response.on('close', leave);
    try {
      while (open) {
        const batch = engine.eventsAfter(id, seq);
        for (const event of batch) {
          seq = event.seq;
          if (!response.write(sseFrame(event)) && open) await new Promise<void>((resolve) => { response.once('drain', resolve); response.once('close', resolve); });
        }
        if (batch.length === 0 && open) {
          await watcher.wait(KEEPALIVE_MS);
          if (open && engine.eventsAfter(id, seq).length === 0) response.write(': keepalive\n\n');
        }
      }
    } finally {
      leave();
      if (!response.writableEnded) response.end();
    }
  }
}
