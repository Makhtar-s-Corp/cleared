// The ticket store on the local tracker's tables in ledger.db (plan, decision
// 11): tracker_tickets, tracker_history, tracker_comments, as
// lib/tracker/adapters/local.mjs creates and reads them, so tracker.ts,
// ask-validation.ts and merge-pr.ts see what the service writes and the
// service sees what they write.
//
// Two kinds of writer, as in v1. The service acting for the agents writes
// 'agents' rows, unsigned. A signed-in person's writes are 'human' rows signed
// with the service's key (src/approval/signer.ts), under the name in
// [tracker] owner_id, which is what the lock reads as the human, and only for
// the signed-in user whose name is owner_id: any other user's write is a
// 'human' row without a proof, which the lock reads as someone else (a
// comment of a guest never counts as the owner's line, a ticket of a guest
// never as the owner's mark). The move to the go state is the approval
// itself: only recordApproval writes it.
import { createHash, createPublicKey, verify } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { UserDirectory } from '../modules/registry.ts';
import { ApprovalError } from '../approval/errors.ts';
import { approvalContext, byPr, readApprovalRecord, sameVersions, type Version } from '../approval/record.ts';
import { approvalPayload, commentPayload, type ApprovalSigner } from '../approval/signer.ts';
import type { WorkspaceConfig } from '../workspace/config.ts';
import {
  DEFAULT_STATES, TicketError, newTicketServices,
  type Actor, type Author, type Comment, type NewTicket, type StatusChange, type Ticket, type TicketId, type TicketService, type TicketStates, type TicketStore,
} from './contract.ts';

// One statement each, as lib/tracker/adapters/local.mjs SCHEMA writes them
// (a test keeps them identical).
export const TICKET_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS tracker_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
  labels TEXT NOT NULL, project TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS tracker_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket INTEGER NOT NULL, status TEXT NOT NULL,
  actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, at TEXT NOT NULL
  , proof TEXT, approval_context TEXT, content_hash TEXT
)`,
  `CREATE TABLE IF NOT EXISTS tracker_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket INTEGER NOT NULL, body TEXT NOT NULL,
  images TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL, edited_at TEXT, proof TEXT
)`,
  'CREATE INDEX IF NOT EXISTS tracker_tickets_status ON tracker_tickets(status)',
  'CREATE INDEX IF NOT EXISTS tracker_history_ticket ON tracker_history(ticket, id)',
  'CREATE INDEX IF NOT EXISTS tracker_comments_ticket ON tracker_comments(ticket, id)',
  `CREATE TABLE IF NOT EXISTS tracker_images (
  digest TEXT PRIMARY KEY, mime TEXT NOT NULL, body BLOB NOT NULL, created_at TEXT NOT NULL
)`,
];

// The workspace and its services (docs/v2/milestone-2-plan.md, decision 18),
// tables of the tickets module beside the v1 tracker tables, which do not
// change: a ticket's workspace is its tracker row's `project`, and its parts
// per service are ticket_services rows (ticket is 'LOCAL-<n>', as the v2
// tables name tickets).
const TICKET_SERVICES_TABLE = `CREATE TABLE IF NOT EXISTS ticket_services (
  ticket TEXT NOT NULL, service TEXT NOT NULL, branch TEXT, pr INTEGER, state TEXT NOT NULL,
  PRIMARY KEY (ticket, service)
)`;

export const WORKSPACE_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS services (
  workspace TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, repo TEXT NOT NULL, url TEXT NOT NULL, base TEXT NOT NULL,
  path TEXT, health_url TEXT, sensitivity TEXT NOT NULL, consumes TEXT NOT NULL, run TEXT, contract TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, name)
)`,
  TICKET_SERVICES_TABLE,
];

