// When a schedule runs (docs/v2/milestone-2-plan.md, decision 29), in the
// server's time zone:
//
//   every   day HH:MM          each day
//           weekdays HH:MM     Monday to Friday
//           monday HH:MM       one day of the week (monday to sunday)
//           hour :MM           each hour, at that minute
//   at      2026-10-24T03:00   once; with Z or an offset, at that instant
//
// A time a day does not have (02:30 when summer time starts) is the time
// the clock shows instead, as JavaScript's local dates make it; at the end
// of summer time a daily run comes after 25 hours, once.
export class ScheduleError extends Error {
  override name = 'ScheduleError';
}

export type Every = {
  readonly days: readonly number[];     // Date.getDay(): 0 is Sunday
  readonly hour: number | null;         // null: every hour
  readonly minute: number;
  readonly text: string;                // as written, normalized
};

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EVERY_FORMS = 'day HH:MM, weekdays HH:MM, a day of the week and HH:MM (monday 06:00), or hour :MM';

export function parseEvery(text: string): Every {
  const normal = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const refuse = (): never => { throw new ScheduleError(`"${text.slice(0, 40)}" is not a period: write ${EVERY_FORMS}`); };
  const hourly = /^hour :(\d{2})$/.exec(normal);
  if (hourly) {
    const minute = Number(hourly[1]);
    if (minute > 59) return refuse();
    return { days: [0, 1, 2, 3, 4, 5, 6], hour: null, minute, text: normal };
  }
  const daily = /^([a-z]+) (\d{2}):(\d{2})$/.exec(normal);
  if (!daily) return refuse();
  const [hour, minute] = [Number(daily[2]), Number(daily[3])];
  if (hour > 23 || minute > 59) return refuse();
  const word = daily[1] as string;
  const days = word === 'day' ? [0, 1, 2, 3, 4, 5, 6] : word === 'weekdays' ? [1, 2, 3, 4, 5] : DAYS.includes(word) ? [DAYS.indexOf(word)] : refuse();
  return { days, hour, minute, text: normal };
}

// The first time of the period strictly after `after`.
export function nextRun(every: string, after: Date): Date {
  const period = parseEvery(every);
  if (period.hour === null) {
    const at = new Date(after.getFullYear(), after.getMonth(), after.getDate(), after.getHours(), period.minute);
    return at.getTime() > after.getTime() ? at : new Date(at.getTime() + 3600_000);
  }
  for (let day = 0; day <= 7; day++) {
    const at = new Date(after.getFullYear(), after.getMonth(), after.getDate() + day, period.hour, period.minute);
    if (at.getTime() > after.getTime() && period.days.includes(at.getDay())) return at;
  }
  throw new ScheduleError(`no time of "${every}" in the week after ${after.toISOString()}`);
}

const AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

// A time to run once, which must be to come.
export function parseAt(text: string, now: Date): Date {
  const match = AT.exec(text.trim());
  const refuse = (why: string): never => { throw new ScheduleError(`"${text.slice(0, 40)}" ${why}`); };
  if (!match) return refuse('is not a time: write it as 2026-10-24T03:00, in the server\'s time zone, or with Z or its offset');
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(match[i] ?? 0)) as [number, number, number, number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return refuse('is not a day and a time that exist');
  const at = match[7] ? new Date(Date.parse(text.trim())) : new Date(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(at.getTime())) return refuse('is not a time');
  if (at.getTime() <= now.getTime()) return refuse(`is not to come: it is ${now.toISOString()} now`);
  return at;
}
