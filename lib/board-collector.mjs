// The wake's board collector. The app never imports this module. It reads the
// tracker and ledger, filters display fields, and publishes one complete file.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { ORCH_HOME, expandHome, loadConf, projectDir, section, stateDir } from './conf.mjs';
import { EVENT_KINDS, ledgerPath, openLedger } from './ledger.mjs';
import { createTracker } from './tracker/contract.mjs';
import { remoteCapture } from './tracker/adapters/capture-hosts.mjs';
import { message } from './i18n.mjs';
import { approvalOf } from './validation-record.mjs';
import { scrub } from './board-scrub.mjs';
import { hasSections, questionsOf, reportBody, reportOutcome, reportSections } from './board-report.mjs';

const run = promisify(execFile);
const DAY = 86400e3;
const isoTime = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new Error('Invalid timestamp in board data');
  return new Date(value).toISOString();
};

export { scrub } from './board-scrub.mjs';
export { questionsOf, reportSections } from './board-report.mjs';
// A ticket's share of the week's usage says something only once several
// tickets shared that week: below this many tickets with a run in the last
// seven days, the share is not shown (one ticket alone would read "79 %").
export const SHARE_MIN_TICKETS = 5;

const ROLE = { dev: 'author', mechanical: 'author', writing: 'author', triage: 'author', cleanup: 'author', review: 'reviewer', release: 'project lead', lead: 'project lead' };
export const roleName = (role) => ROLE[role] ?? 'author';
const family = (model) => /opus/i.test(model) ? 'Opus' : /sonnet/i.test(model) ? 'Sonnet' : /haiku/i.test(model) ? 'Haiku' : /fable/i.test(model) ? 'Fable' : scrub(model || 'a model', 40);

