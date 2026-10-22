// A lane 8 service in a box: the ticket store and approval writer of the
// lane over a temporary ledger, with a fake clock, fake timers and a fake
// broker, so a test steps through the 60 second grace without waiting.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LockApprovalWriter, type Timers } from '../../src/approval/writer.ts';
import { ApprovalSigner } from '../../src/approval/signer.ts';
import { createApproval, APPROVAL_TABLES } from '../../src/approval/service.ts';
import { TICKET_TABLES, LocalTicketStore } from '../../src/tickets/local-store.ts';
import type { ReleaseBrokerRequest } from '../../src/approval/broker.ts';
import { MemoryUsers } from '../../src/modules/registry.ts';
import { applyTables } from '../../src/store/db.ts';
import { OWNER, lockBox } from './harness.ts';

export const PROOF = 'a'.repeat(64);
export const head = (c: string) => c.repeat(40);

export class FakeTimers implements Timers {
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  #next = 1;
  set(fn: () => void, ms: number): number { const id = this.#next++; this.pending.set(id, { fn, ms }); return id; }
  clear(id: unknown): void { this.pending.delete(id as number); }
  // Runs every timer set so far, in order, and waits for what they started.
  async fire(): Promise<void> {
    const due = [...this.pending.entries()];
    this.pending.clear();
    for (const [, timer] of due) timer.fn();
    await settle();
  }
}

export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

export class FakeBroker {
  readonly requests: ReleaseBrokerRequest[] = [];
  answer: { ok: boolean; output: string; reason: string } = { ok: true, output: 'merged', reason: '' };
  async requestRelease(request: ReleaseBrokerRequest) { this.requests.push(request); return this.answer; }
}

export async function service(options: { broker?: FakeBroker | null; withKey?: boolean; realClock?: boolean; proof?: string; ownerId?: string } = {}) {
  const box = lockBox();
  const db = new DatabaseSync(join(box.state, 'ledger.db'));
  db.exec('PRAGMA busy_timeout = 5000');
  applyTables(db, [...TICKET_TABLES, ...APPROVAL_TABLES]);
  const users = new MemoryUsers();
  users.users.set('u-owner', { id: 'u-owner', name: OWNER });
  users.users.set('u-guest', { id: 'u-guest', name: 'guest' });
  users.users.set('u-alice', { id: 'u-alice', name: 'alice' });
  const timers = new FakeTimers();
  const broker = options.broker === undefined ? new FakeBroker() : options.broker;
  let clock = Date.UTC(2026, 9, 21, 10, 0, 0);
  const now = () => new Date(clock);
  const advance = (ms: number) => { clock += ms; };
  const signer = options.withKey === false ? undefined : ApprovalSigner.load(box.keyFile);
  const parts = createApproval({
    db, users, stateDir: box.state, ownerId: options.ownerId ?? OWNER, publicKey: box.keys.publicKey, ...(signer ? { signer } : {}),
    proof: options.proof ?? PROOF, verdict: 'no blocking issues', timers, broker, ...(options.realClock ? {} : { now }),
  });
  const store = parts.ticketStore;
  const writer = parts.approvalWriter;
  // What ask-validation.sh keeps for a ticket (the shown versions).
  const ask = (heads: { pr: number; head: string }[], at = '2026-10-21T09:59:00.123456789Z', ticket = 'LOCAL-1') => {
    mkdirSync(join(box.state, 'validations'), { recursive: true });
    writeFileSync(join(box.state, 'validations', `${ticket}.json`), JSON.stringify({ ticket, at, pulls: heads }));
    return { ticket, requestedAt: at, heads };
  };
  const service = { kind: 'agents' as const, id: 'cleared-v2' };
  const waiting = async () => {
    const ticket = await store.create({ title: 'Newest entry first', body: 'The guestbook shows the newest entry first.', project: 'guestbook' }, service);
    await store.move(ticket.id, 'Needs Approval', service);
    return ticket;
  };
  const events = () => (db.prepare("SELECT kind, ticket, detail, source FROM events WHERE kind = 'app_gesture' ORDER BY event_id").all() as { kind: string; ticket: string; detail: string; source: string }[])
    .map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
  return { box, db, users, timers, broker, store: store as LocalTicketStore, writer: writer as LockApprovalWriter, parts, ask, waiting, events, advance, now };
}
