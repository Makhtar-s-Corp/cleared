#!/usr/bin/env node
// The ledger: one SQLite file, written by the scripts and never by a model.
// Token counts come from the output of the CLIs, not from an estimate.
//
//   ledger.mjs init
//   ledger.mjs run-start --run-id … --role … [--ticket …] [--lane …] [--model …]
//                        [--provider …] [--requested-model …] [--project …] [--label …] [--source …]
//   ledger.mjs run-end   --run-id … --outcome … [--exit-code N] [--usage-file usage.json]
//   ledger.mjs run-set   --run-id … [--outcome …] [--pr-number N] [--lines-changed N]
//                        [--human-decision …] [--human-latency-min N]
//   ledger.mjs event     --kind … [--ticket …] [--run-id …] [--detail …] [--value N]
//   ledger.mjs sql "select …"        (read only, prints JSON)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { duplicateConfigKeys, ignoredConfigs, loadConf, runAsCommand, section, stateDir } from './conf.mjs';

export const EVENT_KINDS = [
  'wake_skipped', // the pre-check found nothing to do: no model was started
  'monitor_expired', // a watch of the old project lead ran out
  'lane_limit_reached', // a lane was refused: too many are open
  'prod_revert', // a merged change was reverted in production
  'model_fallback', // a declared fallback was taken (the lane still ran)
  'model_fallback_failed', // no model of the chain could run
  'comment_handled', // value = minutes between a comment of the user and the first action
  'cli_outdated', // value = days a CLI is behind its latest release (weekly check)
  'orca_terminal_delayed', // value = seconds Orca took to open the terminal of a lane (past the usual wait)
  'orca_terminal_failed', // Orca did not open the terminal of a lane: the run was not started
  'lead_lane_blocked', // the lane of the project lead holds work of its own: no session starts until it is looked at
  'wake_started', // a session of the project lead was started; the detail says what woke it
  'decision', // a decision the user worded in a discussion, transcribed by decide.sh (source discussion)
  'role_model_changed', // the model of a role was changed: detail "<role>: <from> -> <to>: <why>"; the lead only starts on the one decided last
  'merged_by_script', // merge-pr.sh put a pull request live: value is its number, the detail says what was checked
  'merge_refused', // a go-live asked for was refused for good, or left the queue: the detail says why
  'ticket_left_open', // a go-live was done but GitHub could not say what became of another pull request shown on the ticket: the wake asks again
  'lane_stuck', // a lane the rules cannot move forward (opened too many times a day, work that could not be sent, a ticket put back after its lane was over): the lead is told
  'self_updated', // the checkout the dispatcher runs from took a newer version of the base
  'self_update_refused', // it did not (changed by hand, or a script of the new version cannot be read): the lead is told
  'project_updated', // the checkout of the project took a newer version of its base
  'project_update_refused', // it did not (changed by hand, or commits of its own): the lead is told
  'teams_ready', // the two teams the user gave a ticket to are both reviewed and green: value is one of the two pull requests, the detail names both; the lead asks him once, with both results
  'ticket_cost', // a ticket reached the cap on what it may cost: its lane is stopped; the lead tells the user and asks whether to raise it
  'subscription_stop', // the subscription the lanes run on reached the stop set for the project: no lane opens until its window starts over; the lead is told
  'lane_asks', // the session of a lane ended on a question for the user: the detail is the question, the lead carries it to him
  'lanes_tidied', // tidy-lanes.sh closed lanes by rule: value is how many, the detail says which and why
  'review_dropped', // a review asked for left the queue without opening; the detail says which and why
  'github_down', // GitHub was down: at is the start, value the minutes it lasted, detail "from <start> to <end>: <what was down>"
  'private_terms_disabled', // no committed fingerprint lists are configured for this project
  'untracked_config_ignored', // an untracked .cleared/agents.conf was ignored
  'duplicate_config_key', // a later setting with the same key was ignored
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  ticket TEXT,
  role TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cache INTEGER,
  cost_eur REAL,
  outcome TEXT,
  pr_number INTEGER,
  lines_changed INTEGER,
  human_decision TEXT,
  human_latency_min REAL,
  lane TEXT,
  source TEXT NOT NULL DEFAULT 'dispatcher',
  requested_model TEXT,
  exit_code INTEGER,
  tokens_cache_write INTEGER,
  tokens_total INTEGER,
  cost_basis TEXT,
  project TEXT,
  label TEXT
);
CREATE INDEX IF NOT EXISTS runs_started ON runs (started_at);
CREATE INDEX IF NOT EXISTS runs_ticket ON runs (ticket);
CREATE TABLE IF NOT EXISTS events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  ticket TEXT,
  run_id TEXT,
  detail TEXT,
  value REAL,
  source TEXT NOT NULL DEFAULT 'dispatcher'
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);
`;

export function ledgerPath() {
  return process.env.ORCH_LEDGER || join(stateDir(), 'ledger.db');
}

export function openLedger(path = ledgerPath(), { readOnly = false } = {}) {
  if (!readOnly && path !== ':memory:') mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path, { readOnly });
  db.exec('PRAGMA busy_timeout = 5000');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    // Columns added after the first ledger was created.
    const columns = db.prepare('PRAGMA table_info(runs)').all().map((column) => column.name);
    for (const column of ['project', 'label']) if (!columns.includes(column)) db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`);
    const ignored = new Set([...ignoredConfigs, process.env.CLEARED_IGNORED_UNTRACKED_CONF].filter(Boolean));
    for (const detail of ignored) {
      if (!db.prepare('SELECT 1 FROM events WHERE kind = ? AND detail = ? LIMIT 1').get('untracked_config_ignored', detail))
        db.prepare('INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'untracked_config_ignored', detail);
    }
    try { loadConf(); } catch { /* a malformed config is reported at its first use */ }
    for (const detail of duplicateConfigKeys) {
      if (!db.prepare('SELECT 1 FROM events WHERE kind = ? AND detail = ? LIMIT 1').get('duplicate_config_key', detail))
        db.prepare('INSERT INTO events (at, kind, detail) VALUES (?, ?, ?)').run(new Date().toISOString(), 'duplicate_config_key', detail);
    }
  }
  return db;
}

