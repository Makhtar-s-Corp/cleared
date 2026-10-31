// The quota reading (issue #270, docs/v2/requirements-matrix.md, P71): each
// hour, each harness's usage windows are read from a source that answers in
// data, not from a terminal's screen, and every attempt is kept in the
// ledger, a failed one with its reason.
//
//   source    Claude Code's: GET /api/oauth/usage, the endpoint the CLI's
//             /usage reads (CLI 2.1.310: `fetchUtilization`), with the
//             service's login. Its answer per window is a utilization in
//             percent and an ISO reset time. Nothing is spent: it is no
//             model call.
//   history   quota_readings: one row per window read, or one row with ok 0
//             and the reason when the reading failed; nothing is deleted.
//   failure   said without blocking: the row, the Consumption screen's line,
//             and one health notification per run of failures (the first
//             after a reading that worked), as the scheduler says a schedule
//             that fails again for the same reason once. The plans and the
//             schedules go on with the newest figure they have.
//   refused   a login the endpoint will not read (HTTP 403, seen on a login made by
//             `claude setup-token`; its cause is not established, issue #509): no
//             failure to alarm about. No notification, the screen says the reading
//             is unavailable, and it is asked again once a day, or as soon as the
//             login changes, not each hour. A session's report is then the only
//             source of the figure, so a lane's stop rests on the last one reported.
//   alerts    at 75 and 85 percent of a window, once per window cycle (its
//             reset time), kept in quota_alerts so a restart does not alert
//             again: a health notification each.
//   latest    latestQuota: the newest figure of a window, from a reading or
//             from a session's own report (`cleared.rate_limit`), none once
//             its reset passed. The plans' stop, the schedules' week share
//             and the Consumption screen read it, so no lane starts above the
//             stop (85 by default) even when no session ran since.
import { readFileSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { NotifyQueue, type Occurrence } from '../notify/queue.ts';
import type { Harness } from '../session/contract.ts';

export type QuotaWindow = 'five_hour' | 'seven_day';
export const QUOTA_WINDOWS: readonly QuotaWindow[] = ['seven_day', 'five_hour'];
export const ALERT_PERCENTS: readonly number[] = [75, 85];
export const READ_MINUTES = 60;
const REFUSED_RETRY_MS = 24 * 60 * 60_000;
// The row's reason for a login the endpoint will not read; a row keeps no other mark of it.
export const READING_UNAVAILABLE = 'the endpoint refused the login (HTTP 403)';

export const QUOTA_TABLES: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS quota_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    harness TEXT NOT NULL,
    source TEXT NOT NULL,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    "window" TEXT,
    used_percent REAL,
    resets_at TEXT,
    error TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS quota_readings_newest ON quota_readings (project, harness, at)',
  `CREATE TABLE IF NOT EXISTS quota_alerts (
    project TEXT NOT NULL,
    harness TEXT NOT NULL,
    "window" TEXT NOT NULL,
    resets_at TEXT NOT NULL,
    percent INTEGER NOT NULL,
    used_percent REAL NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (project, harness, "window", resets_at, percent)
  )`,
];

export type WindowReading = { readonly window: QuotaWindow; readonly usedPercent: number; readonly resetsAt: string | null };

// A failed reading: its message is what the row and the screen say, so it
// never carries the login or the answer's body.
export class QuotaReadError extends Error {
  override name = 'QuotaReadError';
}

export type QuotaSource = {
  readonly harness: Harness;
  readonly source: string;                      // what the row and the screen name
  read(signal: AbortSignal): Promise<readonly WindowReading[]>;
  // When the login last changed, in milliseconds; a refused login is asked again from then on.
  loginChangedAt?(): number | undefined;
};

// ---------------------------------------------------------------- the source

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_BETA = 'oauth-2025-04-20';

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

