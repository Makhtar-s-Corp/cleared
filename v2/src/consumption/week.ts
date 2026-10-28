// The week's figures (docs/v2/requirements-matrix.md, C17, issue #396;
// docs/v2/milestone-4-plan.md, section 10), read from what the ledger already
// holds, with no table of their own and nothing written:
//
//   the week  the Consumption screen's seven days in the person's zone
//             (usage.ts lastDays), from the first one's midnight to now
//   merged    a ticket of the workspace Done now, whose last move to Done is
//             in the week and was the service's: the flow's (agents), or the
//             guarded merge's, which merge-pr.ts writes through v1's tracker
//             under the service account, read as `other`; never the mirror's
//             (an issue closed on a tracker) nor a person's signed move (a
//             move by hand is not a merge)
//   spend     every session of the workspace that finished a turn in the
//             week, whatever its role, counted as a ticket's cost is
//             (ticket-cost.ts sessionsCost from the week's start): tokens,
//             the agents' time, the dollars only as the harness reported
//             them, none when one session reported nothing
//   estimates each merged ticket a plan estimated (plan_items), its minutes
//             against its own, measured as the estimates measure a sample
//             (lead/plans/estimates.ts ticketSample); minutes only, since an
//             estimate's dollars fall back to invented defaults
//   services  a session's own service, else its ticket's one service, else
//             (a ticket that names none) the workspace's first; the lead,
//             the questions to the code and a ticket on several services
//             that names none on a row of the workspace's own (`service`
//             null), so the rows add up to the week. A merged ticket counts
//             once on each of its services.
import type { DatabaseSync } from 'node:sqlite';
import { ticketSample } from '../lead/plans/estimates.ts';
import type { Role } from '../session/contract.ts';
import type { AgUiEvent, SessionEvent } from '../session/events.ts';
import type { TicketId, TicketStore } from '../tickets/contract.ts';
import { MIRROR_ACTOR } from '../tickets/mirror.ts';
import { COST_EVENTS, sessionsCost, type SessionsCost } from './ticket-cost.ts';
import { dayOf, lastDays, zoneOf } from './usage.ts';

export type WeekTicket = {
  readonly id: TicketId;
  readonly title: string;
  readonly services: readonly string[];
  readonly mergedAt: string;
  readonly estimateMinutes: number | null;         // the plan's, null when no plan estimated it
  readonly actualMinutes: number | null;           // null when it reached no release request
};

export type WeekService = SessionsCost & {
  readonly service: string | null;                 // null: the workspace's own row
  readonly merged: number;
};

export type WeekFigures = {
  readonly at: string;
  readonly timeZone: string;
  readonly days: readonly string[];                // the Consumption screen's, oldest first
  readonly since: string;                          // the first day's midnight in the zone
  readonly merged: readonly WeekTicket[];          // the newest first
  readonly spend: SessionsCost;
  // Over the merged tickets that have both an estimate and their own minutes.
  readonly estimates: { readonly tickets: number; readonly estimatedMinutes: number; readonly actualMinutes: number };
  readonly services: readonly WeekService[];       // the configured ones in order, then any other a session names, then the workspace's
};

const HOUR_MS = 3_600_000;
const SAMPLED = "('RUN_STARTED', 'RUN_FINISHED', 'STEP_STARTED', 'STEP_FINISHED')";

