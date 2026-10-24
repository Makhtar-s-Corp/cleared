// A ticket's variants (issue #271): 2 to 4 author sessions work the same
// one-service ticket at once, each in its own clone of the ticket branch,
// <workdirs>/<ticket>.variant-<round>-<position> (a ticket id has no dot,
// so no other ticket's checkout is ever named so). At most the lanes the
// Consumption screen allows run at once, 3 when it says nothing; the
// others wait for a free lane. A variant that fails fails alone.
//
// Once one is done, the inbox shows a `variants` item: each variant's
// committed change against the base, its files, its lines, its cost and
// its time, updated as the others end. The owner chooses one: the others
// stop, their containers and networks are released at once, and the
// chosen one's checkout is the ticket's from then on (its review, its
// publish, a reopened author). Every variant failing puts the ticket back.
//
// The variants are `ticket_variants` rows, one run (`round`) per start with
// variants; this file holds the table, the store, what the author is told
// and the two routes. The engine (flow/engine.ts) runs them, since it owns
// the sessions.
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, VARIANT_DIFF_MAX, VARIANTS_MAX, VARIANTS_MIN, type TicketVariant, type VariantState } from '../api/types.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { SessionId, UserId } from '../session/contract.ts';
import type { TicketId } from '../tickets/contract.ts';
import { FlowError, type FlowEngine } from './engine.ts';

export { VARIANTS_MAX, VARIANTS_MIN } from '../api/types.ts';

// The variants that run at once when the Consumption screen sets no lanes:
// the issue's limit of 3 lanes in parallel.
export const VARIANT_PARALLEL = 3;

export const VARIANTS_TABLE = `CREATE TABLE IF NOT EXISTS ticket_variants (
  id TEXT PRIMARY KEY, ticket TEXT NOT NULL, project TEXT NOT NULL, round INTEGER NOT NULL, position INTEGER NOT NULL,
  state TEXT NOT NULL, session TEXT, workdir TEXT, files TEXT NOT NULL, added INTEGER NOT NULL, removed INTEGER NOT NULL,
  diff TEXT NOT NULL, cut INTEGER NOT NULL, cost REAL, minutes REAL, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (ticket, round, position)
)`;

// What names a variant's checkout: its run and its place in it.
export type VariantKey = { readonly round: number; readonly position: number };

export type Variant = VariantKey & {
  readonly id: string;
  readonly ticket: TicketId;
  readonly project: string;
  readonly state: VariantState;
  readonly session: SessionId | null;
  readonly workdir: string | null;
  readonly files: readonly string[];
  readonly added: number;
  readonly removed: number;
  readonly diff: string;
  readonly cut: boolean;
  readonly cost: number | null;
  readonly minutes: number | null;
  readonly note: string | null;
};

// The folder of a variant's checkout under the workdirs.
export function variantFolder(ticket: TicketId, key: VariantKey): string {
  if (!Number.isInteger(key.round) || key.round < 1 || !Number.isInteger(key.position) || key.position < 1 || key.position > VARIANTS_MAX)
    throw new FlowError('invalid', `round ${key.round}, variant ${key.position} is not a variant`);
  return `${ticket}.variant-${key.round}-${key.position}`;
}

// The lines a unified diff adds and removes, its file headers left out.
export function diffLines(diff: string): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

// What a variant's author is told besides the ticket.
export function variantPrompt(position: number, count: number): string {
  return [
    `You are variant ${position} of ${count} of this ticket: ${count - 1 === 1 ? 'another author works' : `${count - 1} other authors work`} the same ticket at the same time, each in a checkout of its own.`,
    'Work on your own approach. The owner compares the variants once they are done, and only the one chosen is reviewed; what is not committed is not compared.',
  ].join('\n');
}

type Row = Record<string, unknown>;
const str = (row: Row, key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]));
const num = (row: Row, key: string): number | null => (row[key] === null || row[key] === undefined ? null : Number(row[key]));

