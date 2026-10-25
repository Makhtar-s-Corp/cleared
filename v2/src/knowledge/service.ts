// Knowledge is proposed, then approved in the inbox, then landed in the
// skill (docs/v2/milestone-2-plan.md, decision 27, lane 24).
//
//   - Proposed: a stored handover's lessons and decisions (proposals.ts)
//     become `knowledge` inbox items, through the cleaner, at their level:
//     the workspace's, the session's service's, or the contract's (the
//     service's own, else the first it consumes, as lane 19 files lessons).
//   - Approved: the owner's Approve writes the entry into lib/memory at its
//     level at once (memory.ts), then handles the item and queues the entry
//     for the skill of each service it concerns. Reject handles the item and
//     writes nothing.
//   - Landed: once a day, from SKILL_HOUR, or on "Update the skill now", a
//     Quick ticket per service with something queued asks for the whole
//     skill file (skill.ts); it lands through the lock like any change.
//
// Only the owner answers: the signed-in user whose name is [tracker]
// owner_id, the one user lib/memory lets approve. v1's approval by comment is
// not carried over.
import { basename, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeItem, KnowledgeLevel } from '../api/types.ts';
import { QUICK_LABEL } from '../flow/engine.ts';
import type { InboxStore } from '../inbox/store.ts';
import type { User } from '../modules/registry.ts';
import type { SessionId } from '../session/contract.ts';
import type { Actor, TicketId, TicketStore } from '../tickets/contract.ts';
import { ensureLevel, levelContext, type MemoryContext, type MemoryLevel } from '../workspace/briefing.ts';
import type { ServiceConfig, WorkspaceConfig } from '../workspace/config.ts';
import type { CapturedHandover } from '../workspace/handover.ts';
import { writeApproved, type MemoryWrite } from './memory.ts';
import { proposalsOf } from './proposals.ts';
import { skillTicket } from './skill.ts';
import { KnowledgeStore, type SkillRow } from './store.ts';

export type { MemoryWrite } from './memory.ts';

// The hour of the server's day from which the daily skill tickets are made.
export const SKILL_HOUR = 3;
// How often the daily tickets are looked for.
export const TICK_MS = 10 * 60_000;

// The flow's own identity, which writes the skill tickets.
const SERVICE: Actor = { kind: 'agents', id: 'cleared-v2' };

