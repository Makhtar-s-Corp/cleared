// The v2 notification dispatcher (docs/v2/milestone-2-plan.md, section 6):
// every 30 seconds in the service, it tells the owner what waits, through
// the adapters of lib/notify (Web Push by default; ntfy, e-mail, Telegram as
// configured), with v1's rules (docs/notifications.md):
//
//   - the first run takes note of what exists and sends nothing;
//   - one notification per group (a ticket, or the lead) every
//     coalesce_minutes, the most pressing kind first, what waits with it
//     folded into it; a rollback or a health problem waits only behind
//     another one of those;
//   - the quiet hours hold all but rollback and health;
//   - an inbox item handled before it is sent is not sent; nothing older
//     than a day is sent; a kind left out of [notify] events is never sent;
//   - three failed tries give an occurrence up; what the deadline cut, or
//     what came while no device could be told, is tried again at the next
//     tick, not counted as a try (v1 dropped the latter).
//
// Each delivery is one notification_sent event in v1's events table
// (kind, ticket, adapter, the seconds since it happened), each failure one
// notification_failed with a short code: what the milestone's proof counts.
//
// lib/notify is never imported here. Importing it (lib/conf.mjs) copies
// every CLEARED_* variable of the process to ORCH_*, so the settings and the
// sending run in a child process, src/cli/notify.ts, as lib/memory does for
// the briefing. The child reads the same agents.conf as the app, so both
// use one private directory and one key pair.
import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { InboxItem } from '../api/types.ts';
import { NotifyQueue, type Kind, type Row } from './queue.ts';
import { INBOX_KINDS, inboxOccurrences, lastEvent, ledgerOccurrences } from './sources.ts';

// What the dispatcher needs of [notify] and of lib/notify, as the child
// reads them (notifySettings, URGENT, URGENCY). Nothing here is a secret.
export type NotifySettings = {
  readonly events: readonly string[];
  readonly quiet: { readonly start: number; readonly end: number } | null;   // minutes of the day
  readonly timezone: string;
  readonly coalesceMinutes: number;
  readonly deadlineMs: number;
  readonly urgent: readonly string[];
  readonly urgency: readonly string[];
};

// One notification to make: the facts lib/notify renders, never a text of its own.
export type Message = {
  readonly key: string;
  readonly kind: Kind;
  readonly ticket: string | null;
  readonly group: string;
  readonly title: string;
  readonly code: string | null;
  readonly link: string;
  readonly from: 'lead' | null;
};

// One adapter's try. `reason` is the adapter's short code.
export type Outcome = { readonly adapter: string; readonly result: 'sent' | 'failed' | 'abandoned'; readonly reason?: string };

// Per message key, what each ready adapter did; an empty list when no
// adapter was ready; no entry when the deadline came before it was tried.
export type Deliveries = Readonly<Record<string, readonly Outcome[]>>;

export interface Sender {
  settings(): Promise<NotifySettings>;
  send(messages: readonly Message[], deadlineMs: number): Promise<Deliveries>;
}

export type TickResult = { readonly sent: Message[]; readonly held: string[]; readonly dropped: string[]; readonly failed: string[] };

export type DispatcherDeps = {
  readonly db: DatabaseSync;
  readonly inbox: { list(): InboxItem[] };
  readonly sender: Sender;
  readonly now?: () => Date;
};

const DAY_MS = 24 * 3600_000;
// An occurrence older than this is no longer news.
export const EXPIRE_MS = DAY_MS;
// Tries per notification before it is given up.
export const ATTEMPTS = 3;
// How long settings read from the child are kept: a change of agents.conf
// is seen within this time, and a quiet night does not start a child per tick.
export const SETTINGS_MS = 5 * 60_000;
// A failed delivery keeps its adapter's reason only when it is a short code.
const REASON = /^[a-z][a-z ]{0,40}(?: \(\d{3}\))?$/;