export class VariantStore {
  #db: DatabaseSync;
  #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(VARIANTS_TABLE);
  }

  #variant(row: Row): Variant {
    return {
      id: String(row.id), ticket: String(row.ticket), project: String(row.project), round: Number(row.round), position: Number(row.position),
      state: String(row.state) as VariantState, session: str(row, 'session'), workdir: str(row, 'workdir'), files: JSON.parse(String(row.files)) as string[],
      added: Number(row.added), removed: Number(row.removed), diff: String(row.diff), cut: Number(row.cut) === 1,
      cost: num(row, 'cost'), minutes: num(row, 'minutes'), note: str(row, 'note'),
    };
  }

  // A new run of `count` variants of the ticket, all waiting.
  create(ticket: TicketId, project: string, count: number): Variant[] {
    if (!Number.isInteger(count) || count < VARIANTS_MIN || count > VARIANTS_MAX) throw new FlowError('invalid', `variants is a whole number from ${VARIANTS_MIN} to ${VARIANTS_MAX}`);
    const last = Number((this.#db.prepare('SELECT MAX(round) AS n FROM ticket_variants WHERE ticket = ?').get(ticket) as Row).n ?? 0);
    const round = last + 1;
    const at = this.#now().toISOString();
    const insert = this.#db.prepare("INSERT INTO ticket_variants (id, ticket, project, round, position, state, files, added, removed, diff, cut, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'waiting', '[]', 0, 0, '', 0, ?, ?)");
    for (let position = 1; position <= count; position++) insert.run(`${ticket}:r${round}:v${position}`, ticket, project, round, position, at, at);
    return this.list(ticket, round);
  }

  // The ticket's last run of variants (or run `round`), in position order; none when it never had any.
  list(ticket: TicketId, round?: number): Variant[] {
    const which = round ?? Number((this.#db.prepare('SELECT MAX(round) AS n FROM ticket_variants WHERE ticket = ?').get(ticket) as Row).n ?? 0);
    return (this.#db.prepare('SELECT * FROM ticket_variants WHERE ticket = ? AND round = ? ORDER BY position').all(ticket, which) as Row[]).map((row) => this.#variant(row));
  }

  get(id: string): Variant | undefined {
    const row = this.#db.prepare('SELECT * FROM ticket_variants WHERE id = ?').get(id) as Row | undefined;
    return row ? this.#variant(row) : undefined;
  }

  // The variant chosen last for the ticket, whose checkout is the ticket's.
  chosen(ticket: TicketId): Variant | undefined {
    const row = this.#db.prepare("SELECT * FROM ticket_variants WHERE ticket = ? AND state = 'chosen' ORDER BY round DESC LIMIT 1").get(ticket) as Row | undefined;
    return row ? this.#variant(row) : undefined;
  }

  update(id: string, change: Partial<Pick<Variant, 'state' | 'session' | 'workdir' | 'files' | 'added' | 'removed' | 'diff' | 'cut' | 'cost' | 'minutes' | 'note'>>): Variant {
    const v = this.get(id);
    if (!v) throw new FlowError('not_found', `unknown variant ${id}`);
    const next = { ...v, ...change };
    this.#db.prepare('UPDATE ticket_variants SET state = ?, session = ?, workdir = ?, files = ?, added = ?, removed = ?, diff = ?, cut = ?, cost = ?, minutes = ?, note = ?, updated_at = ? WHERE id = ?').run(
      next.state, next.session, next.workdir, JSON.stringify(next.files), next.added, next.removed, next.diff, next.cut ? 1 : 0, next.cost, next.minutes, next.note,
      this.#now().toISOString(), id,
    );
    return this.get(id) as Variant;
  }

  // A ticket put back or set aside: what of its variants was still open
  // is dropped, so a later start never resumes a run nobody chose from.
  drop(ticket: TicketId, note: string): void {
    this.#db.prepare("UPDATE ticket_variants SET state = 'dropped', note = COALESCE(note, ?), updated_at = ? WHERE ticket = ? AND state IN ('waiting', 'running', 'done')")
      .run(note, this.#now().toISOString(), ticket);
  }
}

// The API's variant: the diff cut at VARIANT_DIFF_MAX.
export function publicVariant(v: Variant): TicketVariant {
  const cut = v.cut || v.diff.length > VARIANT_DIFF_MAX;
  return {
    position: v.position, state: v.state, session: v.session, files: v.files, added: v.added, removed: v.removed,
    diff: v.diff.slice(0, VARIANT_DIFF_MAX), cut, costUsd: v.cost, minutes: v.minutes, note: v.note,
  };
}

// ---- the routes -------------------------------------------------------------

export type VariantRoutesDeps = {
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
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new HttpError(400, 'the request body is not JSON'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'the request body is not a JSON object');
  return value as Record<string, unknown>;
}

// GET /api/tickets/:id/variants and POST /api/variants/:id/choose, with the
// checks of the service's API (api/routes.ts): the app's proof first, then
// the flow, then for a write a user the service knows. A variants item is
// named by its inbox id.
export function variantRoutes(deps: VariantRoutesDeps): Route[] {
  const guarded = (write: boolean, run: (engine: FlowEngine, user: UserId, context: RouteContext) => Promise<void>): Route['handle'] => async (context) => {
    try {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const engine = deps.engine(context.registry);
      if (!engine) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
      const user = header(context.request, SERVICE_USER_HEADER) ?? '';
      if (write && (!user || !(await context.registry.users.get(user)))) throw new HttpError(403, 'unknown user');
      await run(engine, user, context);
    } catch (error) {
      if (error instanceof HttpError) answer(context, error.status, { error: error.message });
      else if (error instanceof FlowError) answer(context, STATUS[error.kind], { error: error.message });
      else throw error;
    }
  };
  const id = (context: RouteContext): string => context.params.id as string;
  return [
    {
      method: 'GET', path: '/api/tickets/:id/variants',
      handle: guarded(false, async (engine, _user, context) => {
        const variants = await engine.ticketVariants(id(context));
        if (!variants) throw new HttpError(404, `unknown ticket ${id(context)}`);
        answer(context, 200, variants);
      }),
    },
    {
      method: 'POST', path: '/api/variants/:id/choose',
      handle: guarded(true, async (engine, user, context) => {
        const variant = (await readBody(context.request)).variant;
        if (typeof variant !== 'number' || !Number.isInteger(variant) || variant < 1 || variant > VARIANTS_MAX) throw new HttpError(400, `variant is the position of a variant, from 1 to ${VARIANTS_MAX}`);
        const { released } = await engine.chooseVariant(id(context), variant, user);
        answer(context, 200, { accepted: true, released });
      }),
    },
  ];
}
