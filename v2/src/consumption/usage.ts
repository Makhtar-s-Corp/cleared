// What the Consumption screen reads (docs/v2/requirements-matrix.md, O15),
// all from the ledger's session_events and sessions, nothing invented:
//
//   tokens   the four counts of each finished turn's `usage` (RUN_FINISHED),
//            in + out + cache read + cache write, the way lib/session-usage.mjs
//            totals a session, by day in the person's time zone, over the
//            last seven days, per the harness of the session
//   quota    the newest figure of each window of a harness, from the hourly
//            reading or a session's `cleared.rate_limit` (quota.ts
//            latestQuota, which the plans' stop reads too): none once its
//            reset passed; with its source, and the harness's last reading,
//            a failed one with its reason (issue #270)
//   cost     the sum of the turns' `total_cost_usd` as the flow sums them
//            (engine.ts #stepCost), only for the turns that report one: a
//            figure the harness gives, never an estimate. null when no turn
//            of the period reports it, with how many did when some did not
//
// The projection is the cycle-average pace, as the reference screen says it:
// the share used divided by the time since the window opened.
import type { DatabaseSync } from 'node:sqlite';
import type { Harness } from '../session/contract.ts';
import { modelChoices, type Levers } from './levers.ts';
import { lastReading, latestQuota, type LastReading } from './quota.ts';

export const DAYS = 7;
const HOUR_MS = 3_600_000;
export const WINDOW_MS = { five_hour: 5 * HOUR_MS, seven_day: 7 * 24 * HOUR_MS } as const;
export type WindowName = keyof typeof WINDOW_MS;

// Under this share of the window gone, the pace says nothing yet.
const MIN_ELAPSED = 0.02;
const HARNESSES: readonly Harness[] = ['claude-code', 'codex'];

export type Projection =
  | { readonly kind: 'idle' }                                                          // nothing used in the window
  | { readonly kind: 'too_early' }                                                     // the window has just opened
  | { readonly kind: 'reached' }                                                       // already at 100 %
  // 100 % before the reset; `nextHitsAt`: the next window at the same pace reaches it again, that long after its opening.
  | { readonly kind: 'before_reset'; readonly hitsAt: string; readonly nextHitsAt: string }
  // Holds until the reset, at `percentAtReset`; the next window, at the same pace, ends there too.
  | { readonly kind: 'holds'; readonly percentAtReset: number };

export type Quota = {
  readonly window: WindowName;
  readonly usedPercent: number;
  readonly resetsAt: string;
  readonly observedAt: string;
  readonly source: string;                         // a reading's source, or `session` for a session's report
  readonly projection: Projection;
};

export type DayTokens = { readonly day: string; readonly tokens: number };

export type HarnessConsumption = {
  readonly harness: Harness;
  readonly sessions: number;                       // the sessions that ran a turn in the period
  readonly tokens: number;
  readonly perDay: readonly DayTokens[];
  readonly quotas: readonly Quota[];               // the seven-day window first
  readonly lastReading: LastReading | null;        // the harness's last quota reading, failed or not; null before the first
  // API-equivalent dollars the harness reported, null when none did.
  readonly costUsd: number | null;
  readonly costTurns: { readonly reported: number; readonly turns: number };
};

export type LeverChoices = {
  readonly model: { readonly current: string; readonly choice: string | null; readonly options: readonly string[]; readonly reviewer: string };
  readonly maxLanes: { readonly choice: number | null; readonly options: readonly number[] };
  readonly paused: boolean;
};

export type Consumption = {
  readonly at: string;
  readonly timeZone: string;
  readonly days: readonly string[];                // oldest first, the last is today
  readonly harnesses: readonly HarnessConsumption[];
  readonly levers: LeverChoices;
};

// The projection of a window at the pace so far. `observedAt` is when the
// share was measured; the pace is read from the window's opening to then.
export function projectQuota(input: { readonly usedPercent: number; readonly resetsAt: string; readonly observedAt: string; readonly window: WindowName }): Projection {
  const length = WINDOW_MS[input.window];
  const resets = Date.parse(input.resetsAt);
  const seen = Date.parse(input.observedAt);
  const elapsed = seen - (resets - length);
  if (input.usedPercent >= 100) return { kind: 'reached' };
  if (input.usedPercent <= 0) return { kind: 'idle' };
  if (!(elapsed > length * MIN_ELAPSED)) return { kind: 'too_early' };
  const pace = input.usedPercent / elapsed;                       // percent per millisecond
  const hits = seen + (100 - input.usedPercent) / pace;
  // After the reset the window opens at 0 and the pace is the cycle's: it reaches
  // 100 % after 100 / pace, which is within the window exactly when this one did.
  if (hits < resets) return { kind: 'before_reset', hitsAt: new Date(hits).toISOString(), nextHitsAt: new Date(resets + 100 / pace).toISOString() };
  return { kind: 'holds', percentAtReset: Math.round((input.usedPercent + pace * (resets - seen)) * 10) / 10 };
}

