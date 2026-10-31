// The Consumption screen (O15, requirements matrix): what each harness has
// used over the last seven days, where its quota is heading before the next
// reset and after it, the dollars only where the harness reported them, and
// three levers that call real actions of the service (the author model of
// the next sessions, the sessions run at once, the pause of the schedules);
// and the week's figures (C17): what merged, what it took, per service.
// The model and the wording are pure, so the tests run them under Node;
// Consumption.tsx draws the screen and reads it again as time passes.
//
// Every number and date is said through Intl in the page's language and
// every duration through lib/time.ts, never as raw milliseconds or ISO text.
import type { Consumption, HarnessConsumption, HarnessWins, LeverChoices, LeversChange, Projection, Quota, WeekFigures } from '../../../../src/api/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../lib/screen.ts';
import { count, duration, lasted } from '../../lib/time.ts';

type Api = ScreenContext['api'];
type Language = 'en' | 'fr';

// How often the screen reads the consumption again: the quotas move slowly.
export const REFRESH_MS = 60_000;

export function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export const consumptionPath = (zone: string): string => `/consumption?tz=${encodeURIComponent(zone)}`;

export const readConsumption = (api: Api, zone: string): Promise<Consumption> => api<Consumption>(consumptionPath(zone));
export const readWeek = (api: Api, zone: string): Promise<WeekFigures> => api<WeekFigures>(`/consumption/week?tz=${encodeURIComponent(zone)}`);
export const setLevers = (api: Api, change: LeversChange): Promise<LeverChoices> => api<LeverChoices>('/consumption/levers', { method: 'POST', body: change });

// A lever the service refused says why (its own words are English and
// technical): the screen says it in its catalog.
export function leverFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'consumption_lever_forbidden';
    if (error.status === 400) return 'consumption_lever_refused';
    if (error.status === 503) return 'consumption_down';
  }
  return 'consumption_lever_failed';
}

export function readFailure(error: unknown): string {
  return error instanceof ApiError && error.status === 503 ? 'consumption_down' : 'consumption_read_failed';
}

// ------------------------------------------------------------------ words

const HARNESSES = new Set(['claude-code', 'codex']);
// Cursor is named by the harness pick's wins (issue #329); the cards show Claude Code and Codex.
const NAMED = new Set([...HARNESSES, 'cursor']);
export const harnessName = (harness: string, t: Translate): string => (NAMED.has(harness) ? t(`consumption_harness_${harness}`) : harness);
export const harnessMaker = (harness: string, t: Translate): string => (HARNESSES.has(harness) ? t(`consumption_maker_${harness}`) : '');

// "Opus 5.5" from "claude-opus-5-5": the names are the makers', not translated.
export function modelName(id: string): string {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (!match) return id;
  const family = `${match[1]!.charAt(0).toUpperCase()}${match[1]!.slice(1)}`;
  return `${family} ${match[2]}.${match[3]}`;
}

// 2,8 Md and 717,9 M in French, 2.8B and 717.9M in English.
export const tokensText = (tokens: number, language: Language): string =>
  new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens);

export const percentText = (value: number, language: Language): string =>
  new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value);

export const dollars = (amount: number, language: Language): string =>
  new Intl.NumberFormat(language, { style: 'currency', currency: 'USD' }).format(amount);

