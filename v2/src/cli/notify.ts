// cleared-v2 notify: lib/notify in a process of its own.
//   node src/cli/notify.ts test        (npm run notify -- test) sends the fixed test message to each adapter
//   node src/cli/notify.ts settings    (the dispatcher) prints what it needs of [notify], as JSON
//   node src/cli/notify.ts send        (the dispatcher) reads its messages on stdin, prints what each adapter did
//
// The dispatcher (src/notify/dispatcher.ts) runs in the service and never
// imports lib/notify: lib/conf.ts copies every CLEARED_* variable to ORCH_*
// when it is imported. Here that copy is harmless, and the process ends.
//
// The settings are the app's (app/src/notifications.ts): [notify] in the
// project's agents.conf (CLEARED_CONF, else <CLEARED_REPO>/.cleared/agents.conf),
// and CLEARED_NOTIFY_* in the environment. So the app, which keeps the
// browsers' subscriptions, and the dispatcher, which sends to them, use one
// private directory and one key pair.
//
// A message carries facts only: its kind, the ticket, a title, a health
// code, a link among the app's own pages. lib/notify's render makes the text
// from the catalog and filters the title; nothing else is ever said.
import { readFileSync } from 'node:fs';
import { confFile, parseSections } from '../approval/conf.ts';
import { RUNS_TABLES } from '../approval/review.ts';
import { applyTables, ledgerPath, openStore } from '../store/db.ts';

const USAGE = 'usage: npm run notify -- test';
const LIB = new URL('../../../lib/notify/', import.meta.url).href;

type Rendered = { readonly title: string; readonly body: string; readonly urgent: boolean };
type Adapter = { readonly name: string; ready(): string | null; send(message: object, options?: { signal?: AbortSignal }): Promise<unknown> };
type Settings = {
  readonly adapters: readonly string[]; readonly events: readonly string[]; readonly quiet: { start: number; end: number } | null; readonly timezone: string;
  readonly coalesceMinutes: number; readonly deadlineMs: number; readonly linkBase: string; readonly secretsDir: string; readonly language: string;
};
type Contract = {
  readonly URGENT: readonly string[];
  readonly URGENCY: readonly string[];
  notifySettings(conf: unknown, env: NodeJS.ProcessEnv): Settings;
  render(facts: object, options: { language: string; linkBase: string }): Rendered;
  testMessage(options: { language: string; linkBase: string }): object;
  createAdapters(settings: Settings, deps: { store: unknown }): Adapter[];
};

class Usage extends Error {}

function fail(message: string, code: number): never {
  console.error(`cleared-v2: notifications: ${message}`);
  process.exit(code);
}

async function load(env: NodeJS.ProcessEnv): Promise<{ contract: Contract; settings: Settings; adapters: () => Adapter[] }> {
  const file = confFile(env);
  let sections: Record<string, Record<string, string>> = {};
  if (file) {
    try { sections = parseSections(readFileSync(file, 'utf8')); } catch { /* no settings file: the defaults */ }
  }
  const contract = await import(`${LIB}contract.ts`) as Contract;
  const { notifyStore } = await import(`${LIB}store.ts`) as { notifyStore(dir: string, options: { project?: string }): unknown };
  const settings = contract.notifySettings({ sections }, env);
  const project = env.CLEARED_REPO || env.ORCH_REPO;
  // Never created here: the app makes the directory and the keys when a person turns notifications on.
  const adapters = () => contract.createAdapters(settings, { store: notifyStore(settings.secretsDir, project ? { project } : {}) });
  return { contract, settings, adapters };
}

const ready = (adapter: Adapter): string | null => {
  try { return adapter.ready(); } catch { return 'unreadable'; }
};
// An adapter's reason is said only when it is its own short code.
const REASON = /^[a-z][a-z ]{0,40}(?: \(\d{3}\))?$/;
const reason = (error: unknown) => { const said = error instanceof Error ? error.message : ''; return REASON.test(said) ? said : 'failed'; };

// ---- send ------------------------------------------------------------------

const KINDS = ['approval', 'permission', 'question', 'plan', 'rollback', 'health'];
type Message = { key: string; kind: string; ticket: string | null; group: string; title: string; code: string | null; link: string; from: 'lead' | null };

