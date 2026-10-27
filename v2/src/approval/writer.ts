// The service's approval writer: an approval is held for 60 seconds, during
// which Undo writes nothing; then the checks are made again and the human's
// move to the go state is signed and written; then the lock is asked to put
// the change live. The human is the signed-in owner of the app; the service
// holds the key (plan, decision 6). Held approvals live in memory: a restart
// of the service during the grace loses them and writes nothing, so the app
// shows the ticket still waiting and the owner approves again.
import type { DatabaseSync } from 'node:sqlite';
import type { ApprovalRequest, ApprovalWriter, UserDirectory } from '../modules/registry.ts';
import type { LocalTicketStore } from '../tickets/local-store.ts';
import type { Ticket } from '../tickets/contract.ts';
import { sameProof } from '../modules/users.ts';
import type { ReleaseBroker } from './broker.ts';
import { ApprovalError } from './errors.ts';
import type { Version } from './record.ts';

export const GRACE_MS = 60_000;

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref(); return handle; },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// The writer the route needs: the registry's ApprovalWriter, with the grace.
export interface GraceApprovalWriter extends ApprovalWriter {
  begin(request: ApprovalRequest): Promise<{ readonly dueAt: string }>;
  undo(ticket: string, by: string): Promise<{ readonly undone: boolean }>;
  verifyProof(given: unknown): boolean;
  readonly users: UserDirectory;
}

export const isGraceWriter = (writer: ApprovalWriter): writer is GraceApprovalWriter => typeof (writer as Partial<GraceApprovalWriter>).begin === 'function';

export type WriterOptions = {
  readonly store: LocalTicketStore;
  readonly db: DatabaseSync;
  readonly users: UserDirectory;
  readonly proof: string;                              // the shared secret the app shows on every request
  readonly ownerId?: string | undefined;               // [tracker] owner_id: the one user who approves
  readonly graceMs?: number;
  readonly timers?: Timers;
  readonly broker?: ReleaseBroker | null;              // null: the lock is not asked (the move is still written)
  readonly now?: () => Date;
  readonly announce?: (ticket: Ticket, by: string) => string;
};

type Held = { readonly request: ApprovalRequest; readonly handle: unknown; readonly dueAt: string };

const TICKET = /^LOCAL-[1-9][0-9]*$/;

// What the lock asks to be told before it merges: what changes, where to
// see it, how to check. The owner's own request text lives on the ticket;
// this is the short form the merge comment carries.
const defaultAnnouncement = (ticket: Ticket, by: string) =>
  `${ticket.title}\n\n${ticket.body}\n\nApproved in the Cleared app by ${by}. Open the project's page to see the change.`;

const short = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300);

export class LockApprovalWriter implements GraceApprovalWriter {
  readonly users: UserDirectory;
  readonly #options: WriterOptions;
  readonly #held = new Map<string, Held>();

  constructor(options: WriterOptions) {
    this.#options = options;
    this.users = options.users;
  }

  verifyProof(given: unknown): boolean {
    // No proof configured (its file could not be read) refuses everything, the empty header included.
    if (!this.#options.proof) return false;
    return sameProof(given, this.#options.proof);
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date();
  }

  #event(ticket: string, detail: Record<string, unknown>): void {
    this.#options.db.prepare("INSERT INTO events (at, kind, ticket, detail, source) VALUES (?, 'app_gesture', ?, ?, 'app')")
      .run(this.#now().toISOString(), ticket, JSON.stringify({ gesture: 'approve', device: null, ...detail }));
  }

  // The user must be the owner: the one name the signed rows carry.
  async #owner(by: string): Promise<{ id: string; name: string }> {
    const user = await this.#options.users.get(by);
    if (!user) throw new ApprovalError('user', 'unknown user');
    // The owner given, else the store's as its keys say now (approval/service.ts reads them at each need).
    const owner = this.#options.ownerId ?? this.#options.store.ownerId;
    if (!owner || !this.#options.store.canSign) throw new ApprovalError('setup', 'approval is not set up: no signing key or [tracker] owner_id (npm run setup)');
    if (user.name !== owner) throw new ApprovalError('owner', 'only the owner approves');
    return user;
  }

  async begin(request: ApprovalRequest): Promise<{ readonly dueAt: string }> {
    if (!TICKET.test(request.ticket)) throw new ApprovalError('ticket', `no such ticket: ${request.ticket}`);
    await this.#owner(request.by);
    // From here to the timer there is no await: two approvals cannot both pass.
    if (this.#held.has(request.ticket)) throw new ApprovalError('pending', 'an approval for this ticket is already held');
    this.#options.store.checkApproval(request.ticket, request);
    const dueAt = new Date(this.#now().getTime() + (this.#options.graceMs ?? GRACE_MS)).toISOString();
    const handle = (this.#options.timers ?? realTimers).set(() => { void this.#write(request.ticket); }, this.#options.graceMs ?? GRACE_MS);
    this.#held.set(request.ticket, { request, handle, dueAt });
    this.#event(request.ticket, { result: 'started', user: request.by, version: request.heads, dueAt });
    return { dueAt };
  }

  // The registry's contract: accept the approval (it is written after the grace).
  async approve(request: ApprovalRequest): Promise<void> {
    await this.begin(request);
  }

  async undo(ticket: string, by: string): Promise<{ readonly undone: boolean }> {
    await this.#owner(by);
    const held = this.#held.get(ticket);
    if (!held) return { undone: false };
    (this.#options.timers ?? realTimers).clear(held.handle);
    this.#held.delete(ticket);
    this.#event(ticket, { result: 'undone', user: by, version: held.request.heads });
    return { undone: true };
  }

  async #write(ticket: string): Promise<void> {
    const held = this.#held.get(ticket);
    if (!held) return;
    this.#held.delete(ticket);                         // from now on Undo is too late
    const { request } = held;
    try {
      await this.#options.store.recordApproval(ticket, request);
    } catch (error) {
      const reason = error instanceof ApprovalError ? `${error.code}: ${error.message}` : 'internal error';
      if (!(error instanceof ApprovalError)) console.error(`cleared-v2: approval of ${ticket} failed (${error instanceof Error ? error.name : typeof error})`);
      this.#event(ticket, { result: 'refused', user: request.by, version: request.heads, reason });
      return;
    }
    this.#event(ticket, { result: 'written', user: request.by, version: request.heads });
    await this.#askTheLock(request);
  }

  async #askTheLock(request: ApprovalRequest): Promise<void> {
    const broker = this.#options.broker;
    if (!broker) return;
    try {
      const ticket = await this.#options.store.get(request.ticket);
      const user = await this.#options.users.get(request.by);
      const announcement = (this.#options.announce ?? defaultAnnouncement)(ticket as Ticket, user?.name ?? 'the owner');
      for (const { pr } of [...request.heads].sort((a: Version, b: Version) => a.pr - b.pr)) {
        const answer = await broker.requestRelease({ ticket: request.ticket, pr, announcement });
        if (!answer.ok) {
          this.#event(request.ticket, { result: 'release_refused', user: request.by, pr, reason: short(answer.reason || answer.output) });
          return;
        }
      }
    } catch (error) {
      console.error(`cleared-v2: asking the lock for ${request.ticket} failed (${error instanceof Error ? error.name : typeof error})`);
      this.#event(request.ticket, { result: 'release_refused', user: request.by, reason: 'the lock could not be asked' });
    }
  }
}
