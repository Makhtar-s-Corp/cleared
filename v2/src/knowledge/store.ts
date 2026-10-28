// The knowledge module's tables (decision 27, lane 24), in ledger.db beside
// the inbox's. The inbox item is the proposal and holds its answer; these
// tables hold what the inbox shape has no field for:
//
//   knowledge_proposals  each item's kind (a lesson or a decision), kept
//                        when the handover proposes it;
//   knowledge_skill      what the owner approved, once per service whose
//                        skill it goes into, with the skill ticket that took
//                        it (null while it waits: the queue);
//   knowledge_skill_tickets  the skill tickets, per service and day, so the
//                        daily one is made once;
//   knowledge_rejected   the words of every item the owner rejected
//                        (fingerprint.ts), so the nightly pass never
//                        proposes the same rule again (issue #455).
import type { DatabaseSync } from 'node:sqlite';
import type { KnowledgeLevel } from '../api/types.ts';
import type { UserId } from '../session/contract.ts';
import type { TicketId } from '../tickets/contract.ts';
import type { ProposalKind } from './proposals.ts';

export const KNOWLEDGE_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS knowledge_proposals (
  item TEXT PRIMARY KEY, kind TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS knowledge_skill (
  item TEXT NOT NULL, service TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL, provider TEXT,
  text TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, ticket TEXT,
  PRIMARY KEY (item, service)
)`,
  `CREATE TABLE IF NOT EXISTS knowledge_skill_tickets (
  ticket TEXT PRIMARY KEY, service TEXT NOT NULL, day TEXT NOT NULL, asked_by TEXT, at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS knowledge_rejected (
  item TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, at TEXT NOT NULL
)`,
];

// An approved entry as a service's skill holds it. `provider` is the
// service whose contract a contract entry is about; null otherwise.
export type SkillRow = {
  readonly item: string;
  readonly service: string;
  readonly kind: ProposalKind;
  readonly level: KnowledgeLevel;
  readonly provider: string | null;
  readonly text: string;
  readonly approvedBy: UserId;
  readonly approvedAt: string;
  readonly ticket: TicketId | null;
};

type Row = Record<string, unknown>;

const skillRow = (row: Row): SkillRow => ({
  item: String(row.item), service: String(row.service), kind: String(row.kind) as ProposalKind, level: String(row.level) as KnowledgeLevel,
  provider: row.provider === null ? null : String(row.provider), text: String(row.text),
  approvedBy: String(row.approved_by), approvedAt: String(row.approved_at), ticket: row.ticket === null ? null : String(row.ticket),
});

export class KnowledgeStore {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  setKind(item: string, kind: ProposalKind): void {
    this.#db.prepare('INSERT OR REPLACE INTO knowledge_proposals (item, kind) VALUES (?, ?)').run(item, kind);
  }

  // A lesson unless the handover said decision; an item made elsewhere is a lesson.
  kind(item: string): ProposalKind {
    const row = this.#db.prepare('SELECT kind FROM knowledge_proposals WHERE item = ?').get(item) as Row | undefined;
    return row?.kind === 'decision' ? 'decision' : 'lesson';
  }

  // Queues an approved entry for the skill of each of `services`, in one transaction.
  queue(entry: Omit<SkillRow, 'service' | 'ticket'>, services: readonly string[]): void {
    const insert = this.#db.prepare('INSERT OR IGNORE INTO knowledge_skill (item, service, kind, level, provider, text, approved_by, approved_at, ticket) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const service of services) insert.run(entry.item, service, entry.kind, entry.level, entry.provider, entry.text, entry.approvedBy, entry.approvedAt);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  // What waits for the service's next skill ticket, in the order it was approved.
  queued(service: string): SkillRow[] {
    return (this.#db.prepare('SELECT * FROM knowledge_skill WHERE service = ? AND ticket IS NULL ORDER BY approved_at, rowid').all(service) as Row[]).map(skillRow);
  }

  // Every entry of the service's skill, in the order it was approved.
  approved(service: string): SkillRow[] {
    return (this.#db.prepare('SELECT * FROM knowledge_skill WHERE service = ? ORDER BY approved_at, rowid').all(service) as Row[]).map(skillRow);
  }

  // Every approved entry's text, whatever its service: what the memory holds from the inbox.
  approvedTexts(): string[] {
    return (this.#db.prepare('SELECT DISTINCT text FROM knowledge_skill').all() as Row[]).map((row) => String(row.text));
  }

  rejected(item: string, fingerprint: string, at: string): void {
    this.#db.prepare('INSERT OR IGNORE INTO knowledge_rejected (item, fingerprint, at) VALUES (?, ?, ?)').run(item, fingerprint, at);
  }

  rejectedFingerprints(): string[] {
    return (this.#db.prepare('SELECT DISTINCT fingerprint FROM knowledge_rejected').all() as Row[]).map((row) => String(row.fingerprint));
  }

  // The services with something queued.
  services(): string[] {
    return (this.#db.prepare('SELECT DISTINCT service FROM knowledge_skill WHERE ticket IS NULL').all() as Row[]).map((row) => String(row.service));
  }

  // The skill ticket made for the service on `day`, if one was.
  ticketOn(service: string, day: string): TicketId | undefined {
    const row = this.#db.prepare('SELECT ticket FROM knowledge_skill_tickets WHERE service = ? AND day = ? LIMIT 1').get(service, day) as Row | undefined;
    return row ? String(row.ticket) : undefined;
  }

  // The ticket takes the queued entries it was made from.
  took(input: { readonly ticket: TicketId; readonly service: string; readonly items: readonly string[]; readonly day: string; readonly askedBy: UserId | null; readonly at: string }): void {
    const take = this.#db.prepare('UPDATE knowledge_skill SET ticket = ? WHERE item = ? AND service = ? AND ticket IS NULL');
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of input.items) take.run(input.ticket, item, input.service);
      this.#db.prepare('INSERT INTO knowledge_skill_tickets (ticket, service, day, asked_by, at) VALUES (?, ?, ?, ?, ?)').run(input.ticket, input.service, input.day, input.askedBy, input.at);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}

// The service a ticket is the skill ticket of, or undefined for any other
// ticket and when the knowledge tables do not exist (the module not started).
export function skillTicketService(db: DatabaseSync, ticket: TicketId): string | undefined {
  try {
    const row = db.prepare('SELECT service FROM knowledge_skill_tickets WHERE ticket = ?').get(ticket) as Row | undefined;
    return row ? String(row.service) : undefined;
  } catch {
    return undefined;
  }
}