export function now() {
  return new Date().toISOString();
}

// Cost in euros: what the CLI reported when it reports one, else the token
// counts times the price table, else nothing.
export function costEur(conf, usage) {
  const rate = Number(section(conf, 'currency').usd_eur);
  if (!rate) return { cost: null, basis: null };
  if (typeof usage.cost_usd === 'number') return { cost: usage.cost_usd * rate, basis: 'cli' };
  const line = section(conf, 'prices')[usage.model];
  if (!line) return { cost: null, basis: null };
  const [input, output, cacheRead, write5m, write1h] = line.split(/\s+/).map(Number);
  const w5 = usage.tokens_cache_write_5m ?? 0;
  const w1 = usage.tokens_cache_write_1h ?? Math.max((usage.tokens_cache_write ?? 0) - w5, 0);
  const usd = ((usage.tokens_in ?? 0) * input + (usage.tokens_out ?? 0) * output + (usage.tokens_cache ?? 0) * cacheRead + w5 * write5m + w1 * write1h) / 1e6;
  return { cost: usd * rate, basis: 'prices' };
}

export function totalTokens(usage) {
  if (typeof usage.tokens_total === 'number') return usage.tokens_total;
  const parts = [usage.tokens_in, usage.tokens_out, usage.tokens_cache, usage.tokens_cache_write];
  return parts.some((n) => typeof n === 'number') ? parts.reduce((sum, n) => sum + (n ?? 0), 0) : null;
}

export function runStart(db, run) {
  db.prepare(`INSERT INTO runs (run_id, ticket, role, model, provider, started_at, lane, source, requested_model, project, label, outcome)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`).run(
    run.runId, run.ticket ?? null, run.role, run.model ?? null, run.provider ?? null, run.startedAt ?? now(),
    run.lane ?? null, run.source ?? 'dispatcher', run.requestedModel ?? null, run.project ?? null, run.label ?? null,
  );
}

