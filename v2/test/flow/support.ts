// What the flow tests share: a store in memory, the in-memory ticket store
// and recorders of the registry, a fake adapter that plays one script per
// role, and effects that record their calls instead of running git, gh,
// Docker or the broker.
import { FlowEngine, type FlowEffects } from '../../src/flow/engine.ts';
import type { FlowConfig } from '../../src/flow/config.ts';
import { parseServices } from '../../src/container/services.ts';
import { RUNS_TABLES } from '../../src/approval/review.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import { MemoryApprovalWriter, MemoryReviewRecorder, MemoryUsers } from '../../src/modules/registry.ts';
import { createFakeAdapter, type FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionAdapter, SessionHandle, SessionId, StartInput } from '../../src/session/contract.ts';
import type { AgUiEvent, SessionEvent } from '../../src/session/events.ts';
import { applyTables, openStore, type Store } from '../../src/store/db.ts';
import { MemoryTicketStore, type Ticket } from '../../src/tickets/contract.ts';
import type { FlowEvent } from '../../src/flow/events.ts';
import type { ServiceLock } from '../../src/release/lock.ts';
import type { ServiceConfig } from '../../src/workspace/config.ts';

export const REPORT_PASS = 'I read the change.\n\nVerdict: “no blocking issues”\nDefects: none\nTo verify: nothing\nQuestions for the user: None.';
export const REPORT_FIX = 'I read the change.\n\nVerdict: “fix before merge”\nDefects: src/entries.ts:3 sorts the wrong way\nTo verify: nothing\nQuestions for the user: None.';

