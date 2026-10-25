// The v1 tickets imported as samples of the plans' estimates
// (docs/v2/milestone-4-plan.md, section 3.3, item 1). The import creates the
// table (src/import/apply.ts); the estimates read it when it exists. A sample
// has no cost: v1 kept none from a real source.
import type { DatabaseSync } from 'node:sqlite';
import type { PlanItem } from '../api/types.ts';

export const SAMPLES_TABLE = `CREATE TABLE IF NOT EXISTS v1_ticket_samples (
  project TEXT NOT NULL, ticket TEXT NOT NULL, lane TEXT NOT NULL, size TEXT NOT NULL, minutes REAL NOT NULL,
  tokens INTEGER, lines INTEGER, measured_at TEXT NOT NULL, imported_at TEXT NOT NULL,
  PRIMARY KEY (project, ticket)
)`;

export type ImportedSample = { readonly size: PlanItem['size']; readonly lane: PlanItem['lane']; readonly minutes: number; readonly costUsd: null };

// The workspace's imported samples; none before the first import.
export function importedSamples(db: DatabaseSync, project: string): ImportedSample[] {
  let rows: Record<string, unknown>[];
  try {
    rows = db.prepare('SELECT size, lane, minutes FROM v1_ticket_samples WHERE project = ? ORDER BY ticket').all(project) as Record<string, unknown>[];
  } catch (error) {
    if (/no such table/.test((error as Error).message)) return [];
    throw error;
  }
  return rows.map((row) => ({ size: String(row.size) as PlanItem['size'], lane: row.lane === 'fast' ? 'fast' : 'full', minutes: Number(row.minutes), costUsd: null }));
}
