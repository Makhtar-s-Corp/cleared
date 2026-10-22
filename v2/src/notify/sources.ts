// Where the dispatcher learns what may notify (docs/v2/milestone-2-plan.md,
// section 6), each read at every tick:
//
//   the inbox     what waits for a person now: a release (approval), a
//                 permission, a question (a team's, or the lead's), a plan
//   v1's events   what the release watch (lib/release.mjs) wrote since the
//                 last tick: a rollback, or a watch that failed (health)
//
// The flow's FlowEvents are not read: the flow's engine is built on the
// first request to the API, so a service restarted at night with no
// browser open would never say a rollback. The ledger's rows are the ones
// the flow itself reads for its rolled_back event (flow/ledger.ts), and
// the release watch writes them whether or not the engine runs.
//
// Nothing of a permission's input, a question's text, a plan's summary or
// a ledger row's detail is taken: a notification says its kind, the ticket,
// a title and a health code, nothing more.
import type { DatabaseSync } from 'node:sqlite';
import type { InboxItem } from '../api/types.ts';
import { LEAD_TICKET } from '../lead/contract.ts';
import type { Kind, Occurrence } from './queue.ts';

// The kinds that last as long as their inbox item waits.
export const INBOX_KINDS: readonly Kind[] = ['approval', 'permission', 'question', 'plan'];

// The lead's items have no ticket: they are one group, told on /lead.
const LEAD_GROUP = 'lead';
const inboxLink = (id: string) => `/inbox#${encodeURIComponent(id)}`;

export function inboxOccurrences(items: readonly InboxItem[]): Occurrence[] {
  const out: Occurrence[] = [];
  for (const item of items) {
    if (item.state !== 'waiting') continue;
    const base = { key: item.id, at: item.since, code: null, from: null };
    const team = { ...base, ticket: item.ticket, group: item.ticket, link: inboxLink(item.id) };
    if (item.kind === 'release') out.push({ ...team, kind: 'approval', title: item.title });
    else if (item.kind === 'permission') out.push({ ...team, kind: 'permission', title: '' });
    else if (item.kind === 'question' && item.ticket === LEAD_TICKET) out.push({ ...base, kind: 'question', ticket: null, group: LEAD_GROUP, title: '', link: '/lead', from: 'lead' });
    else if (item.kind === 'question') out.push({ ...team, kind: 'question', title: '' });
    else if (item.kind === 'plan') out.push({ ...base, kind: 'plan', ticket: null, group: LEAD_GROUP, title: item.title, link: '/lead' });
  }
  return out;
}

// The release watch's rows, as lib/notify.mjs (v1) read them.
const ROLLBACK = ['rollback_pushed', 'prod_revert'];
const RELEASE_HEALTH = ['release_health_failing', 'rollback_health_still_failing', 'release_watch_failed', 'rollback_failed', 'rollback_migrations_blocked', 'rollback_ambiguous_base'];
const TICKET = /^[A-Za-z0-9._-]{1,40}$/;

type Raw = Record<string, unknown>;

function rows<T>(read: () => T[]): T[] {
  try {
    return read();
  } catch (error) {
    // A ledger where v1 never wrote has no events or releases table yet: nothing happened.
    if (error instanceof Error && /no such table/.test(error.message)) return [];
    throw error;
  }
}

// The last event_id of v1's events table, 0 when it has none.
export function lastEvent(db: DatabaseSync): number {
  return rows(() => [db.prepare('SELECT COALESCE(MAX(event_id), 0) AS id FROM events').get() as Raw]).map((row) => Number(row.id))[0] ?? 0;
}

// The rows after `cursor` that notify.
export function ledgerOccurrences(db: DatabaseSync, cursor: number): Occurrence[] {
  const kinds = [...ROLLBACK, ...RELEASE_HEALTH];
  const found = rows(() => db.prepare(`SELECT event_id, at, kind, ticket FROM events WHERE event_id > ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY event_id`).all(cursor, ...kinds) as Raw[]);
  // The title the release was merged with (lib/release.mjs), as v1 said it.
  const titleOf = (ticket: string) => rows(() => [db.prepare('SELECT title FROM releases WHERE ticket = ? ORDER BY id DESC LIMIT 1').get(ticket) as Raw | undefined])
    .map((row) => (row ? String(row.title) : ''))[0] ?? '';
  return found.map((row) => {
    const ticket = TICKET.test(String(row.ticket ?? '')) ? String(row.ticket) : null;
    const kind = String(row.kind);
    const title = ticket ? titleOf(ticket) : '';
    const at = String(row.at);
    if (ROLLBACK.includes(kind)) return { key: `rollback:${String(row.event_id)}`, kind: 'rollback', ticket, group: ticket ?? 'rollback:none', title, code: null, link: '/inbox', from: null, at };
    return { key: `health:${String(row.event_id)}`, kind: 'health', ticket, group: ticket ?? `health:${kind}`, title, code: kind, link: '/', from: null, at };
  });
}
