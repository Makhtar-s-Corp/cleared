// The quota gauge at the sidebar's foot (the product owner's decision of
// 2026-10-25, 11:14, P227): of the agents' seven-day quotas, the one that
// matters most, in the Consumption screen's own verdict, so the gauge and
// the screen never disagree. The first to reach 100 % before its reset (one
// already at 100 % first), else the most used; a five-hour window is never
// the week's. Pure, so the tests run it under Node.
import type { Consumption, Quota } from '../../../src/api/types.ts';
import { verdictOf, type Verdict } from '../screens/consumption/model.ts';

export type WeeklyQuota =
  | { readonly kind: 'measured'; readonly percent: number; readonly verdict: Verdict; readonly resetsAt: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'unavailable' };   // no figure, and the hourly reading refuses this login (issue #509)

const reachAt = (quota: Quota): number => (quota.projection.kind === 'reached' ? -Infinity : quota.projection.kind === 'before_reset' ? Date.parse(quota.projection.hitsAt) : Infinity);

export function weeklyQuota(data: Pick<Consumption, 'harnesses'> | null): WeeklyQuota {
  const week = (data?.harnesses ?? []).flatMap((h) => h.quotas.filter((q) => q.window === 'seven_day'));
  const hits = week.filter((q) => verdictOf(q.projection) === 'hit').sort((a, b) => reachAt(a) - reachAt(b));
  const shown = hits[0] ?? [...week].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (!shown) return (data?.harnesses ?? []).some((h) => h.lastReading?.unavailable) ? { kind: 'unavailable' } : { kind: 'none' };
  return { kind: 'measured', percent: shown.usedPercent, verdict: verdictOf(shown.projection), resetsAt: shown.resetsAt };
}

// The colour of a quota's bar and figure (the project lead's review of #462, lane j6-ui-pro): the accent up to 80 %,
// amber past 80 %, red only past 90 %. The verdict (will it be reached before its reset) stays in the words.
export type QuotaLevel = 'ok' | 'high' | 'over';
export const quotaLevel = (percent: number): QuotaLevel => (percent > 90 ? 'over' : percent > 80 ? 'high' : 'ok');
