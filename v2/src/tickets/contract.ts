// The ticket store contract the flow codes against, with an in-memory
// implementation for tests and fixtures. Lane 8 implements it on the local
// tracker's tables in ledger.db (tracker_tickets, tracker_history,
// tracker_comments, lib/tracker/adapters/local.mjs), so ids, states and
// actor kinds are the local tracker's.
import type { UserId } from '../session/contract.ts';

export type TicketId = string;                                // 'LOCAL-<n>', as the local tracker names them

// The roles of the six states, with the local tracker's default names
// (agents.example.conf, [tracker] *_state).
export type TicketStates = {
  readonly todo: string;
  readonly progress: string;
  readonly review: string;
  readonly validate: string;
  readonly go: string;
  readonly done: string;
};

export const DEFAULT_STATES: TicketStates = {
  todo: 'Todo',
  progress: 'In Progress',
  review: 'In Review',
  validate: 'Needs Approval',
  go: 'Ready to Ship',
  done: 'Done',
};

// Who writes: a signed-in person, or the service acting for the agents.
export type Actor =
  | { readonly kind: 'human'; readonly id: UserId }
  | { readonly kind: 'agents'; readonly id: string };

// Who wrote, as read back: 'other' is anything the store cannot prove.
export type Author = { readonly kind: 'human' | 'agents' | 'other'; readonly id: string };

// A ticket's part on one service of the workspace (ticket_services,
// docs/v2/milestone-2-plan.md, decision 18): the branch and the pull request
// of that service, once published, and its state there.
export type TicketService = {
  readonly name: string;
  readonly branch: string | null;
  readonly pr: number | null;
  readonly state: string;                                     // 'open' when the ticket is created
};

export type Ticket = {
  readonly id: TicketId;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly project: string | null;                            // the workspace's id
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  // The services it touches, in the order they were named. Absent when it
  // names none, as every ticket of a one-service workspace: it is then on
  // that one service, and reads as it did in milestone 1.
  readonly services?: readonly TicketService[];
};

export type StatusChange = { readonly status: string; readonly by: Author; readonly at: string };
export type Comment = { readonly id: string; readonly body: string; readonly by: Author; readonly createdAt: string };

export type NewTicket = {
  readonly title: string;
  readonly body?: string;
  readonly labels?: readonly string[];
  readonly project: string;
  readonly services?: readonly string[];                      // service names; each once
};

export interface TicketStore {
  readonly states: TicketStates;
  create(ticket: NewTicket, by: Actor): Promise<Ticket>;   // in the todo state
  get(id: TicketId): Promise<Ticket | undefined>;
  list(filter?: { readonly status?: string; readonly project?: string }): Promise<Ticket[]>;
  // Any state but go: the move to go is the human's approval, which only the
  // approval writer records (registry.ts ApprovalWriter, lane 8).
  move(id: TicketId, status: string, by: Actor): Promise<Ticket>;
  history(id: TicketId): Promise<StatusChange[]>;
  // Several tickets' history in one read, keyed by id, each as history gives
  // it; an id the store does not know is left out (mcp/lanes.ts reads every
  // open ticket's at once).
  histories(ids: readonly TicketId[]): Promise<Map<TicketId, StatusChange[]>>;
  comment(id: TicketId, body: string, by: Actor): Promise<Comment>;
  comments(id: TicketId): Promise<Comment[]>;
}

export class TicketError extends Error {
  override name = 'TicketError';
}

// The parts a new ticket starts with on the services it names, or undefined
// when it names none.
export function newTicketServices(names: readonly string[] | undefined): TicketService[] | undefined {
  if (names === undefined || names.length === 0) return undefined;
  if (new Set(names).size !== names.length) throw new TicketError('a ticket names each service once');
  return names.map((name) => ({ name, branch: null, pr: null, state: 'open' }));
}

type Entry = { ticket: Ticket; history: StatusChange[]; comments: Comment[] };

export class MemoryTicketStore implements TicketStore {
  readonly states: TicketStates;
  #now: () => string;
  #tickets = new Map<TicketId, Entry>();
  #comments = 0;

  constructor(options: { readonly states?: TicketStates; readonly now?: () => string } = {}) {
    this.states = options.states ?? DEFAULT_STATES;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #entry(id: TicketId): Entry {
    const entry = this.#tickets.get(id);
    if (!entry) throw new TicketError(`unknown ticket ${id}`);
    return entry;
  }

  #set(id: TicketId, status: string, by: Actor): Ticket {
    const entry = this.#entry(id);
    const at = this.#now();
    entry.ticket = { ...entry.ticket, status, updatedAt: at };
    entry.history.push({ status, by, at });
    return entry.ticket;
  }

  async create(ticket: NewTicket, by: Actor): Promise<Ticket> {
    const at = this.#now();
    const services = newTicketServices(ticket.services);
    const created: Ticket = {
      id: `LOCAL-${this.#tickets.size + 1}`, title: ticket.title, body: ticket.body ?? '', labels: [...(ticket.labels ?? [])],
      project: ticket.project, status: this.states.todo, createdAt: at, updatedAt: at, ...(services ? { services } : {}),
    };
    this.#tickets.set(created.id, { ticket: created, history: [{ status: created.status, by, at }], comments: [] });
    return created;
  }

  async get(id: TicketId): Promise<Ticket | undefined> {
    return this.#tickets.get(id)?.ticket;
  }

  async list(filter: { readonly status?: string; readonly project?: string } = {}): Promise<Ticket[]> {
    return [...this.#tickets.values()].map((e) => e.ticket)
      .filter((t) => (filter.status === undefined || t.status === filter.status) && (filter.project === undefined || t.project === filter.project));
  }

  async move(id: TicketId, status: string, by: Actor): Promise<Ticket> {
    this.#entry(id);
    if (status === this.states.go) throw new TicketError(`${status} is written by the approval writer only, after the human's approval`);
    if (!Object.values(this.states).includes(status)) throw new TicketError(`unknown state ${status}`);
    return this.#set(id, status, by);
  }

  // What the in-memory approval writer calls: the human's move to go.
  async recordApproval(id: TicketId, by: Extract<Actor, { kind: 'human' }>): Promise<Ticket> {
    if (by.kind !== 'human') throw new TicketError('only a human approves a ticket');
    return this.#set(id, this.states.go, by);
  }

  async history(id: TicketId): Promise<StatusChange[]> {
    return [...this.#entry(id).history];
  }

  async histories(ids: readonly TicketId[]): Promise<Map<TicketId, StatusChange[]>> {
    const out = new Map<TicketId, StatusChange[]>();
    for (const id of ids) {
      const entry = this.#tickets.get(id);
      if (entry) out.set(id, [...entry.history]);
    }
    return out;
  }

  async comment(id: TicketId, body: string, by: Actor): Promise<Comment> {
    const entry = this.#entry(id);
    const comment: Comment = { id: String(++this.#comments), body, by, createdAt: this.#now() };
    entry.comments.push(comment);
    return comment;
  }

  async comments(id: TicketId): Promise<Comment[]> {
    return [...this.#entry(id).comments];
  }
}