// Whether `at` falls in the quiet hours, read on the configured clock
// (lib/notify/contract.mjs isQuiet, which this process does not import).
export function isQuiet(settings: Pick<NotifySettings, 'quiet' | 'timezone'>, at: number): boolean {
  if (!settings.quiet) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: settings.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const { start, end } = settings.quiet;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

// What the child process said went wrong with the settings: its own words
// (a setting's name and what it must read like), which carry no path or secret.
export class NotifySettingsError extends Error {
  override name = 'NotifySettingsError';
}

export class Dispatcher {
  #db: DatabaseSync;
  #queue: NotifyQueue;
  #inbox: DispatcherDeps['inbox'];
  #sender: Sender;
  #now: () => Date;
  #settings: { readonly value: NotifySettings; readonly at: number } | undefined;
  #running: Promise<TickResult> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #said: string | undefined;

  constructor(deps: DispatcherDeps) {
    this.#db = deps.db;
    this.#queue = new NotifyQueue(deps.db);
    this.#inbox = deps.inbox;
    this.#sender = deps.sender;
    this.#now = deps.now ?? (() => new Date());
  }

  // Ticks now and every `ms` until close(); the timer never keeps the
  // process alive. A failure is said once, until a tick works again.
  start(ms = 30_000): void {
    if (this.#timer) return;
    const run = () => {
      this.tick().then(() => { this.#said = undefined; }, (error: unknown) => {
        const line = error instanceof NotifySettingsError ? error.message : `the dispatch failed (${error instanceof Error ? error.name : typeof error})`;
        if (line !== this.#said) console.error(`cleared-v2: notifications: ${line}`);
        this.#said = line;
      });
    };
    this.#timer = setInterval(run, ms);
    this.#timer.unref();
    run();
  }

  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running?.catch(() => undefined);
  }

  // One dispatch. A tick asked while one runs is that tick: a send can last
  // longer than the interval, and nothing is sent twice.
  tick(): Promise<TickResult> {
    this.#running ??= this.#tick().finally(() => { this.#running = undefined; });
    return this.#running;
  }

  async #tick(): Promise<TickResult> {
    const now = this.#now().getTime();
    const at = new Date(now).toISOString();
    const done: TickResult = { sent: [], held: [], dropped: [], failed: [] };
    const live = inboxOccurrences(this.#inbox.list());
    const cursor = this.#queue.cursor();
    const last = lastEvent(this.#db);
    if (cursor === null) {
      for (const o of live) this.#queue.add(o, 'seen', at);
      this.#queue.setCursor(last, at);
      return done;
    }
    for (const o of [...ledgerOccurrences(this.#db, cursor), ...live]) this.#queue.add(o, 'pending', at);
    this.#queue.setCursor(last, at);

    // An inbox item that stopped waiting (answered, approved, its session ended) is no longer worth a word.
    const liveKeys = new Set(live.map((o) => o.key));
    const pending = this.#queue.pending().filter((row) => {
      if (!INBOX_KINDS.includes(row.kind) || liveKeys.has(row.key)) return true;
      this.#drop(row.key, 'gone', at, done);
      return false;
    });
    this.#queue.purge(now);
    if (pending.length === 0) return done;

    const settings = await this.#readSettings(now);
    const quiet = isQuiet(settings, now);
    const rank = (kind: string) => { const i = settings.urgency.indexOf(kind); return i < 0 ? settings.urgency.length : i; };
    const groups = new Map<string, Row[]>();
    for (const row of pending) {
      if (!settings.events.includes(row.kind)) { this.#drop(row.key, 'off', at, done); continue; }
      if (now - Date.parse(row.firstAt) > EXPIRE_MS) { this.#drop(row.key, 'expired', at, done); continue; }
      const urgent = settings.urgent.includes(row.kind);
      if (quiet && !urgent) { done.held.push(row.key); continue; }
      const told = this.#queue.lastSent(row.group, urgent ? settings.urgent : undefined);
      if (told !== null && now - told < settings.coalesceMinutes * 60_000) { done.held.push(row.key); continue; }
      groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
    }

    // One notification per group: the most pressing, the newest of its kind.
    const chosen: { row: Row; folded: Row[]; message: Message }[] = [];
    for (const rows of groups.values()) {
      rows.sort((a, b) => rank(a.kind) - rank(b.kind) || b.firstAt.localeCompare(a.firstAt) || b.key.localeCompare(a.key));
      const [row, ...folded] = rows as [Row, ...Row[]];
      chosen.push({ row, folded, message: { key: row.key, kind: row.kind, ticket: row.ticket, group: row.group, title: row.title, code: row.code, link: row.link, from: row.from } });
    }
    if (chosen.length === 0) return done;
    const deliveries = await this.#sender.send(chosen.map((c) => c.message), settings.deadlineMs);

    for (const { row, folded, message } of chosen) {
      const outcomes = deliveries[row.key];
      const fold = () => { for (const other of folded) this.#drop(other.key, 'grouped', at, done); };
      if (outcomes === undefined || (!outcomes.some((o) => o.result === 'sent') && outcomes.some((o) => o.result === 'abandoned'))) {
        // Cut by the deadline: still pending, not a try.
        done.held.push(row.key);
        continue;
      }
      if (outcomes.length === 0) {
        // Nobody to tell yet (no device subscribed, an adapter not ready):
        // it waits, not a try, until a device can be told or its day ends.
        done.held.push(row.key);
        continue;
      }
      if (outcomes.some((o) => o.result === 'sent')) {
        // Marked sent first: whatever happens to the events below, it is not sent again.
        this.#queue.finish(row.key, 'sent', at);
        fold();
        done.sent.push(message);
      } else {
        // Folded only into what was told: behind one given up, the others still wait their turn.
        if (this.#queue.failed(row.key) >= ATTEMPTS) this.#queue.finish(row.key, 'failed', at);
        done.failed.push(row.key);
      }
      const since = Date.parse(row.at);
      for (const o of outcomes) {
        if (o.result === 'sent') this.#event('notification_sent', row.ticket, { event: row.kind, adapter: o.adapter }, Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 1000)) : null, at);
        else if (o.result === 'failed') this.#event('notification_failed', row.ticket, { event: row.kind, adapter: o.adapter, reason: REASON.test(o.reason ?? '') ? o.reason : 'failed' }, null, at);
      }
    }
    return done;
  }

  #drop(key: string, state: 'gone' | 'off' | 'expired' | 'grouped', at: string, done: TickResult): void {
    this.#queue.finish(key, state, at);
    done.dropped.push(key);
  }

  async #readSettings(now: number): Promise<NotifySettings> {
    if (this.#settings && now - this.#settings.at < SETTINGS_MS && now >= this.#settings.at) return this.#settings.value;
    const value = await this.#sender.settings();
    this.#settings = { value, at: now };
    return value;
  }

  // An event that cannot be written (no events table yet, the ledger locked)
  // is said by its kind and changes nothing: what was delivered stays sent.
  #event(kind: 'notification_sent' | 'notification_failed', ticket: string | null, detail: Record<string, unknown>, value: number | null, at: string): void {
    try {
      this.#db.prepare("INSERT INTO events (at, kind, ticket, detail, value, source) VALUES (?, ?, ?, ?, ?, 'notify')").run(at, kind, ticket, JSON.stringify(detail), value);
    } catch {
      console.error(`cleared-v2: notifications: a ${kind} event could not be written to the ledger`);
    }
  }
}

// The sender the service uses: src/cli/notify.ts in a child process, with
// the service's environment. `settings` prints the settings as JSON; `send`
// reads the messages on its stdin and prints what each adapter did. The
// child stops sending at the deadline by itself; past it, and ten seconds
// more, it is killed and what it was sending waits for the next tick.
export function childSender(env: NodeJS.ProcessEnv, cli = fileURLToPath(new URL('../cli/notify.ts', import.meta.url))): Sender {
  const run = (args: readonly string[], input: string, timeoutMs: number) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
  const said = (stderr: string) => (stderr.split('\n')[0] ?? '').replace(/^cleared-v2: notifications: /, '').slice(0, 200) || 'the notification settings could not be read';
  return {
    async settings() {
      const out = await run(['settings'], '', 30_000);
      if (out.code !== 0) throw new NotifySettingsError(said(out.stderr));
      return JSON.parse(out.stdout) as NotifySettings;
    },
    async send(messages, deadlineMs) {
      const out = await run(['send'], JSON.stringify({ messages }), deadlineMs + 10_000);
      // Killed at the deadline: nothing is known, everything waits.
      if (out.code === null) return {};
      if (out.code !== 0) throw new NotifySettingsError(said(out.stderr));
      return (JSON.parse(out.stdout) as { results: Deliveries }).results;
    },
  };
}
