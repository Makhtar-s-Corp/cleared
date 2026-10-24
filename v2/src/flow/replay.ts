// Resume from here (issue #272, Devin's "Redo from here"): a step of an
// author's thread, a row of its worklog, starts the ticket again from the
// commit the step began from, with the owner's corrected instruction.
//
//   - The flow journals the tip of the author's branch as
//     `cleared.checkpoint`: once when the session starts, read before it
//     does, then after each tool call and at the end of each turn, when it
//     moved. A step begins from the last checkpoint journaled before its
//     first event, or from the session's first when none is.
//   - POST /api/sessions/:id/replay {seq, message}: the ticket's sessions
//     stop, what of it waits in the inbox is settled, and a new author
//     starts on a new branch, cleared/<ticket>.r<n>, made at that commit in
//     a new checkout. The old checkout is kept aside and its branch is kept
//     as it was, in the checkout and in the service's own (no git command
//     rewrites a branch, nothing is pushed, nothing is forced). Each
//     session gets a `cleared.replay` event, so the thread says where the
//     ticket went on, and the old continuation stays readable.
//   - The ticket's later sessions and its publish use the newest resume
//     branch, kept in ticket_replays across a restart.
//
// In this version a ticket of a workspace of several services is not
// resumed from a step, and Resume from here is the owner account's, as
// Take over is (flow/takeover.ts). This file holds the table, the rule of a
// step's commit, the prompt and the route; the engine does the work.
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../api/types.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { SessionId, UserId } from '../session/contract.ts';
import type { CustomValue, SessionEvent } from '../session/events.ts';
import type { TicketId } from '../tickets/contract.ts';
import { FlowError, type FlowEngine } from './engine.ts';
import { ownerOf } from './takeover.ts';

export const REPLAYS_TABLE = `CREATE TABLE IF NOT EXISTS ticket_replays (
  ticket TEXT NOT NULL, n INTEGER NOT NULL, project TEXT NOT NULL, session TEXT NOT NULL, seq INTEGER NOT NULL, commit_id TEXT NOT NULL,
  branch TEXT NOT NULL, previous TEXT NOT NULL, previous_head TEXT NOT NULL, aside TEXT NOT NULL, resumed TEXT, message TEXT NOT NULL,
  by TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (ticket, n)
)`;

// The longest corrected instruction, as a Send back's.
export const MAX_REPLAY = 2000;

export type Checkpoint = CustomValue['cleared.checkpoint'];

// A resume as the table keeps it: the session and the step it started
// from, the commit, the new branch, the branch left (`previous`, at
// `previousHead`, its checkout kept in `aside`), the new author once it
// started, who asked and the instruction.
export type Replay = {
  readonly ticket: TicketId; readonly n: number; readonly project: string; readonly session: SessionId; readonly seq: number;
  readonly commit: string; readonly branch: string; readonly previous: string; readonly previousHead: string; readonly aside: string;
  readonly resumed: SessionId | null; readonly message: string; readonly by: UserId; readonly at: string;
};

type Row = Record<string, unknown>;

export class ReplayStore {
  #db: DatabaseSync;
  #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(REPLAYS_TABLE);
  }

  #replay(row: Row): Replay {
    return {
      ticket: String(row.ticket), n: Number(row.n), project: String(row.project), session: String(row.session), seq: Number(row.seq),
      commit: String(row.commit_id), branch: String(row.branch), previous: String(row.previous), previousHead: String(row.previous_head),
      aside: String(row.aside), resumed: row.resumed === null ? null : String(row.resumed), message: String(row.message), by: String(row.by), at: String(row.at),
    };
  }

  // The ticket's resumes, oldest first.
  list(ticket: TicketId): Replay[] {
    return (this.#db.prepare('SELECT * FROM ticket_replays WHERE ticket = ? ORDER BY n').all(ticket) as Row[]).map((row) => this.#replay(row));
  }

  latest(ticket: TicketId): Replay | undefined {
    const row = this.#db.prepare('SELECT * FROM ticket_replays WHERE ticket = ? ORDER BY n DESC LIMIT 1').get(ticket) as Row | undefined;
    return row ? this.#replay(row) : undefined;
  }

  add(replay: Omit<Replay, 'resumed' | 'at'>): Replay {
    this.#db.prepare('INSERT INTO ticket_replays (ticket, n, project, session, seq, commit_id, branch, previous, previous_head, aside, message, by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      replay.ticket, replay.n, replay.project, replay.session, replay.seq, replay.commit, replay.branch, replay.previous, replay.previousHead, replay.aside,
      replay.message, replay.by, this.#now().toISOString(),
    );
    return this.latest(replay.ticket) as Replay;
  }

  resumed(ticket: TicketId, n: number, session: SessionId): void {
    this.#db.prepare('UPDATE ticket_replays SET resumed = ? WHERE ticket = ? AND n = ?').run(session, ticket, n);
  }
}

