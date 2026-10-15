#!/usr/bin/env node
// The notification dispatcher: at the end of every wake, tells the human on
// his phone what waits for him. No model, and no text of anyone's choosing.
//
//   notify.mjs dispatch      (wake.sh runs it; takes no other argument)
//   notify.mjs test          (the service account, by hand) sends the fixed test message to each adapter
//
// What it looks at, all of it written by the service itself:
//   approval   a card Ready to land in the board snapshot (Cleared holds a request for a version)
//   question   a card Question in the board snapshot (a team ended on a question for the user)
//   rollback   rollback_pushed or prod_revert in the ledger
//   health     heartbeat_problem and the release watch's failures in the ledger
//   blocked    a ticket whose team could not open (lane_limit_reached) or that the
//              rules cannot move (lane_stuck), still so after [notify] blocked_minutes
//
// An agent can make one of these happen (a team that asks a question, a
// release request through the broker); it cannot choose what the notification
// says: lib/notify/contract.mjs builds it from the kind, the ticket's
// identifier and title, a health code and a number of minutes. Nothing here
// reads a ledger event's detail beyond the health code.
//
// Each occurrence waits in a queue (in the ledger's database) until it is sent,
// folded into another one for the same ticket, or gone (the human answered,
// the card left). The quiet hours hold approval, question and blocked until
// they end (rollback and health go through); at most one notification per
// ticket every [notify] coalesce_minutes. Every notification sent is one
// notification_sent event: kind, ticket, adapter, time.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfForCommand, projectDir, runAsCommand, stateDir } from './conf.mjs';
import { addEvent, ledgerPath, openLedger } from './ledger.mjs';
import { createAdapters, HEALTH_CODES, isQuiet, notifySettings, render, testMessage, URGENT } from './notify/contract.mjs';
import { notifyStore } from './notify/store.mjs';

const SCHEMA = `CREATE TABLE IF NOT EXISTS notify_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notify_queue (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, ticket TEXT, grp TEXT NOT NULL, facts TEXT NOT NULL,
  first_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, done_at TEXT
);
CREATE INDEX IF NOT EXISTS notify_queue_state ON notify_queue (state, grp);`;
export const initNotify = (db) => db.exec(SCHEMA);
const iso = (ms) => new Date(ms).toISOString();
const DAY = 86400e3;
// An occurrence older than this is no longer news: it is dropped unsent.
export const EXPIRE_MS = DAY;
// Tries per notification before it is given up.
export const ATTEMPTS = 3;
const RANK = { rollback: 0, health: 1, approval: 2, question: 3, blocked: 4 };
const ROLLBACK = ['rollback_pushed', 'prod_revert'];
const RELEASE_HEALTH = ['release_health_failing', 'rollback_health_still_failing', 'release_watch_failed', 'rollback_failed', 'rollback_migrations_blocked', 'rollback_ambiguous_base'];
const BLOCKING = ['lane_limit_reached', 'lane_stuck'];
const SAFE_ID = /^[A-Za-z0-9._-]{1,40}$/;
const REASON = /^[a-z][a-z ]{0,40}(?: \(\d{3}\))?$/;
// The ticket as the app names it (the local tracker's LOCAL- prefix dropped), or null.
const shown = (ref) => { const id = String(ref ?? '').replace(/^LOCAL-/, ''); return SAFE_ID.test(id) ? id : null; };

