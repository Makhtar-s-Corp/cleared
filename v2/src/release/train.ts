// The landing of a release train (docs/v2/milestone-2-plan.md, decision 21),
// run by the flow's tick. Once the owner approved the card, each service
// lands in turn, providers first: its lock is asked to merge
// (`request_release`), its watch is read from the shared ledger until a
// healthy verdict, and only then is the next one asked. A failing watch
// rolls its own service back (its `auto_rollback`); the train then asks
// `request_rollback` of each service that landed before it, newest first.
//
// One approval, several locks. merge-pr.ts of each service reads the
// owner's move to go against its own validations record, and closes the
// ticket once every pull request that record shows is merged, which is its
// own one. So the owner's signed move of the approval is bound to the first
// service's record, and before each later service lands the ticket is put
// back in the validate state and the owner's move is signed again, bound to
// that service's record, after its lock checked that the record still holds
// exactly the head the card showed. A record that changed since signs
// nothing: the train halts and the ticket goes back with the reason.
import type { DatabaseSync } from 'node:sqlite';
import type { TrainState } from '../api/types.ts';
import type { FlowEvent, PutBackReason } from '../flow/events.ts';
import { atOrAfter, landingOf } from '../flow/ledger.ts';
import type { Actor, TicketId, TicketStore } from '../tickets/contract.ts';
import type { MergeOutcome, ServiceLock } from './lock.ts';
import { view, type Stop, type Train, type TrainStore } from './store.ts';

const SERVICE: Actor = { kind: 'agents', id: 'cleared-v2' };

export type TrainDeps = {
  readonly db: DatabaseSync;
  readonly trains: TrainStore;
  readonly tickets: TicketStore;
  readonly lock: (service: string) => ServiceLock;
  readonly project: string;
  readonly retryMs: number;                                          // a merge a lock queued is asked again after this long
  readonly now: () => Date;
  readonly clean: (text: string) => string;
  readonly emit: (event: FlowEvent) => void;
  readonly card: (item: string, train: TrainState) => void;         // the release item shows the train as it is now
  readonly putBack: (ticket: TicketId, note: string, reason: PutBackReason) => Promise<boolean>;
  readonly track: <T>(promise: Promise<T>) => Promise<T>;           // the flow's own bookkeeping of what runs
};