// The commit a step of the session began from: the last checkpoint
// journaled before the step's first event `seq`, else the session's first,
// which the flow read before the session started. Undefined when the
// session has no checkpoint or no event `seq`. The session screen applies
// the same rule (app/web/screens/session/model.ts, stepCommit).
export function stepCommit(events: readonly SessionEvent[], seq: number): Checkpoint | undefined {
  if (!events.some((e) => e.seq === seq)) return undefined;
  let first: Checkpoint | undefined;
  let before: Checkpoint | undefined;
  for (const { seq: at, event } of events) {
    if (event.type !== 'CUSTOM' || event.name !== 'cleared.checkpoint') continue;
    first ??= event.value;
    if (at < seq) before = event.value;
  }
  return before ?? first;
}

// What the new author is told after the ticket: where its checkout stands,
// and the owner's corrected instruction.
export function replayPrompt(first: string, replay: { readonly commit: string; readonly branch: string; readonly message: string }): string {
  return [
    first,
    '',
    'This ticket is resumed from an earlier step of its last session, at the owner\'s request.',
    `Your checkout is on a new branch, ${replay.branch}, at commit ${replay.commit}: the work committed before that step is there, and nothing the last session did after it. Read the files again before you change them.`,
    'The owner\'s corrected instruction, which wins over any earlier direction:',
    '',
    replay.message,
  ].join('\n');
}

// ---- the route --------------------------------------------------------------

export type ReplayRoutesDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly proof: () => string;
};

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
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new HttpError(400, 'the request body is not JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'the request body is not a JSON object');
  return value as Record<string, unknown>;
}

// POST /api/sessions/:id/replay, with the checks of every write of the
// service's API: the app's proof, the flow, a user the service knows; then
// the owner, as for Take over.
export function replayRoutes(deps: ReplayRoutesDeps): Route[] {
  return [{
    method: 'POST', path: '/api/sessions/:id/replay',
    handle: async (context) => {
      try {
        if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
        const engine = deps.engine(context.registry);
        if (!engine) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
        const user = header(context.request, SERVICE_USER_HEADER);
        if (!user || !(await context.registry.users.get(user))) throw new HttpError(403, 'unknown user');
        if (user !== await ownerOf(context.registry))
          throw new HttpError(403, 'resuming a ticket from a step is the owner account\'s alone in this version (the first account of this service): ask the owner');
        const body = await readBody(context.request);
        const { seq, message } = body;
        if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) throw new HttpError(400, 'seq must be the number of an event of the session');
        if (typeof message !== 'string' || message.trim() === '' || message.length > MAX_REPLAY) throw new HttpError(400, `message must be a non-empty text of at most ${MAX_REPLAY} characters`);
        const replay = await engine.replay(context.params.id as string, seq, message, user);
        answer(context, 200, { accepted: true, session: replay.resumed, branch: replay.branch, commit: replay.commit });
      } catch (error) {
        if (error instanceof HttpError) answer(context, error.status, { error: error.message });
        else if (error instanceof FlowError) answer(context, STATUS[error.kind], { error: error.message });
        else throw error;
      }
    },
  }];
}