export function describeEvent(event, language = 'en') {
  const key = `app_srv_ev_${event.kind}`;
  try { return message(key, language); } catch { return message('app_srv_ev_other', language, { kind: scrub(String(event.kind).replace(/_/g, ' '), 40) }); }
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

// The text is the team's report to the user (and, for the count of tests only, its handover).
const TESTS = /(\d[\d   .,]*)\s+tests?\s+(?:are\s+|sont\s+)?(green|pass(?:ing|ed)?|verts?|passent|réussis)/i;
export function statusLineOf({ handover, reviews, column, waiting, reason, language = 'en' }) {
  const match = handover && TESTS.exec(handover);
  if (match) return message('app_srv_tests_green', language, { n: match[1].trim().replace(/[\s.,]+/g, '\u202f') });
  if (reviews > 1) return reviews === 2 ? message('app_srv_second_round', language) : message('app_srv_round', language, { n: reviews });
  if (waiting) return reason;
  return column ? message(`app_srv_line_${column}`, language) : '';
}
// Filtered first, split after: splitting on a dot would cut an amount or a path in pieces the filter no longer recognises.
const sentences = (text, n = 3) => (scrub(String(text).replace(/^#+.*$/gm, ' '), 4000).replace(/[`*>#]/g, ' ').match(/[^.!?\n]+[.!?]/g) ?? []).map((x) => x.trim().slice(0, 220)).filter((x) => x.length > 8).slice(0, n);
export function boardCollector({ conf = loadConf(), now = () => Date.now(), statusTtlMs = 60000, trackerClient, fuelReader } = {}) {
  const tracker = conf.sections.tracker ?? {};
  const states = { todo: tracker.todo_state, progress: tracker.progress_state, review: tracker.review_state, validate: tracker.validate_state, go: tracker.go_state };
  const project = scrub(basename(projectDir()), 60);
  const language = section(conf, 'owner').language === 'fr' ? 'fr' : 'en';
  // One collection is shared by the current wake only.
  let ledger, trk, cache = { at: 0 };
  const details = {};
  const commentsByTicket = new Map();
  const media = new Map();
  const db = () => (ledger ??= openLedger(ledgerPath(), { readOnly: true }));
  const issues = () => {
    if (trackerClient) return trackerClient;
    if (trk) return trk;
    // A local tracker is opened on a read-only handle, and never on another: if that fails, the read fails.
    trk = createTracker(conf, tracker.adapter === 'local' ? { db: openLedger(ledgerPath()), actor: { kind: 'shared', id: 'snapshot' } } : {});
    return trk;
  };
  const cleared = (...args) => run(process.execPath, args, { timeout: 15000, env: process.env, maxBuffer: 4e6 }).then((r) => r.stdout);
  // Health is what the wake recorded (heartbeat_state, heartbeat_incidents), read on a
  // read-only handle. Nothing is run, probed or written here; the age says how old it is.
  const WAKE = { wake_late: 'app_srv_problem_wake_late', wake_missing: 'app_srv_problem_wake_missing', wake_failed: 'app_srv_problem_wake_failed' };
  function health() {
    const get = (key) => { try { return db().prepare('SELECT value FROM heartbeat_state WHERE key = ?').get(key)?.value || null; } catch { return null; } };
    const lastWakeRaw = get('last_wake_at');
    const lastWake = lastWakeRaw && Number.isFinite(Date.parse(lastWakeRaw)) && /^\d{4}-/.test(lastWakeRaw) ? isoTime(lastWakeRaw) : null;
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
    rows = fuelReader ? await fuelReader() : JSON.parse(await cleared(join(ORCH_HOME, 'lib', 'limits.mjs'), 'summary'));
    const out = rows.map((row) => {
      const [name, window] = Object.entries(row.windows).sort((a, b) => b[1].used - a[1].used)[0] ?? [];
      if (!window) return null;
      const used = Number(window.used);
      if (!Number.isFinite(used)) throw new Error('Invalid fuel reading');
      return { adapter: scrub(row.adapter, 40), measured: true, window: scrub(name, 40),
        used: Math.round(used), left: Math.max(0, 100 - Math.round(used)), resetsAt: window.resets_at ? isoTime(window.resets_at) : null };
    }).filter(Boolean);
    for (const value of Object.values(conf.sections.models ?? {})) {
      const adapter = String(value).split(':')[0];
      if (adapter && !out.some((f) => f.adapter === adapter)) out.push({ adapter: scrub(adapter, 40), measured: false });
    }
    return out;
  }
  const runsOf = (id) => db().prepare('SELECT * FROM runs WHERE ticket = ? ORDER BY started_at').all(id);
  const eventsOf = (id) => db().prepare('SELECT * FROM events WHERE ticket = ? ORDER BY at').all(id);
  // The handover is the team's internal note for its next session (English, technical): it is
  // never shown. Only a count of green tests may be read from it, and the Black box says it exists.
  const handoverOf = (id) => {
    try { return db().prepare("SELECT content FROM memory_entries WHERE type = 'handover' AND scope = ? ORDER BY rowid DESC LIMIT 1").get(`ticket:${id}`)?.content ?? ''; } catch { return ''; }
  };
  const handoverAt = (id) => {
    try {
      const at = db().prepare("SELECT source_when FROM memory_entries WHERE type = 'handover' AND scope = ? ORDER BY rowid DESC LIMIT 1").get(`ticket:${id}`)?.source_when;
      return typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(at) && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null;
    } catch { return null; }
  };
  const prUrl = (number) => {
    if (!number || !/^[\w.-]+\/[\w.-]+$/.test(tracker.repository ?? '')) return null;
    return `https://github.com/${tracker.repository}/pull/${Number(number)}`;
  };
  // The team's report to the user: the report file the dispatcher keeps for the
  // run (state/reports/<run>.md). The newest finished one wins, which is the
  // formatted one when [tracker] writeup_role rewrote it for the user.
  const reports = new Map();
  function reportOf(ref) {
    if (reports.has(ref)) return reports.get(ref);
    let found = null;
    for (const r of runsOf(ref).filter((x) => !['review', 'release', 'lead'].includes(x.role)).reverse()) {
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(String(r.run_id ?? '')) || r.ended_at == null) continue;
      let text;
      try { text = readFileSync(join(stateDir(), 'reports', `${r.run_id}.md`), 'utf8'); } catch { continue; }
      const outcome = reportOutcome(text);
      if (outcome && outcome !== 'done') continue;
      const body = reportBody(text);
      const sections = reportSections(body);
      if (!hasSections(sections) && !sections.other.length) continue;
      found = { at: isoTime(r.ended_at), body, sections };
      break;
    }
    reports.set(ref, found);
    return found;
  }
  // What the wake knows of each open pull request (wake.sh lists them once per
  // wake and keeps them in wake/state.json): its checks, its size. Nothing is asked here.
  let pulls = null;
  const pullsKnown = () => {
    if (pulls) return pulls;
    try { const kept = JSON.parse(readFileSync(join(stateDir(), 'wake', 'state.json'), 'utf8'))?.pulls; pulls = kept && typeof kept === 'object' && !Array.isArray(kept) ? kept : {}; } catch { pulls = {}; }
    return pulls;
  };
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  function changeOf(number, runs) {
    if (!number) return null;
    const known = pullsKnown()[number] ?? null;
    const [files, additions, deletions] = [count(known?.files), count(known?.additions), count(known?.deletions)];
    const pushed = runs.filter((r) => Number(r.pr_number) === number && Number.isSafeInteger(r.lines_changed) && r.lines_changed > 0).at(-1)?.lines_changed ?? null;
    return { pr: { number, url: prUrl(number) }, files, additions, deletions,
      lines: additions !== null && deletions !== null ? additions + deletions : pushed,
      checks: { success: 'green', failure: 'red', pending: 'running', none: 'none' }[known?.checks] ?? null,
      draft: known ? known.state === 'draft' : null };
  }
  // The share of the week is shown only once enough tickets shared it (SHARE_MIN_TICKETS).
  let week = null;
  const weekUsage = () => (week ??= db().prepare('SELECT COALESCE(SUM(tokens_total),0) AS tokens, COUNT(DISTINCT ticket) AS tickets FROM runs WHERE started_at >= ? AND ticket IS NOT NULL').get(new Date(now() - 7 * DAY).toISOString()));
  const shareOf = (tokens) => {
    const { tokens: all, tickets } = weekUsage();
    return all > 0 && tickets >= SHARE_MIN_TICKETS ? Math.round((tokens / all) * 1000) / 10 : null;
  };
  const SCREEN = /(?<![\p{L}\d])(?:screens?|captures?|pages?|tabs?|buttons?|écrans?|onglets?|boutons?)(?![\p{L}\d])/iu;

  function card(t) {
    const id = scrub(String(t.identifier ?? t.id).replace(/^LOCAL-/, ''), 40);
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) throw new Error('Invalid ticket identifier');
    const ref = String(t.identifier ?? t.id);
    const runs = runsOf(ref);
    const last = [...runs].reverse().find((r) => r.role !== 'review') ?? null;
    const reviews = runs.filter((r) => r.role === 'review').length;
    const stateName = t.status ?? t.state;
    const pr = runs.map((r) => r.pr_number).filter(Boolean).at(-1) ?? null;
    const events = eventsOf(ref);
    const asks = events.filter((e) => e.kind === 'lane_asks').at(-1);
    const queued = !last && events.some((e) => e.kind === 'lane_limit_reached');
    let column = stateName === states.review || stateName === states.go ? 'review' : 'progress';
    if (column === 'progress' && last?.pr_number && last.outcome === 'done' && !reviews) column = 'checks';
    let waiting = false, reason = '', kind = queued ? 'queued' : 'normal', approval = null, since = null, questions = [];
    if (stateName === states.validate) {
      column = 'awaiting';
      // Ready to land only when Cleared holds a request for a version (state/validations/<ticket>.json).
      // A ticket that merely sits in the tracker's approval status is shown apart, with nothing to clear.
      approval = queued ? null : approvalOf(ref, stateDir());
      if (approval) { waiting = true; kind = 'ready'; reason = message('app_srv_approval', language); since = isoTime(approval.at); }
      else if (!queued) { kind = 'tracker'; reason = message('app_srv_tracker_only', language); }
    } else if (asks && (!last || asks.at > (last.ended_at ?? last.started_at))) {
      column = 'awaiting'; waiting = true; reason = message('app_srv_question', language); since = isoTime(asks.at);
      if (!queued) { kind = 'question'; questions = questionsOf(asks.detail); }
    }
    const minutes = runs.filter((r) => r.role !== 'review').reduce((sum, r) => sum + Math.max(0, (Date.parse(r.ended_at ?? new Date(now()).toISOString()) - Date.parse(r.started_at)) / 60000), 0);
    const tokens = runs.filter((r) => Date.parse(r.started_at) >= now() - 7 * DAY).reduce((s, r) => s + (r.tokens_total ?? 0), 0);
    // A count of green tests: said by the report, or failing that by the handover (a number, never its text).
    const told = `${reportOf(ref)?.body ?? ''}\n${handoverOf(ref)}`;
    const [harness, model] = [last?.provider ?? '', last?.model ?? last?.requested_model ?? ''];
    return { id, ref: /^[A-Z][A-Z0-9]*-[0-9]+$/.test(ref) ? ref : null, approval,
      options: questions.length === 1 ? questions[0].options : [], questions, since,
      title: scrub(t.title, 160), column, waiting, kind,
      live: Boolean(last && last.outcome === 'running' && !last.ended_at), round: reviews, tests: testsCount(told), captures: null,
      reason: queued ? message('app_srv_queued', language) : reason, queued,
      harness: scrub(harness, 40), model: scrub(model, 60), flightMinutes: Math.round(minutes),
      quotaShare: shareOf(tokens),
      statusLine: scrub(statusLineOf({ handover: told, reviews, column, waiting, reason, language }), 120), screen: SCREEN.test(`${t.title} ${t.body ?? ''}`),
      pr: pr ? { number: Number(pr), url: prUrl(pr) } : null, change: changeOf(Number(pr), runs) };
  }

  // What shipped in the last two days (the page keeps today's), and how many went through first time.
  const titles = new Map();
  const titleOf = (id) => {
    if (tracker.adapter === 'local' && !/^LOCAL-[1-9][0-9]*$/.test(id)) return '';
    if (!titles.has(id)) titles.set(id, scrub(issues().getTicket(id)?.title, 160));
    return titles.get(id);
  };
  function landedOf() {
    const merged = db().prepare("SELECT ticket, at FROM events WHERE kind = 'merged_by_script' AND ticket IS NOT NULL AND at >= ? ORDER BY at DESC").all(new Date(now() - 7 * DAY).toISOString());
    const cutoff = now() - 2 * DAY;
    const rows = merged.map((m) => {
      const runs = runsOf(m.ticket);
      const author = [...runs].reverse().find((r) => r.role !== 'review');
      const fixes = runs.filter((r) => r.role === 'review' && ['changes', 'fix'].includes(r.outcome)).length;
      const back = db().prepare("SELECT MIN(at) at FROM events WHERE ticket = ? AND at >= ? AND kind IN ('prod_revert','rollback_pushed')").get(m.ticket, m.at)?.at ?? null;
      const tokens = runs.reduce((sum, r) => sum + (r.tokens_total ?? 0), 0);
      return { at: isoTime(m.at), id: scrub(String(m.ticket).replace(/^LOCAL-/, ''), 40), title: Date.parse(m.at) >= cutoff ? titleOf(m.ticket) || scrub(m.ticket, 40) : scrub(m.ticket, 40), model: scrub(author?.model || author?.requested_model, 60),
        harness: scrub(author?.provider, 40), fixes, rolledBackAt: back ? isoTime(back) : null, tokens, share: shareOf(tokens) };
    });
    const clean = rows.filter((r) => r.fixes === 0 && !r.rolledBackAt).length;
    return { landed: rows.filter((r) => Date.parse(r.at) >= cutoff).map(({ tokens, ...r }) => r),
      firstTimeClean: rows.length ? Math.round((clean / rows.length) * 100) : null };
  }

  async function build() {
    const tickets = [];
    for (const state of [states.progress, states.review, states.validate, states.go]) if (state) for (const t of issues().listTickets({ status: state })) tickets.push(card(t));
    if (!cache.slow || now() - cache.slow.at > statusTtlMs) cache.slow = { at: now(), fuel: await fuel() };
    const order = { awaiting: 0, progress: 1, checks: 2, review: 3 };
    // What waits for the human first, the longest waiting first; then the rest by stage.
    tickets.sort((a, b) => Number(b.waiting) - Number(a.waiting) || order[a.column] - order[b.column]
      || (a.since ?? '~').localeCompare(b.since ?? '~') || a.id.localeCompare(b.id, 'en', { numeric: true }));
    const guarded = Boolean(section(conf, 'merge').tooling_paths && section(conf, 'merge').tooling_paths !== 'none');
    const { landed, firstTimeClean } = landedOf();
    for (const ticket of tickets) {
      const d = await detail(ticket.id);
      if (!d) throw new Error('A listed ticket disappeared during collection');
      details[ticket.id] = d;
      if (ticket.waiting && ticket.kind === 'ready' && d.show.kind === 'screen') {
        ticket.captures = { before: d.show.before[0]?.url, after: d.show.after[0]?.url };
        if (!ticket.captures.before || !ticket.captures.after) ticket.captures = null;
      }
    }
    const generatedAt = new Date(now()).toISOString();
    const currentHealth = health();
    currentHealth.problems = currentHealth.problems.filter((p) => !['wake_late', 'wake_missing', 'wake_failed'].includes(p.code));
    currentHealth.ok = currentHealth.problems.length === 0;
    currentHealth.recordedAt = generatedAt;
    cache.value = { schema: 1, project, projects: [{ id: project, name: project }], language, generatedAt,
      owner: { name: scrub(section(conf, 'owner').name, 60) }, stats: { inFlight: tickets.filter((x) => x.live).length, firstTimeClean }, landed,
      health: currentHealth, fuel: cache.slow.fuel, tickets, details,
      mode: { key: guarded ? 'guarded-tooling' : 'guarded', short: message('app_srv_mode_short', language), label: message(guarded ? 'app_srv_mode_tooling' : 'app_srv_mode_guarded', language) } };
    cache.at = now();
    return cache.value;

  }

  return {
    async snapshot() {
      if (cache.value) return cache.value;
      if (cache.pending) return cache.pending;
      cache.pending = build().finally(() => { cache.pending = null; });
      return cache.pending;
    },
    async ticket(id) { return detail(id); },
    media,
  };

  // The captures the team set apart for the user ([lanes] kept_in/<ticket>/,
  // kept by flow-lanes.sh when its worktree closes): PNG or JPEG files only,
  // no link followed, a few at most. Their folder never reaches the snapshot.
  function keptFolder() {
    const value = section(conf, 'lanes').kept_in;
    if (!value) return null;
    const path = expandHome(value);
    return isAbsolute(path) ? path : join(projectDir(), path);
  }
  function keptImages(ref) {
    const root = keptFolder();
    if (!root || !/^[A-Za-z0-9._-]{1,40}$/.test(ref) || /^\.+$/.test(ref)) return [];
    const found = [];
    const walk = (dir, depth) => {
      let names;
      try { names = readdirSync(dir).sort(); } catch { return; }
      for (const name of names) {
        if (found.length >= 8) return;
        const path = join(dir, name);
        let stat;
        try { stat = lstatSync(path); } catch { continue; }
        if (stat.isDirectory() && depth === 0) walk(path, 1);
        else if (stat.isFile() && /\.(?:png|jpe?g)$/i.test(name) && stat.size <= 5_000_000) found.push({ path, name });
      }
    };
    walk(join(root, ref), 0);
    const out = [];
    for (const file of found) {
      let bytes;
      try { bytes = readFileSync(file.path); } catch { continue; }
      const mime = imageType(bytes);
      if (!mime) continue;
      const digest = createHash('sha256').update(bytes).digest('hex');
      media.set(digest, { mime, body: bytes });
      out.push({ digest, text: file.name.replace(/\.[^.]+$/, '').replace(/[-_.]+/g, ' ').trim() });
    }
    return out;
  }

  async function detail(id) {
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(id)) return null;
      const ref = tracker.adapter === 'local' && /^\d+$/.test(id) ? `LOCAL-${id}` : id;
      const t = issues().getTicket(ref);
      if (!t || ![states.progress, states.review, states.validate, states.go].includes(t.status ?? t.state)) return null;
      const runs = runsOf(ref);
      const c = card(t);
      const report = reportOf(ref);
      const comments = commentsByTicket.has(ref) ? commentsByTicket.get(ref) : issues().comments(ref);
      commentsByTicket.set(ref, comments);
      // The request for agreement the release broker posted (never a comment of the owner's own).
      const request = c.kind === 'ready' ? [...comments].reverse().find((x) => !x.byOwner && /agree|approve|approval|accord/i.test(x.body ?? '')) ?? null : null;
      const where = request ? sentences(request.body) : [];
      const seen = new Set();
      const squad = runs.map((r) => ({ role: roleName(r.role), harness: scrub(r.provider, 40), model: scrub(r.model || r.requested_model, 60) }))
        .filter((s) => s.model && !seen.has(`${s.role}/${s.model}`) && seen.add(`${s.role}/${s.model}`));
      const posted = await cachedImages(comments, tracker.adapter, issues(), db(), media);
      const images = [...posted, ...keptImages(ref).filter((k) => !posted.some((p) => p.digest === k.digest))].slice(0, 8);
      const told = `${report?.body ?? ''}\n${request?.body ?? ''}`;
      const example = exampleOf(told);
      const side = (before) => images.filter((i) => /before|avant/i.test(i.text) === before)
        .map((i) => ({ url: `/media/${i.digest}`, caption: scrub(i.text, 80) || (before ? 'Before' : 'After') }));
      // A screen ticket without a capture says so, and why when it is known.
      const missing = images.length ? null : c.live ? 'working' : keptFolder() ? 'none_kept' : 'not_kept';
      const show = images.length || c.screen
        ? { kind: 'screen', before: side(true), after: side(false), missing, example }
        : { kind: 'code', example, tests: testsOf(report?.body ?? ''), touches: '' };
      const kept = handoverAt(ref);
      const blackBox = [
        ...runs.map((r) => ({ at: isoTime(r.started_at), kind: r.role === 'review' ? 'review' : 'run', text: describeRun(r, language), stage: r.role === 'review' ? 'review' : 'progress', raw: { kind: 'run', role: scrub(r.role, 20), outcome: scrub(r.outcome, 40), at: isoTime(r.started_at) } })),
        ...eventsOf(ref).map((e) => {
          const kind = EVENT_KINDS.includes(e.kind) ? e.kind : 'other';
          return { at: isoTime(e.at), kind, text: describeEvent({ kind }, language), stage: stageOf(kind), raw: { kind, at: isoTime(e.at) } };
        }),
        ...(kept ? [{ at: kept, kind: 'handover', text: message('app_srv_handover_kept', language), stage: 'progress', raw: { kind: 'handover', at: kept } }] : []),
      ].sort((a, b) => a.at.localeCompare(b.at));
      return { id, title: scrub(t.title, 160), pr: c.pr, column: c.column, kind: c.kind, waiting: c.waiting, since: c.since,
        flightMinutes: c.flightMinutes, quotaShare: c.quotaShare, tests: c.tests, questions: c.questions, change: c.change,
        report: report ? { at: report.at, done: report.sections.done, remaining: report.sections.remaining, other: hasSections(report.sections) ? [] : report.sections.other } : null,
        where, squad, show, blackBox };
    }

}

// The request posts its captures in the text: **Caption** then ![Caption](local://capture/<digest>).
function imagesOf(comments) {
  return comments.flatMap((c) => [
    ...(c.images ?? []).map((url) => ({ url, text: c.body ?? '' })),
    ...[...String(c.body ?? '').matchAll(/(?:\*\*([^*\n]{1,80})\*\*\s*)?!\[([^\]\n]{0,80})\]\(([^)\s]+)\)/g)]
      .map((m) => ({ url: m[3], text: m[1] || m[2] || '' })),
  ]).filter((i) => /^local:\/\/capture\/[a-f0-9]{64}$/.test(i.url) || /^https:\/\//.test(i.url))
    .filter((i, n, all) => all.findIndex((o) => o.url === i.url) === n);
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

const imageType = (bytes) => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? 'image/png'
  : bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) ? 'image/jpeg' : null;
