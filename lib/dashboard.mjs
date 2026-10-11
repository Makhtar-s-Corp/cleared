#!/usr/bin/env node
// Renders the dashboard from the ledger: one static page, one column, no
// script. Every figure is a SQL result or a value read by dashboard.sh.
//
//   dashboard.mjs <inputs.json>  > index.html
import { readFileSync } from 'node:fs';
import { loadConf, runAsCommand, section } from './conf.mjs';
import { message } from './i18n.mjs';
import { openLedger } from './ledger.mjs';

const WINDOW_DAYS = 7;
let dashboardLanguage = 'en';
const t = (key, values) => message(`dashboard_${key}`, dashboardLanguage, values);
const locale = () => dashboardLanguage === 'fr' ? 'fr-FR' : 'en-US';

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const number = (n, digits = 0) => new Intl.NumberFormat(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(n);
const euros = (n) => (n == null ? '—' : `${number(n, n < 100 ? 2 : 0)} €`);
function tokens(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${number(n / 1e6, 1)} M`;
  if (n >= 1e3) return `${number(n / 1e3, 0)} k`;
  return number(n);
}
function duration(minutes) {
  if (minutes == null) return '—';
  if (minutes < 1) return t('under_minute');
  if (minutes < 90) return `${number(minutes, minutes < 10 ? 1 : 0)} min`;
  return `${number(minutes / 60, 1)} h`;
}
function ago(iso, nowMs) {
  const minutes = (nowMs - new Date(iso)) / 60000;
  if (minutes < 60) return t('ago_minutes', { count: Math.max(1, Math.round(minutes)) });
  if (minutes < 48 * 60) return t('ago_hours', { count: Math.round(minutes / 60) });
  return t('ago_days', { count: Math.round(minutes / 1440) });
}
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const plural = (n, one, many) => `${number(n)} ${n > 1 ? many : one}`;

export function collect(db, conf, inputs, nowMs = Date.now()) {
  const since = new Date(nowMs - WINDOW_DAYS * 86400e3).toISOString();
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const aliasOf = (model) => Object.values(conf.models).find((m) => m.model === model)?.alias ?? model ?? message('dashboard_unknown', section(conf, 'owner').language);

  const merged = one(`WITH merged AS (SELECT DISTINCT ticket FROM runs WHERE source = 'dispatcher' AND ticket IS NOT NULL AND outcome = 'merged' AND started_at >= ?)
    SELECT (SELECT count(*) FROM merged) AS tickets,
           (SELECT sum(cost_eur) FROM runs WHERE source = 'dispatcher' AND ticket IN (SELECT ticket FROM merged)) AS cost`, since);
  const legacy = one("SELECT sum(cost_eur) AS cost, count(*) AS runs FROM runs WHERE source = 'legacy' AND started_at >= ?", since);
  const idle = one("SELECT coalesce(sum(tokens_total), 0) AS tokens, count(*) AS wakes FROM runs WHERE source = 'dispatcher' AND outcome = 'idle' AND started_at >= ?", since);
  const skipped = one("SELECT count(*) AS n FROM events WHERE kind = 'wake_skipped' AND at >= ?", since).n;
  const legacyIdle = one("SELECT coalesce(sum(tokens_total), 0) AS tokens, count(*) AS wakes FROM runs WHERE source = 'legacy' AND outcome = 'idle' AND started_at >= ?", since);
  const delays = all("SELECT value, source FROM events WHERE kind = 'comment_handled' AND at >= ?", since);
  const ours = delays.filter((d) => d.source === 'dispatcher').map((d) => d.value);
  const theirs = delays.filter((d) => d.source !== 'dispatcher').map((d) => d.value);

  const byModel = all(`SELECT coalesce(project, 'No project') AS project, model, count(*) AS runs, sum(cost_eur) AS cost,
      sum(cost_eur IS NULL AND outcome != 'refused') AS unpriced,
      sum(outcome = 'returned' OR human_decision = 'returned') AS returned, sum(outcome = 'reverted') AS reverted
    FROM runs WHERE source = 'dispatcher' AND started_at >= ? AND outcome != 'running' GROUP BY 1, 2 ORDER BY 1, cost DESC`, since)
    .map((row) => ({ ...row, model: aliasOf(row.model) }));
  const legacyByModel = all(`SELECT role, model, count(*) AS runs, sum(cost_eur) AS cost FROM runs
    WHERE source = 'legacy' AND started_at >= ? GROUP BY 1, 2 ORDER BY 1, cost DESC`, since)
    .map((row) => ({ ...row, model: aliasOf(row.model) }));

  const warnDays = Number(section(conf, 'dashboard').warn_days || 10);
  const subscriptions = Object.entries(section(conf, 'subscriptions')).map(([name, end]) => {
    if (!end) return { name, end: null };
    if (end === 'ongoing') return { name, end, ongoing: true };
    const daysLeft = Math.ceil((new Date(`${end}T23:59:59Z`) - nowMs) / 86400e3);
    return { name, end, daysLeft, state: daysLeft < 0 ? 'critical' : daysLeft <= warnDays ? 'warning' : 'good' };
  });

  return {
    since,
    merged: { tickets: merged.tickets, perTicket: merged.tickets ? (merged.cost ?? 0) / merged.tickets : null },
    legacy: { cost: legacy.cost, runs: legacy.runs, mergedPrs: inputs.merged_prs_7d, perPr: legacy.cost != null && inputs.merged_prs_7d ? legacy.cost / inputs.merged_prs_7d : null },
    idle: { ...idle, skipped },
    legacyIdle,
    delay: { ours: median(ours), oursCount: ours.length, theirs: median(theirs), theirsCount: theirs.length },
    lanes: { open: inputs.lanes.length, max: inputs.max_lanes, names: inputs.lanes, worktrees: inputs.worktrees },
    byModel,
    legacyByModel,
    waiting: inputs.waiting,
    // The outages of GitHub explain the holes: nothing could be sent, checked or merged meanwhile.
    outages: all("SELECT at, value, detail FROM events WHERE kind = 'github_down' AND at >= ? ORDER BY at DESC", since)
      .map((row) => ({ at: row.at, minutes: row.value, detail: (row.detail ?? '').replace(/^from \S+ to \S+: /, '') })),
    githubDownSince: inputs.github_down_since ?? null,
    subscriptions,
    // Where each subscription stands, as its sessions said it (lib/limits.mjs).
    limits: inputs.limits ?? [],
    cli: inputs.cli ?? null,
    host: {
      load: inputs.load, cores: inputs.cores,
      swapUsed: (inputs.swap_total_kb - inputs.swap_free_kb) / 1048576, swapTotal: inputs.swap_total_kb / 1048576,
      memAvailable: inputs.mem_available_kb / 1048576, memTotal: inputs.mem_total_kb / 1048576,
    },
  };
}

const STATUS = { good: ['✓', 'status_good'], warning: ['!', 'status_warning'], critical: ['✕', 'status_critical'] };
const badge = (state, label) => `<span class="badge ${state}"><span aria-hidden="true">${STATUS[state][0]}</span> ${esc(label ?? t(STATUS[state][1]))}</span>`;

function tile(label, value, lines) {
  return `<div class="tile"><p class="label">${esc(label)}</p><p class="value">${value}</p>${lines.filter(Boolean).map((line) => `<p class="sub">${line}</p>`).join('')}</div>`;
}

export function render(data, conf, nowMs = Date.now()) {
  dashboardLanguage = section(conf, 'owner').language || 'en';
  const zone = section(conf, 'dashboard');
  const when = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: zone.timezone || 'UTC' }).format(nowMs);
  const { merged, legacy, idle, legacyIdle, delay, lanes, host } = data;
  const local = (options) => (iso) => new Intl.DateTimeFormat(locale(), { ...options, timeZone: zone.timezone || 'UTC' }).format(new Date(iso));
  const clock = local({ hour: '2-digit', minute: '2-digit' });
  const day = local({ day: 'numeric', month: 'long' });

  const tiles = [
    tile(t('cost_tile'), merged.perTicket == null ? '—' : esc(euros(merged.perTicket)), [
      merged.tickets ? esc(t('merged_count', { count: plural(merged.tickets, t('merged_one'), t('merged_many')) })) : t('merged_none'),
      legacy.perPr == null
        ? t('legacy_unmeasurable')
        : esc(t('legacy_cost', { per_pr: euros(legacy.perPr), count: number(legacy.mergedPrs), total: euros(legacy.cost) })),
    ]),
    tile(t('idle_tile'), esc(tokens(idle.tokens)), [
      esc(t('idle_summary', { wakes: plural(idle.wakes, t('wake_one'), t('wake_many')), skipped: plural(idle.skipped, t('skipped_one'), t('skipped_many')) })),
      esc(t('legacy_idle', { tokens: tokens(legacyIdle.tokens), wakes: plural(legacyIdle.wakes, t('wake_one'), t('wake_many')) })),
    ]),
    tile(t('delay_tile'), esc(duration(delay.ours)), [
      delay.oursCount ? esc(t('delay_median', { count: plural(delay.oursCount, t('comment_one'), t('comment_many')) })) : t('delay_none'),
      delay.theirsCount ? esc(t('legacy_delay', { duration: duration(delay.theirs), count: plural(delay.theirsCount, t('comment_one'), t('comment_many')) })) : t('legacy_delay_none'),
    ]),
    tile(t('lanes_tile'), `${number(lanes.open)} <span class="of">${esc(t('lanes_of', { count: number(lanes.max) }))}</span>`, [
      `<span class="meter" role="img" aria-label="${esc(t('lanes_aria', { open: number(lanes.open), max: number(lanes.max) }))}"><span class="${lanes.open >= lanes.max ? 'full' : ''}" style="width:${Math.min(100, (lanes.open / Math.max(lanes.max, 1)) * 100)}%"></span></span>`,
      lanes.open ? esc(lanes.names.join(', ')) : t('lanes_none'),
      esc(t('worktrees_summary', { count: plural(lanes.worktrees, t('worktree_one'), t('worktree_many')) })),
    ]),
  ].join('');

  let modelRows = '';
  let project = null;
  for (const row of data.byModel) {
    if (row.project !== project) {
      project = row.project;
      modelRows += `<tr class="group"><th colspan="5" scope="colgroup">${esc(project === 'No project' ? t('no_project') : project)}</th></tr>`;
    }
    const cost = row.cost == null ? (row.unpriced ? t('plan') : '—') : euros(row.cost);
    modelRows += `<tr><th scope="row">${esc(row.model)}</th><td>${number(row.runs)}</td><td>${esc(cost)}</td><td>${number(row.returned)}</td><td>${number(row.reverted)}</td></tr>`;
  }
  if (!modelRows) modelRows = `<tr><td colspan="5" class="empty">${esc(t('no_runs'))}</td></tr>`;
  const legacyRows = data.legacyByModel.map((row) => `<tr><th scope="row">${esc(row.role === 'chef-de-projet' ? t('lead') : t('teams'))} · ${esc(row.model)}</th><td>${number(row.runs)}</td><td>${esc(euros(row.cost))}</td></tr>`).join('')
    || `<tr><td colspan="3" class="empty">${esc(t('no_legacy'))}</td></tr>`;

  const waiting = data.waiting == null
    ? `<p class="empty">${esc(t('tracker_down'))}</p>`
    : data.waiting.length
      ? `<ul class="list">${data.waiting.map((item) => `<li><a href="${esc(item.url)}"><span class="id">${esc(item.identifier)}</span> ${esc(item.title)}</a><span class="sub">${esc(ago(item.since, nowMs))}</span></li>`).join('')}</ul>`
      : `<p class="empty">${esc(t('waiting_none'))}</p>`;

  // The share of each window used, what the day took, the pace, and when the window starts over.
  const windowName = { seven_day: t('week_window'), five_hour: t('five_hour_window') };
  const startsOver = (iso) => new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const limits = (data.limits ?? []).flatMap((one) => Object.entries(one.windows).map(([name, window]) => {
    const state = window.stopped ? 'critical' : one.stop != null && window.used >= one.stop - 10 ? 'warning' : 'good';
    const parts = [t('window_of', { name: windowName[name] ?? t('other_window', { name }) })];
    if (window.today > 0) parts.push(t('points_today', { count: plural(window.today, t('point_one'), t('point_many')) }));
    if (window.pace > 0) parts.push(t('pace', { count: number(window.pace, window.pace % 1 ? 1 : 0), unit: window.pace >= 2 ? t('point_many') : t('point_one') }));
    if (window.stopped) parts.push(t('limit_stopped', { stop: one.stop }));
    else if (window.hours_to_stop != null) parts.push(t('limit_soon', { stop: one.stop, stop_hours: window.hours_to_stop, full_hours: window.hours_to_full }));
    parts.push(t('resets', { date: startsOver(window.resets_at) }));
    return `<li><span class="name">${esc(one.adapter)}</span>${badge(state, `${window.used} %`)}<span class="sub">${esc(parts.join(' · '))}</span></li>`;
  })).join('');
  const subscriptions = data.subscriptions.map((sub) => {
    if (!sub.end) return `<li><span class="name">${esc(sub.name)}</span><span class="sub">${esc(t('subscription_missing'))}</span></li>`;
    if (sub.ongoing) return `<li><span class="name">${esc(sub.name)}</span>${badge('good', t('ongoing'))}<span class="sub">${esc(t('no_end'))}</span></li>`;
    const label = sub.daysLeft < 0 ? t('ended') : sub.daysLeft === 0 ? t('ends_today') : plural(sub.daysLeft, t('day_left_one'), t('day_left_many'));
    const end = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${sub.end}T12:00:00Z`));
    return `<li><span class="name">${esc(sub.name)}</span>${badge(sub.state, label)}<span class="sub">${esc(t('until', { date: end }))}</span></li>`;
  }).join('');

  const cli = data.cli == null
    ? `<li><span class="sub">${esc(t('cli_unchecked'))}</span></li>`
    : data.cli.versions.map((tool) => {
      if (tool.installed == null) return `<li><span class="name">${esc(tool.cli)}</span><span class="sub">${esc(t('version_unreadable'))}</span></li>`;
      if (tool.days_behind == null) return `<li><span class="name">${esc(tool.cli)}</span><span class="sub">${esc(t('latest_unknown', { installed: tool.installed }))}</span></li>`;
      const late = tool.days_behind > data.cli.max_days_behind;
      const label = tool.days_behind === 0 ? t('current') : t('behind', { days: plural(tool.days_behind, t('day_one'), t('day_many')) });
      return `<li><span class="name">${esc(tool.cli)}</span>${badge(late ? 'warning' : 'good', label)}<span class="sub">${esc(tool.installed)}${tool.latest !== tool.installed ? esc(t('latest', { version: tool.latest })) : ''}</span></li>`;
    }).join('');

  const loadRatio = host.load / host.cores;
  const swapRatio = host.swapTotal ? host.swapUsed / host.swapTotal : 0;
  const state = (ratio, warn, critical) => (ratio >= critical ? 'critical' : ratio >= warn ? 'warning' : 'good');
  const health = [
    `<li><span class="name">${esc(t('load'))}</span>${badge(state(loadRatio, 0.7, 1))}<span class="sub">${esc(t('load_detail', { load: number(host.load, 1), cores: number(host.cores) }))}</span></li>`,
    `<li><span class="name">Swap</span>${badge(state(swapRatio, 0.5, 0.9))}<span class="sub">${esc(t('swap_detail', { used: number(host.swapUsed, 1), total: number(host.swapTotal, 1) }))}</span></li>`,
    `<li><span class="name">${esc(t('memory'))}</span>${badge(state(1 - host.memAvailable / host.memTotal, 0.8, 0.92))}<span class="sub">${esc(t('memory_detail', { available: number(host.memAvailable, 1), total: number(host.memTotal, 0) }))}</span></li>`,
  ].join('')
    + (data.githubDownSince ? `<li><span class="name">GitHub</span>${badge('critical', t('down'))}<span class="sub">${esc(t('github_down', { time: clock(data.githubDownSince) }))}</span></li>` : '')
    + (data.outages ?? []).map((outage) => `<li><span class="name">${esc(t('outage_title', { date: day(outage.at) }))}</span><span class="sub">${esc(t('outage_detail', { time: clock(outage.at), minutes: number(outage.minutes), detail: outage.detail }))}</span></li>`).join('');

  return `<!doctype html>
<html lang="${esc(dashboardLanguage)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Cleared</title>
<style>
:root { --surface: #fcfcfb; --raised: #ffffff; --line: #e4e3df; --ink: #0b0b0b; --ink-2: #52514e; --accent: #2a5fc4;
  --good: #0ca30c; --warning: #fab219; --critical: #d03b3b; color-scheme: light dark; }
@media (prefers-color-scheme: dark) {
  :root { --surface: #1a1a19; --raised: #232322; --line: #3a3936; --ink: #ffffff; --ink-2: #c3c2b7; --accent: #7fa8f5; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface); color: var(--ink); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 20px 16px 40px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 15px; margin: 32px 0 10px; }
p { margin: 0; }
.stamp, .sub, .note { color: var(--ink-2); font-size: 13px; }
.tile { background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-top: 12px; }
.tile .label { font-size: 13px; color: var(--ink-2); }
.tile .value { font-size: 34px; font-weight: 600; line-height: 1.2; font-variant-numeric: tabular-nums; margin: 2px 0 6px; }
.tile .value .of { font-size: 16px; font-weight: 400; color: var(--ink-2); }
.tile .sub + .sub { margin-top: 2px; }
.meter { display: block; height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; margin: 2px 0 6px; }
.meter span { display: block; height: 100%; background: var(--accent); border-radius: 3px; }
.meter span.full { background: var(--critical); }
table { width: 100%; border-collapse: collapse; font-size: 13px; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 4px; border-bottom: 1px solid var(--line); text-align: right; vertical-align: top; font-weight: 400; }
th:first-child, td:first-child { text-align: left; padding-left: 0; }
thead th { color: var(--ink-2); font-size: 12px; }
tr.group th { text-align: left; font-weight: 600; padding-top: 14px; }
.empty { color: var(--ink-2); font-size: 14px; text-align: left; }
.list { list-style: none; margin: 0; padding: 0; }
.list li { padding: 10px 0; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 2px 10px; align-items: baseline; }
.list a { color: var(--ink); text-decoration: underline; text-decoration-color: var(--line); text-underline-offset: 3px; flex: 1 1 100%; overflow-wrap: anywhere; }
.list .id { color: var(--accent); font-weight: 600; white-space: nowrap; }
.list .name { font-weight: 600; text-transform: capitalize; min-width: 76px; }
.badge { font-size: 13px; white-space: nowrap; }
.badge span { display: inline-block; width: 18px; height: 18px; line-height: 18px; text-align: center; border-radius: 9px; font-size: 12px; font-weight: 700; color: #0b0b0b; }
.badge.good span { background: var(--good); color: #fff; }
.badge.warning span { background: var(--warning); }
.badge.critical span { background: var(--critical); color: #fff; }
code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; }
.note { margin-top: 28px; border-top: 1px solid var(--line); padding-top: 12px; }
</style>
</head>
<body>
<main>
<h1>Cleared</h1>
<p class="stamp">${esc(t('stamp', { when, zone: zone.timezone_label || 'UTC', days: WINDOW_DAYS }))}</p>

${tiles}

<h2>${esc(t('models_title', { days: WINDOW_DAYS }))}</h2>
<table>
<thead><tr><th scope="col">${esc(t('model'))}</th><th scope="col">${esc(t('runs'))}</th><th scope="col">${esc(t('cost'))}</th><th scope="col">${esc(t('returned'))}</th><th scope="col">${esc(t('reverts'))}</th></tr></thead>
<tbody>${modelRows}</tbody>
</table>

<h2>${esc(t('legacy_title', { days: WINDOW_DAYS }))}</h2>
<table>
<thead><tr><th scope="col">${esc(t('legacy_sessions'))}</th><th scope="col">${esc(t('wakes'))}</th><th scope="col">${esc(t('cost'))}</th></tr></thead>
<tbody>${legacyRows}</tbody>
</table>

<h2>${esc(t('waiting_title'))}</h2>
${waiting}

<h2>${esc(t('subscriptions'))}</h2>
<ul class="list">${subscriptions}${limits}</ul>

<h2>${esc(t('cli_title'))}</h2>
<ul class="list">${cli}</ul>

<h2>${esc(t('health'))}</h2>
<ul class="list">${health}</ul>

<p class="note">${esc(t('note'))}</p>
</main>
</body>
</html>
`;
}

if (runAsCommand(import.meta.url)) {
  const inputs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const conf = loadConf();
  const db = openLedger();
  process.stdout.write(render(collect(db, conf, inputs), conf));
  db.close();
}