// The reset time as ISO: the endpoint gives an ISO text; seconds since the
// epoch are read too (the CLI's headers and status line give those).
function resetOf(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  const at = typeof value === 'number' && Number.isFinite(value) ? value * 1000 : typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

// The windows of an answer of /api/oauth/usage. A window absent or null is
// one the plan does not have now; an answer with neither, or a window whose
// figures are not numbers, is a failed reading: the shape changed, and a
// wrong figure is worse than none.
export function parseUsage(body: unknown): WindowReading[] {
  const answer = record(body);
  if (!answer) throw new QuotaReadError('the answer is not a JSON object');
  const out: WindowReading[] = [];
  for (const window of QUOTA_WINDOWS) {
    const raw = answer[window];
    if (raw === null || raw === undefined) continue;
    const entry = record(raw);
    const used = entry?.utilization;
    if (!entry || (used !== null && (typeof used !== 'number' || !Number.isFinite(used) || used < 0))) throw new QuotaReadError(`the ${window} window is not read as a utilization and a reset time`);
    const resetsAt = resetOf(entry.resets_at);
    if (resetsAt === undefined) throw new QuotaReadError(`the ${window} window's reset time is not a date`);
    if (used === null) continue;
    out.push({ window, usedPercent: Math.round(used * 10) / 10, resetsAt });
  }
  if (out.length === 0) throw new QuotaReadError('the answer has neither a five-hour nor a seven-day window');
  return out;
}

// The access token of the login file: a setup-token token, or the access
// token of a credentials file (as the session runner reads it).
export function loginToken(text: string | undefined): string | undefined {
  const trimmed = text?.trim() ?? '';
  if (!trimmed.startsWith('{')) return trimmed || undefined;
  try {
    const oauth = record(record(JSON.parse(trimmed))?.claudeAiOauth);
    return typeof oauth?.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : undefined;
  } catch {
    return undefined;
  }
}

export type UsageFetch = (url: string, init: { readonly headers: Record<string, string>; readonly signal: AbortSignal }) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

export function claudeCodeQuotaSource(options: {
  readonly loginFile: string;
  readonly readFile?: (path: string) => string | undefined;
  readonly fetch?: UsageFetch;
}): QuotaSource {
  const readFile = options.readFile ?? ((path: string) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } });
  const get: UsageFetch = options.fetch ?? ((url, init) => fetch(url, init));
  return {
    harness: 'claude-code',
    source: 'claude-code /api/oauth/usage',
    loginChangedAt() {
      try { return statSync(options.loginFile).mtimeMs; } catch { return undefined; }
    },
    async read(signal) {
      const token = loginToken(readFile(options.loginFile));
      if (!token) throw new QuotaReadError('no token in the login file');
      let answer: Awaited<ReturnType<UsageFetch>>;
      try {
        answer = await get(USAGE_URL, { headers: { authorization: `Bearer ${token}`, 'anthropic-beta': USAGE_BETA, accept: 'application/json' }, signal });
      } catch (error) {
        throw new QuotaReadError(signal.aborted ? 'the endpoint did not answer in time' : `the endpoint could not be reached (${error instanceof Error ? error.name : 'error'})`);
      }
      if (answer.status === 401 || answer.status === 403) throw new QuotaReadError(`the endpoint refused the login (HTTP ${answer.status})`);
      if (answer.status !== 200) throw new QuotaReadError(`the endpoint answered HTTP ${answer.status}`);
      let body: unknown;
      try { body = await answer.json(); } catch { throw new QuotaReadError('the answer is not JSON'); }
      return parseUsage(body);
    },
  };
}

// ---------------------------------------------------------------- the newest figure

export type LatestQuota = {
  readonly window: QuotaWindow;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly observedAt: string;
  readonly source: string;                       // a reading's source, or `session` for a session's own report
};