// Writes the workspace's row and its services' rows as the configuration
// says, keeping each row's creation time: the same configuration twice
// changes nothing. A service no longer configured keeps its row (its
// tickets still name it); nothing is deleted.
export function recordWorkspace(db: DatabaseSync, workspace: WorkspaceConfig, at: string): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name WHERE name IS NOT excluded.name')
      .run(workspace.id, workspace.name, at);
    const upsert = db.prepare(
      'INSERT INTO services (workspace, name, kind, repo, url, base, path, health_url, sensitivity, consumes, run, contract, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(workspace, name) DO UPDATE SET kind = excluded.kind, repo = excluded.repo, url = excluded.url, base = excluded.base, path = excluded.path, ' +
      'health_url = excluded.health_url, sensitivity = excluded.sensitivity, consumes = excluded.consumes, run = excluded.run, contract = excluded.contract',
    );
    for (const s of workspace.services) {
      upsert.run(workspace.id, s.name, s.kind, s.repo, s.url, s.base, s.path, s.healthUrl, s.sensitivity, JSON.stringify(s.consumes),
        s.run ? `${s.run.dockerfile}:${s.run.port}` : null, s.contract ? `${s.contract.format}:${s.contract.path}` : null, at);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export type LocalStoreOptions = {
  readonly stateDir: string;                       // where ask-validation.ts keeps validations/<ticket>.json
  readonly states?: TicketStates;
  readonly ownerId?: string;                       // [tracker] owner_id: the name a human's rows carry
  readonly publicKey?: string;                     // [tracker] human_public_key: base64 of the PEM
  readonly signer?: ApprovalSigner;
  readonly users?: UserDirectory;                  // who is the owner: a human write is signed for that user only
  readonly now?: () => string;
};

type Row = Record<string, unknown>;
const str = (row: Row, key: string) => String(row[key]);

export class LocalTicketStore implements TicketStore {
  readonly states: TicketStates;
  readonly #db: DatabaseSync;
  readonly #stateDir: string;
  readonly #ownerId: string | undefined;
  readonly #publicKey: string | undefined;
  readonly #signer: ApprovalSigner | undefined;
  readonly #users: UserDirectory | undefined;
  readonly #now: () => string;
  readonly #ticket: StatementSync;
  readonly #tickets: StatementSync;
  readonly #historyRows: StatementSync;
  readonly #historiesRows: StatementSync;
  readonly #commentRows: StatementSync;
  readonly #serviceRows: StatementSync;

  constructor(db: DatabaseSync, options: LocalStoreOptions) {
    this.#db = db;
    this.#stateDir = options.stateDir;
    this.states = options.states ?? DEFAULT_STATES;
    this.#ownerId = options.ownerId;
    this.#publicKey = options.publicKey;
    this.#signer = options.signer;
    this.#users = options.users;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#ticket = db.prepare('SELECT * FROM tracker_tickets WHERE id = ?');
    this.#tickets = db.prepare('SELECT * FROM tracker_tickets ORDER BY id');
    this.#historyRows = db.prepare('SELECT status, actor_kind, actor_id, at, proof, approval_context, content_hash FROM tracker_history WHERE ticket = ? ORDER BY id');
    this.#historiesRows = db.prepare('SELECT ticket, status, actor_kind, actor_id, at, proof, approval_context, content_hash FROM tracker_history WHERE ticket IN (SELECT value FROM json_each(?)) ORDER BY ticket, id');
    this.#commentRows = db.prepare('SELECT * FROM tracker_comments WHERE ticket = ? ORDER BY id');
    // Its own table, made here too: a store opened on the tracker tables
    // alone (as the v1 tools and the approval's tests open it) still reads
    // and writes a ticket's services.
    db.exec(TICKET_SERVICES_TABLE);
    this.#serviceRows = db.prepare('SELECT service, branch, pr, state FROM ticket_services WHERE ticket = ? ORDER BY rowid');
  }

  // Whether the service can sign for the owner at all.
  get canSign(): boolean {
    return this.#signer !== undefined && this.#ownerId !== undefined;
  }

  #number(id: TicketId): number | undefined {
    const match = /^LOCAL-([1-9][0-9]*)$/.exec(String(id));
    return match ? Number(match[1]) : undefined;
  }

  #row(id: TicketId): Row {
    const number = this.#number(id);
    const row = number === undefined ? undefined : this.#ticket.get(number) as Row | undefined;
    if (!row) throw new TicketError(`unknown ticket ${id}`);
    return row;
  }

  #toTicket(row: Row): Ticket {
    const id = `LOCAL-${str(row, 'id')}`;
    const services = (this.#serviceRows.all(id) as Row[]).map((r): TicketService => ({
      name: str(r, 'service'), branch: r.branch === null ? null : str(r, 'branch'), pr: r.pr === null ? null : Number(r.pr), state: str(r, 'state'),
    }));
    return {
      id, title: str(row, 'title'), body: str(row, 'body'), labels: JSON.parse(str(row, 'labels')) as string[],
      project: row.project === null ? null : str(row, 'project'), status: str(row, 'status'),
      createdAt: str(row, 'created_at'), updatedAt: str(row, 'updated_at'), ...(services.length > 0 ? { services } : {}),
    };
  }

  // The user must exist; the owner is the one whose name is [tracker] owner_id.
  async #user(id: string): Promise<{ id: string; name: string }> {
    const user = await this.#users?.get(id);
    if (!user) throw new TicketError(`unknown user ${id}`);
    return user;
  }

  // Who writes and whether the key signs for them. The owner's rows carry
  // owner_id and a proof; another user's rows carry their id and none.
  async #who(by: Actor): Promise<{ kind: 'human' | 'agents'; id: string; sign: ((payload: string) => string) | null }> {
    if (by.kind === 'agents') return { kind: 'agents', id: by.id, sign: null };
    const user = await this.#user(by.id);
    if (!this.#signer || !this.#ownerId) throw new TicketError('a human write needs the signing key and [tracker] owner_id: run npm run setup');
    if (user.name !== this.#ownerId) return { kind: 'human', id: user.id, sign: null };
    const signer = this.#signer;
    return { kind: 'human', id: this.#ownerId, sign: (payload) => signer.sign(payload) };
  }

  #transaction<T>(run: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #contentHash(number: number): string | null {
    const row = this.#db.prepare('SELECT title, body, labels, project FROM tracker_tickets WHERE id = ?').get(number) as Row | undefined;
    if (!row) return null;
    return createHash('sha256').update(JSON.stringify([row.title, row.body, row.labels, row.project])).digest('hex');
  }

  #insertHistory(number: number, status: string, who: { kind: string; id: string; sign: ((p: string) => string) | null }, at: string, context: string | null, contentHash: string | null): void {
    const proof = who.sign ? who.sign(approvalPayload(number, status, at, who.id, context, contentHash)) : null;
    this.#db.prepare('INSERT INTO tracker_history(ticket, status, actor_kind, actor_id, at, proof, approval_context, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(number, status, who.kind, who.id, at, proof, context, contentHash);
  }

  async create(ticket: NewTicket, by: Actor): Promise<Ticket> {
    if (!ticket.title?.trim()) throw new TicketError('a ticket needs a title');
    const services = newTicketServices(ticket.services) ?? [];
    const who = await this.#who(by);
    const at = this.#now();
    const number = this.#transaction(() => {
      const result = this.#db.prepare('INSERT INTO tracker_tickets(title, body, labels, project, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(ticket.title, ticket.body ?? '', JSON.stringify(ticket.labels ?? []), ticket.project, this.states.todo, at, at);
      const created = Number(result.lastInsertRowid);
      this.#insertHistory(created, this.states.todo, who, at, null, this.#contentHash(created));
      const part = this.#db.prepare('INSERT INTO ticket_services (ticket, service, branch, pr, state) VALUES (?, ?, ?, ?, ?)');
      for (const s of services) part.run(`LOCAL-${created}`, s.name, s.branch, s.pr, s.state);
      return created;
    });
    return this.#toTicket(this.#row(`LOCAL-${number}`));
  }

  async get(id: TicketId): Promise<Ticket | undefined> {
    const number = this.#number(id);
    const row = number === undefined ? undefined : this.#ticket.get(number) as Row | undefined;
    return row ? this.#toTicket(row) : undefined;
  }

  async list(filter: { readonly status?: string; readonly project?: string } = {}): Promise<Ticket[]> {
    return (this.#tickets.all() as Row[]).map((row) => this.#toTicket(row))
      .filter((t) => (filter.status === undefined || t.status === filter.status) && (filter.project === undefined || t.project === filter.project));
  }

  async move(id: TicketId, status: string, by: Actor): Promise<Ticket> {
    const row = this.#row(id);
    if (status === this.states.go) throw new TicketError(`${status} is written by the approval writer only, after the human's approval`);
    if (!Object.values(this.states).includes(status)) throw new TicketError(`unknown state ${status}`);
    const who = await this.#who(by);
    const number = Number(row.id);
    const at = this.#now();
    this.#transaction(() => {
      this.#db.prepare('UPDATE tracker_tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, at, number);
      this.#insertHistory(number, status, who, at, null, null);
    });
    return this.#toTicket(this.#row(id));
  }

  #verified(row: Row, number: number): Author['kind'] {
    if (row.actor_kind !== 'human') return row.actor_kind === 'agents' ? 'agents' : 'other';
    if (!this.#publicKey || !row.proof) return 'other';
    if (row.content_hash && row.content_hash !== this.#contentHash(number)) return 'other';
    const payload = approvalPayload(number, str(row, 'status'), str(row, 'at'), str(row, 'actor_id'),
      row.approval_context === null ? null : str(row, 'approval_context'), row.content_hash === null ? null : str(row, 'content_hash'));
    try {
      return verify(null, Buffer.from(payload), createPublicKey(Buffer.from(this.#publicKey, 'base64')), Buffer.from(str(row, 'proof'), 'base64')) ? 'human' : 'other';
    } catch {
      return 'other';
    }
  }

  #change(row: Row, number: number): StatusChange {
    return { status: str(row, 'status'), by: { kind: this.#verified(row, number), id: str(row, 'actor_id') }, at: str(row, 'at') };
  }

  async history(id: TicketId): Promise<StatusChange[]> {
    const number = Number(this.#row(id).id);
    return (this.#historyRows.all(number) as Row[]).map((row) => this.#change(row, number));
  }

  // One query for every ticket asked; a ticket has a row from its creation,
  // so one without any is not this store's.
  async histories(ids: readonly TicketId[]): Promise<Map<TicketId, StatusChange[]>> {
    const numbers = new Map<number, TicketId>();
    for (const id of ids) {
      const number = this.#number(id);
      if (number !== undefined) numbers.set(number, id);
    }
    const found = new Map<number, StatusChange[]>();
    if (numbers.size > 0) {
      for (const row of this.#historiesRows.all(JSON.stringify([...numbers.keys()])) as Row[]) {
        const number = Number(row.ticket);
        const changes = found.get(number) ?? [];
        changes.push(this.#change(row, number));
        found.set(number, changes);
      }
    }
    const out = new Map<TicketId, StatusChange[]>();
    for (const [number, id] of numbers) {
      const changes = found.get(number);
      if (changes) out.set(id, changes);
    }
    return out;
  }

  async comment(id: TicketId, body: string, by: Actor): Promise<Comment> {
    const number = Number(this.#row(id).id);
    const who = await this.#who(by);
    const at = this.#now();
    const images = '[]';
    const proof = who.sign ? who.sign(commentPayload(number, body, images, at, who.id)) : null;
    const commentId = this.#transaction(() => {
      const result = this.#db.prepare('INSERT INTO tracker_comments(ticket, body, images, actor_kind, actor_id, created_at, proof) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(number, body, images, who.kind, who.id, at, proof);
      this.#db.prepare('UPDATE tracker_tickets SET updated_at = ? WHERE id = ?').run(at, number);
      return Number(result.lastInsertRowid);
    });
    return { id: String(commentId), body, by: { kind: who.kind === 'human' ? 'human' : 'agents', id: who.id }, createdAt: at };
  }

  async comments(id: TicketId): Promise<Comment[]> {
    const number = Number(this.#row(id).id);
    return (this.#commentRows.all(number) as Row[]).map((row) => {
      let kind: Author['kind'] = row.actor_kind === 'agents' ? 'agents' : 'other';
      if (row.actor_kind === 'human' && this.#publicKey && row.proof) {
        const written = row.edited_at ? str(row, 'edited_at') : str(row, 'created_at');
        const payload = commentPayload(number, str(row, 'body'), str(row, 'images'), written, str(row, 'actor_id'));
        try {
          kind = verify(null, Buffer.from(payload), createPublicKey(Buffer.from(this.#publicKey, 'base64')), Buffer.from(str(row, 'proof'), 'base64')) ? 'human' : 'other';
        } catch { kind = 'other'; }
      }
      return { id: str(row, 'id'), body: str(row, 'body'), by: { kind, id: str(row, 'actor_id') }, createdAt: str(row, 'created_at') };
    });
  }

  // Everything the approval needs to hold, without writing: the ticket
  // exists and waits for the owner, and the request kept for it is the one
  // shown. Returns what the signature will bind.
  checkApproval(id: TicketId, request: { readonly requestedAt: string; readonly heads: readonly Version[] }): { ticket: Ticket; at: string; versions: readonly Version[] } {
    if (!this.canSign) throw new ApprovalError('setup', 'approval is not set up: no signing key or [tracker] owner_id (npm run setup)');
    const number = this.#number(id);
    const row = number === undefined ? undefined : this.#ticket.get(number) as Row | undefined;
    if (!row) throw new ApprovalError('ticket', `no such ticket: ${id}`);
    const ticket = this.#toTicket(row);
    if (ticket.status !== this.states.validate) throw new ApprovalError('state', `the ticket is not waiting for the owner (it is in “${ticket.status}”)`);
    const record = readApprovalRecord(this.#stateDir, ticket.id);
    if (!record) throw new ApprovalError('version', 'no request for agreement is kept for this ticket');
    if (request.requestedAt !== record.at) throw new ApprovalError('version', 'the request for agreement was made again since: review again');
    if (!sameVersions(record.versions, [...request.heads].sort(byPr))) throw new ApprovalError('version', 'the version asked for is not the one that was shown: review again');
    return { ticket, at: record.at, versions: record.versions };
  }

  // The human's move to the go state, signed, bound to the request time and
  // the shown heads (approval_context). The checks are made again here, under
  // the write lock, on the record as it is now.
  async recordApproval(id: TicketId, request: { readonly by: string; readonly requestedAt: string; readonly heads: readonly Version[] }): Promise<Ticket> {
    // Only the owner approves, whoever calls: the signature is the owner's.
    const user = await this.#users?.get(request.by);
    if (!user) throw new ApprovalError('user', 'unknown user');
    if (user.name !== this.#ownerId) throw new ApprovalError('owner', 'only the owner approves');
    return this.#transaction(() => {
      const { ticket, at: requested, versions } = this.checkApproval(id, request);
      const human = { id: this.#ownerId as string, sign: (payload: string) => (this.#signer as ApprovalSigner).sign(payload) };
      const number = Number(ticket.id.slice('LOCAL-'.length));
      const at = this.#now();
      this.#db.prepare('UPDATE tracker_tickets SET status = ?, updated_at = ? WHERE id = ?').run(this.states.go, at, number);
      this.#insertHistory(number, this.states.go, { kind: 'human', id: human.id, sign: human.sign }, at, approvalContext(ticket.id, requested, versions), null);
      return this.#toTicket(this.#row(ticket.id));
    });
  }
}
