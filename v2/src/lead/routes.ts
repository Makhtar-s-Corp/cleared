// The lead's routes (docs/v2/milestone-2-plan.md, section 7.1): its state,
// the owner's thread and its stream, an owner's message or goal (which
// answers the lead's pending question when one waits, decision 8), and what
// the lead remembers. Guarded as milestone 1's routes are: the app's proof
// first, then a configured lead, then for a write a user the service knows.
// The plan routes are lane 7's.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { leadFrame, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type LeadStreamFrame } from '../api/types.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { UserId } from '../session/contract.ts';
import { LeadError, type LeadEngine } from './engine.ts';

export type LeadRouteDeps = {
  // The lead, or undefined when the service runs no lead.
  readonly lead: (registry: Registry) => LeadEngine | undefined;
  readonly proof: () => string;
};

const MAX_BODY = 64 * 1024;
const MAX_TEXT = 20_000;
const KEEPALIVE_MS = 15_000;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATUS: Record<LeadError['kind'], number> = { not_found: 404, conflict: 409, invalid: 400 };

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

// A sequence number from `?after=`, or from Last-Event-ID, which wins.
function afterOf(request: IncomingMessage, stream: boolean): number {
  const query = new URL(request.url ?? '/', 'http://localhost').searchParams.get('after');
  const last = stream ? header(request, 'last-event-id') : undefined;
  const raw = last !== undefined && last !== '' ? last : query ?? '0';
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, 'after is a sequence number');
  return Number(raw);
}

export function createLeadRoutes(deps: LeadRouteDeps): Route[] {
  function guarded(write: boolean, run: (lead: LeadEngine, user: UserId | undefined, context: RouteContext) => void | Promise<void>): Route['handle'] {
    return async (context) => {
      const { request, response } = context;
      try {
        if (!sameProof(header(request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
        const lead = deps.lead(context.registry);
        if (!lead) throw new HttpError(503, 'the lead is not running: see CLEARED_V2_PROJECT and CLEARED_V2_LEAD_ENABLED in v2/README.md');
        let user: UserId | undefined;
        if (write) {
          const given = header(request, SERVICE_USER_HEADER);
          if (!given || !(await context.registry.users.get(given))) throw new HttpError(403, 'unknown user');
          user = given;
        }
        await run(lead, user, context);
      } catch (error) {
        if (error instanceof HttpError) send(response, error.status, { error: error.message });
        else if (error instanceof LeadError) send(response, STATUS[error.kind], { error: error.message });
        else throw error;
      }
    };
  }

  return [
    { method: 'GET', path: '/api/lead', handle: guarded(false, (lead, _u, c) => send(c.response, 200, lead.state())) },
    { method: 'GET', path: '/api/lead/messages', handle: guarded(false, (lead, _u, c) => send(c.response, 200, lead.messages(afterOf(c.request, false)))) },
    {
      method: 'POST', path: '/api/lead/messages',
      handle: guarded(true, async (lead, user, c) => {
        const body = await readJson(c.request);
        const text = body.text;
        if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT) throw new HttpError(400, `text must be a non-empty text of at most ${MAX_TEXT} characters`);
        if (body.goal !== undefined && body.goal !== true) throw new HttpError(400, 'goal is true or absent');
        send(c.response, 200, await lead.post(text, user as UserId, body.goal === true));
      }),
    },
    { method: 'GET', path: '/api/lead/memory', handle: guarded(false, (lead, _u, c) => send(c.response, 200, lead.memory())) },
    { method: 'GET', path: '/api/lead/stream', handle: guarded(false, stream) },
  ];

  // The thread after the seq given, the state, then what comes. The
  // listener is set before the thread is read, so nothing written in
  // between is missed; a message already sent is not sent twice.
  async function stream(lead: LeadEngine, _user: UserId | undefined, c: RouteContext): Promise<void> {
    let seq = afterOf(c.request, true);
    const { request, response } = c;
    const frames: LeadStreamFrame[] = [];
    let wake = () => {};
    const stop = lead.watch((frame) => { frames.push(frame); wake(); });
    let open = true;
    const leave = () => { open = false; stop(); wake(); };
    request.on('close', leave);
    response.on('close', leave);
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    response.write(': stream open\n\n');
    const write = async (frame: LeadStreamFrame) => {
      if (frame.kind === 'message') {
        if (frame.message.seq <= seq) return;
        seq = frame.message.seq;
      }
      if (!response.write(leadFrame(frame)) && open) await new Promise<void>((resolve) => { response.once('drain', resolve); response.once('close', resolve); });
    };
    try {
      for (const message of lead.messages(seq)) await write({ kind: 'message', message });
      await write({ kind: 'state', state: lead.state() });
      while (open) {
        while (frames.length > 0 && open) await write(frames.shift() as LeadStreamFrame);
        if (!open) break;
        const timedOut = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), KEEPALIVE_MS);
          wake = () => { clearTimeout(timer); resolve(false); };
          if (frames.length > 0 || !open) wake();
        });
        if (timedOut && open) response.write(': keepalive\n\n');
      }
    } finally {
      leave();
      if (!response.writableEnded) response.end();
    }
  }
}
