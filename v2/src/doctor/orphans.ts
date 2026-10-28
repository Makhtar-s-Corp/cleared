// The volumes and networks labelled cleared.dev=v2 that no live session
// holds (issue #477, after issue 265), for the ready section's orphans line.
// Read only: the ledger is opened read only and never made, Docker is asked
// labelled lists, and nothing is removed; the doctor says what to do.
//
// Live is the ledger's word for its own rows: a flow or lead session whose
// row is not in a live phase is not live, even with a container that still
// runs (issue 265's case: an egress left running after its stop). The
// running containers decide where the ledger cannot: a reader's row says
// done while it waits for a follow-up, and a session the ledger does not
// know (an environment check, the doctor's own probe, another install on
// this host, which shares the label) is live while one of its containers runs.
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SESSION_LABEL, type ContainerRow, type NetworkRow, type VolumeRow } from '../container/docker.ts';
import { LIVE_PHASES } from '../session/events.ts';

export type LedgerSession = { readonly ticket: string; readonly role: string; readonly status: string };

// The ledger's sessions by id, or undefined when there is no ledger yet.
// Throws when the file is there and cannot be read.
export function readLedgerSessions(path: string): ReadonlyMap<string, LedgerSession> | undefined {
  if (!existsSync(path)) return undefined;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get();
    if (!table) return new Map();
    const rows = db.prepare('SELECT id, ticket, role, status FROM sessions').all() as { id: string; ticket: string; role: string; status: string }[];
    return new Map(rows.map((row) => [String(row.id), { ticket: String(row.ticket), role: String(row.role), status: String(row.status) }]));
  } finally {
    db.close();
  }
}

// One object no live session holds; ticket when the ledger knows its session.
export type Orphan = { readonly name: string; readonly session?: string; readonly ticket?: string };

// networks: every orphan network. kept: the volumes of sessions the ledger
// knows, kept on purpose so that a stopped session can resume. unknown: the
// volumes of sessions it does not know.
export type Orphans = { readonly networks: readonly Orphan[]; readonly kept: readonly Orphan[]; readonly unknown: readonly Orphan[] };

export function findOrphans(input: {
  readonly containers: readonly ContainerRow[];
  readonly networks: readonly NetworkRow[];
  readonly volumes: readonly VolumeRow[];
  readonly sessions?: ReadonlyMap<string, LedgerSession>;
}): Orphans {
  const running = new Set(input.containers.filter((row) => row.state === 'running').map((row) => row.labels[SESSION_LABEL]).filter((s): s is string => s !== undefined));
  const live = (session: string | undefined): boolean => {
    if (session === undefined) return false;
    const row = input.sessions?.get(session);
    if (!row || row.role === 'reader') return running.has(session);
    return LIVE_PHASES.has(row.status);
  };
  const orphan = (row: { readonly name: string; readonly labels: Readonly<Record<string, string>> }): Orphan => {
    const session = row.labels[SESSION_LABEL];
    const ticket = session === undefined ? undefined : input.sessions?.get(session)?.ticket;
    return { name: row.name, ...(session === undefined ? {} : { session }), ...(ticket === undefined ? {} : { ticket }) };
  };
  const volumes = input.volumes.filter((row) => !live(row.labels[SESSION_LABEL])).map(orphan);
  return {
    networks: input.networks.filter((row) => !live(row.labels[SESSION_LABEL])).map(orphan),
    kept: volumes.filter((o) => o.ticket !== undefined),
    unknown: volumes.filter((o) => o.ticket === undefined),
  };
}
