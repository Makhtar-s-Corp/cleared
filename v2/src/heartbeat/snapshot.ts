// What v2's ledger says of the service's health (docs/v2/milestone-4-plan.md,
// section 7.3), read and never written: the beat the service last wrote,
// its live sessions, what waits for the owner, the subscription's windows,
// the mirrors' last full passes and the release trains not landed. The
// sessions' tables are the store's own and always there; a module's table
// that does not exist yet (a ledger the service has not opened since it was
// updated) reads as empty.
import type { DatabaseSync } from 'node:sqlite';
import { latestQuota, type QuotaWindow } from '../consumption/quota.ts';
import type { HeartbeatSettings, MonitorState } from './settings.ts';

export type Snapshot = {
  readonly lastBeat: { readonly at: string; readonly ok: boolean; readonly everyMs: number } | null;
  readonly monitor: { readonly state: MonitorState; readonly refused: readonly string[] } | null;
  readonly sessions: readonly { readonly id: string; readonly ticket: string; readonly role: string; readonly status: string; readonly movedAt: string }[];
  readonly waiting: { readonly count: number; readonly oldest: { readonly ticket: string; readonly kind: string; readonly since: string } | null };
  readonly quota: readonly { readonly window: QuotaWindow; readonly usedPercent: number; readonly resetsAt: string | null }[] | null;
  readonly trackers: readonly { readonly name: string; readonly readAt: string }[];
  readonly releases: readonly { readonly ticket: string; readonly state: string; readonly since: string }[];
};

// The sessions the idle watchdog watches (session/watchdog.ts): the lead
// waits between events by design, and is not one of them.
const LIVE = ['starting', 'working', 'waiting_human', 'reviewing'];
const WATCHED = ['author', 'reviewer', 'reader'];
const NOT_LANDED = ['blocked', 'waiting', 'landing', 'halted'];

type Row = Record<string, unknown>;

function hasTable(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export const HEARTBEAT_STATE = 'v2_heartbeat_state';

export function stateOf(db: DatabaseSync): Map<string, string> {
  if (!hasTable(db, HEARTBEAT_STATE)) return new Map();
  return new Map((db.prepare(`SELECT key, value FROM ${HEARTBEAT_STATE}`).all() as Row[]).map((row) => [String(row.key), String(row.value)]));
}

const placeholders = (values: readonly string[]) => values.map(() => '?').join(', ');

export function collectSnapshot(db: DatabaseSync, input: { readonly settings: HeartbeatSettings; readonly project: string | null; readonly now: Date }): Snapshot {
  const state = stateOf(db);
  const beatAt = state.get('last_beat_at');
  const monitor = state.get('monitor');

  const sessions = (db.prepare(`SELECT s.id, s.ticket, s.role, s.status, s.updated_at AS updated, (SELECT MAX(e.at) FROM session_events e WHERE e.session_id = s.id) AS last
    FROM sessions s WHERE s.status IN (${placeholders(LIVE)}) AND s.role IN (${placeholders(WATCHED)}) ORDER BY s.created_at, s.id`).all(...LIVE, ...WATCHED) as Row[])
    .map((row) => {
      const updated = String(row.updated);
      const last = row.last === null ? null : String(row.last);
      return { id: String(row.id), ticket: String(row.ticket), role: String(row.role), status: String(row.status), movedAt: last && Date.parse(last) > Date.parse(updated) ? last : updated };
    });

  let waiting: Snapshot['waiting'] = { count: 0, oldest: null };
  if (hasTable(db, 'flow_inbox')) {
    const count = Number((db.prepare("SELECT COUNT(*) AS n FROM flow_inbox WHERE state = 'waiting'").get() as Row).n);
    const oldest = db.prepare("SELECT ticket, kind, since FROM flow_inbox WHERE state = 'waiting' ORDER BY since, id LIMIT 1").get() as Row | undefined;
    waiting = { count, oldest: oldest ? { ticket: String(oldest.ticket), kind: String(oldest.kind), since: String(oldest.since) } : null };
  }

  const project = input.project;
  const quota = project === null ? null : (['five_hour', 'seven_day'] as const).flatMap((window) => {
    const latest = latestQuota(db, { project, window, now: input.now });
    return latest ? [{ window, usedPercent: latest.usedPercent, resetsAt: latest.resetsAt }] : [];
  });

  const kinds = input.settings.trackers;
  const trackers = hasTable(db, 'mirror_trackers') && kinds.length > 0
    ? (db.prepare('SELECT tracker, read_at FROM mirror_trackers ORDER BY tracker').all() as Row[])
      .filter((row) => kinds.some((kind) => String(row.tracker).startsWith(`${kind}:`)))
      .map((row) => ({ name: String(row.tracker), readAt: String(row.read_at) }))
    : [];

  const releases = hasTable(db, 'release_trains')
    ? (db.prepare(`SELECT ticket, state, updated_at FROM release_trains WHERE state IN (${placeholders(NOT_LANDED)}) ORDER BY updated_at, item`).all(...NOT_LANDED) as Row[])
      .map((row) => ({ ticket: String(row.ticket), state: String(row.state), since: String(row.updated_at) }))
    : [];

  return {
    lastBeat: beatAt ? { at: beatAt, ok: state.get('last_beat_ok') !== 'false', everyMs: Number(state.get('beat_every_ms')) || 60_000 } : null,
    monitor: monitor === 'on' || monitor === 'off' || monitor === 'invalid'
      ? { state: monitor, refused: (state.get('monitor_refused') ?? '').split(',').filter(Boolean) }
      : null,
    sessions, waiting, quota, trackers, releases,
  };
}
