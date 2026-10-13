// The real source: reads the ledger (read only), the tracker through its
// contract, `cleared status --json` and the quota summary. It never writes.
// Only an allowlist of fields leaves this file; no path, no secret, no cost.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { ORCH_HOME, loadConf, projectDir, section } from '../../lib/conf.mjs';
import { ledgerPath, openLedger } from '../../lib/ledger.mjs';
import { createTracker } from '../../lib/tracker/contract.mjs';

const run = promisify(execFile);
const DAY = 86400e3;

// Whatever text comes from a tool, a ticket or a log: no absolute path, no
// long secret-looking string, no control character, bounded length.
export function scrub(text, max = 400) {
  return String(text ?? '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .replace(/(?:~|\/(?:home|root|tmp|var|etc|usr|opt|srv|mnt|run|Users))[^\s'"`)\]]*/g, '[path]')
    .replace(/\b(?:sk-|ghp_|gho_|github_pat_|xox[a-z]-|lin_api_)[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[secret]')
    .slice(0, max);
}

const ROLE = { dev: 'author', mechanical: 'author', writing: 'author', triage: 'author', cleanup: 'author', review: 'reviewer', release: 'project lead', lead: 'project lead' };
export const roleName = (role) => ROLE[role] ?? 'author';
const family = (model) => /opus/i.test(model) ? 'Opus' : /sonnet/i.test(model) ? 'Sonnet' : /haiku/i.test(model) ? 'Haiku' : /fable/i.test(model) ? 'Fable' : scrub(model || 'a model', 40);

const EVENT_TEXT = {
  lane_limit_reached: 'Waiting for a place on the machine', lane_asks: 'The team asks a question', merged_by_script: 'Merged by the guarded script',
  merge_refused: 'Merge refused', lane_stuck: 'The team is stuck', ticket_cost: 'Ticket reached its cap', subscription_stop: 'Paused: subscription limit reached',
  teams_ready: 'Both teams are ready', handover_missing: 'The team ended without a handover', prod_revert: 'Reverted in production',
  review_dropped: 'A review was dropped', model_fallback: 'Fell back to another model', comment_handled: 'Your comment was handled',
  rollback_started: 'Rollback started', rollback_pushed: 'Rollback pushed', release_watch_complete: 'Release watch finished, healthy',
};
export function describeEvent(event) {
  return EVENT_TEXT[event.kind] ?? event.kind.replace(/_/g, ' ');
}
export function describeRun(row) {
  const model = scrub(row.model || row.requested_model || 'a model', 60);
  if (row.role === 'review') {
    const outcome = { done: 'done', approved: 'approved', changes: 'one fix requested', fix: 'one fix requested' }[row.outcome] ?? scrub(row.outcome || 'running', 40);
    return `Review by ${family(model)}: ${outcome}`;
  }
  if (row.ended_at && row.outcome && !['done', 'idle'].includes(row.outcome)) return `Team ended: ${scrub(row.outcome, 40)}`;
  return `Team started: ${model}`;
}

const TESTS = /(\d[\d  .,]*)\s+tests?\s+(?:are\s+)?(green|pass(?:ing|ed)?)/i;
export function statusLineOf({ handover, reviews, column, waiting, reason }) {
  const match = handover && TESTS.exec(handover);
  if (match) return `${match[1].replace(/[ .,]/g, ' ').trim()} tests green`;
  if (reviews > 1) return reviews === 2 ? 'second review round' : `review round ${reviews}`;
  if (waiting) return reason;
  return { progress: 'a team is working', checks: 'checks running', review: 'under review', awaiting: 'waiting for you' }[column] ?? '';
}
const sentences = (text, n = 3) => (String(text).replace(/^#+.*$/gm, ' ').replace(/[`*_>#-]/g, ' ').match(/[^.!?\n]+[.!?]/g) ?? []).map((s) => scrub(s.trim(), 220)).filter((s) => s.length > 8).slice(0, n);
const section_ = (text, heading) => new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(text)?.[1] ?? '';

export function liveSource({ conf = loadConf(), now = () => Date.now(), statusTtlMs = 20000 } = {}) {
  const tracker = conf.sections.tracker ?? {};
  const states = { todo: tracker.todo_state, progress: tracker.progress_state, review: tracker.review_state, validate: tracker.validate_state, go: tracker.go_state };
  const project = basename(projectDir());
  const language = section(conf, 'owner').language || 'en';
  let ledger, trk, cache = { at: 0 };
  const db = () => (ledger ??= openLedger(ledgerPath(), { readOnly: true }));
  const issues = () => {
    if (trk) return trk;
    // A local tracker is opened on a read-only handle: no schema check can write.
    try { trk = createTracker(conf, tracker.adapter === 'local' ? { db: openLedger(ledgerPath(), { readOnly: true }) } : {}); }
    catch { trk = createTracker(conf); }
    return trk;
  };
  const cleared = (...args) => run(process.execPath, args, { timeout: 15000, env: process.env, maxBuffer: 4e6 }).then((r) => r.stdout);
  async function health() {
    try {
      const status = JSON.parse(await cleared(join(ORCH_HOME, 'cleared'), 'status', '--json'));
      return { ok: Boolean(status.ok), problems: (status.problems ?? []).map((p) => ({ code: scrub(p.code, 60), message: scrub(p.message, 240) })) };
    } catch { return { ok: false, problems: [{ code: 'status_unavailable', message: 'The health check could not be read.' }] }; }
  }
  async function fuel() {
    let rows = [];
    try { rows = JSON.parse(await cleared(join(ORCH_HOME, 'lib', 'limits.mjs'), 'summary')); } catch { /* not measured */ }
    const out = rows.map((row) => {
      const [name, window] = Object.entries(row.windows).sort((a, b) => b[1].used - a[1].used)[0] ?? [];
      return window ? { adapter: scrub(row.adapter, 40), measured: true, window: scrub(name, 40), used: Math.round(window.used), resetsAt: window.resets_at } : null;
    }).filter(Boolean);
    for (const value of Object.values(conf.sections.models ?? {})) {
      const adapter = String(value).split(':')[0];
      if (adapter && !out.some((f) => f.adapter === adapter)) out.push({ adapter: scrub(adapter, 40), measured: false });
    }
    return out;
  }
  const runsOf = (id) => db().prepare('SELECT * FROM runs WHERE ticket = ? ORDER BY started_at').all(id);
  const eventsOf = (id) => db().prepare('SELECT * FROM events WHERE ticket = ? ORDER BY at').all(id);
  const handoverOf = (id) => {
    try { return db().prepare("SELECT content FROM memory_entries WHERE type = 'handover' AND scope = ? ORDER BY rowid DESC LIMIT 1").get(`ticket:${id}`)?.content ?? ''; } catch { return ''; }
  };
  const prUrl = (number) => {
    if (!number || !tracker.repository) return null;
    return `https://github.com/${scrub(tracker.repository, 100)}/pull/${Number(number)}`;
  };

  function card(t, weekTokens) {
    const id = String(t.identifier ?? t.id).replace(/^LOCAL-/, '');
    const runs = runsOf(t.identifier ?? t.id);
    const last = [...runs].reverse().find((r) => r.role !== 'review') ?? null;
    const reviews = runs.filter((r) => r.role === 'review').length;
    const stateName = t.status ?? t.state;
    const pr = runs.map((r) => r.pr_number).filter(Boolean).at(-1) ?? null;
    const events = eventsOf(t.identifier ?? t.id);
    const asks = events.filter((e) => e.kind === 'lane_asks').at(-1);
    const queued = !last && events.some((e) => e.kind === 'lane_limit_reached');
    let column = stateName === states.review || stateName === states.go ? 'review' : 'progress';
    if (column === 'progress' && last?.pr_number && last.outcome === 'done' && !reviews) column = 'checks';
    let waiting = false, reason = '';
    if (stateName === states.validate) { column = 'awaiting'; waiting = true; reason = 'Your approval is needed before this ships'; }
    else if (asks && (!last || asks.at > (last.ended_at ?? last.started_at))) { column = 'awaiting'; waiting = true; reason = 'A question for you'; }
    const minutes = runs.filter((r) => r.role !== 'review').reduce((sum, r) => sum + Math.max(0, (Date.parse(r.ended_at ?? new Date(now()).toISOString()) - Date.parse(r.started_at)) / 60000), 0);
    const tokens = runs.filter((r) => Date.parse(r.started_at) >= now() - 7 * DAY).reduce((s, r) => s + (r.tokens_total ?? 0), 0);
    const handover = handoverOf(t.identifier ?? t.id);
    const [harness, model] = [last?.provider ?? '', last?.model ?? last?.requested_model ?? ''];
    return { id, title: scrub(t.title, 160), column, waiting, reason: queued ? 'Waiting for a place on the machine' : reason, queued,
      harness: scrub(harness, 40), model: scrub(model, 60), flightMinutes: Math.round(minutes),
      quotaShare: weekTokens ? Math.round((tokens / weekTokens) * 1000) / 10 : 0,
      statusLine: scrub(statusLineOf({ handover, reviews, column, waiting, reason }), 120), screen: /\bscreen|capture|page|tab|button\b/i.test(`${t.title} ${t.body ?? ''}`),
      pr: pr ? { number: Number(pr), url: prUrl(pr) } : null };
  }

  return {
    async snapshot() {
      if (now() - cache.at < 1500 && cache.value) return cache.value;
      const weekTokens = db().prepare('SELECT COALESCE(SUM(tokens_total),0) AS n FROM runs WHERE started_at >= ?').get(new Date(now() - 7 * DAY).toISOString()).n;
      const tickets = [];
      for (const state of [states.progress, states.review, states.validate, states.go]) if (state) for (const t of issues().listTickets({ status: state })) tickets.push(card(t, weekTokens));
      if (!cache.slow || now() - cache.slow.at > statusTtlMs) cache.slow = { at: now(), health: await health(), fuel: await fuel() };
      const order = { awaiting: 0, progress: 1, checks: 2, review: 3 };
      tickets.sort((a, b) => Number(b.waiting) - Number(a.waiting) || order[a.column] - order[b.column] || a.id.localeCompare(b.id, 'en', { numeric: true }));
      const guarded = Boolean(section(conf, 'merge').tooling_paths && section(conf, 'merge').tooling_paths !== 'none');
      cache.value = { schema: 1, project, projects: [{ id: project, name: project }], language, generatedAt: new Date(now()).toISOString(),
        health: cache.slow.health, fuel: cache.slow.fuel, tickets,
        mode: { key: guarded ? 'guarded-tooling' : 'guarded', label: guarded ? 'Guarded: you approve application changes; tooling paths merge after review' : 'Guarded: you approve every application change' } };
      cache.at = now();
      return cache.value;
    },
    async ticket(id) {
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) return null;
      const ref = tracker.adapter === 'local' && /^\d+$/.test(id) ? `LOCAL-${id}` : id;
      let t;
      try { t = issues().getTicket(ref); } catch { return null; }
      if (!t) return null;
      const runs = runsOf(ref);
      const handover = handoverOf(ref);
      const comments = (() => { try { return issues().comments(ref); } catch { return []; } })();
      const request = [...comments].reverse().find((c) => /agree|approve|approval|accord/i.test(c.body ?? '')) ?? null;
      const where = sentences(`${section_(handover, 'Done')} ${section_(handover, 'Left to do')} ${request?.body ?? ''}`);
      const seen = new Set();
      const squad = runs.map((r) => ({ role: roleName(r.role), harness: scrub(r.provider, 40), model: scrub(r.model || r.requested_model, 60) }))
        .filter((s) => s.model && !seen.has(`${s.role}/${s.model}`) && seen.add(`${s.role}/${s.model}`));
      const images = comments.flatMap((c) => (c.images ?? []).map((ref_) => ({ digest: /[a-f0-9]{64}/.exec(String(ref_))?.[0], text: c.body ?? '' }))).filter((i) => i.digest);
      const show = images.length
        ? { kind: 'screen',
          before: images.filter((i) => /before|avant/i.test(i.text)).map((i) => ({ url: `/media/${i.digest}`, caption: 'Before' })),
          after: images.filter((i) => !/before|avant/i.test(i.text)).map((i) => ({ url: `/media/${i.digest}`, caption: 'After' })) }
        : { kind: 'code', example: exampleOf(`${handover}\n${request?.body ?? ''}`), tests: testsOf(handover), touches: sentences(section_(handover, 'Done'), 1)[0] ?? '' };
      const blackBox = [
        ...runs.map((r) => ({ at: r.started_at, kind: r.role === 'review' ? 'review' : 'run', text: describeRun(r), raw: { kind: 'run', role: r.role, outcome: scrub(r.outcome, 40), at: r.started_at } })),
        ...eventsOf(ref).map((e) => ({ at: e.at, kind: e.kind, text: describeEvent(e), raw: { kind: e.kind, at: e.at, detail: scrub(e.detail), value: e.value } })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      const n = runs.map((r) => r.pr_number).filter(Boolean).at(-1);
      return { id, title: scrub(t.title, 160), pr: n ? { number: Number(n), url: prUrl(n) } : null, where, squad, show, blackBox };
    },
    async media(digest) {
      try {
        const row = db().prepare('SELECT mime, body FROM tracker_images WHERE digest = ?').get(digest);
        return row && /^image\/(png|jpeg|webp|gif)$/.test(row.mime) ? { mime: row.mime, body: Buffer.from(row.body) } : null;
      } catch { return null; }
    },
  };
}

function exampleOf(text) {
  const before = /before\s*[:\-–]\s*(.{3,160})/i.exec(text)?.[1], after = /after\s*[:\-–]\s*(.{3,160})/i.exec(text)?.[1];
  return before && after ? { before: scrub(before, 160), after: scrub(after, 160) } : null;
}
function testsOf(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const match = /^[-*]\s*(?:test(?:s)?\s+)?(added|modified|updated)[:\s]+(.{3,120}?)(?:\s+[-–(]\s*(pass(?:ing|ed)?|green|fail(?:ing|ed)?|red)\)?)?\s*$/i.exec(line.trim());
    if (match) out.push({ name: scrub(match[2], 120), change: /add/i.test(match[1]) ? 'added' : 'modified', state: /pass|green/i.test(match[3] ?? '') ? 'pass' : /fail|red/i.test(match[3] ?? '') ? 'fail' : 'unknown' });
  }
  return out.slice(0, 30);
}
