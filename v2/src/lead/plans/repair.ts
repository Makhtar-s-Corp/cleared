// The repair of the tickets that name a service the workspace no longer has
// (docs/v2/decisions-log-milestone-2.md, 2026-10-23, single-service mode): a
// workspace that changed under the same id, from several services to one, kept the
// old services' rows in the ledger, and plans approved before the fix named
// them on their tickets, which the flow refuses ("guestbook is not a
// service of workspace ..."). npm run repair-services
// (src/cli/repair-services.ts) runs it, a dry run unless --apply is given,
// with the service stopped. It renames and never deletes a row.
//
// A ticket is repaired when it is in Todo, in this workspace of one
// service, and names one service only, an unknown one, whose part never
// ran (no branch, no pull request):
//
//   - its part is renamed to the workspace's service;
//   - its plan item, held or put back, is put back, so the runner starts
//     it again at its next tick; its count of put backs is kept;
//   - a comment on the ticket says what changed.
//
// Left alone, and said why: a part that ran; steps of its plan item or of
// the flow on an unknown service (cancel the item and propose it again); a
// ticket that names more than that one service, or a ticket of a workspace
// of several services, which a rename alone cannot repair (removing a part
// would delete ledger data, and only a person knows which services a
// ticket of several touches). The ledger's `services` rows are never
// touched.
import type { DatabaseSync } from 'node:sqlite';

export type RepairWorkspace = { readonly id: string; readonly services: readonly string[] };

export type TicketRepair = {
  readonly ticket: string;
  readonly from: readonly string[];              // the services it names
  readonly to: readonly string[] | null;         // what it will name, or null when it is left alone
  readonly reason: string | null;                // why it is left alone
  readonly item: { readonly plan: string; readonly position: number; readonly from: string; readonly to: string } | null;
};

type Row = Record<string, unknown>;

const table = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

type Input = { readonly workspace: RepairWorkspace; readonly todo: string; readonly apply: boolean; readonly at: string };

// What the repair would do, or did with `apply`, ticket by ticket. Applied,
// it reads and writes in one transaction.
export function repairTicketServices(db: DatabaseSync, input: Input): TicketRepair[] {
  if (!table(db, 'ticket_services') || !table(db, 'tracker_tickets')) return [];
  if (!input.apply) return survey(db, input).out;
  db.exec('BEGIN IMMEDIATE');
  try {
    const { out, changes } = survey(db, input);
    for (const change of changes) change();
    db.exec('COMMIT');
    return out;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function survey(db: DatabaseSync, input: Input): { readonly out: TicketRepair[]; readonly changes: (() => void)[] } {
  const { workspace } = input;
  const known = new Set(workspace.services);
  const plans = table(db, 'plan_items') && table(db, 'plans');
  const planSteps = plans && table(db, 'plan_steps');
  const flowSteps = table(db, 'ticket_steps');
  const candidates = (db.prepare(`SELECT DISTINCT s.ticket FROM ticket_services s JOIN tracker_tickets t ON s.ticket = 'LOCAL-' || t.id
    WHERE t.project = ? AND t.status = ? ORDER BY t.id`).all(workspace.id, input.todo) as Row[]).map((row) => String(row.ticket));
  const out: TicketRepair[] = [];
  const changes: (() => void)[] = [];
  for (const ticket of candidates) {
    const parts = db.prepare('SELECT rowid, service, branch, pr FROM ticket_services WHERE ticket = ? ORDER BY rowid').all(ticket) as Row[];
    const from = parts.map((part) => String(part.service));
    const stale = parts.filter((part) => !known.has(String(part.service)));
    if (stale.length === 0) continue;
    const found = plans
      ? db.prepare(`SELECT i.plan_id, i.position, i.state FROM plan_items i JOIN plans p ON p.id = i.plan_id
          WHERE i.ticket = ? AND p.project = ? ORDER BY p.proposed_at DESC LIMIT 1`).get(ticket, workspace.id) as Row | undefined
      : undefined;
    const leave = (reason: string) => out.push({ ticket, from, to: null, reason, item: null });
    const ran = stale.find((part) => part.branch !== null || part.pr !== null);
    if (ran) { leave(`its part on ${String(ran.service)} has a branch or a pull request: repair it by hand`); continue; }
    const stepped = (rows: Row[]) => rows.map((row) => String(row.service)).find((name) => !known.has(name));
    const itemStep = found && planSteps
      ? stepped(db.prepare('SELECT service FROM plan_steps WHERE plan_id = ? AND item = ?').all(String(found.plan_id), Number(found.position)) as Row[])
      : undefined;
    if (itemStep) { leave(`item ${Number(found?.position)} of ${String(found?.plan_id)} has steps on ${itemStep}: cancel the item and propose it again`); continue; }
    const flowStep = flowSteps ? stepped(db.prepare('SELECT service FROM ticket_steps WHERE ticket = ?').all(ticket) as Row[]) : undefined;
    if (flowStep) { leave(`its steps run on ${flowStep}: repair it by hand`); continue; }
    if (workspace.services.length !== 1) { leave(`${workspace.id} has several services (${workspace.services.join(', ')}): name the ticket's by hand`); continue; }
    if (parts.length > 1) { leave(`it names ${from.join(', ')}: a rename cannot make that one service, and the repair deletes no part: set it aside, or cancel the item and propose it again`); continue; }
    const to = [workspace.services[0] as string];
    const itemState = found ? String(found.state) : null;
    const item = found && (itemState === 'held' || itemState === 'put_back')
      ? { plan: String(found.plan_id), position: Number(found.position), from: itemState, to: 'put_back' }
      : null;
    out.push({ ticket, from, to, reason: null, item });
    changes.push(() => {
      db.prepare('UPDATE ticket_services SET service = ? WHERE rowid = ?').run(to[0] as string, Number(stale[0]?.rowid));
      const note = `Cleared: this ticket named ${from[0]}, not a service of workspace ${workspace.id}; it now names ${to[0]}.`;
      const number = Number(ticket.slice('LOCAL-'.length));
      db.prepare("INSERT INTO tracker_comments(ticket, body, images, actor_kind, actor_id, created_at, proof) VALUES (?, ?, '[]', 'agents', 'cleared-v2', ?, NULL)").run(number, note, input.at);
      db.prepare('UPDATE tracker_tickets SET updated_at = ? WHERE id = ?').run(input.at, number);
      if (item) db.prepare('UPDATE plan_items SET state = ?, note = ?, updated_at = ? WHERE plan_id = ? AND position = ?').run(item.to, note, input.at, item.plan, item.position);
    });
  }
  return { out, changes };
}
