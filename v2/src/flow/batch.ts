// A batch of tickets (requirement C6, "Multiple sessions in batches"): 2 to
// 20 new tickets launched at once, each its own session. The tickets are
// created in Todo, labelled batch:<id>, in the order given; then they start
// in that order, within two limits read at each pass, never copied:
//
//   the lanes   at most the Consumption screen's lanes (consumption/
//               levers.ts maxLanes, 3 when it sets none) run at once,
//               counting every ticket of the project in progress or in
//               review, whoever started it, and those this runner starts;
//   the stop    nothing starts while a window of the subscription is at or
//               above the week stop (CLEARED_V2_WEEK_STOP_PERCENT, 85 % by
//               default), the plans' own stop (consumption/quota.ts quotaStop).
//
// The others wait in line (queued). A pass runs at each event of the flow
// (a lane frees as soon as a ticket waits for approval or goes back to
// Todo), at each timer tick (a quota figure that falls says nothing on the
// bus) and when a batch is created. A ticket that cannot start fails alone,
// says why, and frees its lane; a queued ticket a person moved out of Todo
// is not started. A batch starts each of its tickets once: a ticket the
// flow puts back later is the person's to start again, as any other.
//
// The batches are in batches and batch_items, so a runner built over the
// same ledger (a restart) finishes the queue.
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { BATCH_MAX, BATCH_MIN, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type Batch, type BatchHold, type BatchItem, type BatchItemState, type CreateBatchBody } from '../api/types.ts';
import type { LeverReader } from '../consumption/levers.ts';
import { quotaStop } from '../consumption/quota.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import type { UserId } from '../session/contract.ts';
import type { TicketId, TicketStore } from '../tickets/contract.ts';
import type { FlowListener } from './events.ts';

export { BATCH_MAX, BATCH_MIN } from '../api/types.ts';

// The lanes when the Consumption screen sets none: the variants' limit of 3.
export const BATCH_LANES = 3;
export const BATCH_TITLE_MAX = 200;
export const BATCH_BODY_MAX = 20_000;

export const BATCH_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, project TEXT NOT NULL, by_user TEXT NOT NULL, at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS batch_items (
  batch TEXT NOT NULL, position INTEGER NOT NULL, ticket TEXT NOT NULL, title TEXT NOT NULL,
  state TEXT NOT NULL, note TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (batch, position)
)`,
];

export type BatchErrorKind = 'not_found' | 'invalid';

export class BatchError extends Error {
  override name = 'BatchError';
  readonly kind: BatchErrorKind;
  constructor(kind: BatchErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

// What a batch uses of the flow (flow/engine.ts FlowEngine): launch is
// start, in the background, waited for by the engine's settled().
export type BatchFlow = {
  launch(ticket: TicketId, by: UserId): Promise<void>;
  subscribe(listener: FlowListener): () => void;
};

export type BatchDeps = {
  readonly db: DatabaseSync;
  readonly tickets: TicketStore;
  readonly flow: BatchFlow;
  readonly project: string;
  readonly levers: LeverReader;
  readonly weekStopPercent: number;
  readonly now?: () => Date;
};

export type BatchTicket = CreateBatchBody['tickets'][number];

type Row = Record<string, unknown>;
type StoredItem = { readonly batch: string; readonly position: number; readonly ticket: TicketId; readonly title: string; readonly state: BatchItemState; readonly note: string | null };

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);
const isText = (value: unknown): value is string => typeof value === 'string';

// The tickets of a batch, checked whole before any of them exists.
export function validateBatch(tickets: unknown): BatchTicket[] {
  if (!Array.isArray(tickets)) throw new BatchError('invalid', 'tickets is a list of tickets');
  if (tickets.length < BATCH_MIN || tickets.length > BATCH_MAX) throw new BatchError('invalid', `a batch holds ${BATCH_MIN} to ${BATCH_MAX} tickets, not ${tickets.length}`);
  return tickets.map((entry: unknown, index) => {
    const n = index + 1;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new BatchError('invalid', `ticket ${n} is not an object`);
    const { title, body, labels, ...rest } = entry as Record<string, unknown>;
    const unknown = Object.keys(rest);
    if (unknown.length > 0) throw new BatchError('invalid', `ticket ${n}: a batch's ticket has a title, a body and labels, not ${unknown.join(', ')}`);
    if (!isText(title) || !title.trim() || title.trim().length > BATCH_TITLE_MAX) throw new BatchError('invalid', `ticket ${n}: the title is a text of 1 to ${BATCH_TITLE_MAX} characters`);
    if (body !== undefined && (!isText(body) || body.length > BATCH_BODY_MAX)) throw new BatchError('invalid', `ticket ${n}: the body is a text of at most ${BATCH_BODY_MAX} characters`);
    if (labels !== undefined && (!Array.isArray(labels) || labels.some((l) => !isText(l) || l.length > 100))) throw new BatchError('invalid', `ticket ${n}: labels is a list of short texts`);
    return { title: title.trim(), ...(isText(body) && body.trim() ? { body } : {}), ...(labels === undefined ? {} : { labels: labels as string[] }) };
  });
}

