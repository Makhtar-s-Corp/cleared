// The real source: reads the ledger (read only), the tracker through its
// contract, `cleared status --json` and the quota summary. It writes nothing itself.
// Only an allowlist of fields leaves this file; no path, no secret, no cost.
// Nothing is run, probed or written: health is read from what the wake recorded.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { ORCH_HOME, loadConf, projectDir, section } from '../../lib/conf.mjs';
import { ledgerPath, openLedger } from '../../lib/ledger.mjs';
import { createTracker } from '../../lib/tracker/contract.mjs';
import { message } from '../../lib/i18n.mjs';

const run = promisify(execFile);
const DAY = 86400e3;

// Whatever text comes from a tool, a ticket or a log: no absolute path, no
// long secret-looking string, no control character, bounded length.
export function scrub(text, max = 400) {
  return String(text ?? '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .replace(/(?:~|\/(?:home|root|tmp|var|etc|usr|opt|srv|mnt|run|Users))[^\s'"`)\]]*/g, '[path]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi, '[credentials]@')
    .replace(/\b(?:sk-|ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|xox[a-z]-|lin_api_|AKIA)[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[secret]')
    .replace(/(?:\b(?:USD|EUR)\s?)?\d[\d\s\u202f.,]*\d?\s?(?:\$|€|\bUSD\b|\bEUR\b|dollars?|euros?)|(?:\$|€|\bUSD\b|\bEUR\b)\s?\d[\d\s\u202f.,]*\d?/gi, '[amount]')
    .slice(0, max);
}

const ROLE = { dev: 'author', mechanical: 'author', writing: 'author', triage: 'author', cleanup: 'author', review: 'reviewer', release: 'project lead', lead: 'project lead' };
export const roleName = (role) => ROLE[role] ?? 'author';
const family = (model) => /opus/i.test(model) ? 'Opus' : /sonnet/i.test(model) ? 'Sonnet' : /haiku/i.test(model) ? 'Haiku' : /fable/i.test(model) ? 'Fable' : scrub(model || 'a model', 40);

export function describeEvent(event, language = 'en') {
  const key = `app_srv_ev_${event.kind}`;
  try { return message(key, language); } catch { return message('app_srv_ev_other', language, { kind: event.kind.replace(/_/g, ' ') }); }
}
export function describeRun(row, language = 'en') {
  const model = scrub(row.model || row.requested_model || message('app_srv_a_model', language), 60);
  const said = (outcome) => {
    const key = { done: 'done', approved: 'approved', changes: 'fix', fix: 'fix', running: 'running' }[outcome];
    return key ? message(`app_srv_outcome_${key}`, language) : scrub(outcome || message('app_srv_outcome_running', language), 40);
  };
  if (row.role === 'review') return message('app_srv_review_by', language, { who: family(model), outcome: said(row.outcome) });
  if (row.ended_at && row.outcome && !['done', 'idle'].includes(row.outcome)) return message('app_srv_team_ended', language, { outcome: scrub(row.outcome, 40) });
  return message('app_srv_team_started', language, { model });
}

const TESTS = /(\d[\d  .,]*)\s+tests?\s+(?:are\s+)?(green|pass(?:ing|ed)?)/i;
export function statusLineOf({ handover, reviews, column, waiting, reason, language = 'en' }) {
  const match = handover && TESTS.exec(handover);
  if (match) return `${match[1].replace(/[ .,]/g, ' ').trim()} tests green`;
  if (reviews > 1) return reviews === 2 ? message('app_srv_second_round', language) : message('app_srv_round', language, { n: reviews });
  if (waiting) return reason;
  return column ? message(`app_srv_line_${column}`, language) : '';
}
// Filtered first, split after: splitting on a dot would cut an amount or a path in pieces the filter no longer recognises.
const sentences = (text, n = 3) => (scrub(String(text).replace(/^#+.*$/gm, ' '), 4000).replace(/[`*>#]/g, ' ').match(/[^.!?\n]+[.!?]/g) ?? []).map((x) => x.trim().slice(0, 220)).filter((x) => x.length > 8).slice(0, n);
const section_ = (text, heading) => new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(text)?.[1] ?? '';

export function liveSource({ conf = loadConf(), now = () => Date.now(), statusTtlMs = 60000 } = {}) {
  const tracker = conf.sections.tracker ?? {};
  const states = { todo: tracker.todo_state, progress: tracker.progress_state, review: tracker.review_state, validate: tracker.validate_state, go: tracker.go_state };
  const project = basename(projectDir());
  const language = section(conf, 'owner').language || 'en';
  // Remote trackers are asked rarely and once for all pages; a local one is cheap.
  const ttl = tracker.adapter === 'local' ? 1500 : 30000;
  let ledger, trk, cache = { at: 0 };
  const db = () => (ledger ??= openLedger(ledgerPath(), { readOnly: true }));
  const issues = () => {
    if (trk) return trk;
    // A local tracker is opened on a read-only handle, and never on another: if that fails, the read fails.
    trk = createTracker(conf, tracker.adapter === 'local' ? { db: openLedger(ledgerPath(), { readOnly: true }) } : {});
    return trk;
  };
  const cleared = (...args) => run(process.execPath, args, { timeout: 15000, env: process.env, maxBuffer: 4e6 }).then((r) => r.stdout);
  // Health is what the wake recorded (heartbeat_state, heartbeat_incidents), read on a
  // read-only handle. Nothing is run, probed or written here; the age says how old it is.
  const WAKE = { wake_late: 'app_srv_problem_wake_late', wake_missing: 'app_srv_problem_wake_missing', wake_failed: 'app_srv_problem_wake_failed' };
  function health() {
    const get = (key) => { try { return db().prepare('SELECT value FROM heartbeat_state WHERE key = ?').get(key)?.value || null; } catch { return null; } };
    const lastWake = get('last_wake_at');
    const interval = Number(section(conf, 'heartbeat').wake_interval_minutes) || 1;
    const age = lastWake ? now() - Date.parse(lastWake) : null;
    const problems = [];
    if (!lastWake) problems.push({ code: 'wake_missing', message: message(WAKE.wake_missing, language) });
    else if (age > 3 * interval * 60000) problems.push({ code: 'wake_late', message: message(WAKE.wake_late, language, { minutes: Math.floor(age / 60000) }) });
    else if (get('last_wake_ok') === 'false') problems.push({ code: 'wake_failed', message: message(WAKE.wake_failed, language) });
    let incidents = [];
    try { incidents = db().prepare('SELECT id FROM heartbeat_incidents WHERE active = 1 ORDER BY first_seen').all(); } catch { /* none recorded yet */ }
    for (const { id } of incidents) {
      const [code, ...rest] = String(id).split(':');
      if (WAKE[code]) continue; // the age above says it afresh
      const key = `app_srv_problem_${code}`;
      let text;
      try { text = message(key, language, { name: scrub(rest.join(':'), 60) }); } catch { text = message('app_srv_problem_other', language, { code: scrub(code, 40) }); }
      problems.push({ code: scrub(code, 40), message: text });
    }
    return { ok: problems.length === 0, problems, recordedAt: lastWake };
  }
  async function fuel() {
    let rows = [];
    try { rows = JSON.parse(await cleared(join(ORCH_HOME, 'lib', 'limits.mjs'), 'summary')); } catch { /* not measured */ }
    const out = rows.map((row) => {
      const [name, window] = Object.entries(row.windows).sort((a, b) => b[1].used - a[1].used)[0] ?? [];
      return window ? { adapter: scrub(row.adapter, 40), measured: true, window: scrub(name, 40), used: Math.round(window.used), left: Math.max(0, 100 - Math.round(window.used)), resetsAt: window.resets_at } : null;
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
    if (!number || !/^[\w.-]+\/[\w.-]+$/.test(tracker.repository ?? '')) return null;
    return `https://github.com/${tracker.repository}/pull/${Number(number)}`;
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
    if (stateName === states.validate) { column = 'awaiting'; waiting = true; reason = message('app_srv_approval', language); }
    else if (asks && (!last || asks.at > (last.ended_at ?? last.started_at))) { column = 'awaiting'; waiting = true; reason = message('app_srv_question', language); }
    const minutes = runs.filter((r) => r.role !== 'review').reduce((sum, r) => sum + Math.max(0, (Date.parse(r.ended_at ?? new Date(now()).toISOString()) - Date.parse(r.started_at)) / 60000), 0);
    const tokens = runs.filter((r) => Date.parse(r.started_at) >= now() - 7 * DAY).reduce((s, r) => s + (r.tokens_total ?? 0), 0);
    const handover = handoverOf(t.identifier ?? t.id);
    const [harness, model] = [last?.provider ?? '', last?.model ?? last?.requested_model ?? ''];
    const isQuestion = waiting && stateName !== states.validate;
    // Small before/after tiles on a card that waits for approval: the first capture of each side (local tracker only: no extra call to a remote one).
    let captures = null;
    if (waiting && !isQuestion && tracker.adapter === 'local') {
      try {
        const images = imagesOf(issues().comments(t.identifier ?? t.id));
        const before = images.find((i) => /before|avant/i.test(i.text)), after = images.find((i) => !/before|avant/i.test(i.text));
        if (before && after) captures = { before: `/media/${before.digest}`, after: `/media/${after.digest}` };
      } catch { /* a card without tiles */ }
    }
    // A question card says the question itself (the event's text), and keeps the ticket title as its sentence.
    const question = isQuestion ? scrub(asks?.detail, 160) : '';
    return { id, title: question || scrub(t.title, 160), column, waiting, kind: queued ? 'queued' : isQuestion ? 'question' : waiting ? 'ready' : 'normal',
      live: Boolean(last && last.outcome === 'running' && !last.ended_at), round: reviews, tests: testsCount(handover), captures,
      reason: queued ? message('app_srv_queued', language) : question ? scrub(t.title, 160) : reason, queued,
      harness: scrub(harness, 40), model: scrub(model, 60), flightMinutes: Math.round(minutes),
      quotaShare: weekTokens ? Math.round((tokens / weekTokens) * 1000) / 10 : 0,
      statusLine: scrub(statusLineOf({ handover, reviews, column, waiting, reason, language }), 120), screen: /\b(?:screen|capture|page|tab|button)\b/i.test(`${t.title} ${t.body ?? ''}`),
      pr: pr ? { number: Number(pr), url: prUrl(pr) } : null };
  }

  // What shipped in the last two days (the page keeps today's), and how many went through first time.
  const titles = new Map();
  const titleOf = (id) => {
    if (tracker.adapter !== 'local') return ''; // a remote tracker is not called for this: the id is shown
    if (!titles.has(id)) { try { titles.set(id, scrub(issues().getTicket(id)?.title, 160)); } catch { titles.set(id, ''); } }
    return titles.get(id);
  };
  function landedOf(weekTokens) {
    const merged = db().prepare("SELECT ticket, at FROM events WHERE kind = 'merged_by_script' AND ticket IS NOT NULL AND at >= ? ORDER BY at DESC").all(new Date(now() - 7 * DAY).toISOString());
    const rows = merged.map((m) => {
      const runs = runsOf(m.ticket);
      const author = [...runs].reverse().find((r) => r.role !== 'review');
      const fixes = runs.filter((r) => r.role === 'review' && ['changes', 'fix'].includes(r.outcome)).length;
      const back = db().prepare("SELECT MIN(at) at FROM events WHERE ticket = ? AND at >= ? AND kind IN ('prod_revert','rollback_pushed')").get(m.ticket, m.at)?.at ?? null;
      const tokens = runs.reduce((sum, r) => sum + (r.tokens_total ?? 0), 0);
      return { at: m.at, id: scrub(String(m.ticket).replace(/^LOCAL-/, ''), 40), title: titleOf(m.ticket) || scrub(m.ticket, 40), model: scrub(author?.model || author?.requested_model, 60),
        harness: scrub(author?.provider, 40), fixes, rolledBackAt: back, tokens, share: weekTokens ? Math.round((tokens / weekTokens) * 1000) / 10 : 0 };
    });
    const clean = rows.filter((r) => r.fixes === 0 && !r.rolledBackAt).length;
    const cutoff = now() - 2 * DAY;
    return { landed: rows.filter((r) => Date.parse(r.at) >= cutoff).map(({ tokens, ...r }) => r),
      firstTimeClean: rows.length ? Math.round((clean / rows.length) * 100) : null };
  }

  async function build() {
    const weekTokens = db().prepare('SELECT COALESCE(SUM(tokens_total),0) AS n FROM runs WHERE started_at >= ?').get(new Date(now() - 7 * DAY).toISOString()).n;
    const tickets = [];
    for (const state of [states.progress, states.review, states.validate, states.go]) if (state) for (const t of issues().listTickets({ status: state })) tickets.push(card(t, weekTokens));
    if (!cache.slow || now() - cache.slow.at > statusTtlMs) cache.slow = { at: now(), fuel: await fuel() };
    const order = { awaiting: 0, progress: 1, checks: 2, review: 3 };
    tickets.sort((a, b) => Number(b.waiting) - Number(a.waiting) || order[a.column] - order[b.column] || a.id.localeCompare(b.id, 'en', { numeric: true }));
    const guarded = Boolean(section(conf, 'merge').tooling_paths && section(conf, 'merge').tooling_paths !== 'none');
    const { landed, firstTimeClean } = landedOf(weekTokens);
    cache.value = { schema: 1, project, projects: [{ id: project, name: project }], language, generatedAt: new Date(now()).toISOString(),
      owner: { name: scrub(section(conf, 'owner').name, 60) }, stats: { inFlight: tickets.filter((x) => x.live).length, firstTimeClean }, landed,
      health: health(), fuel: cache.slow.fuel, tickets,
      mode: { key: guarded ? 'guarded-tooling' : 'guarded', short: message('app_srv_mode_short', language), label: message(guarded ? 'app_srv_mode_tooling' : 'app_srv_mode_guarded', language) } };
    cache.at = now();
    return cache.value;
    
  }

  return {
    async snapshot() {
      if (now() - cache.at < ttl && cache.value) return cache.value;
      if (cache.pending) return cache.pending;
      cache.pending = build().finally(() => { cache.pending = null; });
      return cache.pending;
    },
    async ticket(id) {
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) return null;
      const ref = tracker.adapter === 'local' && /^\d+$/.test(id) ? `LOCAL-${id}` : id;
      let t;
      try { t = issues().getTicket(ref); } catch { return null; }
      if (!t || ![states.progress, states.review, states.validate, states.go].includes(t.status ?? t.state)) return null;
      const runs = runsOf(ref);
      const handover = handoverOf(ref);
      const comments = (() => { try { return issues().comments(ref); } catch { return []; } })();
      const request = [...comments].reverse().find((c) => /agree|approve|approval|accord/i.test(c.body ?? '')) ?? null;
      const where = sentences(`${section_(handover, 'Done')} ${section_(handover, 'Left to do')} ${request?.body ?? ''}`);
      const seen = new Set();
      const squad = runs.map((r) => ({ role: roleName(r.role), harness: scrub(r.provider, 40), model: scrub(r.model || r.requested_model, 60) }))
        .filter((s) => s.model && !seen.has(`${s.role}/${s.model}`) && seen.add(`${s.role}/${s.model}`));
      const images = imagesOf(comments);
      const show = images.length
        ? { kind: 'screen',
          before: images.filter((i) => /before|avant/i.test(i.text)).map((i) => ({ url: `/media/${i.digest}`, caption: scrub(i.text, 80) || 'Before' })),
          after: images.filter((i) => !/before|avant/i.test(i.text)).map((i) => ({ url: `/media/${i.digest}`, caption: scrub(i.text, 80) || 'After' })) }
        : { kind: 'code', example: exampleOf(`${handover}\n${request?.body ?? ''}`), tests: testsOf(handover), touches: sentences(section_(handover, 'Done'), 1)[0] ?? '' };
      const blackBox = [
        ...runs.map((r) => ({ at: r.started_at, kind: r.role === 'review' ? 'review' : 'run', text: describeRun(r, language), stage: r.role === 'review' ? 'review' : 'progress', raw: { kind: 'run', role: scrub(r.role, 20), outcome: scrub(r.outcome, 40), at: r.started_at } })),
        ...eventsOf(ref).map((e) => ({ at: e.at, kind: e.kind, text: describeEvent(e, language), stage: stageOf(e.kind), raw: { kind: e.kind, at: e.at } })),
      ].sort((a, b) => a.at.localeCompare(b.at));
      const n = runs.map((r) => r.pr_number).filter(Boolean).at(-1);
      const weekTokens = db().prepare('SELECT COALESCE(SUM(tokens_total),0) AS n FROM runs WHERE started_at >= ?').get(new Date(now() - 7 * DAY).toISOString()).n;
      const c = card(t, weekTokens);
      return { id, title: scrub(t.title, 160), pr: n ? { number: Number(n), url: prUrl(n) } : null, column: c.column, kind: c.kind, waiting: c.waiting,
        flightMinutes: c.flightMinutes, quotaShare: c.quotaShare, tests: c.tests, where, squad, show, blackBox };
    },
    async media(digest) {
      try {
        const row = db().prepare('SELECT mime, body FROM tracker_images WHERE digest = ?').get(digest);
        return row && /^image\/(png|jpeg|webp|gif)$/.test(row.mime) ? { mime: row.mime, body: Buffer.from(row.body) } : null;
      } catch { return null; }
    },
  };
}

// The request posts its captures in the text: **Caption** then ![Caption](local://capture/<digest>).
function imagesOf(comments) {
  const inText = comments.flatMap((c) => [...String(c.body ?? '').matchAll(/(?:\*\*([^*\n]{1,80})\*\*\s*)?!\[([^\]\n]{0,80})\]\(local:\/\/capture\/([a-f0-9]{64})\)/g)]
    .map((m) => ({ digest: m[3], text: m[1] || m[2] || '' })));
  return [...comments.flatMap((c) => (c.images ?? []).map((ref_) => ({ digest: /[a-f0-9]{64}/.exec(String(ref_))?.[0], text: c.body ?? '' }))), ...inText].filter((i) => i.digest)
    .filter((i, n, all) => all.findIndex((o) => o.digest === i.digest) === n);
}
const testsCount = (text) => { const m = TESTS.exec(text || ''); return m ? Number(m[1].replace(/\D/g, '')) : null; };
// The stage a Black box line belongs to: the colour of its dot.
export const stageOf = (kind) => ({ review: 'review', lane_asks: 'awaiting', teams_ready: 'awaiting', ask: 'awaiting', merged_by_script: 'done',
  prod_revert: 'danger', merge_refused: 'danger', lane_stuck: 'danger', rollback_started: 'danger', rollback_pushed: 'danger' })[kind] ?? 'progress';

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
