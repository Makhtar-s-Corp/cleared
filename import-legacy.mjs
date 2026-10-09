#!/usr/bin/env node
// Puts the sessions of the old way of working in the ledger, read from the
// Claude Code session logs after the fact, so that the new dispatcher can be
// compared with something. Nothing is estimated: tokens are the usage the
// API reported for each message, as the CLI logged it.
//
//   import-legacy.mjs [--days 8] [--lead-worktree orrchestrator] [--no-linear]
//
// One row of `runs` per wake of a session: what happens between two messages
// that are not tool results (a word from the user, or a notification, whether
// it started a turn or landed in the middle of one). A wake caused by a notification, in which the
// session calls no tool other than re-arming its watches, is "idle".
// Safe to run again: the rows of a session are replaced.
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { loadConf, ORCH_HOME, expandHome, section } from './lib/conf.mjs';
import { openLedger, costEur } from './lib/ledger.mjs';
import { dispatcherWorktree } from './lib/lanes.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const days = Number(option('--days', '8'));
// The old project lead is told apart by the worktree its sessions ran in:
// its branch changed whenever it committed documents.
const leadWorktree = option('--lead-worktree', 'orrchestrator');
const since = new Date(Date.now() - days * 86400e3).toISOString();
const conf = loadConf();
const REARM = new Set(['Monitor', 'TaskStop', 'TaskOutput', 'ScheduleWakeup']);

// The session logs of every worktree under the lanes root. Those of a
// worktree the dispatcher opened are marked: they are not the old way of
// working, and the ledger has them already.
function logFiles() {
  const root = expandHome(section(conf, 'lanes').root);
  const prefix = root.replace(/[^A-Za-z0-9]/g, '-');
  const projects = join(homedir(), '.claude', 'projects');
  const files = [];
  for (const dir of readdirSync(projects)) {
    if (!dir.startsWith(prefix)) continue;
    const lead = dir.slice(prefix.length + 1).split('-')[0] === leadWorktree;
    const owned = dispatcherWorktree(dir.slice(prefix.length + 1), Object.keys(conf.roles));
    for (const file of readdirSync(join(projects, dir))) {
      if (!file.endsWith('.jsonl')) continue;
      files.push({ path: join(projects, dir, file), session: basename(file, '.jsonl'), subagent: false, lead, owned });
      const sub = join(projects, dir, basename(file, '.jsonl'), 'subagents');
      if (!existsSync(sub)) continue;
      for (const child of readdirSync(sub)) {
        if (child.endsWith('.jsonl')) files.push({ path: join(sub, child), session: basename(file, '.jsonl'), subagent: basename(child, '.jsonl'), lead, owned });
      }
    }
  }
  return files;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  return content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

async function readSession(file) {
  const wakes = [];
  const events = [];
  const pending = []; // comments of the user the session was told about, not acted on yet
  const told = new Set();
  let wake = null;
  const close = () => { if (wake && wake.messages.size) wakes.push(wake); wake = null; };
  const open = (entry, text) => {
    close();
    wake = { start: entry.timestamp, end: entry.timestamp, branch: entry.gitBranch, notified: text.includes('<task-notification>'), messages: new Map(), tools: new Set() };
  };
  const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
  for await (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'queue-operation' && entry.operation === 'enqueue') {
      // Every notification goes through the queue once, whether it then
      // starts a turn or lands in the middle of one.
      const text = entry.content ?? '';
      const id = (text.match(/<task-id>(\w+)<\/task-id>/) || [])[1];
      const comment = text.match(/<event>Linear : commentaire de l'utilisateur sur ([A-Z]+-\d+) \([^)]*\) : ([^<]*)/);
      const key = `${id}:${comment ? comment[2] : 'expired'}`;
      if (told.has(key)) continue;
      if (/\[Monitor expired after/.test(text)) {
        told.add(key);
        events.push({ kind: 'monitor_expired', at: entry.timestamp, detail: (text.match(/<summary>Monitor event: "([^"]{0,80})/) || [])[1] ?? null });
      } else if (comment) {
        told.add(key);
        pending.push({ ticket: comment[1], text: comment[2].trim(), toldAt: entry.timestamp });
      }
    } else if (entry.type === 'user') {
      const content = entry.message?.content ?? '';
      const isToolResult = Array.isArray(content) && content.some((block) => block.type === 'tool_result');
      if (isToolResult && wake) continue;
      open(entry, textOf(content));
    } else if (entry.type === 'attachment' && entry.attachment?.type === 'queued_command') {
      // A notification delivered in the middle of a turn is a wake too.
      open(entry, JSON.stringify(entry.attachment));
    } else if (entry.type === 'assistant' && entry.message?.usage) {
      if (!wake) open(entry, '');
      wake.end = entry.timestamp;
      wake.branch ??= entry.gitBranch;
      // A message is logged once per content block, with the same usage.
      wake.messages.set(entry.message.id, { model: entry.message.model, usage: entry.message.usage });
      const blocks = entry.message.content ?? [];
      for (const block of blocks) if (block.type === 'tool_use') wake.tools.add(block.name);
      // First thing the session did about a comment: its first tool call
      // that names the ticket.
      const calls = JSON.stringify(blocks.filter((block) => block.type === 'tool_use' && !REARM.has(block.name)));
      for (const comment of pending) {
        if (!comment.actedAt && calls.includes(comment.ticket)) {
          comment.actedAt = entry.timestamp;
          events.push({ kind: 'comment_handled', comment });
        }
      }
    }
  }
  close();
  return { wakes, events };
}

