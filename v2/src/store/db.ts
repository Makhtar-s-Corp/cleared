// The service's store: the v1 ledger file (ledger.db), opened with
// node:sqlite as lib/ledger.mjs opens it, so that the tracker tables and the
// runs merge-pr.sh reads stay in the same file (docs/v2/milestone-1-plan.md,
// decision 11). This file owns three tables: session_events, sessions and
// policy_rules. Every other table belongs to the module that declares it.
// What changes a table that exists is a versioned migration (migrations.ts,
// milestone 2 decision 19), run here once the tables it needs exist.
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Harness, Role, SessionId, UserId } from '../session/contract.ts';
import type { AgUiEvent, EventLog, SessionEvent } from '../session/events.ts';
import { MIGRATIONS, migrate, type Migration } from './migrations.ts';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS session_events (
  session_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, ticket TEXT NOT NULL, project TEXT NOT NULL,
  type TEXT NOT NULL, event TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, ticket TEXT NOT NULL, role TEXT NOT NULL, harness TEXT NOT NULL,
  model TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_ticket ON sessions(ticket);
CREATE TABLE IF NOT EXISTS policy_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, tool TEXT NOT NULL, pattern TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (project, tool, pattern)
);
`;

export class LedgerPathError extends Error {
  override name = 'LedgerPathError';
}

// The ledger exists where it should but cannot be opened: a directory that
// cannot be made or written, a file that is not a database, a lock.
export class StoreError extends Error {
  override name = 'StoreError';
}

// A migration that cannot run, or a ledger newer than this code: the ledger
// is left as it was before the failing migration.
export class MigrationError extends StoreError {
  override name = 'MigrationError';
}

// The project whose ledger this is, named as v1 names it (lib/conf.mjs
// projectDir): CLEARED_REPO, ORCH_REPO, or the first line of
// <config>/cleared/project. v1's last resort, asking git for the checkout
// that holds Cleared, is not followed: the v2 service runs no git to find
// its own state.
function projectName(env: NodeJS.ProcessEnv): string | undefined {
  const named = env.CLEARED_REPO || env.ORCH_REPO;
  if (named) return basename(named);
  const config = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config');
  try {
    const line = readFileSync(join(config, 'cleared', 'project'), 'utf8').split('\n')[0]?.trim();
    return line ? basename(line) : undefined;
  } catch {
    return undefined;
  }
}

// Where ledger.db is, as lib/ledger.mjs ledgerPath and lib/conf.mjs stateDir
// find it: ORCH_LEDGER, then CLEARED_STATE_DIR or ORCH_STATE_DIR, then
// <XDG_STATE_HOME or ~/.local/state>/cleared/<project name>.
export function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ORCH_LEDGER) return env.ORCH_LEDGER;
  const state = env.CLEARED_STATE_DIR || env.ORCH_STATE_DIR;
  if (state) return join(state, 'ledger.db');
  const project = projectName(env);
  if (!project) throw new LedgerPathError('cannot tell where ledger.db is: set CLEARED_STATE_DIR (or ORCH_LEDGER), or name the project with CLEARED_REPO');
  return join(env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'), 'cleared', project, 'ledger.db');
}

export type SessionRecord = {
  readonly id: SessionId;
  readonly project: string;
  readonly ticket: string;
  readonly role: Role;
  readonly harness: Harness;
  readonly model: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  // Milestone 2 (lane 14): the workspace service it works on, and its
  // preview's unguessable segment (decision 20, issued by lane 15). Read
  // back as null when unset; a put that leaves them out keeps them.
  readonly service?: string | null;
  readonly previewKey?: string | null;
};

export type LearnedRule = {
  readonly project: string;
  readonly tool: string;
  readonly pattern: string;
  readonly by: UserId;
  readonly at: string;
};

export type Store = {
  readonly db: DatabaseSync;
  readonly events: EventLog;
  readonly sessions: {
    put(record: SessionRecord): void;
    get(id: SessionId): SessionRecord | undefined;
    list(filter?: { readonly ticket?: string }): SessionRecord[];
  };
  readonly policyRules: {
    learn(rule: LearnedRule): void;                 // an "Always in this project" answer; the same rule twice is kept once
    learned(project: string): { tool: string; pattern: string }[];
  };
  close(): void;
};

// Creates a module's tables, then runs the migrations that waited for them.
// Each statement must create only what does not exist yet, so opening the
// store never changes a table someone else owns. A migration that fails
// stops the process with exit 64 and its message, as a ledger that cannot
// be opened does: main.ts calls this at the start, before it listens.
export function applyTables(db: DatabaseSync, tables: readonly string[], migrations: readonly Migration[] = MIGRATIONS): void {
  for (const statement of tables) {
    if (!/^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\b/i.test(statement))
      throw new Error(`a module table is created with CREATE TABLE IF NOT EXISTS (or CREATE INDEX IF NOT EXISTS), not: ${statement.trim().slice(0, 60)}`);
    db.exec(statement);
  }
  try {
    migrate(db, migrations);
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    console.error(`cleared-v2: ${error.message}`);
    process.exit(64);
  }
}

type Row = Record<string, unknown>;
const text = (row: Row, key: string) => String(row[key]);

function session(row: Row): SessionRecord {
  return {
    id: text(row, 'id'), project: text(row, 'project'), ticket: text(row, 'ticket'), role: text(row, 'role') as Role,
    harness: text(row, 'harness') as Harness, model: text(row, 'model'), status: text(row, 'status'),
    createdAt: text(row, 'created_at'), updatedAt: text(row, 'updated_at'),
    service: row.service === null ? null : text(row, 'service'), previewKey: row.preview_key === null ? null : text(row, 'preview_key'),
  };
}

// Opened as lib/ledger.mjs openLedger opens it for writing: the directory
// made, a 5 second busy timeout, the WAL journal, which v1 already sets on
// the same file, so merge-pr.sh and the tracker read it as before.
function openDatabase(path: string): DatabaseSync {
  let db: DatabaseSync | undefined;
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    return db;
  } catch (error) {
    db?.close();
    throw new StoreError(`cannot open the ledger at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function openStore(path: string): Store {
  const db = openDatabase(path);
  try {
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  // One statement, so the next seq is read and written at once. The event's
  // service is its session's.
  const append = db.prepare(
    'INSERT INTO session_events (session_id, seq, at, ticket, project, type, event, service) ' +
    'SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, (SELECT service FROM sessions WHERE id = ?) FROM session_events WHERE session_id = ? RETURNING seq',
  );
  const after = db.prepare('SELECT seq, at, session_id, ticket, project, event FROM session_events WHERE session_id = ? AND seq > ? ORDER BY seq');
  const putSession = db.prepare(
    'INSERT INTO sessions (id, project, ticket, role, harness, model, status, created_at, updated_at, service, preview_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET model = excluded.model, status = excluded.status, updated_at = excluded.updated_at, ' +
    'service = COALESCE(excluded.service, sessions.service), preview_key = COALESCE(excluded.preview_key, sessions.preview_key)',
  );
  const getSession = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const allSessions = db.prepare('SELECT * FROM sessions ORDER BY created_at, id');
  const ticketSessions = db.prepare('SELECT * FROM sessions WHERE ticket = ? ORDER BY created_at, id');
  const learn = db.prepare('INSERT OR IGNORE INTO policy_rules (project, tool, pattern, created_by, created_at) VALUES (?, ?, ?, ?, ?)');
  const learned = db.prepare('SELECT tool, pattern FROM policy_rules WHERE project = ? ORDER BY id');

  const events: EventLog = {
    append(entry) {
      const row = append.get(entry.sessionId, entry.at, entry.ticket, entry.project, entry.event.type, JSON.stringify(entry.event), entry.sessionId, entry.sessionId) as Row;
      return { seq: Number(row.seq), ...entry };
    },
    after(sessionId, seq = 0) {
      return (after.all(sessionId, seq) as Row[]).map((row): SessionEvent => ({
        seq: Number(row.seq), at: text(row, 'at'), sessionId: text(row, 'session_id'), ticket: text(row, 'ticket'), project: text(row, 'project'),
        event: JSON.parse(text(row, 'event')) as AgUiEvent,
      }));
    },
  };

  return {
    db,
    events,
    sessions: {
      put: (r) => { putSession.run(r.id, r.project, r.ticket, r.role, r.harness, r.model, r.status, r.createdAt, r.updatedAt, r.service ?? null, r.previewKey ?? null); },
      get: (id) => { const row = getSession.get(id) as Row | undefined; return row ? session(row) : undefined; },
      list: (filter = {}) => ((filter.ticket === undefined ? allSessions.all() : ticketSessions.all(filter.ticket)) as Row[]).map(session),
    },
    policyRules: {
      learn: (r) => { learn.run(r.project, r.tool, r.pattern, r.by, r.at); },
      learned: (project) => (learned.all(project) as Row[]).map((row) => ({ tool: text(row, 'tool'), pattern: text(row, 'pattern') })),
    },
    close: () => db.close(),
  };
}
