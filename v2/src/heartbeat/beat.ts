// The v2 service's heartbeat (docs/v2/milestone-4-plan.md, section 7), kept
// from v1 (B2.1, lib/heartbeat.mjs). The service beats on its own timer:
// each beat writes its time, finds the problems, records each continuous
// problem once (v2_heartbeat_incidents, and a heartbeat_problem row of the
// ledger's events), then calls the monitor's success address with no
// problem, or its failure address with one. Only the problems' stable
// codes leave the host: never a ticket, a title, a session, a path or an
// address. A delivery that fails is one event an hour, with no address.
import type { DatabaseSync } from 'node:sqlite';
import { ledgerEvent } from '../store/ledger-events.ts';
import { monitorState, type HeartbeatSettings, type MonitorAddresses } from './settings.ts';
import { HEARTBEAT_STATE, collectSnapshot, stateOf, type Snapshot } from './snapshot.ts';

export const HEARTBEAT_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ${HEARTBEAT_STATE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  'CREATE TABLE IF NOT EXISTS v2_heartbeat_incidents (id TEXT PRIMARY KEY, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, active INTEGER NOT NULL)',
];

export const PROBLEM_CODES = ['beat_missing', 'beat_late', 'beat_failed', 'service_unreachable', 'monitor_invalid', 'monitor_off', 'session_stalled', 'tracker_stale'] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

// `problem` fails the beat and the status's exit code; `notice` is a
// standing condition the status says and the monitor never hears.
export type Problem = {
  readonly code: ProblemCode;
  readonly id: string;
  readonly level: 'problem' | 'notice';
  readonly values: Readonly<Record<string, string | number>>;
};

const problem = (code: ProblemCode, id: string, values: Problem['values'] = {}): Problem => ({ code, id, level: 'problem', values });
const minutesSince = (at: string, now: Date) => Math.floor((now.getTime() - Date.parse(at)) / 60_000);
export const failing = (problems: readonly Problem[]) => problems.filter((p) => p.level === 'problem');

// The status sees the beat from outside: missing, late, failed, and the
// service silent on its address. The service's own beat does not judge
// itself by its last row; it says a late previous beat itself.
export function diagnose(input: {
  readonly side: 'service' | 'status';
  readonly snapshot: Snapshot;
  readonly settings: HeartbeatSettings;
  readonly now: Date;
  readonly health?: { readonly address: string; readonly reachable: boolean };
}): Problem[] {
  const { snapshot, settings, now } = input;
  const out: Problem[] = [];
  if (input.side === 'status') {
    const beat = snapshot.lastBeat;
    if (!beat) out.push(problem('beat_missing', 'beat'));
    else {
      if (now.getTime() - Date.parse(beat.at) > 3 * beat.everyMs) out.push(problem('beat_late', 'beat', { minutes: minutesSince(beat.at, now) }));
      if (!beat.ok) out.push(problem('beat_failed', 'beat'));
    }
    if (input.health && !input.health.reachable) out.push(problem('service_unreachable', 'service', { address: input.health.address }));
  }
  if (snapshot.monitor?.state === 'invalid') out.push(problem('monitor_invalid', 'monitor', { variables: snapshot.monitor.refused.join(', ') }));
  if (snapshot.monitor?.state === 'off') out.push({ code: 'monitor_off', id: 'monitor', level: 'notice', values: {} });
  for (const session of snapshot.sessions) {
    const minutes = minutesSince(session.movedAt, now);
    if (minutes > settings.sessionMinutes) out.push(problem('session_stalled', session.id, { session: session.id, ticket: session.ticket, role: session.role, minutes }));
  }
  for (const tracker of snapshot.trackers) {
    const minutes = minutesSince(tracker.readAt, now);
    if (minutes > settings.trackerMinutes) out.push(problem('tracker_stale', tracker.name, { tracker: tracker.name, minutes }));
  }
  return out;
}

