// The Consumption screen (O15, requirements matrix): what each harness has
// used over the last seven days, where its quota is heading before the next
// reset and after it, the dollars only where the harness reported them, and
// three levers that call real actions of the service (the author model of
// the next sessions, the sessions run at once, the pause of the schedules).
// The model and the wording are pure, so the tests run them under Node;
// Consumption.tsx draws the screen and reads it again as time passes.
//
// Every number and date is said through Intl in the page's language and
// every duration through lib/time.ts, never as raw milliseconds or ISO text.
import type { Consumption, HarnessConsumption, LeverChoices, LeversChange, Projection, Quota } from '../../../../src/api/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../lib/screen.ts';
import { duration } from '../../lib/time.ts';

type Api = ScreenContext['api'];
type Language = 'en' | 'fr';

// How often the screen reads the consumption again: the quotas move slowly.
export const REFRESH_MS = 60_000;

export function browserZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export const consumptionPath = (zone: string): string => `/consumption?tz=${encodeURIComponent(zone)}`;

export const readConsumption = (api: Api, zone: string): Promise<Consumption> => api<Consumption>(consumptionPath(zone));
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
export const harnessName = (harness: string, t: Translate): string => (HARNESSES.has(harness) ? t(`consumption_harness_${harness}`) : harness);
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

export const resetIn = (quota: Pick<Quota, 'resetsAt'>, now: Date, t: Translate): string => t('consumption_reset_in', { time: duration(minutesUntil(quota.resetsAt, now), t) });

// The sentence above the quotas: the first harness to reach 100 % before its
// reset, else that none does, else that nothing is measured yet.
export function headline(data: Consumption, language: Language, t: Translate): { readonly kind: 'hit' | 'ok' | 'none'; readonly text: string; readonly harness?: string } {
  const week = data.harnesses.flatMap((h) => h.quotas.filter((q) => q.window === 'seven_day').map((quota) => ({ h, quota })));
  const hits = week.flatMap((entry) => (entry.quota.projection.kind === 'before_reset' ? [{ ...entry, at: entry.quota.projection.hitsAt }] : []))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = hits[0];
  if (first) {
    return { kind: 'hit', harness: first.h.harness, text: t('consumption_headline_hit', { harness: harnessName(first.h.harness, t), when: moment(first.at, data.timeZone, language), reset: moment(first.quota.resetsAt, data.timeZone, language) }) };
  }
  if (week.length > 0) return { kind: 'ok', text: t('consumption_headline_ok') };
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
