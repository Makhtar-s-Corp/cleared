// The import of a v1 ledger into v2's (docs/v2/milestone-4-plan.md, section
// 3): what it would bring, and with `apply` what it brings, once.
//
//   The samples go in v1_ticket_samples, keyed by the workspace and the v1
//   ticket, so a second run adds nothing. A decision the owner approved in
//   v1 is approved in v2 through lib/memory, in a child Node process as
//   knowledge/memory.ts approves one, only when v1 holds the owner's record,
//   that owner is v2's, and the file is the same text in v2's checkout,
//   committed and on disk; v1's record is kept in v1_memory_approvals.
//   v2's own ledger is never read as v1's.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyTables, openStore } from '../store/db.ts';
import { git } from '../workspace/checkout.ts';
import { SAMPLES_TABLE } from './samples.ts';
import { V1ImportError, readV1, type V1Approval, type V1Sample, type V1Skip } from './v1.ts';

export const IMPORT_TABLES: string[] = [
  SAMPLES_TABLE,
  `CREATE TABLE IF NOT EXISTS v1_memory_approvals (
  id TEXT PRIMARY KEY, path TEXT NOT NULL, v1_by TEXT NOT NULL, v1_at TEXT NOT NULL, imported_at TEXT NOT NULL
)`,
];

export type ApprovalSkip = 'changed' | 'missing' | 'other_owner' | 'no_owner' | 'no_record';

export type ImportOptions = {
  readonly from: string;                  // the v1 ledger.db
  readonly ledger: string;                // v2's, as store/db.ts ledgerPath finds it
  readonly project: string;               // the workspace the samples are for
  readonly checkout: string;              // the workspace's checkout, where its memory reads its files
  readonly ownerId: string | undefined;   // [tracker] owner_id of v2's settings
  readonly apply: boolean;
  readonly env?: NodeJS.ProcessEnv;       // the service's, for lib/memory
  readonly now?: () => Date;
};

export type ImportReport = {
  readonly project: string;
  readonly applied: boolean;
  readonly measured: number;
  readonly samples: { readonly added: readonly V1Sample[]; readonly known: readonly string[]; readonly skipped: readonly V1Skip[] };
  readonly approvals: {
    readonly added: readonly { readonly path: string; readonly by: string; readonly at: string }[];
    readonly known: readonly string[];
    readonly skipped: readonly { readonly path: string; readonly reason: ApprovalSkip }[];
  };
  readonly handovers: number;
};

export class ImportMemoryError extends Error {
  override name = 'ImportMemoryError';
}

export async function importV1(options: ImportOptions): Promise<ImportReport> {
  if (sameFile(options.from, options.ledger)) throw new V1ImportError('same_file', options.from);
  const v1 = readV1(options.from);
  const known = knownOf(options.ledger, options.project, options.apply);
  const samples = v1.samples.filter((s) => !known.samples.has(s.ticket));
  const same = (s: V1Sample) => known.samples.get(s.ticket) === s.measuredAt;
  const taken: V1Skip[] = v1.samples.filter((s) => known.samples.has(s.ticket) && !same(s)).map((s) => ({ ticket: s.ticket, reason: 'taken' }));

  const skipped: { path: string; reason: ApprovalSkip }[] = [];
  const knownApprovals: string[] = [];
  let candidates: (V1Approval & { by: string; at: string })[] = [];
  for (const approval of v1.approvals) {
    const reason = await approvalSkip(approval, options);
    if (reason) skipped.push({ path: approval.path, reason });
    else if (known.approved.has(approval.id)) knownApprovals.push(approval.path);
    else candidates.push(approval as V1Approval & { by: string; at: string });
  }

  if (options.apply) {
    const at = (options.now?.() ?? new Date()).toISOString();
    const store = openStore(options.ledger);
    try {
      applyTables(store.db, IMPORT_TABLES);
      const insert = store.db.prepare('INSERT INTO v1_ticket_samples (project, ticket, lane, size, minutes, tokens, lines, measured_at, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
      store.db.exec('BEGIN IMMEDIATE');
      try {
        for (const s of samples) insert.run(options.project, s.ticket, s.lane, s.size, s.minutes, s.tokens, s.lines, s.measuredAt, at);
        store.db.exec('COMMIT');
      } catch (error) {
        store.db.exec('ROLLBACK');
        throw error;
      }
      if (candidates.length > 0) {
        const results = await approveInMemory(options, candidates);
        const record = store.db.prepare('INSERT INTO v1_memory_approvals (id, path, v1_by, v1_at, imported_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING');
        const approved = [];
        for (const candidate of candidates) {
          const result = results[candidate.id];
          if (result === 'approved') {
            record.run(candidate.id, candidate.path, candidate.by, candidate.at, at);
            approved.push(candidate);
          } else if (result === 'known') knownApprovals.push(candidate.path);
          else skipped.push({ path: candidate.path, reason: result === 'missing' ? 'missing' : 'changed' });
        }
        candidates = approved;
      }
    } finally {
      store.close();
    }
  }

  const order = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path, 'en');
  return {
    project: options.project,
    applied: options.apply,
    measured: v1.measured,
    samples: { added: samples, known: v1.samples.filter((s) => known.samples.has(s.ticket) && same(s)).map((s) => s.ticket), skipped: [...v1.skipped, ...taken].sort((a, b) => a.ticket.localeCompare(b.ticket, 'en', { numeric: true })) },
    approvals: { added: candidates.map(({ path, by, at }) => ({ path, by, at })), known: knownApprovals.sort((a, b) => a.localeCompare(b, 'en')), skipped: skipped.sort(order) },
    handovers: v1.handovers,
  };
}