export const text = (id: string, delta: string): FakeStep[] => [
  { emit: { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' } },
  { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta } },
  { emit: { type: 'TEXT_MESSAGE_END', messageId: id } },
];
export const finished = (cost: number | null, thread = 'thread'): FakeStep => ({
  emit: { type: 'RUN_FINISHED', threadId: thread, runId: 'run', outcome: { type: 'success' }, usage: [{ inputTokens: 100, outputTokens: 10 }], result: { stopReason: 'end_turn', total_cost_usd: cost } },
});
export const started: FakeStep = { emit: { type: 'RUN_STARTED', threadId: 'thread', runId: 'run' } };
export const permission: FakeStep = {
  permission: { requestId: 'request-1', toolCallId: 'run-1', tool: 'Bash', input: { kind: 'execute', command: 'touch test/fixtures/entries.json' }, suggestion: { decision: 'ask', rule: 'default', reason: 'no rule allows this request' } },
};

// One author turn with a permission to answer and one message to take.
export const authorScript: readonly FakeStep[] = [started, ...text('a1', 'I will sort the entries.'), permission, { awaitMessage: true }, finished(0.4)];
export const quickAuthor: readonly FakeStep[] = [started, ...text('a1', 'Done.'), finished(0.3)];
export const reviewerScript = (report: string, cost = 0.1): readonly FakeStep[] => [started, ...text('r1', report), finished(cost)];
// What a reopened author does: waits for the request, then works one more turn.
export const reopenScript: readonly FakeStep[] = [{ awaitMessage: true }, started, ...text('a2', 'Fixed.'), finished(0.2)];

export type Scripts = {
  readonly author?: readonly FakeStep[];
  readonly authors?: readonly (readonly FakeStep[])[];       // one per author session started, then `author`
  readonly reviewers?: readonly (readonly FakeStep[])[];     // one per review round
  readonly reopen?: readonly FakeStep[] | 'throw' | 'send_fails';
  readonly stops?: SessionId[];                                // filled with the ids of resumed handles that were stopped
};

export type Started = { readonly input: StartInput; readonly id: SessionId };

// An adapter that plays the script of the session's role. A reviewer round
// takes the next script of the list. resume reopens an author under its own
// id, as the real adapter does, or throws.
export function scriptedAdapter(store: Store, scripts: Scripts, started_: Started[]): SessionAdapter {
  const authors = [...(scripts.authors ?? [])];
  const reviewers = [...(scripts.reviewers ?? [reviewerScript(REPORT_PASS)])];
  const inputs = new Map<SessionId, StartInput>();
  return {
    harness: 'claude-code',
    async start(input) {
      const handle = input.role === 'reviewer'
        ? await createFakeAdapter({ log: store.events, script: reviewers.shift() ?? reviewerScript(REPORT_PASS) }).start(input)
        : await createFakeAdapter({ log: store.events, script: authors.shift() ?? scripts.author ?? authorScript }).start(input);
      inputs.set(handle.id, input);
      started_.push({ input, id: handle.id });
      return handle;
    },
    async resume(id): Promise<SessionHandle> {
      const input = inputs.get(id);
      if (!input || scripts.reopen === 'throw') throw new Error(`cannot resume ${id}`);
      const handle = await createFakeAdapter({ log: store.events, script: scripts.reopen === 'send_fails' || scripts.reopen === undefined ? reopenScript : scripts.reopen, newId: () => id }).start(input);
      if (scripts.reopen !== 'send_fails') return handle;
      return { ...handle, send: async () => { throw new Error('the container is gone'); }, stop: async () => { scripts.stops?.push(id); await handle.stop(); } };
    },
  };
}

export type Calls = string[];

export function fakeEffects(calls: Calls, overrides: Partial<FlowEffects> = {}): FlowEffects {
  return {
    async settings() { return { verdict: 'no blocking issues', safeCommands: ['npm ci'], hosts: ['registry.npmjs.org'], services: parseServices('postgres:16'), scripts: ['test', 'typecheck'] }; },
    async refreshProject() { calls.push('refreshProject'); },
    async prepareWorkdir({ ticket, role }) {
      calls.push(`prepareWorkdir:${role}`);
      return { workdir: `/work/${ticket.id}`, briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null } };
    },
    async captureHandover(input) { calls.push(`captureHandover:${input.role}`); return 'entry-1'; },
    async publish(input) { calls.push(`publish:${input.ticket}`); return { url: 'https://example.invalid/pull/7', number: 7, head: 'abc123', created: true }; },
    async requestRelease(input) { calls.push(`requestRelease:${input.ticket}:${input.pr}`); return {}; },
    async prChecks() { return 'passed'; },
    async mergeRelease(input) { calls.push(`mergeRelease:${input.ticket}:${input.pr}`); return { outcome: 'merged', message: '' }; },
    ...overrides,
  };
}

export const CONFIG: FlowConfig = {
  project: 'guestbook', projectDir: '/srv/guestbook', repoUrl: 'https://example.invalid/guestbook.git', repo: 'example-org/cleared-example-guestbook',
  base: 'main', workdirRoot: '/work', authorModel: 'claude-opus-5-5', reviewerModel: 'claude-sonnet-5-5',
  idleMs: 15 * 60 * 1000, maxReviewRounds: 2, budgetUsd: undefined, mergeRetryMs: 60_000,
};

export type Setup = Awaited<ReturnType<typeof setup>>;

export type SetupOptions = {
  scripts?: Scripts; config?: Partial<FlowConfig>; effects?: Partial<FlowEffects>; adapterless?: boolean;
  ledger?: boolean;                       // the v1 events table the lock and the release watch write; true by default
  locks?: (service: ServiceConfig) => ServiceLock;   // the lock of each service of a workspace of several
  clean?: (text: string) => string;                  // the service's cleaner; the identity by default
};