// A time zone Intl knows, else UTC.
export function zoneOf(name: string | undefined): string {
  if (!name) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return name;
  } catch {
    return 'UTC';
  }
}

// The calendar day of an instant in a zone, "2026-10-23".
export function dayOf(at: string | number | Date, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}

// The last `count` calendar days in a zone, oldest first: today's date in the
// zone, then the dates before it counted on the calendar, not in hours.
export function lastDays(now: Date, zone: string, count = DAYS): string[] {
  const noon = Date.parse(`${dayOf(now, zone)}T12:00:00Z`);
  return Array.from({ length: count }, (_, i) => new Date(noon - (count - 1 - i) * 24 * HOUR_MS).toISOString().slice(0, 10));
}

type TurnRow = { harness: string; session_id: string; at: string; event: string };
type Turn = { readonly usage?: unknown; readonly result?: { readonly total_cost_usd?: unknown } };

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);

function turnTokens(turn: Turn): number {
  const usage = Array.isArray(turn.usage) ? turn.usage : [];
  let total = 0;
  for (const u of usage) {
    if (typeof u !== 'object' || u === null) continue;
    const entry = u as Record<string, unknown>;
    total += count(entry.inputTokens) + count(entry.outputTokens) + count(entry.cachedInputTokens) + count(entry.cacheWriteInputTokens);
  }
  return total;
}

// The newest measure of a window for a harness, none once the window's reset
// has passed or when it has no reset time to project to.
function quotaOf(db: DatabaseSync, project: string, harness: Harness, window: WindowName, now: Date): Quota | undefined {
  const latest = latestQuota(db, { project, window, now, harness });
  if (!latest?.resetsAt) return undefined;
  const base = { window, usedPercent: latest.usedPercent, resetsAt: latest.resetsAt, observedAt: latest.observedAt };
  return { ...base, source: latest.source, projection: projectQuota(base) };
}

export function leverChoices(current: Levers, config: { readonly authorModel: string; readonly reviewerModel: string }): LeverChoices {
  return {
    model: {
      current: current.model ?? config.authorModel, choice: current.model, reviewer: config.reviewerModel,
      options: modelChoices(config, current.model),
    },
    maxLanes: { choice: current.maxLanes, options: [1, 2, 3] },
    paused: current.paused,
  };
}

export function consumption(db: DatabaseSync, input: {
  readonly project: string; readonly now: Date; readonly timeZone?: string; readonly levers: Levers;
  readonly config: { readonly authorModel: string; readonly reviewerModel: string };
}): Consumption {
  const zone = zoneOf(input.timeZone);
  const days = lastDays(input.now, zone);
  const since = new Date(input.now.getTime() - (DAYS + 1) * 24 * HOUR_MS).toISOString();
  const rows = db.prepare(`SELECT s.harness AS harness, e.session_id AS session_id, e.at AS at, e.event AS event
    FROM session_events e JOIN sessions s ON s.id = e.session_id
    WHERE e.project = ? AND e.type = 'RUN_FINISHED' AND e.at >= ? ORDER BY e.at`).all(input.project, since) as TurnRow[];

  const harnesses = HARNESSES.map((harness): HarnessConsumption => {
    const perDay = new Map(days.map((day) => [day, 0]));
    const sessions = new Set<string>();
    let cost = 0;
    let reported = 0;
    let turns = 0;
    for (const row of rows) {
      if (row.harness !== harness) continue;
      const day = dayOf(row.at, zone);
      if (!perDay.has(day)) continue;
      let turn: Turn;
      try { turn = JSON.parse(row.event) as Turn; } catch { continue; }
      sessions.add(row.session_id);
      perDay.set(day, (perDay.get(day) ?? 0) + turnTokens(turn));
      turns += 1;
      const total = turn.result?.total_cost_usd;
      if (typeof total === 'number' && Number.isFinite(total) && total >= 0) { cost += total; reported += 1; }
    }
    const quotas = (['seven_day', 'five_hour'] as const).flatMap((window) => quotaOf(db, input.project, harness, window, input.now) ?? []);
    const tokens = [...perDay.values()].reduce((sum, n) => sum + n, 0);
    return {
      harness, sessions: sessions.size, tokens,
      perDay: days.map((day) => ({ day, tokens: perDay.get(day) ?? 0 })),
      quotas,
      lastReading: lastReading(db, input.project, harness) ?? null,
      costUsd: reported === 0 ? null : Math.round(cost * 100) / 100,
      costTurns: { reported, turns },
    };
  });
  return { at: input.now.toISOString(), timeZone: zone, days, harnesses, levers: leverChoices(input.levers, input.config) };
}