function get(db, key) { return db.prepare('SELECT value FROM notify_state WHERE key = ?').get(key)?.value ?? null; }
function put(db, key, value) { db.prepare('INSERT INTO notify_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)); }

export function readSnapshot(dir = stateDir()) {
  try {
    const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
    return snapshot?.schema === 1 && Array.isArray(snapshot.tickets) ? snapshot : null;
  } catch { return null; }
}

// What the snapshot says waits for the human now. Keyed by the request or the
// question, so a new one for the same ticket is news and the same one is not.
function waitingCards(snapshot) {
  const out = [];
  for (const card of snapshot?.tickets ?? []) {
    const id = shown(card.id);
    if (!id || !card.waiting) continue;
    const at = card.approval?.at ?? card.since ?? '';
    if (card.kind === 'ready') out.push({ key: `approval:${id}:${at}`, kind: 'approval', ticket: id, title: card.title, at });
    else if (card.kind === 'question') out.push({ key: `question:${id}:${at}`, kind: 'question', ticket: id, title: card.title, at });
  }
  return out;
}

// The ledger events since the cursor that notify.
function ledgerEvents(db, cursor, titleOf) {
  const kinds = [...ROLLBACK, 'heartbeat_problem', ...RELEASE_HEALTH];
  const rows = db.prepare(`SELECT event_id, at, kind, ticket, detail FROM events WHERE event_id > ? AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY event_id`).all(cursor, ...kinds);
  return rows.map((row) => {
    const ticket = shown(row.ticket);
    if (ROLLBACK.includes(row.kind)) return { key: `rollback:${row.event_id}`, kind: 'rollback', ticket, title: titleOf(row.ticket), at: row.at };
    // Only the code of a heartbeat problem (before its first colon), and only a known one: what follows it (a name) is never said.
    const code = row.kind === 'heartbeat_problem' ? String(row.detail ?? '').split(':')[0] : row.kind;
    return { key: `health:${row.event_id}`, kind: 'health', ticket: row.kind === 'heartbeat_problem' ? null : ticket, title: row.kind === 'heartbeat_problem' ? '' : titleOf(row.ticket),
      code: HEALTH_CODES.includes(code) ? code : 'other', at: row.at };
  });
}

// A ticket whose team could not open or that the rules cannot move, with no
// run of it started since, for longer than the threshold. One per episode: the
// first such event after its last run.
function blockedTeams(db, settings, now, titleOf) {
  const window = Math.max(DAY, 2 * settings.blockedMinutes * 60000);
  const rows = db.prepare(`SELECT ticket, MIN(e.at) at FROM events e WHERE e.kind IN (${BLOCKING.map(() => '?').join(',')}) AND e.ticket IS NOT NULL AND e.at >= ?
    AND e.at > COALESCE((SELECT MAX(started_at) FROM runs r WHERE r.ticket = e.ticket), '') GROUP BY ticket`).all(...BLOCKING, iso(now - window));
  const out = [];
  for (const row of rows) {
    const id = shown(row.ticket);
    const since = Date.parse(row.at);
    if (!id || !Number.isFinite(since) || now - since < settings.blockedMinutes * 60000) continue;
    out.push({ key: `blocked:${id}:${row.at}`, kind: 'blocked', ticket: id, title: titleOf(row.ticket), minutes: Math.floor((now - since) / 60000), at: row.at });
  }
  return out;
}

const ownGroup = (o) => o.ticket ?? `health:${o.code ?? 'other'}`;
const factsOf = (o) => JSON.stringify({ title: o.title ?? '', code: o.code ?? null, minutes: o.minutes ?? null, at: o.at ?? null });

// One dispatch. Returns what happened, for the tests and the wake's log.
export async function dispatch({ db, settings, snapshot, adapters, now = Date.now(), language = settings.language }) {
  initNotify(db);
  const done = { sent: [], held: [], failed: [], dropped: [] };
  const titles = new Map((snapshot?.tickets ?? []).map((t) => [shown(t.id), t.title]));
  const titleOf = (ref) => {
    const id = shown(ref);
    if (titles.has(id)) return titles.get(id);
    try { return db.prepare('SELECT title FROM releases WHERE ticket = ? ORDER BY id DESC LIMIT 1').get(ref)?.title ?? ''; } catch { return ''; }
  };
  const cursor = Number(get(db, 'cursor'));
  const last = db.prepare('SELECT COALESCE(MAX(event_id), 0) id FROM events').get().id;
  const live = [...(snapshot ? waitingCards(snapshot) : []), ...blockedTeams(db, settings, now, titleOf)];
  const insert = db.prepare('INSERT OR IGNORE INTO notify_queue (key, kind, ticket, grp, facts, first_at, state) VALUES (?, ?, ?, ?, ?, ?, ?)');
  // The first dispatch takes note of what exists and sends nothing: no backlog when notifications are turned on.
  if (!Number.isSafeInteger(cursor) || get(db, 'cursor') === null) {
    for (const o of live) insert.run(o.key, o.kind, o.ticket, ownGroup(o), factsOf(o), iso(now), 'seen');
    put(db, 'cursor', last);
    return done;
  }
  const fresh = [...ledgerEvents(db, cursor, titleOf), ...live];
  for (const o of fresh) insert.run(o.key, o.kind, o.ticket, ownGroup(o), factsOf(o), iso(now), 'pending');
  put(db, 'cursor', last);
  // A live occurrence that left (answered, cleared, unblocked) is no longer worth a word; the minutes of one still blocked are brought up to date.
  const liveKeys = new Set(live.map((o) => o.key));
  for (const o of live.filter((x) => x.kind === 'blocked')) db.prepare("UPDATE notify_queue SET facts = ? WHERE key = ? AND state = 'pending'").run(factsOf(o), o.key);
  const finish = db.prepare('UPDATE notify_queue SET state = ?, done_at = ? WHERE key = ?');
  for (const row of db.prepare("SELECT key, kind FROM notify_queue WHERE state = 'pending'").all()) {
    const fromSnapshot = row.kind === 'approval' || row.kind === 'question';
    if ((fromSnapshot && snapshot && !liveKeys.has(row.key)) || (row.kind === 'blocked' && !liveKeys.has(row.key))) { finish.run('gone', iso(now), row.key); done.dropped.push(row.key); }
  }

  const quiet = isQuiet(settings, now);
  const ready = adapters.filter((a) => { try { return a.ready() === null; } catch { return false; } });
  const pending = db.prepare("SELECT * FROM notify_queue WHERE state = 'pending' ORDER BY first_at, key").all();
  const groups = new Map();
  for (const row of pending) {
    if (!settings.events.includes(row.kind)) { finish.run('off', iso(now), row.key); done.dropped.push(row.key); continue; }
    if (now - Date.parse(row.first_at) > EXPIRE_MS) { finish.run('expired', iso(now), row.key); done.dropped.push(row.key); continue; }
    if (quiet && !URGENT.includes(row.kind)) { done.held.push(row.key); continue; }
    const sentLast = db.prepare("SELECT MAX(done_at) at FROM notify_queue WHERE grp = ? AND state = 'sent'").get(row.grp)?.at;
    if (sentLast && now - Date.parse(sentLast) < settings.coalesceMinutes * 60000) { done.held.push(row.key); continue; }
    if (!groups.has(row.grp)) groups.set(row.grp, []);
    groups.get(row.grp).push(row);
  }
  for (const rows of groups.values()) {
    // One notification per ticket at a time: the most pressing, the newest of its kind; the others are folded into it.
    rows.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.first_at.localeCompare(a.first_at) || b.key.localeCompare(a.key));
    const [row, ...folded] = rows;
    for (const other of folded) { finish.run('grouped', iso(now), other.key); done.dropped.push(other.key); }
    if (!ready.length) { finish.run('undelivered', iso(now), row.key); done.dropped.push(row.key); continue; }
    const facts = JSON.parse(row.facts);
    const message = render({ kind: row.kind, ticket: row.ticket, title: facts.title, code: facts.code, minutes: facts.minutes }, { language, linkBase: settings.linkBase });
    const occurred = Date.parse(facts.at);
    let delivered = 0;
    for (const adapter of ready) {
      try {
        await adapter.send(message);
        delivered += 1;
        // The time of this event is the time it was sent; value: seconds since what it tells happened.
        addEvent(db, { kind: 'notification_sent', ticket: row.ticket, source: 'notify', value: Number.isFinite(occurred) ? Math.max(0, Math.round((now - occurred) / 1000)) : null,
          detail: JSON.stringify({ event: row.kind, adapter: adapter.name }) });
      } catch (error) {
        // The adapter's reason is a short code of its own; anything else (an address, a path, an answer body) is not kept.
        const said = String(error?.message ?? '');
        addEvent(db, { kind: 'notification_failed', ticket: row.ticket, source: 'notify', detail: JSON.stringify({ event: row.kind, adapter: adapter.name, reason: REASON.test(said) ? said : 'failed' }) });
      }
    }
    if (delivered) { finish.run('sent', iso(now), row.key); done.sent.push({ key: row.key, message }); }
    else {
      const attempts = row.attempts + 1;
      db.prepare('UPDATE notify_queue SET attempts = ? WHERE key = ?').run(attempts, row.key);
      if (attempts >= ATTEMPTS) finish.run('failed', iso(now), row.key);
      done.failed.push(row.key);
    }
  }
  // The queue keeps two weeks.
  db.prepare('DELETE FROM notify_queue WHERE state != ? AND first_at < ?').run('pending', iso(now - 14 * DAY));
  return done;
}

// `test`: the fixed test message to every configured adapter, to check a setup
// (run as the service account: nobody else can read the secrets). Says, per
// adapter, sent, not ready and why, or failed with its code.
export async function sendTest({ db, settings, adapters, now = Date.now() }) {
  const lines = [];
  const message = testMessage({ language: settings.language, linkBase: settings.linkBase });
  for (const adapter of adapters) {
    let reason;
    try { reason = adapter.ready(); } catch { reason = 'unreadable'; }
    if (reason) { lines.push(`${adapter.name}: not ready (${reason})`); continue; }
    try {
      await adapter.send(message);
      addEvent(db, { kind: 'notification_sent', source: 'notify', at: iso(now), detail: JSON.stringify({ event: 'test', adapter: adapter.name }) });
      lines.push(`${adapter.name}: sent`);
    } catch (error) {
      const said = String(error?.message ?? '');
      lines.push(`${adapter.name}: failed (${REASON.test(said) ? said : 'failed'})`);
    }
  }
  return lines;
}

async function main(args) {
  if (args.length !== 1 || !['dispatch', 'test'].includes(args[0])) throw new Error('usage: notify.mjs dispatch | test');
  const conf = loadConfForCommand();
  const settings = notifySettings(conf);
  const db = openLedger(ledgerPath());
  try {
    const store = notifyStore(settings.secretsDir, { project: projectDir() });
    const adapters = createAdapters(settings, { store });
    if (args[0] === 'test') {
      const lines = await sendTest({ db, settings, adapters });
      console.log(lines.length ? lines.join('\n') : 'no adapter: [notify] adapters names none');
      if (!lines.some((line) => line.endsWith(': sent'))) process.exitCode = 1;
      return;
    }
    await dispatch({ db, settings, snapshot: readSnapshot(), adapters });
  } finally { db.close(); }
}

if (runAsCommand(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    // A setting's or an adapter's own words: no path, address or secret in them.
    console.error(`cleared: notifications: ${error.message}`);
    process.exitCode = 1;
  });
}