function put(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`INSERT INTO ${HEARTBEAT_STATE} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, value);
}

// Each continuous problem once: a new one is a heartbeat_problem event, one
// that lasts only moves its last_seen, one gone is no longer active.
export function recordIncidents(db: DatabaseSync, problems: readonly Problem[], at: string): void {
  const now = new Set<string>();
  for (const p of failing(problems)) {
    const id = `${p.code}:${p.id}`;
    now.add(id);
    const old = db.prepare('SELECT active FROM v2_heartbeat_incidents WHERE id = ?').get(id) as { active: number } | undefined;
    db.prepare(`INSERT INTO v2_heartbeat_incidents (id, first_seen, last_seen, active) VALUES (?, ?, ?, 1)
      ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen, active = 1`).run(id, at, at);
    if (!old?.active) ledgerEvent(db, { at, kind: 'heartbeat_problem', ticket: null, detail: { code: p.code, id: p.id }, source: 'heartbeat' });
  }
  for (const row of db.prepare('SELECT id FROM v2_heartbeat_incidents WHERE active = 1').all() as { id: string }[]) {
    if (!now.has(row.id)) db.prepare('UPDATE v2_heartbeat_incidents SET active = 0 WHERE id = ?').run(row.id);
  }
}

export type HeartbeatDeps = {
  readonly db: DatabaseSync;
  readonly settings: HeartbeatSettings;
  readonly monitor: MonitorAddresses;
  readonly project: string | null;
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
  readonly timeoutMs?: number;
};

export type BeatResult = { readonly problems: readonly Problem[]; readonly sent: 'ping' | 'fail' | null };

const HOUR_MS = 3_600_000;
const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

export class Heartbeat {
  #deps: HeartbeatDeps;
  #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<BeatResult> | undefined;

  constructor(deps: HeartbeatDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
  }

  // Beats at once, then every `ms` until close(); the timer never keeps the process alive.
  start(ms = this.#deps.settings.everyMs): void {
    if (this.#timer) return;
    const tick = () => { void this.beat().catch((error) => this.#log(`cleared-v2: the heartbeat failed (${errorName(error)})`)); };
    this.#timer = setInterval(tick, ms);
    this.#timer.unref();
    tick();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  // One beat at a time; a beat asked while one runs gets that one's result.
  beat(): Promise<BeatResult> {
    this.#running ??= this.#beat().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  #log(line: string): void {
    (this.#deps.log ?? ((text: string) => console.error(text)))(line);
  }

  async #beat(): Promise<BeatResult> {
    const { db, settings, monitor } = this.#deps;
    const now = this.#now();
    const at = now.toISOString();
    const previous = stateOf(db);
    put(db, 'monitor', monitorState(monitor));
    put(db, 'monitor_refused', monitor.refused.join(','));
    let problems: Problem[];
    let ok = true;
    try {
      problems = diagnose({ side: 'service', snapshot: collectSnapshot(db, { settings, project: this.#deps.project, now }), settings, now });
    } catch (error) {
      ok = false;
      problems = [problem('beat_failed', 'beat')];
      this.#log(`cleared-v2: the heartbeat could not read the ledger (${errorName(error)})`);
    }
    const before = previous.get('last_beat_at');
    const every = Number(previous.get('beat_every_ms')) || settings.everyMs;
    if (before && now.getTime() - Date.parse(before) > 3 * every) problems.unshift(problem('beat_late', 'beat', { minutes: minutesSince(before, now) }));
    put(db, 'last_beat_at', at);
    put(db, 'last_beat_ok', String(ok));
    put(db, 'beat_every_ms', String(settings.everyMs));
    recordIncidents(db, problems, at);
    return { problems, sent: await this.#send(problems, previous.get('delivery_failed_at'), now) };
  }

  async #send(problems: readonly Problem[], lastFailure: string | undefined, now: Date): Promise<BeatResult['sent']> {
    const failures = failing(problems);
    const kind = failures.length > 0 ? 'fail' : 'ping';
    const url = kind === 'fail' ? this.#deps.monitor.fail : this.#deps.monitor.ping;
    if (!url) return null;
    const body = kind === 'fail' ? ['Cleared health: blocked', ...new Set(failures.map((p) => p.code))].join('\n') : undefined;
    try {
      const response = await (this.#deps.fetch ?? fetch)(url, { method: body ? 'POST' : 'GET', body, signal: AbortSignal.timeout(this.#deps.timeoutMs ?? 10_000) });
      await response.body?.cancel();
      if (!response.ok) throw new Error('the monitor answered an error');
    } catch {
      if (!lastFailure || now.getTime() - Date.parse(lastFailure) >= HOUR_MS) {
        ledgerEvent(this.#deps.db, { at: now.toISOString(), kind: 'heartbeat_delivery_failed', ticket: null, detail: { to: kind }, source: 'heartbeat' });
        put(this.#deps.db, 'delivery_failed_at', now.toISOString());
      }
    }
    return kind;
  }
}