export async function setup(options: SetupOptions = {}) {
  const store = openStore(':memory:');
  store.db.exec(INBOX_TABLE);
  if (options.ledger !== false) applyTables(store.db, [...RUNS_TABLES, RELEASES_TABLE]);
  const clock = { now: Date.parse('2026-10-21T10:00:00.000Z') };
  const tickets = new MemoryTicketStore({ now: () => new Date(clock.now).toISOString() });
  const users = new MemoryUsers();
  users.users.set('u1', { id: 'u1', name: 'Demo' });
  const recorder = new MemoryReviewRecorder();
  const approvals = new MemoryApprovalWriter();
  const calls: Calls = [];
  const startedSessions: Started[] = [];
  const inbox = new InboxStore(store.db, () => new Date(clock.now));
  const registry = {
    sessionAdapters: options.adapterless ? {} : { 'claude-code': scriptedAdapter(store, options.scripts ?? {}, startedSessions) },
    ticketStore: tickets, reviewRecorder: recorder, approvalWriter: approvals, users,
  };
  const deps = {
    store, inbox, registry, config: { ...CONFIG, ...options.config }, effects: fakeEffects(calls, options.effects),
    now: () => new Date(clock.now), ...(options.locks ? { locks: options.locks } : {}), ...(options.clean ? { clean: options.clean } : {}),
  };
  const engine = new FlowEngine(deps);
  const flowEvents: FlowEvent[] = [];
  engine.subscribe((event) => { flowEvents.push(event); });
  const ticket: Ticket = await tickets.create({ title: 'Newest entry first', body: 'The guestbook lists entries newest first.', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  return { deps, store, clock, tickets, users, recorder, approvals, calls, startedSessions, inbox, registry, engine, ticket, flowEvents };
}

// lib/release.mjs's table of the releases it watches, as it creates it (a
// test of landing.test.ts keeps the two texts the same).
export const RELEASES_TABLE = `CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL, pr INTEGER NOT NULL,
  merge_sha TEXT NOT NULL UNIQUE, title TEXT NOT NULL, merged_at TEXT NOT NULL,
  status TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, last_health TEXT,
  rollback_sha TEXT, planned_rollback_sha TEXT, rollback_pushed_at TEXT, ended_at TEXT, notified_at TEXT,
  watch_pid INTEGER
)`;

// A release as lib/release.mjs keeps it: one row per merge, its status the watch's verdict.
export function releaseRow(store: Store, row: { ticket: string; pr: number; status: string; mergedAt: string; lastHealth?: string; endedAt?: string }): void {
  store.db.prepare('INSERT INTO releases (ticket, pr, merge_sha, title, merged_at, status, last_health, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(row.ticket, row.pr, `${row.ticket}-${row.pr}-${row.mergedAt}`, 'Newest entry first', row.mergedAt, row.status, row.lastHealth ?? null, row.endedAt ?? null);
}

// A row of the v1 ledger's events table, as merge-pr.sh and lib/release.mjs write it.
export function ledgerRow(store: Store, row: { kind: string; ticket: string; pr: number; at: string; detail?: string }): void {
  store.db.prepare('INSERT INTO events (at, kind, ticket, detail, value, source) VALUES (?, ?, ?, ?, ?, ?)')
    .run(row.at, row.kind, row.ticket, row.detail ?? '', row.pr, 'dispatcher');
}

// Runs the ticket of `t` to the release waiting in the inbox, then the
// human's approval as lane 8 writes it, and the tick that notices it.
export async function approved(t: Setup, afterMs = 0): Promise<void> {
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release item', 5000);
  await t.engine.settled();
  t.clock.now += afterMs;
  await t.tickets.recordApproval(t.ticket.id, { kind: 'human', id: 'u1' });
  await t.engine.tick();
  await t.engine.settled();
}

// Waits, in short real turns, until a condition holds.
export async function until(condition: () => boolean | Promise<boolean>, what = 'the condition', ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function allEvents(store: Store, sessionIds: readonly SessionId[]): SessionEvent[] {
  return sessionIds.flatMap((id) => store.events.after(id));
}

export function stepLines(events: readonly SessionEvent[]): string[] {
  return events
    .filter((e): e is SessionEvent & { event: Extract<AgUiEvent, { type: 'STEP_STARTED' | 'STEP_FINISHED' }> } => e.event.type === 'STEP_STARTED' || e.event.type === 'STEP_FINISHED')
    .map((e) => `${e.event.type === 'STEP_STARTED' ? '+' : '-'}${e.event.stepName}`);
}