export class KnowledgeError extends Error {
  override name = 'KnowledgeError';
  readonly kind: 'not_found' | 'conflict' | 'forbidden' | 'unavailable';
  constructor(kind: KnowledgeError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

export type KnowledgeDeps = {
  readonly db: DatabaseSync;
  readonly inbox: InboxStore;
  readonly tickets: TicketStore;
  readonly workspace: WorkspaceConfig;
  readonly memory: MemoryContext;                       // the workspace's: its first service's checkout, the service's environment
  readonly ownerId: string | undefined;                 // [tracker] owner_id: the name of the one user who approves
  readonly clean: (text: string) => string;
  readonly now?: () => Date;
  readonly serviceOf?: (session: SessionId) => string | null | undefined;   // the session's service, as the store has it
  readonly write?: MemoryWrite;
};

// The server's day of a time, as a schedule reads it: its own time zone.
function dayOf(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class Knowledge {
  readonly #deps: KnowledgeDeps;
  readonly #store: KnowledgeStore;
  readonly #now: () => Date;
  readonly #write: MemoryWrite;
  // Items being answered and services whose ticket is being made, so a
  // double click answers once and a tick and a click make one ticket.
  readonly #answering = new Set<string>();
  readonly #making = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: KnowledgeDeps) {
    this.#deps = deps;
    this.#store = new KnowledgeStore(deps.db);
    this.#now = deps.now ?? (() => new Date());
    this.#write = deps.write ?? writeApproved;
  }

  #service(name: string): ServiceConfig | undefined {
    return this.#deps.workspace.services.find((service) => service.name === name);
  }

  // Where `## ... for the contract` goes for a session on `own`: its own
  // contract, else the first one it consumes (flow/effects.ts files lessons so).
  #contractOf(own: ServiceConfig | undefined): ServiceConfig | undefined {
    if (!own) return undefined;
    return [own, ...own.consumes.map((name) => this.#service(name))].find((service): service is ServiceConfig => !!service?.contract);
  }

  // ---- proposed --------------------------------------------------------------

  // The knowledge items of a stored handover, added to the inbox; the
  // session's service is the store's, else the one its lessons were filed
  // for, else the workspace's first. What a handover of the same ticket
  // already proposed at the same level, waiting or answered, is not proposed
  // again: an author reopened after a review writes its handover anew.
  propose(handover: CapturedHandover): KnowledgeItem[] {
    const proposals = proposalsOf(handover.content);
    if (proposals.length === 0) return [];
    const key = (level: KnowledgeLevel, service: string | null, text: string) => JSON.stringify([level, service, text]);
    const known = new Set([...this.#deps.inbox.knowledge({ ticket: handover.ticket }), ...this.#deps.inbox.knowledge({ ticket: handover.ticket, state: 'handled' })]
      .map((item) => key(item.level, item.service, item.text)));
    const name = this.#deps.serviceOf?.(handover.sessionId) ?? handover.service ?? this.#deps.workspace.services[0]?.name;
    const own = name ? this.#service(name) : undefined;
    // The contract the session's step builds against, when its handover names one (flow/effects.ts), else the first it has or consumes.
    const named = handover.contract ? this.#service(handover.contract) : undefined;
    const contract = named?.contract ? named : this.#contractOf(own);
    const items: KnowledgeItem[] = [];
    for (const proposal of proposals) {
      let level: KnowledgeLevel = proposal.level;
      let service: string | null = null;
      if (level === 'service' && own) service = own.name;
      else if (level === 'contract' && contract) service = contract.name;
      else level = 'workspace';
      const text = this.#deps.clean(proposal.text);
      if (known.has(key(level, service, text))) continue;
      known.add(key(level, service, text));
      const item = this.#deps.inbox.addKnowledge({ ticket: handover.ticket, project: this.#deps.workspace.id, sessionId: handover.sessionId, text, level, service });
      this.#store.setKind(item.id, proposal.kind);
      items.push(item);
    }
    return items;
  }

  // ---- approved or rejected --------------------------------------------------

  #owner(user: User): string {
    const owner = this.#deps.ownerId;
    if (!owner) throw new KnowledgeError('unavailable', 'knowledge is not set up: no [tracker] owner_id (npm run setup)');
    if (user.name !== owner) throw new KnowledgeError('forbidden', `only the owner (${owner}) approves or rejects knowledge`);
    return owner;
  }

  #waiting(id: string): KnowledgeItem {
    const item = this.#deps.inbox.item(id);
    if (!item || item.kind !== 'knowledge') throw new KnowledgeError('not_found', `no knowledge item ${id}`);
    if (item.state !== 'waiting' || this.#answering.has(id)) throw new KnowledgeError('conflict', `knowledge item ${id} is already answered`);
    return item;
  }

  // The memory an approved entry is written in: the workspace's; a
  // service's, unless its checkout is the workspace's, whose memory it then
  // is; a contract's, beside the contract in its provider's checkout.
  #memoryOf(item: KnowledgeItem): MemoryContext | MemoryLevel {
    const workspace = this.#deps.memory;
    const service = item.service ? this.#service(item.service) : undefined;
    if (item.level === 'service' && service && resolve(service.dir) !== resolve(workspace.project))
      return levelContext(workspace, { kind: 'service', name: service.name, project: service.dir });
    if (item.level === 'contract' && service?.contract)
      return levelContext(workspace, { kind: 'contract', name: service.name, project: service.dir, contract: service.contract.path });
    return workspace;
  }

  // The skills an approved entry goes into: every service's for the
  // workspace's; the service's own; for a contract, its provider's and each
  // of its consumers'.
  #skillsOf(item: KnowledgeItem): string[] {
    const services = this.#deps.workspace.services;
    if (item.level === 'workspace' || !item.service) return services.map((service) => service.name);
    if (item.level === 'service') return [item.service];
    return services.filter((service) => service.name === item.service || service.consumes.includes(item.service as string)).map((service) => service.name);
  }