async function cachedImages(comments, adapter, trackerClient, db, media) {
  const output = [];
  for (const image of imagesOf(comments)) {
    let bytes, mime;
    if (image.url.startsWith('local://')) {
      const digest = image.url.slice('local://capture/'.length);
      const row = db.prepare('SELECT mime, body FROM tracker_images WHERE digest = ?').get(digest);
      if (!row) throw new Error('Local capture is missing');
      bytes = Buffer.from(row.body); mime = imageType(bytes);
    } else {
      bytes = await remoteCapture(trackerClient, adapter, image.url); mime = imageType(bytes);
    }
    if (!mime || bytes.length > 5_000_000) throw new Error('Capture is not a supported image');
    const digest = createHash('sha256').update(bytes).digest('hex');
    media.set(digest, { mime, body: bytes });
    output.push({ digest, text: image.text });
  }
  return output;
}

export async function writeBoardSnapshot({ collector = boardCollector(), dir = stateDir() } = {}) {
  const snapshot = await collector.snapshot();
  if (snapshot.schema !== 1 || !Array.isArray(snapshot.tickets) || !snapshot.details) throw new Error('Incomplete board snapshot');
  const cache = join(dir, 'snapshot-captures');
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  for (const [digest, image] of collector.media) {
    const path = join(cache, digest);
    const temp = `${path}.${process.pid}.tmp`;
    try { writeFileSync(temp, image.body, { mode: 0o600 }); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
  const path = join(dir, 'snapshot.json');
  const temp = `${path}.${process.pid}.tmp`;
  try { writeFileSync(temp, JSON.stringify(snapshot), { mode: 0o600 }); renameSync(temp, path); }
  finally { rmSync(temp, { force: true }); }
  return snapshot;
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  writeBoardSnapshot().catch((error) => { console.error(`board snapshot: ${error.message}`); process.exitCode = 1; });
}