const name = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const and = (names: readonly string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const be = (names: readonly string[]) => (names.length === 1 ? 'is' : 'are');

export class TrainRunner {
  readonly #deps: TrainDeps;
  readonly #inFlight = new Set<string>();

  constructor(deps: TrainDeps) {
    this.#deps = deps;
  }

  // One step of every train not over yet. A train being driven is left
  // alone, so a lock is never asked twice for one step.
  tick(): void {
    for (const train of this.#deps.trains.active(this.#deps.project)) {
      if (train.state === 'blocked' || this.#inFlight.has(train.item)) continue;
      this.#inFlight.add(train.item);
      void this.#deps.track(this.#drive(train)
        .catch((error: unknown) => console.error(`cleared-v2: the train of ${train.ticket} failed a step, the next tick tries again (${error instanceof Error ? error.name : typeof error})`))
        .finally(() => { this.#inFlight.delete(train.item); }));
    }
  }

  #at(): string {
    return this.#deps.now().toISOString();
  }

  #save(train: Train, change: { readonly state?: Train['state']; readonly stops?: readonly Stop[] }): Train {
    const saved = this.#deps.trains.update(train.item, change);
    this.#deps.card(saved.item, view(saved));
    return saved;
  }

  #stop(train: Train, index: number, change: Partial<Stop>, state?: Train['state']): Train {
    const stops = train.stops.map((stop, i) => (i === index ? { ...stop, ...change } : stop));
    return this.#save(train, { stops, ...(state ? { state } : {}) });
  }

  async #drive(start: Train): Promise<void> {
    const { tickets } = this.#deps;
    const states = tickets.states;
    let train = start;
    const ticket = await tickets.get(train.ticket);
    if (!ticket) return;
    if (train.state === 'waiting') {
      const first = train.stops[0];
      if (!first) return;
      const history = await tickets.history(train.ticket);
      const approved = history.some((h) => h.status === states.go && h.by.kind === 'human' && atOrAfter(h.at, first.requestedAt));
      if (!approved) {
        // Sent back before any approval: this train is over, a new flow makes another.
        if (ticket.status === states.todo || ticket.status === states.progress || ticket.status === states.review) this.#save(train, { state: 'halted' });
        return;
      }
      // The owner's own move is bound to the first service's record.
      train = this.#stop(train, 0, { signed: true }, 'landing');
    }
    const index = train.stops.findIndex((stop) => stop.state !== 'healthy');
    const stop = train.stops[index];
    if (!stop) return;
    if (stop.state === 'waiting') await this.#land(train, index);
    else if (stop.state === 'merged') await this.#watch(train, index);
  }

  async #land(train: Train, index: number): Promise<void> {
    const { tickets } = this.#deps;
    const stop = train.stops[index] as Stop;
    if (stop.next && this.#deps.now().getTime() < Date.parse(stop.next)) return;
    const lock = this.#deps.lock(stop.service);
    let current = train;
    if (!stop.signed) {
      if (!train.approver) return this.#halt(train, index, `${stop.service} was not landed: nobody is recorded as having approved the card, so no move can be signed for it`);
      const why = lock.check({ ticket: train.ticket, requestedAt: stop.requestedAt, head: { pr: stop.pr.number, head: stop.head } });
      if (why) return this.#halt(train, index, `${stop.service} was not landed: ${why}`);
      if ((await tickets.get(train.ticket))?.status !== tickets.states.validate) await tickets.move(train.ticket, tickets.states.validate, SERVICE);
      try {
        await lock.sign({ ticket: train.ticket, by: train.approver, requestedAt: stop.requestedAt, heads: [{ pr: stop.pr.number, head: stop.head }] });
      } catch (error) {
        return this.#halt(train, index, `${stop.service} was not landed: ${name(error)}`);
      }
      current = this.#stop(train, index, { signed: true });
    }
    // Kept before the call: a process that stops during it leaves the time,
    // and the next one reads the ledger before asking again.
    const askedAt = stop.askedAt ?? this.#at();
    if (!stop.askedAt) current = this.#stop(current, index, { askedAt });
    else {
      const landing = landingOf(this.#deps.db, { ticket: train.ticket, pr: stop.pr.number, since: askedAt });
      if (landing.state !== 'waiting') {
        current = this.#stop(current, index, { state: 'merged', at: landing.mergedAt, mergedAt: landing.mergedAt, next: null });
        this.#deps.emit({ type: 'release_merged', at: landing.mergedAt, project: train.project, ticket: train.ticket, pr: stop.pr.number, service: stop.service });
        return this.#notDone(current, index);
      }
    }
    let merge: MergeOutcome;
    try {
      merge = await lock.release({ ticket: train.ticket, pr: stop.pr.number, announcement: train.announcement });
    } catch (error) {
      merge = { outcome: 'unavailable', message: name(error) };
    }
    const now = this.#at();
    if (merge.outcome === 'merged') {
      current = this.#stop(current, index, { state: 'merged', at: now, mergedAt: now, askedAt, next: null });
      this.#deps.emit({ type: 'release_merged', at: now, project: train.project, ticket: train.ticket, pr: stop.pr.number, service: stop.service });
      await this.#notDone(current, index);
    } else if (merge.outcome === 'refused') {
      return this.#halt(current, index, `The lock of ${stop.service} refused to merge pull request #${stop.pr.number}: ${merge.message || 'no reason given'}`);
    } else {
      this.#stop(current, index, { askedAt, next: new Date(this.#deps.now().getTime() + this.#deps.retryMs).toISOString() });
    }
  }

  // merge-pr.ts closes the ticket once its own record is merged: while
  // services are still to land, the ticket waits in the validate state, not Done.
  async #notDone(train: Train, index: number): Promise<void> {
    const { tickets } = this.#deps;
    if (index >= train.stops.length - 1) return;
    if ((await tickets.get(train.ticket))?.status === tickets.states.done) await tickets.move(train.ticket, tickets.states.validate, SERVICE);
  }

  async #watch(train: Train, index: number): Promise<void> {
    const { tickets } = this.#deps;
    const stop = train.stops[index] as Stop;
    const landing = landingOf(this.#deps.db, { ticket: train.ticket, pr: stop.pr.number, since: stop.askedAt ?? stop.mergedAt ?? this.#at(), ...(stop.mergedAt ? { mergedHere: stop.mergedAt } : {}) });
    if (landing.state === 'waiting' || landing.state === 'merged') return;
    const base = { project: train.project, ticket: train.ticket, pr: stop.pr.number, service: stop.service };
    if (landing.state === 'landed') {
      const last = index === train.stops.length - 1;
      const saved = this.#stop(train, index, { state: 'healthy', at: landing.at }, last ? 'landed' : undefined);
      if (!last) return this.#notDone(saved, index);
      const status = (await tickets.get(train.ticket))?.status;
      if (status === tickets.states.go || status === tickets.states.validate) await tickets.move(train.ticket, tickets.states.done, SERVICE);
      this.#deps.emit({ type: 'release_landed', at: landing.at, ...base, health: landing.health, services: train.stops.map((s) => s.service) });
      return;
    }
    if (landing.state === 'unhealthy') {
      const note = this.#deps.clean(landing.note);
      this.#stop(train, index, { state: 'failed', at: landing.at, note }, 'halted');
      const rest = train.stops.slice(index + 1).map((s) => s.service);
      await tickets.comment(train.ticket, this.#deps.clean(`${stop.service} is live, but its release watch did not end healthy: ${note}. Nothing was reverted${rest.length ? `, and ${and(rest)} ${be(rest)} not landed` : ''}: look at the release and decide.`), SERVICE).catch(() => undefined);
      this.#deps.emit({ type: 'release_unhealthy', at: landing.at, ...base, note });
      return;
    }
    // Rolled back by its own watch: the services that landed before it are rolled back, newest first.
    const note = this.#deps.clean(landing.note);
    let current = this.#stop(train, index, { state: 'reverted', at: landing.at, note });
    const reverted: string[] = [stop.service];
    const live: string[] = [];
    for (let i = index - 1; i >= 0; i--) {
      const earlier = current.stops[i] as Stop;
      if (earlier.state !== 'healthy' && earlier.state !== 'merged') continue;
      let answer: { ok: boolean; message: string };
      try {
        answer = await this.#deps.lock(earlier.service).rollback({ ticket: train.ticket });
      } catch (error) {
        answer = { ok: false, message: name(error) };
      }
      if (answer.ok) {
        current = this.#stop(current, i, { state: 'reverted', at: this.#at() });
        reverted.push(earlier.service);
      } else {
        current = this.#stop(current, i, { note: this.#deps.clean(`could not be rolled back: ${answer.message || 'the lock gave no reason'}`) });
        live.push(earlier.service);
      }
    }
    this.#save(current, { state: 'rolled_back' });
    const notLanded = train.stops.slice(index + 1).map((s) => s.service);
    const told = [
      `The release train was rolled back: ${stop.service} failed its release watch and its own rollback reverted it (${note}).`,
      reverted.length > 1 ? `Then ${and(reverted.slice(1))} ${reverted.length === 2 ? 'was' : 'were'} rolled back, newest first.` : '',
      live.length ? `${and(live)} ${be(live)} still live: ${live.length === 1 ? 'its' : 'their'} rollback was refused; revert ${live.length === 1 ? 'it' : 'them'} by hand.` : '',
      notLanded.length ? `${and(notLanded)} ${be(notLanded)} not landed.` : '',
      'The ticket is back in Todo.',
    ].filter(Boolean).join(' ');
    this.#deps.emit({ type: 'rolled_back', at: landing.at, ...base, note });
    await this.#deps.putBack(train.ticket, told, 'rolled_back');
  }

  // The train cannot go on: what landed stays live, the ticket goes back with the reason.
  async #halt(train: Train, index: number, reason: string): Promise<void> {
    const note = this.#deps.clean(reason);
    const saved = this.#stop(train, index, { note }, 'halted');
    const live = saved.stops.filter((s) => s.state === 'healthy' || s.state === 'merged').map((s) => s.service);
    const left = saved.stops.slice(index).map((s) => s.service);
    const told = `${note}. ${live.length ? `${and(live)} ${be(live)} live; ` : ''}${and(left)} ${be(left)} not landed. Move the ticket to Todo to start it again.`;
    await this.#deps.putBack(train.ticket, told, 'train_halted');
  }
}
