// The idle watchdog (issue #290): a session idle longer than the idle stop
// (CLEARED_V2_IDLE_MINUTES, 15), waiting for a person included, is
// stopped. It is independent of the flow: its own timer, and what it reads
// is the ledger, the sessions' rows and the time of each one's last event,
// not what an engine keeps in memory, so a session no engine runs any more
// is stopped too.
//
//   - The engine that runs the session stops it itself (FlowEngine.idleStop):
//     one that waits for a person keeps its question in the inbox and is
//     resumed by the answer; one the owner took over is left to the owner.
//   - Then, and for a session nobody runs, its containers and networks,
//     labelled cleared.dev=v2 and named after it, are removed by name
//     (Docker.releaseStopped); its volume, which holds the harness's
//     transcript, stays for a resume. A session nobody runs has its row
//     stopped and a RUN_ERROR `idle` in its timeline.
//   - Each stop is a `session_idle_stopped` row of the ledger's events table.
//
// The permanent lead is not stopped: it waits between events by design, and
// the lead engine ends and starts its generations itself.
import { sessionNames } from '../container/session-runtime.ts';
import { ledgerEvent } from '../store/ledger-events.ts';
import type { Store } from '../store/db.ts';
import type { SessionId } from './contract.ts';

// What the engine that runs a session did with it.
export type IdleOutcome = 'stopped' | 'skipped' | 'unknown';

export type IdleStop = {
  readonly session: SessionId;
  readonly ticket: string;
  readonly by: 'engine' | 'watchdog';                // who stopped the session itself
  readonly containers: readonly string[];
  readonly networks: readonly string[];
};

export type WatchdogDeps = {
  readonly store: Pick<Store, 'db' | 'events' | 'sessions'>;
  readonly project: string;
  readonly idleMs: number;
  readonly now?: () => Date;
  // The engine's stop of a session it runs; absent, every session is nobody's.
  readonly owner?: (session: SessionId) => Promise<IdleOutcome>;
  // Removes the session's labelled containers and networks by name; never a volume.
  readonly release: (session: SessionId) => Promise<{ readonly containers: readonly string[]; readonly networks: readonly string[] }>;
};

const LIVE = ['starting', 'working', 'waiting_human', 'reviewing'];
const WATCHED = ['author', 'reviewer', 'reader'];

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

export class IdleWatchdog {
  #deps: WatchdogDeps;
  #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<IdleStop[]> | undefined;

  constructor(deps: WatchdogDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  // Ticks every `ms` until close(); the timer never keeps the process alive.
  startTimer(ms = 60_000): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick().catch((error) => console.error(`cleared-v2: the idle watchdog failed (${errorName(error)})`)); }, ms);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  // One pass at a time; a pass asked while one runs gets that one's stops.
  tick(): Promise<IdleStop[]> {
    this.#running ??= this.#pass().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  // The project's live author, reviewer and reader sessions whose last
  // event, or their row's last change, is older than the idle stop.
  #idle(): { id: SessionId; ticket: string; role: string; status: string; minutes: number }[] {
    const now = this.#now().getTime();
    const rows = this.#deps.store.db.prepare(`SELECT s.id, s.ticket, s.role, s.status, s.updated_at AS updated, (SELECT MAX(e.at) FROM session_events e WHERE e.session_id = s.id) AS last
      FROM sessions s WHERE s.project = ? AND s.status IN (${LIVE.map(() => '?').join(', ')}) AND s.role IN (${WATCHED.map(() => '?').join(', ')}) ORDER BY s.created_at, s.id`)
      .all(this.#deps.project, ...LIVE, ...WATCHED) as { id: string; ticket: string; role: string; status: string; updated: string; last: string | null }[];
    return rows.flatMap((row) => {
      const last = Math.max(Date.parse(row.updated), row.last ? Date.parse(row.last) : -Infinity);
      const idle = now - last;
      return idle >= this.#deps.idleMs ? [{ id: row.id, ticket: row.ticket, role: row.role, status: row.status, minutes: Math.floor(idle / 60_000) }] : [];
    });
  }

  async #pass(): Promise<IdleStop[]> {
    const stops: IdleStop[] = [];
    for (const row of this.#idle()) {
      let outcome: IdleOutcome = 'unknown';
      try {
        outcome = this.#deps.owner ? await this.#deps.owner(row.id) : 'unknown';
      } catch (error) {
        console.error(`cleared-v2: the engine could not stop the idle session ${row.id} (${errorName(error)}); the watchdog stops it`);
      }
      if (outcome === 'skipped') continue;
      const at = this.#now().toISOString();
      if (outcome === 'unknown') {
        const record = this.#deps.store.sessions.get(row.id);
        this.#deps.store.events.append({ at, sessionId: row.id, ticket: row.ticket, project: this.#deps.project,
          event: { type: 'RUN_ERROR', message: `No activity for ${row.minutes} minutes: the watchdog stopped the session and its containers, and kept its volume for a resume.`, code: 'idle' } });
        if (record) this.#deps.store.sessions.put({ ...record, status: 'stopped', updatedAt: at });
      }
      let released: { readonly containers: readonly string[]; readonly networks: readonly string[] } = { containers: [], networks: [] };
      try {
        released = await this.#deps.release(row.id);
      } catch (error) {
        console.error(`cleared-v2: the containers of the idle session ${row.id} could not be removed (${errorName(error)})`);
      }
      const by = outcome === 'stopped' ? 'engine' : 'watchdog';
      ledgerEvent(this.#deps.store.db, {
        at, kind: 'session_idle_stopped', ticket: row.ticket, source: 'watchdog',
        detail: {
          session: row.id, role: row.role, status: row.status, idleMinutes: row.minutes, by,
          containers: released.containers, networks: released.networks, kept: [sessionNames(row.id).volume],
        },
      });
      stops.push({ session: row.id, ticket: row.ticket, by, containers: released.containers, networks: released.networks });
    }
    return stops;
  }
}