// The first instant of a calendar day in a zone: UTC midnight moved by the
// zone's offset there, then by the hour until the day is the zone's (a day
// that begins at 01:00, as some zones' do when the clocks go forward).
export function startOfDay(day: string, zone: string): number {
  const midnight = Date.parse(`${day}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offset = (instant: number) => {
    const field = Object.fromEntries(parts.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
    return Date.parse(`${field.year}-${field.month}-${field.day}T${field.hour}:${field.minute}:${field.second}Z`) - instant;
  };
  let start = midnight - offset(midnight);
  start = midnight - offset(start);
  while (dayOf(start, zone) < day) start += HOUR_MS;
  while (dayOf(start - 1, zone) === day) start -= HOUR_MS;
  return start;
}

type SessionRow = { id: string; ticket: string; role: Role; service: string | null };
type EventRow = { session_id: string; seq: number; at: string; event: string };

function parsed(rows: readonly EventRow[]): { at: string; seq: number; sessionId: string; event: AgUiEvent }[] {
  return rows.flatMap((row) => {
    try { return [{ at: row.at, seq: row.seq, sessionId: row.session_id, event: JSON.parse(row.event) as AgUiEvent }]; } catch { return []; }
  });
}

// The latest estimate a plan of the workspace gave the ticket, or null.
function estimateOf(db: DatabaseSync, project: string, ticket: string): number | null {
  let row: { estimate: string } | undefined;
  try {
    row = db.prepare('SELECT i.estimate AS estimate FROM plan_items i JOIN plans p ON p.id = i.plan_id WHERE p.project = ? AND i.ticket = ? ORDER BY i.updated_at DESC LIMIT 1')
      .get(project, ticket) as { estimate: string } | undefined;
  } catch (error) {
    if (/no such table/.test((error as Error).message)) return null;
    throw error;
  }
  if (!row) return null;
  try {
    const minutes = (JSON.parse(row.estimate) as { minutes?: unknown }).minutes;
    return typeof minutes === 'number' && Number.isFinite(minutes) ? minutes : null;
  } catch {
    return null;
  }
}

// The ticket's own minutes, as an estimate's sample is measured, or null.
function actualOf(db: DatabaseSync, project: string, ticket: string): number | null {
  const sessions = db.prepare('SELECT id, role FROM sessions WHERE project = ? AND ticket = ?').all(project, ticket) as { id: string; role: string }[];
  const read = db.prepare(`SELECT session_id, seq, at, event FROM session_events WHERE session_id = ? AND type IN ${SAMPLED} ORDER BY seq`);
  const events = sessions.flatMap((s) => parsed(read.all(s.id) as EventRow[])
    .map((e): SessionEvent & { readonly role: string } => ({ ...e, ticket, project, role: s.role })));
  const sample = ticketSample(events);
  return sample ? Math.round(sample.minutes) : null;
}

export async function weekFigures(db: DatabaseSync, tickets: TicketStore | undefined, input: {
  readonly project: string; readonly services: readonly string[]; readonly now: Date; readonly timeZone?: string;
}): Promise<WeekFigures> {
  const zone = zoneOf(input.timeZone);
  const days = lastDays(input.now, zone);
  const from = startOfDay(days[0] as string, zone);
  const since = new Date(from).toISOString();
  const first = input.services[0] ?? null;
  const namesOf = (names: readonly string[] | undefined) => (names && names.length > 0 ? [...names] : first ? [first] : []);

  // The merged tickets.
  const merged: WeekTicket[] = [];
  if (tickets) {
    const done = await tickets.list({ status: tickets.states.done, project: input.project });
    const histories = await tickets.histories(done.map((t) => t.id));
    for (const ticket of done) {
      const last = (histories.get(ticket.id) ?? []).filter((h) => h.status === tickets.states.done).at(-1);
      if (!last || last.by.kind === 'human' || (last.by.kind === 'agents' && last.by.id === MIRROR_ACTOR.id)) continue;
      const at = Date.parse(last.at);
      if (!(at >= from && at <= input.now.getTime())) continue;
      merged.push({
        id: ticket.id, title: ticket.title, services: namesOf(ticket.services?.map((s) => s.name)), mergedAt: last.at,
        estimateMinutes: estimateOf(db, input.project, ticket.id), actualMinutes: actualOf(db, input.project, ticket.id),
      });
    }
  }
  merged.sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || a.id.localeCompare(b.id));

  // The sessions that ended a turn in the week, each with its turns from its start (its dollars need its totals before).
  const ids = (db.prepare(`SELECT DISTINCT session_id AS id FROM session_events WHERE project = ? AND type IN ('RUN_FINISHED', 'RUN_ERROR') AND at >= ?`)
    .all(input.project, since) as { id: string }[]).map((r) => r.id);
  const sessionOf = db.prepare('SELECT id, ticket, role, service FROM sessions WHERE id = ? AND project = ?');
  const turnsOf = db.prepare(`SELECT session_id, seq, at, event FROM session_events WHERE session_id = ? AND ${COST_EVENTS} ORDER BY seq`);
  const ticketServices = new Map<string, readonly string[]>();
  const rows = new Map<string | null, ReturnType<typeof parsed>[]>();
  for (const id of ids) {
    const session = sessionOf.get(id, input.project) as SessionRow | undefined;
    if (!session) continue;
    let bucket: string | null;
    if (session.role === 'lead' || session.role === 'reader') bucket = null;
    else if (session.service) bucket = session.service;
    else {
      if (!ticketServices.has(session.ticket)) ticketServices.set(session.ticket, (await tickets?.get(session.ticket))?.services?.map((s) => s.name) ?? []);
      const names = ticketServices.get(session.ticket) as readonly string[];
      bucket = names.length === 1 ? names[0] as string : names.length === 0 ? first : null;
    }
    const list = rows.get(bucket) ?? [];
    list.push(parsed(turnsOf.all(id) as EventRow[]));
    rows.set(bucket, list);
  }

  const named = [...input.services, ...[...rows.keys()].filter((k): k is string => k !== null && !input.services.includes(k)).sort()];
  const services: WeekService[] = named.map((service) => ({
    service, merged: merged.filter((m) => m.services.includes(service)).length, ...sessionsCost(rows.get(service) ?? [], from),
  }));
  if (rows.has(null)) services.push({ service: null, merged: 0, ...sessionsCost(rows.get(null) ?? [], from) });

  const estimated = merged.filter((m) => m.estimateMinutes !== null && m.actualMinutes !== null);
  return {
    at: input.now.toISOString(), timeZone: zone, days, since, merged,
    spend: sessionsCost([...rows.values()].flat(), from),
    estimates: {
      tickets: estimated.length,
      estimatedMinutes: estimated.reduce((n, m) => n + (m.estimateMinutes as number), 0),
      actualMinutes: estimated.reduce((n, m) => n + (m.actualMinutes as number), 0),
    },
    services,
  };
}