// The same file by its real path, or by its inode when both exist (a hard
// link); a ledger not made yet by the real path of its folder.
function sameFile(from: string, ledger: string): boolean {
  const real = (path: string) => {
    try { return realpathSync(path); } catch { return undefined; }
  };
  const a = real(from) ?? resolve(from);
  const b = real(ledger) ?? join(real(dirname(ledger)) ?? resolve(dirname(ledger)), basename(ledger));
  if (a === b) return true;
  try {
    const [x, y] = [statSync(from), statSync(ledger)];
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

// What v2's ledger already holds: the workspace's imported tickets, each
// with the time of the measure it came from, and the approved decisions. A
// dry run never makes the ledger.
function knownOf(ledger: string, project: string, apply: boolean): { samples: Map<string, string>; approved: Set<string> } {
  const out = { samples: new Map<string, string>(), approved: new Set<string>() };
  if (!existsSync(ledger)) return out;
  const db = new DatabaseSync(ledger, { readOnly: !apply });
  try {
    const read = (sql: string, ...values: string[]) => {
      try { return db.prepare(sql).all(...values) as { key: string; at?: string }[]; }
      catch (error) {
        if (/no such table/.test((error as Error).message)) return [];
        throw error;
      }
    };
    for (const row of read('SELECT ticket AS key, measured_at AS at FROM v1_ticket_samples WHERE project = ?', project)) out.samples.set(row.key, String(row.at));
    for (const row of read("SELECT id AS key FROM memory_entries WHERE status = 'approved'")) out.approved.add(row.key);
  } finally {
    db.close();
  }
  return out;
}

// Why a v1 approval is not carried, or undefined when it can be.
async function approvalSkip(approval: V1Approval, options: ImportOptions): Promise<ApprovalSkip | undefined> {
  if (approval.by === null || approval.at === null) return 'no_record';
  if (!options.ownerId) return 'no_owner';
  if (approval.by !== options.ownerId) return 'other_owner';
  const file = resolve(options.checkout, approval.path);
  const inside = relative(options.checkout, file);
  if (inside.startsWith('..') || inside === '' || !existsSync(file) || !statSync(file).isFile()) return 'missing';
  if (readFileSync(file, 'utf8') !== approval.content) return 'changed';
  let committed: string;
  try {
    committed = await git(options.checkout, ['show', `HEAD:${inside}`]);
  } catch {
    return 'changed';
  }
  return committed === approval.content ? undefined : 'changed';
}

const MEMORY_MODULE = new URL('../../../lib/memory/contract.mjs', import.meta.url).href;
const CONF_MODULE = new URL('../../../lib/conf.mjs', import.meta.url).href;

// The child's program: lib/memory indexes the checkout, then approves each
// entry still a proposal whose indexed text is v1's, committed, as the owner
// (knowledge/memory.ts says why the child's tracker answers the owner).
const APPROVE_PROGRAM = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
try {
  const { createMemory } = await import(request.module);
  const { loadConf } = await import(request.conf);
  const conf = loadConf();
  conf.sections.tracker = { ...(conf.sections.tracker || {}), owner_id: request.owner };
  const memory = createMemory({ conf, tracker: { whoAmI: () => ({ kind: 'human', id: request.owner }) } });
  try {
    memory.index('');
    const out = {};
    for (const item of request.items) {
      const row = memory.db.prepare('SELECT status, content FROM memory_entries WHERE id = ?').get(item.id);
      const file = memory.db.prepare('SELECT committed FROM memory_files WHERE entry_id = ?').get(JSON.stringify([item.id]));
      if (!row || !file) out[item.id] = 'missing';
      else if (row.content !== item.content || !file.committed) out[item.id] = 'changed';
      else if (row.status === 'approved') out[item.id] = 'known';
      else if (row.status !== 'proposed') out[item.id] = 'changed';
      else { memory.approve(item.id); out[item.id] = 'approved'; }
    }
    process.stdout.write(JSON.stringify(out));
  } finally { memory.db.close(); }
} catch (error) {
  process.stderr.write(String(error && error.message || error));
  process.exitCode = 1;
}
`;

function approveInMemory(options: ImportOptions, items: readonly V1Approval[]): Promise<Record<string, string>> {
  const env = { ...process.env, ...options.env, CLEARED_REPO: options.checkout, CLEARED_LEDGER: options.ledger, ORCH_LEDGER: options.ledger };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '--eval', APPROVE_PROGRAM], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new ImportMemoryError(`memory: ${stderr.trim() || `exit ${code}`}`));
      try {
        resolve(JSON.parse(stdout) as Record<string, string>);
      } catch {
        reject(new ImportMemoryError('memory: the answer is not JSON'));
      }
    });
    child.stdin.end(JSON.stringify({ module: MEMORY_MODULE, conf: CONF_MODULE, owner: options.ownerId, items: items.map(({ id, content }) => ({ id, content })) }));
  });
}
