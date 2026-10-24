// A row of the ledger's `events` table, which v1 creates (lib/ledger.mjs)
// and the reports and the proofs read: what the service did on its own
// (issue #290: a question timed out, an idle session stopped). A row that
// cannot be written (no table yet, the ledger locked) is said by its kind
// on the console and changes nothing, as the notifications' (notify/dispatcher.ts).
import type { DatabaseSync } from 'node:sqlite';

export function ledgerEvent(db: DatabaseSync, row: { readonly at: string; readonly kind: string; readonly ticket: string | null; readonly detail: object; readonly source: string }): void {
  try {
    db.prepare('INSERT INTO events (at, kind, ticket, detail, source) VALUES (?, ?, ?, ?, ?)').run(row.at, row.kind, row.ticket, JSON.stringify(row.detail), row.source);
  } catch {
    console.error(`cleared-v2: a ${row.kind} event could not be written to the ledger`);
  }
}
