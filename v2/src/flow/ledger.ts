// What became of a release once the human approved it, read from what the
// lock and the release watch write in ledger.db (docs/v2/milestone-2-plan.md,
// decision 12): merge-pr.ts's `merged_by_script` row in v1's `events` table,
// then lib/release.mjs's `releases` row, whose status is the watch's own
// verdict, with the times and the words of its `events` rows. The flow only
// reads these tables; v1 creates them, and a ledger where they do not exist
// yet reads as "nothing happened".
import type { DatabaseSync } from 'node:sqlite';

export type Landing =
  | { readonly state: 'waiting' }                                     // not merged
  | { readonly state: 'merged'; readonly mergedAt: string }           // merged, the watch still runs
  | { readonly state: 'landed'; readonly mergedAt: string; readonly at: string; readonly health: 'healthy' | 'unwatched' }
  | { readonly state: 'rolled_back'; readonly mergedAt: string; readonly at: string; readonly note: string }
  | { readonly state: 'unhealthy'; readonly mergedAt: string; readonly at: string; readonly note: string };

type Row = Record<string, unknown>;
type Event = { readonly at: string; readonly kind: string; readonly detail: string };

// merge-pr.ts writes its times to the second, the service to the
// millisecond, ask-validation.ts to the nanosecond: times are compared as
// instants, and from the start of the second of `since`.
const instant = (at: string): number => Date.parse(at);
const second = (at: string): number => Math.floor(instant(at) / 1000) * 1000;

// True when `at` is in the second of `since` or later.
export const atOrAfter = (at: string, since: string): boolean => instant(at) >= second(since);

// What a watch that ended without a healthy verdict says, last first.
const FAILURES = ['release_watch_failed', 'rollback_failed', 'rollback_overlapping_release', 'rollback_ambiguous_base', 'rollback_migrations_blocked', 'release_health_failing'];

function rows<T>(read: () => T[]): T[] {
  try {
    return read();
  } catch (error) {
    if (error instanceof Error && /no such table/.test(error.message)) return [];
    throw error;
  }
}

function events(db: DatabaseSync, ticket: string, pr: number, from: number): Event[] {
  return rows(() => db.prepare('SELECT at, kind, detail FROM events WHERE ticket = ? AND value = ? ORDER BY event_id').all(ticket, pr) as Row[])
    .map((row) => ({ at: String(row.at), kind: String(row.kind), detail: String(row.detail ?? '') }))
    .filter((event) => !Number.isNaN(instant(event.at)) && instant(event.at) >= from);
}

// The release of `pr` for `ticket` approved at `since`. `mergedHere` is the
// time the flow's own call to the lock merged it, for a ledger that does not
// say it (the lock writes the row; a test may not).
export function landingOf(db: DatabaseSync, input: { readonly ticket: string; readonly pr: number; readonly since: string; readonly mergedHere?: string }): Landing {
  const after = events(db, input.ticket, input.pr, second(input.since));
  const mergedAt = after.find((event) => event.kind === 'merged_by_script')?.at ?? input.mergedHere;
  if (mergedAt === undefined) return { state: 'waiting' };
  const watch = after.filter((event) => instant(event.at) >= second(mergedAt));
  const last = (kinds: readonly string[]) => [...watch].reverse().find((event) => kinds.includes(event.kind));

  const rollback = watch.find((event) => event.kind === 'rollback_pushed');
  if (rollback) return { state: 'rolled_back', mergedAt, at: rollback.at, note: rollback.detail };

  const release = rows(() => db.prepare('SELECT status, last_health, ended_at, merged_at FROM releases WHERE ticket = ? AND pr = ? ORDER BY id DESC LIMIT 1').all(input.ticket, input.pr) as Row[])
    .find((row) => instant(String(row.merged_at)) >= second(input.since));
  const status = release ? String(release.status) : undefined;
  const ended = release?.ended_at ? String(release.ended_at) : undefined;
  const unhealthy = (fallback: string, at: string): Landing => {
    const said = last(FAILURES);
    return { state: 'unhealthy', mergedAt, at: said?.at ?? at, note: said?.detail || fallback };
  };

  if (status === 'complete') {
    const unconfigured = last(['release_health_unconfigured']);
    if (unconfigured) return { state: 'landed', mergedAt, at: unconfigured.at, health: 'unwatched' };
    const complete = last(['release_watch_complete']);
    const at = complete?.at ?? ended ?? mergedAt;
    // Without an automatic rollback, a failing release still ends its window as complete.
    if (last(['release_health_failing'])) return unhealthy(String(release?.last_health ?? 'the health check failed'), at);
    return { state: 'landed', mergedAt, at, health: 'healthy' };
  }
  if (status === 'failed') return unhealthy(String(release?.last_health ?? 'the release watch failed'), ended ?? mergedAt);
  // No release row: merge-pr.ts merged, but the watch could not start.
  if (status === undefined && last(['release_watch_failed'])) return unhealthy('the release watch could not start', mergedAt);
  return { state: 'merged', mergedAt };
}
