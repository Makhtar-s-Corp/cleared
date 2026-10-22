// The web terminal's routes (docs/v2/milestone-2-plan.md, decision 32, lane
// 31), registered by the flow module:
//
//   POST /api/sessions/:id/terminal/open    { cols, rows, mode? } -> TerminalOpened
//        mode: 'harness' (the default: the session's own harness, resumed on
//        the session through its adapter; 501 with why when the adapter
//        cannot) or 'shell' (owner request of 2026-10-22 17:26)
//   POST /api/sessions/:id/terminal/input   { data }, at most TERMINAL_INPUT_MAX_BYTES
//   POST /api/sessions/:id/terminal/resize  { cols, rows }
//   POST /api/sessions/:id/terminal/close
//   GET  /api/sessions/:id/terminal/stream  server-sent events: `data`
//        (a TerminalChunk, its seq as the id), then one `closed`
//        (TerminalClosed); Last-Event-ID or ?after= gives what was missed.
//
// The checks, in this order: the app's proof (401); the flow (503); a user
// the service knows, and never the flow's own identity nor the lead's (403);
// the session (404); a session taken over (409); by this user (403); then
// one terminal at a time (409, with the mode of the one open). The app answers these routes only on its
// loopback address, with its anti-forgery checks (app/src/server.ts); no
// host tool of the lead or of an author names them.
import type { IncomingMessage } from 'node:http';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, TERMINAL_INPUT_MAX_BYTES, TERMINAL_MODES, type TerminalChunk, type TerminalClosed, type TerminalMode } from '../api/types.ts';
import type { FlowEngine } from '../flow/engine.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { SessionId, UserId } from '../session/contract.ts';
import type { HumanSide } from './human.ts';
import { TerminalError } from './terminals.ts';

// The identities that never get a terminal: the flow's own and the lead's.
export const NOT_HUMAN: ReadonlySet<string> = new Set(['cleared', 'lead']);
const MAX_BODY = 64 * 1024;
const KEEPALIVE_MS = 15_000;

export type TerminalRouteDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly human: (registry: Registry) => HumanSide | undefined;
  readonly proof: () => string;
};

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export function answer(context: RouteContext, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  context.response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  context.response.end(text);
}

export async function readBody(request: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'the request body is too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new HttpError(400, 'the request body is not JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'the request body is not a JSON object');
  return value as Record<string, unknown>;
}

// The proof, then a known user who is a person: what every human route of
// a session's checkout asks first (the terminal, the editor's save).
export async function humanUser(context: RouteContext, proof: string): Promise<UserId> {
  if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), proof)) throw new HttpError(401, 'unauthorized');
  const user = header(context.request, SERVICE_USER_HEADER);
  if (user !== undefined && NOT_HUMAN.has(user)) throw new HttpError(403, `${user} is not a person: the terminal and the editor are a signed-in human's`);
  if (!user || !(await context.registry.users.get(user))) throw new HttpError(403, 'unknown user');
  return user;
}

const size = (body: Record<string, unknown>) => ({ cols: body.cols as number, rows: body.rows as number });
const modeOf = (body: Record<string, unknown>): TerminalMode => {
  if (body.mode === undefined) return 'harness';
  if (!TERMINAL_MODES.includes(body.mode as TerminalMode)) throw new HttpError(400, `mode is ${TERMINAL_MODES.join(' or ')}`);
  return body.mode as TerminalMode;
};

export function terminalRoutes(deps: TerminalRouteDeps): Route[] {
  const route = (run: (human: HumanSide, user: UserId, id: SessionId, context: RouteContext) => Promise<void>): Route['handle'] => async (context) => {
    try {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const engine = deps.engine(context.registry);
      const human = deps.human(context.registry);
      if (!engine || !human) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
      const user = await humanUser(context, deps.proof());
      const id = context.params.id as string;
      if (!engine.sessionDetail(id)) throw new HttpError(404, 'no such session');
      const taken = engine.takenOver(id);
      if (!taken) throw new HttpError(409, 'the session is not taken over: take it over first');
      if (taken.by !== user) throw new HttpError(403, 'the terminal is for the account that took the session over');
      await run(human, user, id, context);
    } catch (error) {
      if (context.response.headersSent) { context.response.end(); return; }
      if (error instanceof HttpError) answer(context, error.status, { error: error.message });
      else if (error instanceof TerminalError) {
        const status = error.kind === 'conflict' ? 409 : error.kind === 'unsupported' ? 501 : 400;
        answer(context, status, { error: error.message, ...(error.mode ? { mode: error.mode } : {}) });
      }
      else throw error;
    }
  };

  return [
    {
      method: 'POST', path: '/api/sessions/:id/terminal/open',
      handle: route(async (human, user, id, context) => {
        const body = await readBody(context.request);
        answer(context, 200, await human.openTerminal(id, user, size(body), modeOf(body)));
      }),
    },
    {
      method: 'POST', path: '/api/sessions/:id/terminal/input',
      handle: route(async (human, _user, id, context) => {
        const data = (await readBody(context.request)).data;
        if (typeof data !== 'string') throw new HttpError(400, 'data is the text typed');
        if (Buffer.byteLength(data) > TERMINAL_INPUT_MAX_BYTES) throw new HttpError(413, `at most ${TERMINAL_INPUT_MAX_BYTES} bytes per post`);
        human.terminals.input(id, data);
        answer(context, 200, { accepted: true });
      }),
    },
    {
      method: 'POST', path: '/api/sessions/:id/terminal/resize',
      handle: route(async (human, _user, id, context) => {
        await human.terminals.resize(id, size(await readBody(context.request)));
        answer(context, 200, { accepted: true });
      }),
    },
    {
      method: 'POST', path: '/api/sessions/:id/terminal/close',
      handle: route(async (human, user, id, context) => {
        if (human.terminals.openBy(id) === undefined) throw new HttpError(409, 'no terminal is open for this session');
        await human.terminals.close(id, user, 'closed');
        answer(context, 200, { accepted: true });
      }),
    },
    {
      method: 'GET', path: '/api/sessions/:id/terminal/stream',
      handle: route(async (human, _user, id, context) => {
        const url = new URL(context.request.url ?? '/', 'http://service');
        const after = Number(header(context.request, 'last-event-id') ?? url.searchParams.get('after') ?? 0);
        const { response } = context;
        let leave = () => {};
        const ended = new Promise<void>((resolve) => { leave = resolve; });
        const frames: string[] = [];
        const write = (frame: string) => { if (!response.writableEnded) response.write(frame); };
        const unsubscribe = human.terminals.stream(id, Number.isFinite(after) ? after : 0, (event) => {
          if (event.kind === 'data') {
            const frame = `id: ${event.chunk.seq}\nevent: data\ndata: ${JSON.stringify(event.chunk satisfies TerminalChunk)}\n\n`;
            if (response.headersSent) write(frame); else frames.push(frame);
          } else {
            write(`event: closed\ndata: ${JSON.stringify(event.closed satisfies TerminalClosed)}\n\n`);
            leave();
          }
        });
        if (!unsubscribe) throw new HttpError(409, 'no terminal is open for this session');
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        for (const frame of frames.splice(0)) write(frame);
        const keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS);
        context.request.on('close', leave);
        try {
          await ended;
        } finally {
          clearInterval(keepalive);
          unsubscribe();
          response.end();
        }
      }),
    },
  ];
}