function usageOf(wake) {
  const usage = { tokens_in: 0, tokens_out: 0, tokens_cache: 0, tokens_cache_write: 0, tokens_cache_write_5m: 0, tokens_cache_write_1h: 0 };
  const models = new Map();
  let cost = 0;
  let priced = true;
  for (const { model, usage: u } of wake.messages.values()) {
    const one = {
      model,
      tokens_in: u.input_tokens ?? 0,
      tokens_out: u.output_tokens ?? 0,
      tokens_cache: u.cache_read_input_tokens ?? 0,
      tokens_cache_write: u.cache_creation_input_tokens ?? 0,
      tokens_cache_write_5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      tokens_cache_write_1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    };
    for (const key of Object.keys(usage)) usage[key] += one[key];
    models.set(model, (models.get(model) ?? 0) + one.tokens_out);
    const { cost: eur } = costEur(conf, one);
    if (eur == null) priced = false; else cost += eur;
  }
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const total = usage.tokens_in + usage.tokens_out + usage.tokens_cache + usage.tokens_cache_write;
  return { usage, model, total, cost: priced ? cost : null };
}

function linearComments(ticket, cache) {
  if (!cache.has(ticket)) {
    try {
      cache.set(ticket, JSON.parse(execFileSync(join(ORCH_HOME, 'linear.sh'), ['comments', ticket], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })));
    } catch { cache.set(ticket, []); }
  }
  return cache.get(ticket);
}

const db = openLedger();
const insert = db.prepare(`INSERT OR REPLACE INTO runs (run_id, ticket, role, model, provider, started_at, ended_at, tokens_in, tokens_out, tokens_cache,
  cost_eur, outcome, lane, source, tokens_cache_write, tokens_total, cost_basis) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy', ?, ?, ?)`);
const insertEvent = db.prepare("INSERT INTO events (at, kind, ticket, run_id, detail, value, source) VALUES (?, ?, ?, ?, ?, ?, ?)");
const comments = new Map();
const summary = { sessions: 0, runs: 0, idle: 0, expired: 0, comments: 0, removed: 0 };

for (const file of logFiles()) {
  const tag = `legacy:${file.session.slice(0, 8)}${file.subagent ? `:${file.subagent.slice(-8)}` : ''}`;
  if (file.owned) {
    // Counted twice by an earlier import: taken back out.
    summary.removed += db.prepare('DELETE FROM runs WHERE source = ? AND run_id LIKE ?').run('legacy', `${tag}:%`).changes;
    db.prepare('DELETE FROM events WHERE source = ?').run(tag);
    continue;
  }
  const { wakes, events } = await readSession(file);
  const recent = wakes.filter((wake) => wake.start >= since);
  if (!recent.length) continue;
  summary.sessions += 1;
  db.exec('BEGIN');
  db.prepare('DELETE FROM runs WHERE run_id LIKE ? AND started_at >= ?').run(`${tag}:%`, since);
  db.prepare('DELETE FROM events WHERE source = ? AND at >= ?').run(tag, since);
  for (const wake of recent) {
    const { usage, model, total, cost } = usageOf(wake);
    const idle = !file.subagent && wake.notified && [...wake.tools].every((tool) => REARM.has(tool));
    const role = file.lead ? 'chef-de-projet' : 'dev';
    const runId = `${tag}:${wake.start}`;
    insert.run(runId, role, model, 'claude', wake.start, wake.end, usage.tokens_in, usage.tokens_out, usage.tokens_cache,
      cost, idle ? 'idle' : 'action', wake.branch ?? null, usage.tokens_cache_write, total, cost == null ? null : 'prices');
    summary.runs += 1;
    if (idle) summary.idle += 1;
  }
  for (const event of events) {
    if (event.kind === 'monitor_expired') {
      if (event.at < since) continue;
      insertEvent.run(event.at, event.kind, null, null, event.detail, null, tag);
      summary.expired += 1;
      continue;
    }
    // Delay between a comment of the user in Linear and the first thing the
    // session did about its ticket. The time of the comment comes from Linear.
    const { comment } = event;
    if (comment.toldAt < since || args.includes('--no-linear')) continue;
    const norm = (text) => text.split(/\s+/).join(' ').trim();
    const found = linearComments(comment.ticket, comments).find((c) => norm(c.body).startsWith(norm(comment.text).slice(0, 60)));
    if (!found) continue;
    const minutes = (new Date(comment.actedAt) - new Date(found.createdAt)) / 60000;
    if (minutes < 0) continue;
    insertEvent.run(found.createdAt, 'comment_handled', comment.ticket, null, 'comment of the user, then first tool call of the old project lead that names the ticket', minutes, tag);
    summary.comments += 1;
  }
  db.exec('COMMIT');
}
db.close();
process.stdout.write(`${JSON.stringify({ since, ...summary })}\n`);
