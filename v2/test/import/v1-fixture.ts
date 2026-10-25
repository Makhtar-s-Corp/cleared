// A v1 ledger for the import's tests, written by v1's own code in a child
// Node process (lib/conf.mjs copies the environment at import, as
// workspace/briefing.ts says): lib/ledger.mjs makes the runs and the events,
// the local tracker its tickets, lib/memory its entries and the owner's
// approval. Every ticket, file and text is invented.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { AGENTS_CONF, gitIn, tempDir, writeFiles } from '../workspace/git.ts';

export const OWNER = 'owner';

// The decisions of the v1 project, as committed in its checkout.
export const DECISIONS = {
  'docs/decisions/0001-queue.md': '# Queue\nOrders are sent through the queue, never written to the shop table directly.\n',
  'docs/decisions/0002-cache.md': '# Cache\nThe catalogue page is cached for five minutes.\n',
  'docs/decisions/0003-fonts.md': '# Fonts\nOne serif font everywhere.\n',
} as const;

export type V1Run = { readonly started: string; readonly ended: string; readonly tokens?: number; readonly lines?: number; readonly pr?: number };
export type V1Ticket = {
  readonly id: string;                    // LOCAL-<n> in the order created, or another tracker's id
  readonly labels?: readonly string[];
  readonly runs?: readonly V1Run[];
  // ticket_measured events, in order: total minutes, the detail's fields, or a detail that is not JSON
  readonly measures?: readonly ({ readonly at: string; readonly total: number; readonly lane: 'fast' | 'full'; readonly pr?: number; readonly todo: string; readonly done: string; readonly humanWait: number | null } | { readonly at: string; readonly unreadable: true })[];
};

export type V1Fixture = { readonly ledger: string; readonly checkout: string; readonly state: string };

const PROGRAM = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const r = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const { openLedger, runStart, addEvent } = await import(r.lib + '/ledger.mjs');
const { LocalTracker } = await import(r.lib + '/tracker/adapters/local.mjs');
const { createMemory } = await import(r.lib + '/memory/contract.mjs');
const conf = { sections: { memory: { enabled: 'true', budget: '8000' }, tracker: { owner_id: r.owner, todo_state: 'Todo', done_state: 'Done' } } };
const db = openLedger(r.ledger);
const tracker = new LocalTracker({ conf, db, actor: { kind: 'agents', id: 'cleared' }, approvalDir: r.state + '/validations' });
for (const ticket of r.tickets) {
  if (/^LOCAL-/.test(ticket.id)) {
    const made = tracker.createTicket({ title: 'Ticket ' + ticket.id, labels: ticket.labels || [], project: 'shop' });
    if ('LOCAL-' + made.id !== ticket.id) throw new Error('tickets are created in order: ' + ticket.id);
  }
  for (const [i, run] of (ticket.runs || []).entries()) {
    const runId = ticket.id + '-run-' + i;
    runStart(db, { runId, ticket: ticket.id, role: 'dev', model: 'claude-opus-5-5', startedAt: run.started, lane: ticket.id, project: 'shop' });
    db.prepare('UPDATE runs SET ended_at = ?, outcome = ?, tokens_total = ?, lines_changed = ?, pr_number = ? WHERE run_id = ?')
      .run(run.ended, 'done', run.tokens ?? null, run.lines ?? null, run.pr ?? null, runId);
  }
  for (const m of ticket.measures || []) {
    if (m.unreadable) addEvent(db, { kind: 'ticket_measured', at: m.at, ticket: ticket.id, value: 12, detail: '{not json' });
    else addEvent(db, { kind: 'ticket_measured', at: m.at, ticket: ticket.id, value: m.total, detail: JSON.stringify({ lane: m.lane, pr: m.pr ?? 0, todo_at: m.todo, done_at: m.done,
      working_min: m.total, human_wait_min: m.humanWait, machine_wait_min: 0, human_wait_from: m.humanWait === null ? null : 'card' }) });
  }
}
const memory = createMemory({ project: r.checkout, db, conf });
memory.index('');
const owner = createMemory({ project: r.checkout, db, conf, tracker: { whoAmI: () => ({ kind: 'human', id: r.owner }) } });
const id = (path) => db.prepare('SELECT id FROM memory_entries WHERE source_where = ?').get(path).id;
for (const path of r.approve) owner.approve(id(path));
for (const path of r.approvedWithoutRecord) db.prepare("UPDATE memory_entries SET status = 'approved' WHERE id = ?").run(id(path));
memory.write({ type: 'handover', scope: 'ticket:LOCAL-1', content: '## Done\\nThe queue.', source_who: 'agent:dev/claude-opus-5-5', source_where: 'session:LOCAL-1-run-0' });
db.close();
`;

// The v1 checkout holds DECISIONS; `approve` are approved by the owner
// through lib/memory, `approvedWithoutRecord` set approved with no event.
export function v1Ledger(tickets: readonly V1Ticket[], options: { readonly approve?: readonly string[]; readonly approvedWithoutRecord?: readonly string[]; readonly owner?: string } = {}): V1Fixture {
  const root = tempDir('v1');
  const checkout = join(root, 'shop');
  execFileSync('git', ['init', '-q', '-b', 'main', checkout]);
  writeFiles(checkout, { 'README.md': '# Shop\n', '.cleared/agents.conf': AGENTS_CONF, ...DECISIONS });
  gitIn(checkout, ['add', '-A']);
  gitIn(checkout, ['commit', '-q', '-m', 'decisions']);
  const state = join(root, 'state');
  const ledger = join(state, 'ledger.db');
  const lib = new URL('../../../lib', import.meta.url).pathname;
  execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '--eval', PROGRAM], {
    input: JSON.stringify({
      lib, ledger, state, checkout, owner: options.owner ?? OWNER, tickets,
      approve: options.approve ?? ['docs/decisions/0001-queue.md', 'docs/decisions/0002-cache.md'],
      approvedWithoutRecord: options.approvedWithoutRecord ?? [],
    }),
    env: { ...process.env, CLEARED_STATE_DIR: state, CLEARED_REPO: checkout, CLEARED_CONF: join(root, 'none.conf') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { ledger, checkout, state };
}

// v2's checkout of the same project: a clone of v1's, with `edits`
// committed, and `dirty` written but not committed.
export function v2Checkout(from: string, edits: Record<string, string> = {}, dirty: Record<string, string> = {}): string {
  const root = tempDir('v2-checkout');
  const checkout = join(root, 'shop');
  execFileSync('git', ['clone', '-q', from, checkout]);
  if (Object.keys(edits).length > 0) {
    writeFiles(checkout, edits);
    gitIn(checkout, ['add', '-A']);
    gitIn(checkout, ['commit', '-q', '-m', 'edits']);
  }
  writeFiles(checkout, dirty);
  return checkout;
}

// Minutes after a fixed day, as the ledger writes its stamps.
export const at = (minutes: number): string => new Date(Date.UTC(2026, 8, 1, 9, 0) + minutes * 60_000).toISOString();