export class BatchRunner {
  #deps: BatchDeps;
  #db: DatabaseSync;
  #now: () => Date;
  #starting = new Set<TicketId>();
  #tracked = new Set<Promise<unknown>>();
  #running: Promise<void> | undefined;
  #next: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(deps: BatchDeps) {
    this.#deps = deps;
    this.#db = deps.db;
    this.#now = deps.now ?? (() => new Date());
    for (const table of BATCH_TABLES) this.#db.exec(table);
  }

  get project(): string {
    return this.#deps.project;
  }

  // ---- lifecycle -------------------------------------------------------------

  // Every event of the project's flow is a pass: a lane may have freed.
  listen(): void {
    this.#unsubscribe ??= this.#deps.flow.subscribe((event) => {
      if (event.project === this.#deps.project) this.#later();
    });
  }

  // A pass every `ms` until close(); the timer never keeps the process alive.
  startTimer(ms = 30_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#later(), ms);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    await this.settled();
  }

  // Waits until nothing the runner started is still running. For the tests and a clean stop.
  async settled(): Promise<void> {
    while (this.#tracked.size > 0 || this.#running || this.#next) {
      await Promise.allSettled([...this.#tracked, this.#running, this.#next]);
    }
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#tracked.add(promise);
    const done = () => { this.#tracked.delete(promise); };
    promise.then(done, done);
    return promise;
  }

  #later(): void {
    void this.#track(this.tick().catch((error) => console.error(`cleared-v2: a batch pass failed (${errorName(error)})`)));
  }

  // ---- the person's gestures -----------------------------------------------------

  // Creates the batch's tickets in order, then starts what the lanes and the stop allow.
  async create(input: { readonly tickets: unknown }, by: UserId): Promise<Batch> {
    const tickets = validateBatch(input.tickets);
    const seq = Number((this.#db.prepare('SELECT MAX(seq) AS n FROM batches').get() as Row).n ?? 0) + 1;
    const id = `batch-${seq}`;
    const at = this.#now().toISOString();
    this.#db.prepare('INSERT INTO batches (id, seq, project, by_user, at) VALUES (?, ?, ?, ?, ?)').run(id, seq, this.#deps.project, by, at);
    const insert = this.#db.prepare("INSERT INTO batch_items (batch, position, ticket, title, state, note, updated_at) VALUES (?, ?, ?, ?, 'queued', NULL, ?)");
    for (const [index, ticket] of tickets.entries()) {
      const position = index + 1;
      try {
        const created = await this.#deps.tickets.create(
          { title: ticket.title, ...(ticket.body ? { body: ticket.body } : {}), labels: [...(ticket.labels ?? []), `batch:${id}`], project: this.#deps.project },
          { kind: 'human', id: by },
        );
        insert.run(id, position, created.id, ticket.title, at);
      } catch (error) {
        // The tickets made so far stay the batch's; the rest are not made.
        console.error(`cleared-v2: ticket ${position} of ${id} could not be created (${errorName(error)})`);
        if (position === 1) {
          this.#db.prepare('DELETE FROM batches WHERE id = ?').run(id);
          throw error;
        }
        break;
      }
    }
    await this.tick();
    return this.get(id);
  }

  // ---- reading ---------------------------------------------------------------------

  async get(id: string): Promise<Batch> {
    const row = this.#db.prepare('SELECT * FROM batches WHERE id = ? AND project = ?').get(id, this.#deps.project) as Row | undefined;
    if (!row) throw new BatchError('not_found', `unknown batch ${id}`);
    return (await this.#publicBatches([row]))[0] as Batch;
  }

  // Newest first.
  async list(): Promise<Batch[]> {
    return this.#publicBatches(this.#db.prepare('SELECT * FROM batches WHERE project = ? ORDER BY seq DESC').all(this.#deps.project) as Row[]);
  }

  async #publicBatches(rows: readonly Row[]): Promise<Batch[]> {
    const lanes = this.#lanes();
    const running = await this.#runningCount();
    const stop = this.#stop();
    const out: Batch[] = [];
    for (const row of rows) {
      const id = String(row.id);
      const items: BatchItem[] = [];
      for (const item of this.#items(id)) {
        const ticket = await this.#deps.tickets.get(item.ticket);
        items.push({ position: item.position, ticket: item.ticket, title: item.title, state: item.state, status: ticket?.status ?? '', note: item.note });
      }
      const waits = items.some((item) => item.state === 'queued');
      const hold: BatchHold | null = !waits ? null : stop ?? (running >= lanes ? { reason: 'lanes', running, lanes } : null);
      out.push({ id, project: String(row.project), by: String(row.by_user) as UserId, at: String(row.at), lanes, running, hold, items });
    }
    return out;
  }

  #items(batch: string): StoredItem[] {
    return (this.#db.prepare('SELECT * FROM batch_items WHERE batch = ? ORDER BY position').all(batch) as Row[]).map((row) => ({
      batch: String(row.batch), position: Number(row.position), ticket: String(row.ticket) as TicketId, title: String(row.title),
      state: String(row.state) as BatchItemState, note: row.note === null || row.note === undefined ? null : String(row.note),
    }));
  }

  #queued(): StoredItem[] {
    return (this.#db.prepare(`SELECT i.* FROM batch_items i JOIN batches b ON b.id = i.batch
      WHERE b.project = ? AND i.state = 'queued' ORDER BY b.seq, i.position`).all(this.#deps.project) as Row[]).map((row) => ({
      batch: String(row.batch), position: Number(row.position), ticket: String(row.ticket) as TicketId, title: String(row.title),
      state: 'queued' as const, note: null,
    }));
  }

  #set(item: StoredItem, state: BatchItemState, note: string | null = null): void {
    this.#db.prepare('UPDATE batch_items SET state = ?, note = ?, updated_at = ? WHERE batch = ? AND position = ?')
      .run(state, note, this.#now().toISOString(), item.batch, item.position);
  }

  // ---- the limits --------------------------------------------------------------------

  #lanes(): number {
    return this.#deps.levers.read().maxLanes ?? BATCH_LANES;
  }

  // The project's tickets in progress or in review, whoever started them, and those being started.
  async #runningCount(): Promise<number> {
    const { tickets, project } = this.#deps;
    const ids = new Set<string>(this.#starting);
    for (const status of [tickets.states.progress, tickets.states.review])
      for (const ticket of await tickets.list({ status, project })) ids.add(ticket.id);
    return ids.size;
  }

  #stop(): BatchHold | null {
    const limit = this.#deps.weekStopPercent;
    const quota = quotaStop(this.#db, { project: this.#deps.project, now: this.#now(), limit });
    return quota ? { reason: 'quota', window: quota.window, percent: quota.usedPercent, stop: limit } : null;
  }

  // ---- the pass ---------------------------------------------------------------------

  // One pass at a time; a pass asked while one runs runs after it, once.
  tick(): Promise<void> {
    if (this.#next) return this.#next;
    if (!this.#running) {
      this.#running = this.#tickOnce().finally(() => { this.#running = undefined; });
      return this.#running;
    }
    this.#next = this.#running.catch(() => undefined).then(() => {
      this.#next = undefined;
      return this.tick();
    });
    return this.#next;
  }

  async #tickOnce(): Promise<void> {
    if (this.#stop()) return;
    const { tickets } = this.#deps;
    let free = this.#lanes() - await this.#runningCount();
    for (const item of this.#queued()) {
      if (free <= 0) return;
      const ticket = await tickets.get(item.ticket);
      if (!ticket) {
        this.#set(item, 'failed', `The ticket ${item.ticket} is gone: it was not started.`);
        continue;
      }
      if (ticket.status !== tickets.states.todo) {
        this.#set(item, 'failed', `The ticket is no longer in ${tickets.states.todo} (it is in ${ticket.status}): it was not started.`);
        continue;
      }
      this.#launch(item);
      free--;
    }
  }

  // Started before the flow is asked, so no pass starts it twice; by the
  // person who created the batch. A start that fails frees its lane.
  #launch(item: StoredItem): void {
    const user = String((this.#db.prepare('SELECT by_user FROM batches WHERE id = ?').get(item.batch) as Row).by_user) as UserId;
    this.#set(item, 'started');
    this.#starting.add(item.ticket);
    const started = this.#deps.flow.launch(item.ticket, user).then(
      () => { this.#starting.delete(item.ticket); },
      (error: unknown) => {
        this.#set(item, 'failed', error instanceof Error ? error.message : String(error));
        this.#starting.delete(item.ticket);
        this.#later();
      },
    );
    this.#track(started);
  }
}

// ---- the routes -------------------------------------------------------------

export type BatchRoutesDeps = {
  readonly runner: (registry: Registry) => BatchRunner | undefined;
  readonly proof: () => string;
};

// 20 tickets, each of a body of up to 20 000 characters.
const MAX_BODY = 512 * 1024;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const STATUS: Record<BatchErrorKind, number> = { not_found: 404, invalid: 400 };

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

// POST /api/batches, GET /api/batches and GET /api/batches/:id, with the
// checks of the service's API (api/routes.ts): the app's proof first, then
// the flow, then for a write a user the service knows.
export function batchRoutes(deps: BatchRoutesDeps): Route[] {
  const guarded = (write: boolean, run: (runner: BatchRunner, user: UserId, context: RouteContext) => Promise<void>): Route['handle'] => async (context) => {
    try {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const runner = deps.runner(context.registry);
      if (!runner) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
      const user = header(context.request, SERVICE_USER_HEADER) ?? '';
      if (write && (!user || !(await context.registry.users.get(user)))) throw new HttpError(403, 'unknown user');
      await run(runner, user, context);
    } catch (error) {
      if (error instanceof HttpError) answer(context, error.status, { error: error.message });
      else if (error instanceof BatchError) answer(context, STATUS[error.kind], { error: error.message });
      else throw error;
    }
  };
  return [
    {
      method: 'POST', path: '/api/batches',
      handle: guarded(true, async (runner, user, context) => {
        const { project, tickets, ...rest } = await readBody(context.request);
        const unknown = Object.keys(rest);
        if (unknown.length > 0) throw new HttpError(400, `a batch has a project and tickets, not ${unknown.join(', ')}`);
        if (project !== runner.project) throw new HttpError(400, `this service runs project ${runner.project}, not ${typeof project === 'string' ? project : 'none'}`);
        answer(context, 200, await runner.create({ tickets }, user));
      }),
    },
    { method: 'GET', path: '/api/batches', handle: guarded(false, async (runner, _user, context) => answer(context, 200, await runner.list())) },
    { method: 'GET', path: '/api/batches/:id', handle: guarded(false, async (runner, _user, context) => answer(context, 200, await runner.get(context.params.id as string))) },
  ];
}