// What the dispatcher sends, and nothing else: a message that could not
// come from it is refused whole.
function message(input: unknown): Message {
  const m = input as Record<string, unknown> | null;
  const text = (value: unknown, pattern: RegExp) => typeof value === 'string' && pattern.test(value);
  const ok = !!m && typeof m === 'object'
    && text(m.key, /^.{1,200}$/s) && KINDS.includes(String(m.kind))
    && (m.ticket === null || text(m.ticket, /^[A-Za-z0-9._-]{1,40}$/))
    && text(m.group, /^[A-Za-z0-9._:-]{1,80}$/)
    && typeof m.title === 'string' && m.title.length <= 2000
    && (m.code === null || text(m.code, /^[a-z_]{1,40}$/))
    // A page of the app: /, /inbox, /lead, with an item after #.
    && text(m.link, /^\/(?:inbox|lead)?(?:#[A-Za-z0-9%._~-]{0,300})?$/)
    && (m.from === null || m.from === 'lead');
  if (!ok) throw new Usage('send: a message the dispatcher does not make');
  return m as unknown as Message;
}

// One adapter's try; 'abandoned' when the deadline came first.
async function attempt(adapter: Adapter, rendered: object, signal: AbortSignal): Promise<{ adapter: string; result: 'sent' | 'failed' | 'abandoned'; reason?: string }> {
  if (signal.aborted) return { adapter: adapter.name, result: 'abandoned' };
  let stop = () => {};
  const expired = new Promise<{ adapter: string; result: 'abandoned' }>((resolve) => {
    stop = () => resolve({ adapter: adapter.name, result: 'abandoned' });
    signal.addEventListener('abort', stop, { once: true });
  });
  const tried = Promise.resolve().then(() => adapter.send(rendered, { signal })).then(
    () => ({ adapter: adapter.name, result: 'sent' as const }),
    (error: unknown) => (signal.aborted ? { adapter: adapter.name, result: 'abandoned' as const } : { adapter: adapter.name, result: 'failed' as const, reason: reason(error) }),
  );
  try { return await Promise.race([tried, expired]); } finally { signal.removeEventListener('abort', stop); }
}

async function send(input: string): Promise<void> {
  let messages: Message[];
  try {
    const body = JSON.parse(input) as { messages?: unknown };
    if (!Array.isArray(body.messages)) throw new Usage('send: no messages');
    messages = body.messages.map(message);
  } catch (error) {
    throw error instanceof Usage ? error : new Usage('send: the messages are not JSON');
  }
  const { contract, settings, adapters } = await load(process.env);
  const usable = adapters().filter((adapter) => ready(adapter) === null);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), settings.deadlineMs);
  const results: Record<string, unknown[]> = {};
  try {
    for (const m of messages) {
      // Past the deadline nothing more is started: what is left waits for the next tick.
      if (deadline.signal.aborted) break;
      const rendered = contract.render({ kind: m.kind, ticket: m.ticket, title: m.title, code: m.code, from: m.from }, { language: settings.language, linkBase: settings.linkBase });
      // The link is the page of its kind, not v1's porthole; the group is the dispatcher's (the lead's items have no ticket).
      const full = { ...rendered, group: m.group, url: settings.linkBase ? `${settings.linkBase}${m.link}` : null };
      results[m.key] = await Promise.all(usable.map((adapter) => attempt(adapter, full, deadline.signal)));
    }
  } finally {
    clearTimeout(timer);
  }
  process.stdout.write(`${JSON.stringify({ results })}\n`);
}

// ---- settings --------------------------------------------------------------

async function settings(): Promise<void> {
  const { contract, settings: s } = await load(process.env);
  process.stdout.write(`${JSON.stringify({ events: s.events, quiet: s.quiet, timezone: s.timezone, coalesceMinutes: s.coalesceMinutes, deadlineMs: s.deadlineMs, urgent: contract.URGENT, urgency: contract.URGENCY })}\n`);
}

// ---- test ------------------------------------------------------------------

// The fixed test message to every configured adapter: per adapter, sent,
// not ready and why, or failed with its code. Run as the service account:
// nobody else can read the private directory.
async function check(): Promise<void> {
  const { contract, settings: s, adapters } = await load(process.env);
  const all = adapters();
  if (all.length === 0) {
    console.log('no adapter: [notify] adapters names none');
    process.exitCode = 1;
    return;
  }
  const rendered = contract.testMessage({ language: s.language, linkBase: s.linkBase });
  const lines: string[] = [];
  const sent: string[] = [];
  for (const adapter of all) {
    const why = ready(adapter);
    if (why) { lines.push(`${adapter.name}: not ready (${why})`); continue; }
    try {
      await adapter.send(rendered);
      sent.push(adapter.name);
      lines.push(`${adapter.name}: sent`);
    } catch (error) {
      lines.push(`${adapter.name}: failed (${reason(error)})`);
    }
  }
  if (sent.length > 0) record(sent);
  console.log(lines.join('\n'));
  if (sent.length === 0) process.exitCode = 1;
}

// One notification_sent event per adapter that took the test message, as v1's test does.
function record(adapters: readonly string[]): void {
  try {
    const store = openStore(ledgerPath(process.env));
    try {
      // v1's events table, as the service creates it at start (the approval module).
      applyTables(store.db, RUNS_TABLES);
      const at = new Date().toISOString();
      for (const adapter of adapters) {
        store.db.prepare("INSERT INTO events (at, kind, detail, source) VALUES (?, 'notification_sent', ?, 'notify')").run(at, JSON.stringify({ event: 'test', adapter }));
      }
    } finally { store.close(); }
  } catch {
    console.error('cleared-v2: notifications: the notification_sent event could not be written to the ledger');
  }
}

async function readStdin(): Promise<string> {
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > 1_000_000) throw new Usage('send: too much input');
  }
  return text;
}

const [command, ...rest] = process.argv.slice(2);
try {
  if (rest.length > 0) throw new Usage(USAGE);
  if (command === 'test') await check();
  else if (command === 'settings') await settings();
  else if (command === 'send') await send(await readStdin());
  else throw new Usage(USAGE);
} catch (error) {
  if (error instanceof Usage) fail(error.message, 64);
  // A setting's own words (lib/notify's), which name no path, address or
  // secret; anything else by its class only, since a system error names its path.
  const said = error instanceof Error ? error.message : '';
  fail(/^(?:\[notify\]|CLEARED_NOTIFY_|The notification )/.test(said) ? said : `failed (${error instanceof Error ? error.name : typeof error})`, 1);
}