// The first letter of a day's weekday, "M" for a Monday, in the page's language.
export const dayInitial = (day: string, language: Language): string =>
  new Intl.DateTimeFormat(language, { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

export const dayLong = (day: string, language: Language): string =>
  new Intl.DateTimeFormat(language, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

// "ven. 23 oct., 23:18" in the zone of the person.
export const moment = (iso: string, zone: string, language: Language): string =>
  new Intl.DateTimeFormat(language, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: zone }).format(new Date(iso));

// "21 oct. to 23 oct. 2026": the period the seven days cover.
export function periodText(days: readonly string[], language: Language): string {
  const first = days[0];
  const last = days[days.length - 1];
  if (!first || !last) return '';
  const range = new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return range.formatRange(new Date(`${first}T12:00:00Z`), new Date(`${last}T12:00:00Z`));
}

const minutesUntil = (iso: string, now: Date): number => Math.max(0, Math.round((Date.parse(iso) - now.getTime()) / 60_000));

// ---------------------------------------------------------------- the chart

export type ChartPoint = { readonly day: string; readonly tokens: number; readonly x: number; readonly y: number };
export type Chart = { readonly width: number; readonly height: number; readonly line: string; readonly area: string; readonly points: readonly ChartPoint[] };

// The usage curve of one harness: tokens per day, the tallest day at the top
// of the drawing, a day with none on its floor.
export function chartOf(perDay: readonly { readonly day: string; readonly tokens: number }[], width = 220, height = 64, pad = 6): Chart {
  const top = Math.max(1, ...perDay.map((d) => d.tokens));
  const step = perDay.length > 1 ? (width - pad * 2) / (perDay.length - 1) : 0;
  const points = perDay.map((d, i) => ({
    day: d.day, tokens: d.tokens, x: Math.round((pad + i * step) * 10) / 10,
    y: Math.round((height - pad - (d.tokens / top) * (height - pad * 2)) * 10) / 10,
  }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const last = points[points.length - 1];
  const first = points[0];
  const area = last && first ? `${line} L${last.x} ${height - pad} L${first.x} ${height - pad} Z` : '';
  return { width, height, line, area, points };
}

// The average over the days that had any use: "measured" days, as the
// reference says, so a quiet weekend does not hide the pace of a work day.
export function averagePerDay(h: Pick<HarnessConsumption, 'perDay' | 'tokens'>): { readonly tokens: number; readonly days: number } {
  const days = h.perDay.filter((d) => d.tokens > 0).length;
  return { tokens: days === 0 ? 0 : h.tokens / days, days };
}

export const quotaOf = (h: Pick<HarnessConsumption, 'quotas'>): Quota | undefined => h.quotas[0];

// ------------------------------------------------------------ the projection

// What the pace says of one quota window, in a sentence, and the verdict a
// chip names ('hit' before the reset, 'ok' until it, 'unknown' when it can not say yet).
export type Verdict = 'hit' | 'ok' | 'unknown';
export const verdictOf = (p: Projection): Verdict => (p.kind === 'before_reset' || p.kind === 'reached' ? 'hit' : p.kind === 'holds' ? 'ok' : 'unknown');

export function projectionLines(quota: Quota, h: Pick<HarnessConsumption, 'harness'>, zone: string, language: Language, t: Translate): { readonly before: string; readonly after: string | null } {
  const name = harnessName(h.harness, t);
  const reset = moment(quota.resetsAt, zone, language);
  const p = quota.projection;
  switch (p.kind) {
    case 'idle': return { before: t('consumption_proj_idle', { harness: name }), after: null };
    case 'too_early': return { before: t('consumption_proj_early', { harness: name }), after: null };
    case 'reached': return { before: t('consumption_proj_reached', { harness: name, reset }), after: null };
    case 'before_reset': return {
      before: t('consumption_proj_hit', { harness: name, when: moment(p.hitsAt, zone, language), reset }),
      after: t('consumption_proj_next_hit', { when: moment(p.nextHitsAt, zone, language) }),
    };
    case 'holds': return {
      before: t('consumption_proj_holds', { harness: name, percent: percentText(p.percentAtReset, language), reset }),
      after: t('consumption_proj_next_holds', { percent: percentText(p.percentAtReset, language) }),
    };
  }
}

// Where the figure comes from and when it was read, and the harness's last
// quota reading when it failed (issue #270): a failure is said, with its
// reason as the service gives it, and never hides the figure read before it.
// A login the reading refuses (issue #509) is not a failure: it says that the
// sessions' reports are the only source, in the screen's own words.
export type ReadingLine = { readonly kind: 'seen' | 'failed' | 'unavailable'; readonly text: string };

export function readingLines(h: Pick<HarnessConsumption, 'lastReading'>, quota: Quota | undefined, zone: string, language: Language, t: Translate): ReadingLine[] {
  const out: ReadingLine[] = [];
  if (quota) {
    const source = t(quota.source === 'session' ? 'consumption_source_session' : 'consumption_source_reading');
    out.push({ kind: 'seen', text: t('consumption_quota_seen', { when: moment(quota.observedAt, zone, language), source }) });
  }
  const last = h.lastReading;
  if (last?.unavailable) out.push({ kind: 'unavailable', text: t('consumption_reading_unavailable') });
  else if (last && !last.ok) out.push({ kind: 'failed', text: t('consumption_reading_failed', { when: moment(last.at, zone, language), reason: last.error ?? '' }) });
  return out;
}

export const resetIn = (quota: Pick<Quota, 'resetsAt'>, now: Date, t: Translate): string => t('consumption_reset_in', { time: duration(minutesUntil(quota.resetsAt, now), t) });

// The sentence above the quotas: the first harness to reach 100 % before its
// reset, else that none does, else that nothing is measured yet.
export function headline(data: Consumption, language: Language, t: Translate): { readonly kind: 'hit' | 'ok' | 'none' | 'unavailable'; readonly text: string; readonly harness?: string } {
  const week = data.harnesses.flatMap((h) => h.quotas.filter((q) => q.window === 'seven_day').map((quota) => ({ h, quota })));
  const hits = week.flatMap((entry) => (entry.quota.projection.kind === 'before_reset' ? [{ ...entry, at: entry.quota.projection.hitsAt }] : []))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = hits[0];
  if (first) {
    return { kind: 'hit', harness: first.h.harness, text: t('consumption_headline_hit', { harness: harnessName(first.h.harness, t), when: moment(first.at, data.timeZone, language), reset: moment(first.quota.resetsAt, data.timeZone, language) }) };
  }
  if (week.length > 0) return { kind: 'ok', text: t('consumption_headline_ok') };
  if (data.harnesses.some((h) => h.lastReading?.unavailable)) return { kind: 'unavailable', text: t('consumption_headline_unavailable') };
  return { kind: 'none', text: t('consumption_headline_none') };
}

// ----------------------------------------------------------------- the cost

export type CostView = {
  readonly rows: readonly { readonly harness: string; readonly name: string; readonly amount: string; readonly partial: string | null }[];
  readonly total: string;
};

// Dollars only for a harness whose turns reported a cost, and nothing at all
// when none did: no row, no total, no zero. A partial figure says how many turns reported.
export function costView(data: Consumption, language: Language, t: Translate): CostView | null {
  const reported = data.harnesses.filter((h) => h.costUsd !== null);
  if (reported.length === 0) return null;
  const rows = reported.map((h) => ({
    harness: h.harness, name: harnessName(h.harness, t), amount: dollars(h.costUsd as number, language),
    partial: h.costTurns.reported < h.costTurns.turns ? t('consumption_cost_partial', { reported: h.costTurns.reported, turns: h.costTurns.turns }) : null,
  }));
  return { rows, total: dollars(reported.reduce((sum, h) => sum + (h.costUsd as number), 0), language) };
}

// ------------------------------------------------------- the week's figures

export type WeekTicketLine = { readonly id: string; readonly title: string; readonly services: string; readonly estimate: string };
export type WeekRow = { readonly key: string; readonly name: string; readonly merged: string; readonly tokens: string; readonly time: string; readonly dollars: string };
export type WeekView = {
  readonly merged: string;
  readonly tokens: string | null;                  // null when no agent finished a turn
  readonly time: string | null;
  readonly idle: string | null;                    // said instead of the two above
  readonly dollars: string | null;                 // the reported dollars, or
  readonly noDollars: string | null;               // why there are none
  readonly tickets: readonly WeekTicketLine[];
  readonly estimates: string | null;               // null when nothing merged
  readonly rows: readonly WeekRow[];
};

// The week's figures as the panel says them: the counts through Intl, the
// durations through lib/time.ts, the dollars only as the agents reported
// them, and an estimate in minutes only.
export function weekView(week: WeekFigures, language: Language, t: Translate): WeekView {
  const n = week.merged.length;
  const worked = week.spend.turns > 0;
  const est = week.estimates;
  const line = (m: WeekFigures['merged'][number]): string => {
    if (m.estimateMinutes === null) return t('consumption_week_no_estimate');
    if (m.actualMinutes === null) return t('consumption_week_estimate_only', { estimate: duration(m.estimateMinutes, t) });
    return t('consumption_week_estimate', { estimate: duration(m.estimateMinutes, t), actual: duration(m.actualMinutes, t) });
  };
  const estimates = n === 0 ? null
    : est.tickets === 0 ? t('consumption_week_estimates_none')
      : t(est.tickets === 1 && n === 1 ? 'consumption_week_estimates_one' : 'consumption_week_estimates', {
        estimate: duration(est.estimatedMinutes, t), actual: duration(est.actualMinutes, t), n: count(est.tickets, language), total: count(n, language),
      });
  return {
    merged: n === 0 ? t('consumption_week_merged_none') : n === 1 ? t('consumption_week_merged_one') : t('consumption_week_merged', { n: count(n, language) }),
    tokens: worked ? t('consumption_week_used', { n: tokensText(week.spend.tokens ?? 0, language) }) : null,
    time: worked ? t('consumption_week_work', { time: lasted(week.spend.workMs, t) }) : null,
    idle: worked ? null : t('consumption_week_idle'),
    dollars: worked && week.spend.costUsd !== null ? t('consumption_week_dollars', { amount: dollars(week.spend.costUsd, language) }) : null,
    noDollars: worked && week.spend.costUsd === null ? t('consumption_week_no_dollars') : null,
    tickets: week.merged.map((m) => ({ id: m.id, title: m.title, services: m.services.join(', '), estimate: line(m) })),
    estimates,
    rows: week.services.map((row) => ({
      key: row.service ?? 'workspace',
      name: row.service ?? t('consumption_week_workspace'),
      merged: count(row.merged, language),
      tokens: tokensText(row.tokens ?? 0, language),
      time: lasted(row.workMs, t),
      dollars: row.turns === 0 ? dollars(0, language) : row.costUsd === null ? t('consumption_week_not_reported') : dollars(row.costUsd, language),
    })),
  };
}

// ---------------------------------------------------------------- the levers

export type LeverId = 'model' | 'lanes' | 'pause';
export type Choice = { readonly id: string; readonly label: string; readonly pressed: boolean; readonly change: LeversChange };
export type LeverView = {
  readonly id: LeverId;
  readonly title: string;
  readonly detail: string;
  readonly state: string;                      // what is on now, one phrase
  readonly active: boolean;                    // the owner moved it from the default
  readonly choices: readonly Choice[];
};

export function leverViews(levers: LeverChoices, t: Translate): LeverView[] {
  const model = levers.model;
  const lanes = levers.maxLanes;
  return [
    {
      id: 'model', title: t('consumption_lever_model'), detail: t('consumption_lever_model_detail', { reviewer: modelName(model.reviewer) }),
      state: model.choice === null ? t('consumption_lever_model_default', { model: modelName(model.current) }) : t('consumption_lever_model_on', { model: modelName(model.choice) }),
      active: model.choice !== null,
      choices: [
        ...model.options.map((option): Choice => ({ id: option, label: modelName(option), pressed: model.current === option && model.choice !== null, change: { model: option } })),
        { id: 'default', label: t('consumption_lever_default'), pressed: model.choice === null, change: { model: null } },
      ],
    },
    {
      id: 'lanes', title: t('consumption_lever_lanes'), detail: t('consumption_lever_lanes_detail'),
      state: lanes.choice === null ? t('consumption_lever_lanes_default') : t(lanes.choice === 1 ? 'consumption_lever_lanes_one' : 'consumption_lever_lanes_on', { n: lanes.choice }),
      active: lanes.choice !== null,
      choices: [
        ...lanes.options.map((n): Choice => ({ id: String(n), label: String(n), pressed: lanes.choice === n, change: { maxLanes: n } })),
        { id: 'none', label: t('consumption_lever_lanes_free'), pressed: lanes.choice === null, change: { maxLanes: null } },
      ],
    },
    {
      id: 'pause', title: t('consumption_lever_pause'), detail: t('consumption_lever_pause_detail'),
      state: levers.paused ? t('consumption_lever_pause_on') : t('consumption_lever_pause_off'), active: levers.paused,
      choices: [{ id: 'pause', label: t(levers.paused ? 'consumption_lever_resume' : 'consumption_lever_pause_do'), pressed: levers.paused, change: { paused: !levers.paused } }],
    },
  ];
}

// "Mesuré le ven. 23 oct., 23:40": when the page's figures were read.
export const measuredAt = (data: Pick<Consumption, 'at' | 'timeZone'>, language: Language, t: Translate): string =>
  t('consumption_measured', { when: moment(data.at, data.timeZone, language) });

// ------------------------------------------------------------------ the harness pick's wins

const TYPE_ORDER: readonly HarnessWins['type'][] = ['bug', 'review', 'ci', 'question', 'other'];
const HARNESS_ORDER: readonly string[] = ['claude-code', 'codex', 'cursor'];

export type WinRow = { readonly key: string; readonly type: string; readonly harness: string; readonly runs: string; readonly green: string; readonly wins: string };

// The wins of the harness pick (issue #329), a row per ticket type and
// agent: in the types' order, and within a type the agent kept most often
// first, then the one whose tests passed most often.
export function winRows(wins: readonly HarnessWins[], t: Translate, language: Language = 'en'): WinRow[] {
  const count = (n: number) => new Intl.NumberFormat(language).format(n);
  return [...wins]
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || b.wins - a.wins || b.green - a.green || HARNESS_ORDER.indexOf(a.harness) - HARNESS_ORDER.indexOf(b.harness))
    .map((w) => ({ key: `${w.type}:${w.harness}`, type: t(`consumption_type_${w.type}`), harness: harnessName(w.harness, t), runs: count(w.runs), green: count(w.green), wins: count(w.wins) }));
}
