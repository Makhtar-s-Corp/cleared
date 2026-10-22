// The store's versioned migrations (docs/v2/milestone-2-plan.md, decision
// 19). A module still creates its tables with CREATE TABLE IF NOT EXISTS; a
// migration changes what exists: a column added, rows filled. The versions
// applied are rows of v2_schema. Each migration names the tables it needs,
// and runs in one transaction once they all exist: openStore runs those of
// its own tables, applyTables those of the module tables it has just
// created. A caller that creates only some tables (the app, the user
// command) leaves the rest pending, in order, for the service's start.
//
// Before the first migration of a start, the ledger is copied with VACUUM
// INTO (a consistent copy of an open database and its WAL) as
// ledger.db.before-<version>-<time> next to it, 0600. The code never reads
// or removes these copies: the owner removes them by hand once the
// migration is trusted. A ledger with no row at all is not copied.
import { chmodSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { MigrationError } from './db.ts';

export { MigrationError };

export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly tables: readonly string[];            // it runs once every one of them exists
  up(db: DatabaseSync): void;                    // idempotent: what it would add may already be there
};

const SCHEMA_TABLE = 'CREATE TABLE IF NOT EXISTS v2_schema (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)';

const columns = (db: DatabaseSync, table: string): string[] =>
  (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((column) => column.name);

function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  if (!columns(db, table).includes(column)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
}

export const MIGRATIONS: readonly Migration[] = [
  {
    // The session's service (decision 18) and its preview's unguessable
    // segment (decision 20, issued by lane 15); an event's service is its
    // session's.
    version: 1, name: 'sessions and their events name their service', tables: ['sessions', 'session_events'],
    up(db) {
      addColumn(db, 'sessions', 'service', 'TEXT');
      addColumn(db, 'sessions', 'preview_key', 'TEXT');
      addColumn(db, 'session_events', 'service', 'TEXT');
    },
  },
  {
    // A wait names the service and the ticket's step it comes from (decisions 18 and 26).
    version: 2, name: 'inbox items name their service and step', tables: ['flow_inbox'],
    up(db) {
      addColumn(db, 'flow_inbox', 'service', 'TEXT');
      addColumn(db, 'flow_inbox', 'step', 'TEXT');
    },
  },
];

const exists = (db: DatabaseSync, table: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;

// The last version applied; 0 before the first migration, when v2_schema
// does not exist yet.
const applied = (db: DatabaseSync): number => exists(db, 'v2_schema')
  ? Number((db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM v2_schema').get() as { version: number }).version)
  : 0;

// Whether any table holds a row: an empty ledger has nothing to keep.
function holdsRows(db: DatabaseSync): boolean {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  return tables.some(({ name }) => db.prepare(`SELECT 1 FROM "${name}" LIMIT 1`).get() !== undefined);
}

// The ledgers already copied in this process: one copy per start.
const copied = new WeakSet<DatabaseSync>();

function backup(db: DatabaseSync, version: number, now: Date): void {
  if (copied.has(db)) return;
  const file = (db.prepare('PRAGMA database_list').all() as { name: string; file: string }[]).find((d) => d.name === 'main')?.file;
  copied.add(db);
  if (!file || !holdsRows(db)) return;
  const target = `${file}.before-${version}-${now.toISOString().replace(/[-:.]/g, '')}`;
  try {
    db.prepare('VACUUM INTO ?').run(target);
    chmodSync(target, 0o600);
  } catch (error) {
    copied.delete(db);
    throw new MigrationError(`cannot copy the ledger before migration ${version} to ${target}: ${error instanceof Error ? error.message : String(error)}; nothing was migrated`);
  }
}

// Runs the pending migrations whose tables exist, in order, each in its own
// transaction, and stops at the first one whose tables do not exist yet.
// A failing migration leaves the ledger as it was before it.
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS, now: () => Date = () => new Date()): void {
  const latest = migrations.at(-1)?.version ?? 0;
  const current = applied(db);
  if (current > latest) throw new MigrationError(`the ledger is at schema version ${current}, newer than this Cleared knows (${latest}): run the newer Cleared, or restore a copy made before it`);
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    if (!migration.tables.every((table) => exists(db, table))) return;
    // The copy is the ledger as it was: made before v2_schema is created.
    backup(db, migration.version, now());
    db.exec(SCHEMA_TABLE);
    db.exec('BEGIN IMMEDIATE');
    try {
      // Another process may have applied it since the read above.
      if (applied(db) >= migration.version) {
        db.exec('ROLLBACK');
        continue;
      }
      migration.up(db);
      db.prepare('INSERT INTO v2_schema (version, applied_at) VALUES (?, ?)').run(migration.version, now().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw new MigrationError(`migration ${migration.version} (${migration.name}) failed: ${error instanceof Error ? error.message : String(error)}; the ledger is left as it was before it`);
    }
  }
}
