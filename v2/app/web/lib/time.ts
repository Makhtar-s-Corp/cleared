// Every time the app says, in one place (the owner's requests of
// 2026-10-23, 08:30 and 08:40, lane i18n): a duration is "42 min" under an
// hour, "10 h 30" (English "10h 30m") under a day, "2 j 4 h" ("2d 4h")
// past it, so no screen ever says "1342 min"; a date is said relative to
// now, "il y a 3 min" ("3 min ago"), "il y a 2 h", "hier" ("yesterday"),
// "il y a 3 j"; a moment of the day is a clock, "09:05". The numbers go
// through Intl in the catalog's locale (its `locale` key), and so does
// "hier"; the units are the `time_*` keys of the shell's catalog, which
// every screen's translator holds. Pure, so the tests run it under Node;
// app/test/time.test.ts is its table, and web/test/durations.test.tsx reads
// every screen for a duration in minutes above 59. The app's numbers go
// through here too (fixed, count, decimal). Two dates do not: the tower's
// next scheduled run names its weekday and the Lead's thread its day and
// month through Date.toLocaleDateString in the page's language, Intl as
// well, but outside this file.
import type { Translate } from './i18n.ts';

const HOUR = 60;
const DAY = 24 * HOUR;
const pad = (n: number) => String(n).padStart(2, '0');

// A number in the catalog's locale; the minutes after the hours with the
// catalog's digits ("10 h 05" in French, "10h 5m" in English).
// A translator without the shell's catalog (a test's) counts in English.
const locale = (t: Translate) => (t('locale') === 'fr' ? 'fr' : 'en');
const number = (n: number, t: Translate, digits = 1) => new Intl.NumberFormat(locale(t), { minimumIntegerDigits: digits, useGrouping: false }).format(n);

// A number with fixed decimals in a language ("3,90" or "3.90"), never grouped inside a sentence.
export const fixed = (value: number, digits: number, language: 'en' | 'fr'): string =>
  new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(value);

// A count in a language, grouped as the language groups ("35 500" or "35,500").
export const count = (value: number, language: 'en' | 'fr'): string => new Intl.NumberFormat(language).format(value);

// A decimal number in the catalog's locale: "3,9" in French, "3.9" in English.
export const decimal = (value: number, t: Translate, min: number, max: number): string =>
  new Intl.NumberFormat(locale(t), { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: false }).format(value);

// 42 min, 1 h, 10 h 30, 1 j, 2 j 4 h: rounded to the minute, never negative.
// Past a day the minutes are dropped.
export function duration(minutes: number, t: Translate): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole < HOUR) return t('time_minutes', { n: number(whole, t) });
  if (whole < DAY) {
    const h = number(Math.floor(whole / HOUR), t);
    const m = whole % HOUR;
    return m === 0 ? t('time_hours', { h }) : t('time_hours_minutes', { h, m: number(m, t, Number(t('time_minute_digits')) || 1) });
  }
  const d = number(Math.floor(whole / DAY), t);
  const h = Math.floor((whole % DAY) / HOUR);
  return h === 0 ? t('time_days', { d }) : t('time_days_hours', { d, h: number(h, t) });
}

// An estimate or a critical path: never zero.
export const estimate = (minutes: number, t: Translate): string => duration(Math.max(1, minutes), t);

const minutesBetween = (from: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000));

// How long something has waited or run since `from`: "à l'instant" under a minute.
export function since(from: string, now: Date, t: Translate): string {
  const minutes = minutesBetween(from, now);
  return minutes < 1 ? t('time_now') : duration(minutes, t);
}

// How long a run took, in milliseconds: seconds under a minute ("42 s").
export function lasted(ms: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? t('time_seconds', { n: number(seconds, t) }) : duration(Math.floor(seconds / 60), t);
}

const dayStart = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

// When something happened, relative to now: minutes under an hour, hours
// the same day, "hier" the day before, then days. Calendar days, in the
// page's time zone: at 00:20, three hours back is yesterday.
export function ago(at: string, now: Date, t: Translate): string {
  const minutes = minutesBetween(at, now);
  if (minutes < 1) return t('time_now');
  if (minutes < HOUR) return t('time_ago', { time: t('time_minutes', { n: number(minutes, t) }) });
  const days = Math.round((dayStart(now) - dayStart(new Date(at))) / (DAY * 60_000));
  if (days <= 0) return t('time_ago', { time: t('time_hours', { h: number(Math.floor(minutes / HOUR), t) }) });
  if (days === 1) return new Intl.RelativeTimeFormat(locale(t), { numeric: 'auto' }).format(-1, 'day');
  return t('time_ago', { time: t('time_days', { d: number(days, t) }) });
}

// 09:05.
export const clock = (iso: string): string => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
