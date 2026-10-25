// A run (docs/v2/milestone-5-plan.md, section 8, C18): a ticket made from a
// terminal or a script and started on the chat's path (P212), a batch of one
// on the flow's batches' runner, so it waits for the Consumption screen's
// lanes and the week stop as any batch does. It is made in the service's
// project, as the token's person, labelled `run`, with the template's type
// label when one is named and the service's part when one is named.
//
// What the flow says of it is kept in run_launches, keyed by ticket: its
// session at ticket_started, its pull request at release_requested, and the
// moments it was approved, went live or was put back; a later start leaves
// what the last one reached behind. So GET /api/run/:id reads its state
// after a restart too, from the batch's item (queued, started, failed) and
// those columns.
import type { DatabaseSync } from 'node:sqlite';
import type { Batch } from '../api/types.ts';
import { BATCH_BODY_MAX, BATCH_TITLE_MAX } from '../flow/batch.ts';
import type { FlowEvent, FlowListener } from '../flow/events.ts';
import type { UserId } from '../session/contract.ts';
import { TICKET_TEMPLATES, typeLabel, type TicketTemplate } from '../tickets/templates.ts';
import type { TicketId, TicketStore } from '../tickets/contract.ts';
import { RUN_LABEL, type Run, type RunBody, type RunState } from './types.ts';