  // Approve: the entry is written first, then the item handled, so a memory
  // that cannot be written leaves the item waiting for another try.
  async approve(id: string, user: User): Promise<void> {
    const owner = this.#owner(user);
    const item = this.#waiting(id);
    this.#answering.add(id);
    try {
      const kind = this.#store.kind(id);
      const memory = this.#memoryOf(item);
      if ('kind' in memory) ensureLevel(memory as MemoryLevel);
      await this.#write(memory, {
        scope: `project:${basename(memory.project)}`, content: kind === 'lesson' ? `Lesson: ${item.text}` : item.text,
        where: id, owner, ticket: item.ticket,
      });
      if (!this.#deps.inbox.handleKnowledge(id, user.id, 'approve')) throw new KnowledgeError('conflict', `knowledge item ${id} is already answered`);
      this.#store.queue({
        item: id, kind, level: item.level, provider: item.level === 'contract' ? item.service : null, text: item.text,
        approvedBy: user.id, approvedAt: this.#now().toISOString(),
      }, this.#skillsOf(item));
    } finally {
      this.#answering.delete(id);
    }
  }

  async reject(id: string, user: User): Promise<void> {
    this.#owner(user);
    this.#waiting(id);
    if (!this.#deps.inbox.handleKnowledge(id, user.id, 'reject')) throw new KnowledgeError('conflict', `knowledge item ${id} is already answered`);
  }

  // ---- landed in the skill ---------------------------------------------------

  queued(service: string): SkillRow[] {
    return this.#store.queued(service);
  }

  // A Quick ticket for the service's skill from what is queued, or null
  // when nothing is. The ticket asks for the whole file, every approved entry
  // of the service in it, so a ticket that never lands loses nothing the
  // next one does not carry.
  async #makeTicket(service: string, askedBy: User | null): Promise<TicketId | null> {
    if (this.#making.has(service)) return null;
    this.#making.add(service);
    try {
      const queued = this.#store.queued(service);
      if (queued.length === 0) return null;
      const entries = this.#store.approved(service).map((row) => ({ kind: row.kind, level: row.level, service: row.level === 'contract' ? row.provider : row.level === 'service' ? row.service : null, text: row.text }));
      const { title, body } = skillTicket({ service, workspace: this.#deps.workspace.name, entries, added: queued.length });
      const several = this.#deps.workspace.services.length > 1;
      const ticket = await this.#deps.tickets.create({ title, body, labels: [QUICK_LABEL], project: this.#deps.workspace.id, ...(several ? { services: [service] } : {}) }, SERVICE);
      const now = this.#now();
      this.#store.took({ ticket: ticket.id, service, items: queued.map((row) => row.item), day: dayOf(now), askedBy: askedBy?.id ?? null, at: now.toISOString() });
      const why = askedBy ? `Asked by ${askedBy.name} ("Update the skill now").` : 'The daily update of the skill.';
      await this.#deps.tickets.comment(ticket.id, `${why} It carries ${queued.length} new approved ${queued.length === 1 ? 'entry' : 'entries'} of the inbox.`, SERVICE).catch(() => undefined);
      return ticket.id;
    } finally {
      this.#making.delete(service);
    }
  }

  // "Update the skill now": the owner's, for one service, whatever the day.
  async updateSkill(service: string, user: User): Promise<TicketId | null> {
    this.#owner(user);
    if (!this.#service(service)) throw new KnowledgeError('not_found', `${service} is not a service of the workspace ${this.#deps.workspace.id}`);
    return this.#makeTicket(service, user);
  }

  // The daily tickets: from SKILL_HOUR, one per service with something
  // queued and no skill ticket made that day, in the workspace's order.
  async tick(): Promise<TicketId[]> {
    const now = this.#now();
    if (now.getHours() < SKILL_HOUR) return [];
    const day = dayOf(now);
    const waiting = new Set(this.#store.services());
    const made: TicketId[] = [];
    for (const { name } of this.#deps.workspace.services) {
      if (!waiting.has(name) || this.#store.ticketOn(name, day)) continue;
      try {
        const ticket = await this.#makeTicket(name, null);
        if (ticket) made.push(ticket);
      } catch (error) {
        console.error(`cleared-v2: the skill ticket of ${name} could not be made (${error instanceof Error ? error.name : typeof error})`);
      }
    }
    return made;
  }

  startTimer(ms: number = TICK_MS): void {
    if (this.#timer) return;
    const run = () => { void this.tick().catch((error) => console.error(`cleared-v2: the knowledge tick failed (${error instanceof Error ? error.name : typeof error})`)); };
    this.#timer = setInterval(run, ms);
    this.#timer.unref();
    run();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