// The newest figure of a window of one harness, Claude Code's when the
// caller names none, from the readings that worked and the sessions'
// reports; none once its reset passed (a null reset is a window that runs).
// A report is Claude Code's unless its session is another harness's, as the
// stop read it before (a report whose session has no row counts); another
// harness's is its session's only. So a Codex window never stops the plans
// or the schedules, which read the subscription's.
export function latestQuota(db: DatabaseSync, input: { readonly project: string; readonly window: QuotaWindow; readonly now: Date; readonly harness?: Harness }): LatestQuota | undefined {
  const { project, window } = input;
  const harness = input.harness ?? 'claude-code';
  const own = harness === 'claude-code'
    ? "NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.harness <> 'claude-code')"
    : 'EXISTS (SELECT 1 FROM sessions s WHERE s.id = e.session_id AND s.harness = ?)';
  const reported = db.prepare(`SELECT e.at AS at, json_extract(e.event, '$.value.usedPercent') AS used, json_extract(e.event, '$.value.resetsAt') AS resets
    FROM session_events e
    WHERE e.project = ? AND e.type = 'CUSTOM' AND json_extract(e.event, '$.name') = 'cleared.rate_limit' AND json_extract(e.event, '$.value.window') = ? AND ${own}
    ORDER BY e.at DESC, e.rowid DESC LIMIT 1`).get(...(harness === 'claude-code' ? [project, window] : [project, window, harness])) as { at: string; used: number | null; resets: string | null } | undefined;
  const read = hasReadings(db)
    ? db.prepare(`SELECT at, used_percent AS used, resets_at AS resets, source FROM quota_readings
      WHERE project = ? AND harness = ? AND ok = 1 AND "window" = ? ORDER BY at DESC, id DESC LIMIT 1`).get(project, harness, window) as { at: string; used: number | null; resets: string | null; source: string } | undefined
    : undefined;
  const candidates = [
    ...(reported && typeof reported.used === 'number' ? [{ window, usedPercent: reported.used, resetsAt: reported.resets, observedAt: reported.at, source: 'session' }] : []),
    ...(read && typeof read.used === 'number' ? [{ window, usedPercent: read.used, resetsAt: read.resets, observedAt: read.at, source: read.source }] : []),
  ].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const newest = candidates[0];
  if (!newest) return undefined;
  return !newest.resetsAt || Date.parse(newest.resetsAt) > input.now.getTime() ? newest : undefined;
}

// The window of the subscription (Claude Code's) at or above `limit` percent,
// the seven-day one first, from its newest figure: what the plans' stop and
// the batches' read, so that no lane starts above the stop.
export function quotaStop(db: DatabaseSync, input: { readonly project: string; readonly now: Date; readonly limit: number }): LatestQuota | undefined {
  for (const window of QUOTA_WINDOWS) {
    const quota = latestQuota(db, { project: input.project, window, now: input.now, harness: 'claude-code' });
    if (quota && quota.usedPercent >= input.limit) return quota;
  }
  return undefined;
}

// The ledger of a caller that never created the reading's tables (a test, the app) reads the sessions only.
function hasReadings(db: DatabaseSync): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quota_readings'").get() !== undefined;
}

export type LastReading = { readonly at: string; readonly source: string; readonly ok: boolean; readonly error?: string; readonly unavailable?: true };

// The last attempt of a harness, whatever its outcome: the screen says a failure.
export function lastReading(db: DatabaseSync, project: string, harness: Harness): LastReading | undefined {
  if (!hasReadings(db)) return undefined;
  const row = db.prepare('SELECT at, source, ok, error FROM quota_readings WHERE project = ? AND harness = ? ORDER BY at DESC, id DESC LIMIT 1')
    .get(project, harness) as { at: string; source: string; ok: number; error: string | null } | undefined;
  if (!row) return undefined;
  return { at: row.at, source: row.source, ok: row.ok === 1, ...(row.ok === 1 || row.error === null ? {} : { error: row.error }), ...(row.ok !== 1 && row.error === READING_UNAVAILABLE ? { unavailable: true as const } : {}) };
}

// ---------------------------------------------------------------- the hourly reading

export type QuotaEvent =
  | { readonly type: 'quota_read'; readonly harness: Harness; readonly at: string; readonly windows: readonly WindowReading[] }
  | { readonly type: 'quota_read_failed'; readonly harness: Harness; readonly at: string; readonly error: string; readonly notified: boolean }
  | { readonly type: 'quota_alert'; readonly harness: Harness; readonly at: string; readonly window: QuotaWindow; readonly percent: number; readonly usedPercent: number };

export type QuotaReaderDeps = {
  readonly db: DatabaseSync;
  readonly project: string;
  readonly sources: readonly QuotaSource[];
  readonly clean?: (text: string) => string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
  // Where a health notification goes; the notify queue of the ledger by default.
  readonly notify?: (occurrence: Occurrence) => void;
};

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

export class QuotaReader {
  #deps: QuotaReaderDeps;
  #now: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<QuotaEvent[]> | undefined;