export const RUN_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_launches (
  ticket TEXT PRIMARY KEY, batch TEXT NOT NULL, by_user TEXT NOT NULL, via TEXT NOT NULL, title TEXT NOT NULL, at TEXT NOT NULL,
  session TEXT, started_at TEXT, pr INTEGER, pr_url TEXT, approval_at TEXT, approved_at TEXT, live_at TEXT,
  put_back_at TEXT, note TEXT
)`,
];

export class RunError extends Error {
  override name = 'RunError';
  readonly kind: 'invalid' | 'not_found';
  constructor(kind: 'invalid' | 'not_found', message: string) {
    super(message);
    this.kind = kind;
  }
}

// What a run uses of the batches' runner (flow/batch.ts BatchRunner) and of the flow.
export type RunRunner = {
  create(input: { readonly tickets: unknown }, by: UserId, options?: { readonly min?: number; readonly services?: readonly string[] }): Promise<Batch>;
  get(id: string): Promise<Batch>;
};
export type RunFlow = { subscribe(listener: FlowListener): () => void };

export type RunDeps = {
  readonly db: DatabaseSync;
  readonly runner: RunRunner;
  readonly flow: RunFlow;
  readonly tickets: TicketStore;
  readonly project: string;
  readonly services: () => readonly string[];          // the workspace's services, by name
  readonly appOrigin: string | null;                   // where the addresses point; none, no address
  readonly now?: () => Date;
};

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const EARLY_MAX = 20;
const FIELDS = new Set(['title', 'description', 'service', 'template']);

// The body of POST /api/run, checked whole before any ticket exists.
export function runInput(body: unknown, services: readonly string[]): RunBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new RunError('invalid', 'a run is a JSON object');
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).filter((name) => !FIELDS.has(name));
  if (unknown.length > 0) throw new RunError('invalid', `a run has a title, a description, a service and a template, not ${unknown.join(', ')}`);
  const { title, description, service, template } = record;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > BATCH_TITLE_MAX) throw new RunError('invalid', `the title is a text of 1 to ${BATCH_TITLE_MAX} characters`);
  if (description !== undefined && (typeof description !== 'string' || description.length > BATCH_BODY_MAX)) throw new RunError('invalid', `the description is a text of at most ${BATCH_BODY_MAX} characters`);
  if (service !== undefined && (typeof service !== 'string' || !services.includes(service)))
    throw new RunError('invalid', `${String(service).slice(0, 100)} is not a service of this workspace (${services.join(', ')})`);
  if (template !== undefined && !(TICKET_TEMPLATES as readonly unknown[]).includes(template))
    throw new RunError('invalid', `the template is one of ${TICKET_TEMPLATES.join(', ')}`);
  return {
    title: title.trim(),
    ...(typeof description === 'string' && description.trim() ? { description } : {}),
    ...(service === undefined ? {} : { service: service as string }),
    ...(template === undefined ? {} : { template: template as TicketTemplate }),
  };
}

export class RunLauncher {
  #deps: RunDeps;
  #db: DatabaseSync;
  #now: () => Date;
  #unsubscribe: (() => void) | undefined;
  // The batch starts the ticket inside create, so the flow may speak of it
  // before launch wrote its row: what it says of a ticket with no row is
  // held here, the last few events at most, and written when launch makes the row.
  #early: FlowEvent[] = [];

  constructor(deps: RunDeps) {
    this.#deps = deps;
    this.#db = deps.db;
    this.#now = deps.now ?? (() => new Date());
    for (const table of RUN_TABLES) this.#db.exec(table);
  }

  listen(): void {
    this.#unsubscribe ??= this.#deps.flow.subscribe((event) => this.#follow(event));
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  // Nothing of a run is sent in the background: what the flow says is written as it says it.
  async settled(): Promise<void> {}

  // Makes the ticket as a batch of one, by the token's person (`via`: the token's id).
  async launch(body: unknown, by: UserId, via: string): Promise<Run> {
    const input = runInput(body, this.#deps.services());
    const labels = [RUN_LABEL, ...(input.template ? [typeLabel(input.template)] : [])];
    const ticket = { title: input.title, ...(input.description ? { body: input.description } : {}), labels };
    const batch = await this.#deps.runner.create({ tickets: [ticket] }, by, { min: 1, ...(input.service ? { services: [input.service] } : {}) });
    const item = batch.items[0];
    if (!item) throw new Error('the batch of one has no ticket');
    const at = (await this.#deps.tickets.get(item.ticket))?.createdAt ?? this.#now().toISOString();
    this.#db.prepare('INSERT OR IGNORE INTO run_launches (ticket, batch, by_user, via, title, at) VALUES (?, ?, ?, ?, ?, ?)').run(item.ticket, batch.id, by, via, item.title, at);
    const early = this.#early.filter((event) => event.ticket === item.ticket);
    this.#early = this.#early.filter((event) => event.ticket !== item.ticket);
    for (const event of early) this.#write(event);
    return (await this.get(item.ticket)) as Run;
  }

  async get(ticket: TicketId): Promise<Run | undefined> {
    const row = this.#db.prepare('SELECT * FROM run_launches WHERE ticket = ?').get(ticket) as Row | undefined;
    if (!row) return undefined;
    let batch: Batch | undefined;
    try { batch = await this.#deps.runner.get(String(row.batch)); } catch { batch = undefined; }
    const item = batch?.items.find((candidate) => candidate.ticket === ticket);
    const found = await this.#deps.tickets.get(ticket);
    const session = text(row.session);
    const startedAt = text(row.started_at);
    const approvalAt = text(row.approval_at);
    const putBackAt = text(row.put_back_at);
    const pr = typeof row.pr === 'number' || typeof row.pr === 'bigint' ? Number(row.pr) : null;
    const prUrl = text(row.pr_url);

    let state: RunState;
    let note: string | null = null;
    if (putBackAt) { state = 'put_back'; note = text(row.note); }
    else if (text(row.live_at)) state = 'live';
    else if (text(row.approved_at)) state = 'approved';
    else if (approvalAt) state = 'approval';
    else if (session) state = 'working';
    else if (item?.state === 'failed') { state = 'failed'; note = item.note; }
    else if (item?.state === 'queued') state = 'queued';
    else state = 'starting';

    const origin = this.#deps.appOrigin;
    return {
      ticket, title: String(row.title), status: found?.status ?? item?.status ?? '', state,
      hold: state === 'queued' ? batch?.hold ?? null : null, note,
      address: origin === null ? null : session ? `${origin}/sessions/${encodeURIComponent(session)}` : `${origin}/`,
      session, pullRequest: pr !== null && prUrl !== null ? { number: pr, url: prUrl } : null,
      createdAt: String(row.at), startedAt, approvalAt, liveAt: text(row.live_at),
    };
  }

  // ---- what the flow says ------------------------------------------------------------

  #follow(event: FlowEvent): void {
    if (event.project !== this.#deps.project) return;
    if (!this.#db.prepare('SELECT 1 FROM run_launches WHERE ticket = ?').get(event.ticket)) {
      this.#early = [...this.#early.slice(-(EARLY_MAX - 1)), event];
      return;
    }
    this.#write(event);
  }

  #write(event: FlowEvent): void {
    const set = (columns: Record<string, string | number | null>) => {
      const names = Object.keys(columns);
      this.#db.prepare(`UPDATE run_launches SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE ticket = ?`).run(...names.map((name) => columns[name] as string | number | null), event.ticket);
    };
    switch (event.type) {
      // A ticket started again (a person moved it back to Todo) is a new start: what the last one reached is left behind.
      case 'ticket_started': return set({ session: event.session, started_at: event.at, pr: null, pr_url: null, approval_at: null, approved_at: null, live_at: null, put_back_at: null, note: null });
      case 'release_requested': return set({ pr: event.pr, pr_url: event.url, approval_at: event.at });
      case 'release_approved': return set({ approved_at: event.at });
      case 'release_landed': return set({ live_at: event.at });
      case 'ticket_put_back': return set({ put_back_at: event.at, note: event.note });
      default: return;
    }
  }
}
