// POST /api/tickets/:id/approve and its Undo. The service accepts a user id
// only from a request that shows the app's proof (src/modules/users.ts), and
// signs only for the owner: a session, which has neither the proof nor the key,
// can at most send a request that is refused before anything is signed.
//
// A ticket of a workspace of several services is approved as a train
// (docs/v2/milestone-2-plan.md, decision 21, lane 16): a card blocked by the
// compatibility check answers 409 with the proposal; otherwise every
// service's record must still hold the head the card showed, and the grace
// is held by TrainApprovals (approval/service.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type ApproveBody } from '../api/types.ts';
import type { Route, RouteContext } from '../modules/registry.ts';
import { ApprovalError, type ApprovalCode } from './errors.ts';
import { TrainBlocked, type TrainApprovals } from './service.ts';
import { isGraceWriter, type GraceApprovalWriter } from './writer.ts';
import type { Version } from './record.ts';

const MAX_BODY = 64 * 1024;

const STATUS: Record<ApprovalCode, number> = { setup: 503, user: 403, owner: 403, ticket: 404, state: 409, version: 409, pending: 409 };

function send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store', ...headers });
  response.end(text);
}

class TooLarge extends Error {}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new TooLarge();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

function heads(value: unknown): Version[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) return undefined;
  const out: Version[] = [];
  for (const item of value as { pr?: unknown; head?: unknown }[]) {
    if (typeof item?.pr !== 'number' || !Number.isSafeInteger(item.pr) || item.pr <= 0 || typeof item.head !== 'string' || !/^[0-9a-f]{40}$/.test(item.head)) return undefined;
    out.push({ pr: item.pr, head: item.head });
  }
  return out;
}

// The refusals every approval route makes before it reads the body.
function authorise(context: RouteContext): { writer: GraceApprovalWriter; user: string } | undefined {
  const { request, response, registry } = context;
  const writer = registry.approvalWriter;
  if (!isGraceWriter(writer)) { send(response, 503, { error: 'approval is not set up on this service' }); return undefined; }
  if (!writer.verifyProof(header(request, SERVICE_PROOF_HEADER))) { send(response, 401, { error: 'unauthorized' }); return undefined; }
  const user = header(request, SERVICE_USER_HEADER);
  if (!user) { send(response, 400, { error: 'a user id is required' }); return undefined; }
  return { writer, user };
}

function refuse(response: ServerResponse, error: unknown): void {
  if (error instanceof TrainBlocked) return send(response, 409, { error: error.message, proposal: error.proposal });
  if (error instanceof ApprovalError) return send(response, STATUS[error.code], { error: error.message });
  throw error;
}

// The train approvals of the workspace, when it has several services.
export type TrainGate = () => TrainApprovals | undefined;

const approve = (trains: TrainGate): Route => ({
  method: 'POST',
  path: '/api/tickets/:id/approve',
  async handle(context) {
    const { request, response, params } = context;
    const auth = authorise(context);
    if (!auth) return;
    let body: Partial<ApproveBody> | undefined;
    try {
      const parsed = await readJson(request);
      body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Partial<ApproveBody> : undefined;
    } catch (error) {
      // A body that is too large is not read to its end: the connection is closed after the answer.
      if (error instanceof TooLarge) return send(response, 413, { error: 'the request is too large' }, { connection: 'close' });
      return send(response, 400, { error: 'the body is not JSON' });
    }
    const shown = heads(body?.heads);
    if (!body || typeof body.requestedAt !== 'string' || !shown) return send(response, 400, { error: 'requestedAt and one to eight heads (a pull request and its 40 hex head) are required' });
    const ticket = params.id as string;
    const train = trains();
    try {
      const request = { ticket, by: auth.user, requestedAt: body.requestedAt, heads: shown };
      const { dueAt } = train?.waiting(ticket) ? await train.begin(request) : await auth.writer.begin(request);
      send(response, 202, { accepted: true, by: auth.user, dueAt });
    } catch (error) {
      refuse(response, error);
    }
  },
});

const undo = (trains: TrainGate): Route => ({
  method: 'POST',
  path: '/api/tickets/:id/approve/undo',
  async handle(context) {
    const auth = authorise(context);
    if (!auth) return;
    const ticket = context.params.id as string;
    const train = trains();
    try {
      const { undone } = train?.waiting(ticket) ? await train.undo(ticket, auth.user) : await auth.writer.undo(ticket, auth.user);
      if (undone) send(context.response, 200, { undone: true });
      else send(context.response, 409, { error: 'nothing is held for this ticket: it was written already, or never started' });
    } catch (error) {
      refuse(context.response, error);
    }
  },
});

export function createApprovalRoutes(trains: TrainGate): readonly Route[] {
  return [approve(trains), undo(trains)];
}

export const approvalRoutes: readonly Route[] = createApprovalRoutes(() => undefined);
