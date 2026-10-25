// What the notification tests share: a ledger in memory with the inbox,
// v1's events table and the queue, an inbox on a clock the test moves, and
// a sender that records what it is given instead of starting the child
// process that runs lib/notify.
import { RUNS_TABLES } from '../../src/approval/review.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import { Dispatcher, type Message, type NotifySettings, type Outcome, type Sender } from '../../src/notify/dispatcher.ts';
import { NOTIFY_TABLES } from '../../src/notify/queue.ts';
import { applyTables, openStore, type Store } from '../../src/store/db.ts';
import type { ReleaseItem } from '../../src/api/types.ts';

export const SETTINGS: NotifySettings = {
  events: ['approval', 'permission', 'question', 'plan', 'rollback', 'health'],
  quiet: null, timezone: 'UTC', coalesceMinutes: 10, deadlineMs: 30_000,
  urgent: ['rollback', 'health'],
  urgency: ['rollback', 'health', 'approval', 'plan', 'question', 'permission'],
};

export type FakeSender = Sender & {
  readonly sent: Message[];
  readonly batches: number;
  settingsValue: NotifySettings;
  outcome: (message: Message) => readonly Outcome[] | undefined;   // undefined: not answered (the deadline)
};

export function fakeSender(settings: Partial<NotifySettings> = {}): FakeSender {
  let batches = 0;
  const sender: FakeSender = {
    sent: [],
    get batches() { return batches; },
    settingsValue: { ...SETTINGS, ...settings },
    outcome: () => [{ adapter: 'webpush', result: 'sent' }],
    async settings() { return sender.settingsValue; },
    async send(messages) {
      batches += 1;
      const out: Record<string, readonly Outcome[]> = {};
      for (const message of messages) {
        const outcome = sender.outcome(message);
        if (outcome === undefined) continue;
        if (outcome.some((o) => o.result === 'sent')) sender.sent.push(message);
        out[message.key] = outcome;
      }
      return out;
    },
  };
  return sender;
}

export type Setup = {
  readonly store: Store;
  readonly inbox: InboxStore;
  readonly sender: FakeSender;
  readonly dispatcher: Dispatcher;
  clock: number;
  advance(minutes: number): void;
  permission(ticket: string, requestId: string, session?: string): string;
  question(ticket: string, requestId: string, session?: string): string;
  release(ticket: string, title: string, pr?: number): ReleaseItem;
  plan(id: string, title: string): string;
  ledger(kind: string, ticket: string | null, detail?: string): void;
  events(kind?: string): { kind: string; ticket: string | null; detail: Record<string, unknown>; value: number | null }[];
  // A dispatcher over the same ledger, as after a restart of the service.
  restart(): Dispatcher;
};

export const START = Date.parse('2026-10-22T20:00:00.000Z');

export function setup(settings: Partial<NotifySettings> = {}): Setup {
  const store = openStore(':memory:');
  applyTables(store.db, [INBOX_TABLE, ...RUNS_TABLES, ...NOTIFY_TABLES]);
  store.db.exec('CREATE TABLE releases (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket TEXT NOT NULL, pr INTEGER NOT NULL, title TEXT NOT NULL)');
  const sender = fakeSender(settings);
  const t = {
    clock: START,
  } as Setup;
  const now = () => new Date(t.clock);
  const inbox = new InboxStore(store.db, now);
  const make = () => new Dispatcher({ db: store.db, inbox, sender, now });
  Object.assign(t, {
    store, inbox, sender, dispatcher: make(),
    advance(minutes: number) { t.clock += minutes * 60_000; },
    permission(ticket: string, requestId: string, session = `s-${ticket}`) {
      return inbox.addPermission({ ticket, project: 'guestbook', sessionId: session, requestId, tool: 'Bash', input: { kind: 'execute', command: 'touch /etc/secret.key' },
        suggestion: { decision: 'ask', rule: 'default', reason: 'no rule allows this request' } }).id;
    },
    question(ticket: string, requestId: string, session = `s-${ticket}`) {
      return inbox.addQuestion({ ticket, project: 'guestbook', sessionId: session, requestId,
        questions: [{ question: 'Which token do I use: tok_live_AbCdEfGhIjKlMnOpQrStUv?', header: 'Token', options: [], multiSelect: false }] }).id;
    },
    release(ticket: string, title: string, pr = 7) {
      return inbox.addRelease({ ticket, project: 'guestbook', title, announcement: 'It ships.', pr: { number: pr, url: `https://github.com/example/guestbook/pull/${pr}`, checks: 'passed' },
        heads: [{ pr, head: 'abc1234' }], requestedAt: now().toISOString(), captures: { before: { desktop: null, phone: null }, after: { desktop: null, phone: null } }, sessions: [] });
    },
    plan(id: string, title: string) {
      // Lane 7 adds the plan item through the inbox store; the row is what it will write.
      const itemId = `plan:${id}`;
      store.db.prepare('INSERT INTO flow_inbox (id, kind, ticket, project, session_id, request_id, since, state, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(itemId, 'plan', 'lead', 'guestbook', '', id, now().toISOString(), 'waiting',
          JSON.stringify({ planId: id, title, summary: 'Five tickets.', itemCount: 5, totals: { minutes: 120, costUsd: 3.9, weekPercent: null, samples: 2 } }));
      return itemId;
    },
    ledger(kind: string, ticket: string | null, detail = '') {
      store.db.prepare("INSERT INTO events (at, kind, ticket, detail, value, source) VALUES (?, ?, ?, ?, 7, 'release')").run(now().toISOString(), kind, ticket, detail);
    },
    events(kind?: string) {
      const rows = store.db.prepare("SELECT kind, ticket, detail, value FROM events WHERE kind LIKE 'notification_%' ORDER BY event_id").all() as Record<string, unknown>[];
      return rows.filter((r) => !kind || r.kind === kind).map((r) => ({
        kind: String(r.kind), ticket: r.ticket === null ? null : String(r.ticket), detail: JSON.parse(String(r.detail)) as Record<string, unknown>, value: r.value === null ? null : Number(r.value),
      }));
    },
    restart: make,
  });
  return t;
}