export function runEnd(db, conf, run) {
  const usage = run.usage ?? {};
  const { cost, basis } = costEur(conf, usage);
  const int = (n) => (typeof n === 'number' ? Math.round(n) : null);
  const result = db.prepare(`UPDATE runs SET ended_at = ?, outcome = ?, exit_code = ?, model = COALESCE(?, model),
    tokens_in = ?, tokens_out = ?, tokens_cache = ?, tokens_cache_write = ?, tokens_total = ?, cost_eur = ?, cost_basis = ?
    WHERE run_id = ?`).run(
    run.endedAt ?? now(), run.outcome, run.exitCode ?? null, usage.model ?? null,
    int(usage.tokens_in), int(usage.tokens_out), int(usage.tokens_cache), int(usage.tokens_cache_write), int(totalTokens(usage)),
    cost, basis, run.runId,
  );
  if (!result.changes) throw new Error(`unknown run ${run.runId}`);
}

const SETTABLE = { '--outcome': 'outcome', '--pr-number': 'pr_number', '--lines-changed': 'lines_changed', '--human-decision': 'human_decision', '--human-latency-min': 'human_latency_min' };

export function addEvent(db, event) {
  if (!EVENT_KINDS.includes(event.kind)) throw new Error(`unknown event kind "${event.kind}" (known: ${EVENT_KINDS.join(', ')})`);
  db.prepare('INSERT INTO events (at, kind, ticket, run_id, detail, value, source) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    event.at ?? now(), event.kind, event.ticket ?? null, event.runId ?? null, event.detail ?? null, event.value ?? null, event.source ?? 'dispatcher',
  );
}

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`expected "--option value", got "${argv[i]}"`);
    out[argv[i]] = argv[i + 1];
  }
  return out;
}

function main([command, ...rest]) {
  if (command === 'init') {
    openLedger().close();
    process.stdout.write(`${ledgerPath()}\n`);
    return;
  }
  if (command === 'sql') {
    const db = openLedger(ledgerPath(), { readOnly: true });
    process.stdout.write(`${JSON.stringify(db.prepare(rest[0]).all())}\n`);
    return;
  }
  const o = options(rest);
  const db = openLedger();
  if (command === 'run-start') {
    runStart(db, { runId: o['--run-id'], ticket: o['--ticket'] || null, role: o['--role'], model: o['--model'] || null, provider: o['--provider'] || null, lane: o['--lane'] || null, source: o['--source'] || 'dispatcher', requestedModel: o['--requested-model'] || null, project: o['--project'] || null, label: o['--label'] || null });
  } else if (command === 'run-end') {
    const usage = o['--usage-file'] ? JSON.parse(readFileSync(o['--usage-file'], 'utf8')) : {};
    runEnd(db, loadConf(), { runId: o['--run-id'], outcome: o['--outcome'], exitCode: o['--exit-code'] === undefined ? null : Number(o['--exit-code']), usage });
  } else if (command === 'run-set') {
    const runId = o['--run-id'];
    for (const [option, column] of Object.entries(SETTABLE)) {
      if (o[option] === undefined) continue;
      const value = column === 'outcome' || column === 'human_decision' ? o[option] : Number(o[option]);
      const result = db.prepare(`UPDATE runs SET ${column} = ? WHERE run_id = ?`).run(value, runId);
      if (!result.changes) throw new Error(`unknown run ${runId}`);
    }
  } else if (command === 'event') {
    addEvent(db, { kind: o['--kind'], at: o['--at'] || undefined, ticket: o['--ticket'] || null, runId: o['--run-id'] || null, detail: o['--detail'] || null, value: o['--value'] === undefined ? null : Number(o['--value']), source: o['--source'] || 'dispatcher' });
  } else {
    throw new Error('usage: ledger.mjs init | run-start | run-end | run-set | event | sql');
  }
  db.close();
}

if (runAsCommand(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ledger: ${error.message}\n`);
    process.exit(1);
  }
}
