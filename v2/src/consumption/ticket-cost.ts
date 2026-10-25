// The cost of a ticket (docs/v2/requirements-matrix.md, P211, issue #327),
// from the ledger only, nothing invented:
//
//   sessions every session the ledger holds for the ticket, whatever its
//            role and its run: the authors (a put-back run, a variant, a
//            handover included) and the reviewers. The lead's turns are kept
//            under its own ticket (lead/contract.ts LEAD_TICKET) and serve
//            several tickets at once: no share of them is the ticket's, and
//            none is counted
//   tokens   the four counts of each finished turn, as the Consumption screen
//            and the proof receipt count them (usage.ts turnTokens); null
//            when no turn finished
//   time     the agents' own time, each turn from its RUN_STARTED to its
//            RUN_FINISHED or RUN_ERROR; and the ticket's, from its first
//            stored event to its last
//   dollars  the API-equivalent figure the harness reports, never an
//            estimate and never euros (no source gives them). Claude Code's
//            `total_cost_usd` is the session's running total (decisions log,
//            lane 25), so a session's dollars are its last total, not the sum
//            of its turns; a turn with no total (a cancelled one) is skipped;
//            a total lower than the one before is a new process of the
//            session (a resume), whose totals add to what was spent. null
//            when a session that finished a turn reported no total (Codex,
//            Cursor): a partial sum is not the cost
//
// The proof receipt of a pull request (flow/engine.ts #receipt, P210) says
// ticketCost's figures, so the card and the receipt never differ.
//
// From a start (`since`, the week's figures, week.ts): only the turns
// finished at or after it, a turn begun before it counting the time inside;
// a session's dollars the increase of its running total after its last
// total before the start; a session that finished no turn since is left out.
import type { DatabaseSync } from 'node:sqlite';
import type { AgUiEvent, SessionEvent } from '../session/events.ts';
import { turnTokens } from './usage.ts';

export type SessionsCost = {
  readonly sessions: number;                       // the sessions that finished a turn
  readonly turns: number;
  readonly tokens: number | null;
  readonly workMs: number;
  readonly costUsd: number | null;
};

export type TicketCost = SessionsCost & {
  readonly ticket: string;
  readonly elapsedMs: number;                      // from the ticket's first stored event to its last
};

const usd = (value: number) => Math.round(value * 1e6) / 1e6;

export function sessionsCost(sessions: readonly (readonly Pick<SessionEvent, 'at' | 'event'>[])[], since?: number): SessionsCost {
  const from = since ?? -Infinity;
  let ran = 0;
  let turns = 0;
  let tokens = 0;
  let workMs = 0;
  let cost = 0;
  let known = true;
  for (const events of sessions) {
    let finished = 0;
    let reported = false;
    let last = 0;
    let spent = 0;
    let open: number | null = null;
    for (const { at, event } of events) {
      if (event.type === 'RUN_STARTED') open = Date.parse(at);
      if (event.type !== 'RUN_FINISHED' && event.type !== 'RUN_ERROR') continue;
      const end = Date.parse(at);
      const inside = end >= from;
      if (open !== null && inside) workMs += Math.max(0, end - Math.max(open, from));
      open = null;
      if (event.type === 'RUN_ERROR') continue;
      if (inside) {
        finished += 1;
        tokens += turnTokens(event);
      }
      const total = event.result.total_cost_usd;
      if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) continue;
      if (inside) {
        spent += total >= last ? total - last : total;
        reported = true;
      }
      last = total;
    }
    if (finished === 0) continue;
    ran += 1;
    turns += finished;
    if (reported) cost += spent;
    else known = false;
  }
  return { sessions: ran, turns, tokens: turns === 0 ? null : tokens, workMs, costUsd: turns > 0 && known ? usd(cost) : null };
}

type Row = { session_id: string; at: string; event: string };

// The ticket's sessions are found through the sessions table, indexed by
// ticket; their events through session_events' key.
const OF_TICKET = 'session_id IN (SELECT id FROM sessions WHERE project = ? AND ticket = ?) AND project = ? AND ticket = ?';

export function ticketCost(db: DatabaseSync, input: { readonly project: string; readonly ticket: string }): TicketCost {
  const keys = [input.project, input.ticket, input.project, input.ticket];
  const rows = db.prepare(`SELECT session_id, at, event FROM session_events
    WHERE ${OF_TICKET} AND type IN ('RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR') ORDER BY session_id, seq`).all(...keys) as Row[];
  const bySession = new Map<string, { at: string; event: AgUiEvent }[]>();
  for (const row of rows) {
    let event: AgUiEvent;
    try { event = JSON.parse(row.event) as AgUiEvent; } catch { continue; }
    const list = bySession.get(row.session_id) ?? [];
    list.push({ at: row.at, event });
    bySession.set(row.session_id, list);
  }
  const span = db.prepare(`SELECT MIN(at) AS first, MAX(at) AS last FROM session_events WHERE ${OF_TICKET}`).get(...keys) as { first: string | null; last: string | null };
  const elapsedMs = span.first && span.last ? Math.max(0, Date.parse(span.last) - Date.parse(span.first)) : 0;
  return { ticket: input.ticket, ...sessionsCost([...bySession.values()]), elapsedMs };
}