  constructor(deps: QuotaReaderDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => new Date());
    for (const sql of QUOTA_TABLES) deps.db.exec(sql);
  }

  // Reads at once, then every `ms`; the timer never keeps the process alive.
  startTimer(ms = READ_MINUTES * 60_000): void {
    if (this.#timer) return;
    const run = () => { void this.tick().catch((error) => console.error(`cleared-v2: quota reading failed (${errorName(error)})`)); };
    run();
    this.#timer = setInterval(run, ms);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  // One reading of every source, one after the other; never throws for a source.
  async tick(): Promise<QuotaEvent[]> {
    if (this.#running) return this.#running;
    this.#running = (async () => {
      const out: QuotaEvent[] = [];
      for (const source of this.#deps.sources) out.push(...(await this.#read(source)));
      return out;
    })();
    try {
      return await this.#running;
    } finally {
      this.#running = undefined;
    }
  }

  // A login the endpoint refused is asked again once a day, or once it changed.
  #waits(source: QuotaSource): boolean {
    const last = lastReading(this.#deps.db, this.#deps.project, source.harness);
    if (!last?.unavailable) return false;
    const at = Date.parse(last.at);
    if (this.#now().getTime() - at >= REFUSED_RETRY_MS) return false;
    return !((source.loginChangedAt?.() ?? 0) > at);
  }

  async #read(source: QuotaSource): Promise<QuotaEvent[]> {
    const { db, project } = this.#deps;
    if (this.#waits(source)) return [];
    const signal = AbortSignal.timeout(this.#deps.timeoutMs ?? 30_000);
    let windows: readonly WindowReading[];
    try {
      windows = await source.read(signal);
    } catch (error) {
      const at = this.#now().toISOString();
      const said = error instanceof QuotaReadError ? error.message : `the reading failed (${errorName(error)})`;
      const message = this.#deps.clean ? this.#deps.clean(said) : said;
      // One notification for a run of failures: the first, after a reading that worked or none.
      const before = lastReading(db, project, source.harness);
      const notified = said !== READING_UNAVAILABLE && (before === undefined || before.ok);
      db.prepare('INSERT INTO quota_readings (project, harness, source, at, ok, error) VALUES (?, ?, ?, ?, 0, ?)').run(project, source.harness, source.source, at, message);
      if (notified) this.#notify({ key: `quota:failed:${source.harness}:${at}`, kind: 'health', ticket: null, group: 'health:quota_read_failed', title: '', code: 'quota_read_failed', link: '/consumption', from: null, at });
      return [{ type: 'quota_read_failed', harness: source.harness, at, error: message, notified }];
    }
    const at = this.#now().toISOString();
    const insert = db.prepare('INSERT INTO quota_readings (project, harness, source, at, ok, "window", used_percent, resets_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)');
    for (const w of windows) insert.run(project, source.harness, source.source, at, w.window, w.usedPercent, w.resetsAt);
    const out: QuotaEvent[] = [{ type: 'quota_read', harness: source.harness, at, windows }];
    for (const w of windows) out.push(...this.#alerts(source.harness, w, at));
    return out;
  }

  // The thresholds a window has reached, each once per cycle; a window with
  // no reset time has no cycle to key it, and is not alerted.
  #alerts(harness: Harness, w: WindowReading, at: string): QuotaEvent[] {
    if (!w.resetsAt) return [];
    const out: QuotaEvent[] = [];
    for (const percent of ALERT_PERCENTS) {
      if (w.usedPercent < percent) continue;
      const added = this.#deps.db.prepare('INSERT OR IGNORE INTO quota_alerts (project, harness, "window", resets_at, percent, used_percent, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(this.#deps.project, harness, w.window, w.resetsAt, percent, w.usedPercent, at);
      if (Number(added.changes) === 0) continue;
      const code = `quota_${percent}`;
      this.#notify({ key: `quota:${harness}:${w.window}:${w.resetsAt}:${percent}`, kind: 'health', ticket: null, group: `health:${code}`, title: '', code, link: '/consumption', from: null, at });
      out.push({ type: 'quota_alert', harness, at, window: w.window, percent, usedPercent: w.usedPercent });
    }
    return out;
  }

  #notify(occurrence: Occurrence): void {
    try {
      if (this.#deps.notify) this.#deps.notify(occurrence);
      else new NotifyQueue(this.#deps.db).add(occurrence, 'pending', occurrence.at);
    } catch (error) {
      // A notification that cannot be queued never stops the reading.
      console.error(`cleared-v2: a quota notification was not queued (${errorName(error)})`);
    }
  }
}
