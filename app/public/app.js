// The Cockpit page. Everything from the server is put on the page as text
// (never as HTML), and nothing is fetched from another site.
import { initActions } from '/actions.js';
import { initNotify } from '/notify.js';
let M = {};
const t = (key, values = {}) => (M[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const { dataset, ariaLabel, ariaCurrent, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  if (ariaLabel) node.setAttribute('aria-label', ariaLabel);
  if (ariaCurrent) node.setAttribute('aria-current', ariaCurrent);
  for (const kid of kids.flat(Infinity)) if (kid != null) node.append(kid);
  return node;
};
const fr = () => document.documentElement.lang === 'fr';
const locale = () => (fr() ? 'fr-FR' : 'en-US');
const clock = (iso) => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const when = (iso) => new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
const cap = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);
const dur = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`);
const pct = (n) => `${String(n).replace('.', fr() ? ',' : '.')}${fr() ? '\u202f' : ''}%`;
const num = (text, cls = '') => el('span', { className: `num ${cls}`.trim(), textContent: text });
// Geist Mono is for the identifiers of tickets and commits only.
const code = (text, cls = '') => el('span', { className: `code ${cls}`.trim(), textContent: text });
const plural = (key, n, values = {}) => t(`${key}_${n === 1 ? 'one' : 'other'}`, { n, ...values });
// "claude-opus-5-5" is said "Opus"; a model without a known family keeps its own name.
const MODELS = [[/opus/i, 'Opus'], [/sonnet/i, 'Sonnet'], [/haiku/i, 'Haiku'], [/fable/i, 'Fable']];
const modelName = (model) => MODELS.find(([re]) => re.test(model ?? ''))?.[1] ?? model ?? '';
const harnessClass = (h) => (['claude', 'codex'].includes(h) ? h : 'other');
const WORDS = { en: ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'], fr: ['', 'Une', 'Deux', 'Trois', 'Quatre', 'Cinq', 'Six', 'Sept', 'Huit', 'Neuf', 'Dix'] };
const word = (n) => (n >= 1 && n <= 10 ? WORDS[fr() ? 'fr' : 'en'][n] : String(n));

const COLUMNS = ['progress', 'checks', 'review', 'awaiting'];
const state = { snap: null, last: null, open: null, project: null, connected: false, opener: null, reason: 'link' };

function theme() {
  const saved = (() => { try { return localStorage.getItem('cleared-theme'); } catch { return null; } })();
  if (saved === 'dark') document.documentElement.dataset.theme = 'dark';
  syncThemeButton();
}
function syncThemeButton() { $('theme').textContent = document.documentElement.dataset.theme === 'dark' ? t('app_theme_light') : t('app_theme_dark'); }
$('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('cleared-theme', next); } catch { /* the choice is just not remembered */ }
  syncThemeButton();
});

// --- header, welcome sentence, counters --------------------------------------
// A state the owner chose on purpose is said plainly in amber, never as a fault in red.
const CHOSEN = ['release_lock_unseparated'];
function renderHeader(s) {
  const pr = $('project');
  const projects = s.projects ?? [];
  if (projects.length > 1) {
    const sel = el('select', { ariaLabel: t('app_project') }, ...projects.map((p) => el('option', { value: p.id, textContent: p.name, selected: p.id === (state.project ?? s.project) })));
    sel.addEventListener('change', () => { state.project = sel.value; });
    pr.replaceChildren(sel);
  } else pr.textContent = s.project;
  const problems = s.health.problems ?? [];
  const chosen = problems.filter((p) => CHOSEN.includes(p.code));
  const faults = problems.filter((p) => !CHOSEN.includes(p.code));
  const mode = $('mode');
  mode.hidden = !chosen.length;
  mode.replaceChildren(el('i'), chosen.map((p) => t(`app_mode_${p.code}`)).join(' · '));
  const h = $('health');
  h.hidden = s.health.ok || (!faults.length && chosen.length > 0);
  h.className = 'pill bad';
  h.replaceChildren(el('i'), faults.map((p) => p.message).join(' · ') || t('app_health'));
  const name = s.owner?.name ?? '';
  $('avatar').hidden = !name;
  $('avatar').textContent = name ? [...name][0].toUpperCase() : '';
  // Places for what is not built yet: dimmed, not clickable, and said to be coming ("soon") in words for a screen reader and on the buttons.
  for (const n of document.querySelectorAll('.views [data-soon], .view-all')) n.replaceChildren(t(n.dataset.soon), el('span', { className: 'sr-only', textContent: ` ${t('app_soon')}` }));
}
function tickClock() {
  const at = state.snap?.generatedAt;
  $('health-age').textContent = at ? t('app_status_age', { age: ageText(at) }) : '';
}
function ageText(iso) {
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return sec < 90 ? t('app_age_s', { n: sec }) : sec < 5400 ? t('app_age_min', { n: Math.round(sec / 60) }) : t('app_age_h', { n: Math.round(sec / 3600) });
}
setInterval(tickClock, 5000);

// "One thing is waiting for you." and under it, in grey, the fuel left and what is under way.
function renderGreeting(s) {
  const waiting = s.tickets.filter((x) => x.waiting);
  const allReady = waiting.length > 0 && waiting.every((x) => x.kind === 'ready');
  const n = waiting.length;
  const one = n === 1 ? 'one' : 'other';
  $('greeting').textContent = n === 0 ? t('app_wait_none')
    : t(`app_wait_${allReady ? 'ready' : 'need'}_${one}_tone`, { n: word(n) }) + t(`app_wait_${allReady ? 'ready' : 'need'}_key_${one}`);
  const parts = s.fuel.filter((f) => f.measured).map((f) => t('app_sub_fuel', { name: cap(f.adapter), n: pct(f.left) }));
  const teams = ['progress', 'checks', 'review'].map((c) => [c, s.tickets.filter((x) => x.kind === 'normal' && x.column === c).length]).filter(([, count]) => count);
  parts.push(...(teams.length ? teams.map(([c, count]) => plural(`app_sub_${c}`, count)) : [t('app_sub_idle')]));
  const landed = todayLanded(s).length;
  parts.push(landed ? plural('app_sub_landed', landed) : t('app_sub_landed_none'));
  if (s.mode?.short) parts.push(s.mode.short);
  $('subline').textContent = parts.join(' · ');
}

const todayLanded = (s) => {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return (s.landed ?? []).filter((r) => Date.parse(r.at) >= start.getTime());
};
function renderStats(s) {
  const landed = todayLanded(s);
  const stat = (k, v, extra) => el('div', { className: 'stat', role: 'listitem' }, el('div', { className: 'k', textContent: k }), el('div', { className: 'v' }, v, extra ?? null));
  const fuel = el('div', { className: 'stat fuel', role: 'listitem' }, el('div', { className: 'k', textContent: t('app_stat_fuel') }),
    ...s.fuel.map((f) => {
      const bar = el('span', { className: `h-${harnessClass(f.adapter)}` });
      bar.style.width = f.measured ? `${f.left}%` : '0';
      return el('div', { className: 'fuelrow' }, el('span', { className: 'n', textContent: f.adapter }),
        el('span', { className: 'bar6', role: 'img', ariaLabel: f.measured ? `${f.adapter} ${f.left}%` : `${f.adapter} ${t('app_not_measured')}` }, bar),
        f.measured ? num(pct(f.left), 'p') : el('span', { className: 'p faint', textContent: t('app_not_measured') }));
    }));
  // One line: the median time from Todo to Done over the last seven days, by lane.
  const lanes = s.stats?.lanes;
  const median = (m) => (Number.isFinite(m) ? dur(Math.round(m)) : '–');
  const medianLine = lanes ? el('div', { className: 'stat median', role: 'listitem' }, el('div', { className: 'k', textContent: t('app_stat_median') }),
    el('div', { className: 'lanes' }, `${t('app_lane_fast')} `, num(median(lanes.fast?.minutes)), ` · ${t('app_lane_full')} `, num(median(lanes.full?.minutes)))) : null;
  $('stats').replaceChildren(stat(t('app_stat_flight'), String(s.stats?.inFlight ?? 0)), stat(t('app_stat_landed'), String(landed.length)),
    stat(t('app_stat_clean'), s.stats?.firstTimeClean == null ? '–' : String(s.stats.firstTimeClean), s.stats?.firstTimeClean == null ? null : el('small', { textContent: '%' })), ...(medianLine ? [medianLine] : []), fuel);
}

// --- tower -------------------------------------------------------------------
// The time something started waiting: the hour today, the day and hour before.
const since = (iso) => {
  const d = new Date(iso), today = new Date();
  return d.toDateString() === today.toDateString() ? clock(iso) : when(iso);
};
const SAYS_REC = /^(?:je recommande|nous recommandons|l['’]équipe recommande|je conseille|nous conseillons|ma recommandation|notre recommandation|recommandation|i recommend|we recommend|the team recommends|my recommendation|our recommendation|recommendation|recommended)\b/iu;
const leadOf = (text) => (/^[^?？]*[?？]/u.exec(text) ?? /^[\s\S]*?[!.](?=\s|$)/u.exec(text))?.[0]?.trim() ?? text;
// "PR #314 · 3 files · +12 −4 · checks green": what a pull request is, in one line. Unknown parts are said so.
function changeParts(c) {
  const parts = [];
  if (c.files !== null) parts.push(t(c.files === 1 ? 'app_pr_files_one' : 'app_pr_files', { n: c.files }));
  if (c.additions !== null && c.deletions !== null) parts.push(`+${c.additions} −${c.deletions}`);
  else if (c.lines !== null) parts.push(t('app_pr_lines', { n: c.lines }));
  if (!parts.length) parts.push(t('app_pr_size_unknown'));
  return parts;
}
const checksText = (c) => (c?.checks ? `${t('app_checks')} ${t(`app_checks_${c.checks}`)}` : `${t('app_checks')} ${t('app_not_measured')}`);
const checksClass = (c) => (c?.checks === 'green' ? 'success' : c?.checks === 'red' ? 'danger' : c?.checks === 'running' ? '' : 'faint');
const minutesSince = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
// A ticket card: what it asks of you or how it is doing, the title, then one line of state and its id.
function card(ticket) {
  const col = COLUMNS.indexOf(ticket.column);
  const parts = [];
  const asks = ticket.kind === 'ready' || ticket.kind === 'question';
  if (asks) {
    const what = t(ticket.kind === 'ready' ? 'app_card_ready' : 'app_chip_question');
    parts.push(el('p', { className: 'wait-line', textContent: ticket.since ? `${what} · ${t('app_card_since', { d: dur(minutesSince(ticket.since)) })}` : what }));
  } else if (ticket.kind === 'tracker') parts.push(el('p', { className: 'tag-line', textContent: t('app_tracker_hint') }));
  else if (ticket.kind === 'queued') parts.push(el('p', { className: 'tag-line', textContent: cap(t('app_queued_tag')) }));
  const questions = ticket.kind === 'question' ? ticket.questions ?? [] : [];
  if (questions.length) {
    // The question in full as the title (at least its first sentence, never cut), then what goes with it.
    const first = questions[0];
    const lead = leadOf(first.text);
    const rest = first.text.slice(lead.length).trim();
    parts.push(el('h3', { textContent: lead }));
    if (rest) parts.push(el('p', { className: 'q-rest', textContent: rest }));
    // "The team recommends" only when the team's own words do not already say it ("I recommend…").
    if (first.recommendation) parts.push(el('p', { className: 'q-rec' }, SAYS_REC.test(first.recommendation) ? null : el('b', { textContent: `${t('app_q_rec')} · ` }), first.recommendation));
    const more = questions.length - 1;
    if (more) parts.push(el('p', { className: 'q-meta', textContent: t(more === 1 ? 'app_q_more_one' : 'app_q_more', { n: more }) }));
    parts.push(el('p', { className: 'q-ticket', textContent: ticket.title }));
  } else parts.push(el('h3', { textContent: ticket.title }));
  const showRail = ticket.kind === 'normal' && col >= 0 && col < 3;
  if (showRail) parts.push(el('div', { className: 'rail' }, ...['progress', 'checks', 'review', null].map((stage, i) => el('span', { className: i <= col && stage ? `s-${stage}` : '' }))));
  // "Opus · 23 min · checks green" for a version to clear; for the others, the team's own sentence.
  const readyLine = ticket.kind === 'ready' ? [modelName(ticket.model), dur(ticket.flightMinutes), ticket.change?.checks ? `${t('app_checks')} ${t(`app_checks_${ticket.change.checks}`)}` : null].filter(Boolean).join(' · ') : null;
  const sentence = actions.noteFor(ticket.id) ?? readyLine
    ?? (ticket.kind === 'question' && questions.length ? null : cap(ticket.queued || ticket.kind === 'question' || ticket.kind === 'tracker' ? ticket.reason : ticket.statusLine));
  const status = ticket.kind === 'question' && questions.length ? el('span', {}, el('span', { className: 'open', textContent: t('app_q_open') }), questions[0].options.length ? ` · ${t('app_q_choices', { n: questions[0].options.length })}` : null) : sentence;
  parts.push(el('div', { className: 'foot' },
    status ? el('span', { className: 'status' }, ticket.live ? el('i', { className: 'live' }) : null, status) : null,
    code(ticket.id, 'id')));
  const btn = el('button', { type: 'button' }, parts);
  btn.addEventListener('click', () => openTicket(ticket.id));
  return el('li', { className: `card ${ticket.kind}`, dataset: { id: ticket.id } }, btn);
}
function renderTower(s) {
  // What waits for the human first, the longest waiting first. Only a ticket with a Cleared team has a column;
  // the tracker's other tickets are folded into one line under the board.
  const tickets = [...s.tickets].sort((a, b) => (b.waiting ? 1 : 0) - (a.waiting ? 1 : 0) || (a.waiting && b.waiting ? (a.since ?? '~').localeCompare(b.since ?? '~') : 0));
  const apart = tickets.filter((x) => x.kind === 'tracker');
  const mine = tickets.filter((x) => x.kind !== 'tracker');
  $('tower').replaceChildren(...COLUMNS.map((c) => {
    const here = mine.filter((x) => x.column === c);
    const shown = c === 'awaiting' ? here.filter((x) => x.waiting).length : here.length;
    return el('section', { className: 'col', dataset: { col: c } },
      el('div', { className: 'col-head' }, el('i', { className: `d-${c}` }), el('h2', { textContent: t(`app_col_${c}`) }), num(String(shown), 'n')),
      here.length ? el('ul', { className: 'cards' }, ...here.map(card)) : el('p', { className: 'empty', textContent: t(`app_empty_${c}`) }));
  }));
  $('fold').hidden = !apart.length;
  $('fold-summary').textContent = apart.length ? plural('app_fold', apart.length) : '';
  $('fold-list').replaceChildren(...apart.map(card));
}
function renderLanded(s) {
  const rows = todayLanded(s);
  const back = rows.filter((r) => r.rolledBackAt).length;
  // The share of the week is left out when it is not measured (too few tickets this week to mean anything).
  const measured = rows.every((r) => r.share != null);
  const share = Math.round(rows.reduce((n, r) => n + (r.share ?? 0), 0) * 10) / 10;
  $('landed-summary').textContent = rows.length
    ? (measured ? t(rows.length === 1 ? 'app_landed_summary_one' : 'app_landed_summary', { n: rows.length, r: back, p: String(share).replace('.', fr() ? ',' : '.') })
      : t(rows.length === 1 ? 'app_landed_summary_short_one' : 'app_landed_summary_short', { n: rows.length, r: back }))
    : '';
  const heads = ['time', 'what', 'model', 'out'].map((k) => el('span', { role: 'columnheader', textContent: t(`app_landed_col_${k}`) }));
  const lines = rows.map((r) => {
    const out = r.rolledBackAt ? ['danger', t('app_outcome_rolled', { time: clock(r.rolledBackAt) })]
      : r.fixes === 0 ? ['success', t('app_outcome_clean')] : ['success', r.fixes === 1 ? t('app_outcome_rounds_one') : t('app_outcome_rounds', { n: r.fixes })];
    // Its lane and where its time went, when the ledger measured it.
    const minutes = (m) => (Number.isFinite(m) ? dur(m) : '–');
    const measured = r.lane ? el('small', { className: 'lane', textContent: `${t(r.lane === 'fast' ? 'app_lane_fast' : 'app_lane_full')} · ${t('app_landed_times', { w: minutes(r.workingMin), h: minutes(r.humanWaitMin), m: minutes(r.machineWaitMin) })}` }) : null;
    return el('div', { role: 'row' }, el('div', { className: 'time', role: 'cell' }, el('time', { dateTime: r.at, textContent: clock(r.at) })), el('div', { className: 'what', role: 'cell' }, r.title, ...(measured ? [el('br'), measured] : [])),
      el('div', { className: 'model', role: 'cell', textContent: modelName(r.model) }), el('div', { className: 'out', role: 'cell' }, el('span', { className: out[0] }, el('i'), out[1])));
  });
  $('landed-rows').replaceChildren(...(lines.length ? [el('div', { role: 'row' }, heads), ...lines] : [el('p', { className: 'empty', textContent: t('app_landed_empty') })]));
}

// Redrawing keeps the keyboard where it was, and skips what did not change.
let shown = { top: '', tower: '', landed: '' };
function render(s) {
  state.snap = s;
  const top = JSON.stringify([s.projects, s.fuel, s.health, s.mode, s.owner, s.stats, s.tickets.map((x) => [x.waiting, x.kind, x.column])]);
  const tower = JSON.stringify([s.tickets, s.generatedAt]);
  const landed = JSON.stringify(s.landed);
  if (top !== shown.top) { shown.top = top; renderHeader(s); renderGreeting(s); renderStats(s); }
  if (landed !== shown.landed) { shown.landed = landed; renderLanded(s); renderGreeting(s); renderStats(s); }
  if (tower !== shown.tower) {
    shown.tower = tower;
    const focused = document.activeElement?.closest?.('.card')?.dataset.id;
    renderTower(s);
    if (focused) document.querySelector(`.card[data-id="${CSS.escape(focused)}"] button`)?.focus();
  }
  if (state.open) actions.mount(s.tickets.find((x) => x.id === state.open));
  tickClock();
}

// --- porthole ----------------------------------------------------------------
// Where the panel covers the page (a phone, a narrow window), what is behind it leaves the keyboard and the screen reader.
function setCovered(on) {
  const covers = matchMedia('(max-width: 767px)').matches; // only where the panel is a full page
  for (const sel of ['.top', '.page']) document.querySelector(sel).inert = on && covers;
}
async function openTicket(id) {
  const ph = $('porthole');
  state.opener = document.activeElement;
  state.open = id;
  ph.hidden = false;
  document.body.classList.add('has-ph');
  setCovered(true);
  $('ph-id').textContent = id;
  $('ph-chip').textContent = '';
  $('ph-body').replaceChildren(el('p', { textContent: '…' }));
  try {
    const r = await fetch(`/api/tickets/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('x');
    const d = await r.json();
    if (state.open !== id) return; // another ticket was opened meanwhile
    const chip = $('ph-chip');
    chip.className = `chip${d.kind === 'question' || d.kind === 'ready' ? ' wait' : ' stage'}`;
    chip.textContent = d.kind === 'ready' ? t('app_card_ready') : d.kind === 'question' ? t('app_chip_question') : d.kind === 'tracker' ? t('app_tracker_hint') : t(`app_col_${d.column}`);
    $('ph-body').replaceChildren(...porthole(d));
    await actions.load();
    if (state.open !== id) return;
    actions.mount(state.snap?.tickets.find((x) => x.id === id), { fresh: true });
    $('ph-close').focus();
  } catch { $('ph-body').replaceChildren(el('p', { className: 'danger', textContent: t('app_unavailable') })); }
}
function closeTicket() {
  actions.mount(null);
  $('porthole').hidden = true; document.body.classList.remove('has-ph'); setBig(false); state.open = null; setCovered(false);
  const back = state.opener?.isConnected ? state.opener : document.querySelector('.card button');
  back?.focus(); state.opener = null;
}
$('ph-close').addEventListener('click', closeTicket);
// The porthole opens small, beside the board; this button makes it large (the board stays behind it) and back.
function setBig(on) {
  // Behind the large porthole the board is hidden: it leaves the keyboard and the screen reader too.
  document.querySelector('.page').inert = on;
  document.querySelector('.top').inert = on && !matchMedia('(min-width: 1280px)').matches;
  $('porthole').classList.toggle('big', on);
  document.body.classList.toggle('ph-big', on);
  $('ph-expand').setAttribute('aria-pressed', String(on));
  $('ph-expand').setAttribute('aria-label', t(on ? 'app_ph_shrink' : 'app_ph_expand'));
}
$('ph-expand').addEventListener('click', () => setBig(!$('porthole').classList.contains('big')));
// The address a notification opens, /#ticket=EX-12: that ticket's porthole. The part after # never reaches the server.
function openFromAddress() {
  const match = /^#ticket=([A-Za-z0-9._-]{1,40})$/.exec(location.hash);
  if (!match) return;
  history.replaceState(null, '', location.pathname);
  openTicket(match[1]);
}
addEventListener('hashchange', openFromAddress);
// Something below the fold of the porthole: the action panel casts a shadow over it, so the panel never looks like the end.
function scrollCue() {
  const body = $('ph-body');
  $('porthole').classList.toggle('more-below', body.scrollHeight - body.clientHeight - body.scrollTop > 8);
}
$('ph-body').addEventListener('scroll', scrollCue, { passive: true });
new ResizeObserver(scrollCue).observe($('ph-body'));
new MutationObserver(scrollCue).observe($('porthole'), { childList: true, subtree: true });
const actions = initActions({ t, el, $, state, clock,
  redraw: () => { shown.tower = ''; if (state.snap) render(state.snap); },
  reopen: (id) => openTicket(id) });
function closeZoom() { $('zoom').hidden = true; state.zoomer?.focus(); }
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('zoom').hidden) closeZoom(); else if (!$('porthole').hidden) closeTicket(); }
  if (e.key === 'Tab' && !$('zoom').hidden) { e.preventDefault(); $('zoom-close').focus(); } // the enlarged capture holds the focus
});
$('zoom-close').addEventListener('click', closeZoom);

// A capture in its device frame: a click enlarges it. A side with no capture says so, in the same frame.
function device(img, after) {
  const label = t(after ? 'app_after' : 'app_before');
  if (!img) return el('figure', { className: after ? 'after' : 'before' }, el('div', { className: 'device blank' }, el('span', { textContent: t('app_no_shot') })), el('figcaption', { textContent: label }));
  const b = el('button', { type: 'button', className: 'device', ariaLabel: `${t('app_enlarge')}: ${img.caption}` }, el('img', { src: img.url, alt: img.caption }));
  b.title = img.caption;
  b.addEventListener('click', () => { state.zoomer = b; $('zoom').querySelector('img').src = img.url; $('zoom').querySelector('img').alt = img.caption; $('zoom').hidden = false; $('zoom-close').focus(); });
  return el('figure', { className: after ? 'after' : 'before' }, b, el('figcaption', { textContent: label }));
}
const section = (label, ...kids) => el('section', { className: 'sec' }, el('span', { className: 'label', textContent: label }), kids);

// The captures of a screen ticket, paired by position: before and after, side by side. A screen is named by its
// caption without the words before / after; without a name it is "Screen 2".
const sideWords = /\b(before|after|avant|apr[eè]s)\b/gi;
const screenName = (pair, i, many = true) => [pair.before, pair.after].map((x) => x?.caption?.replace(sideWords, '').replace(/^[\s:·\-–—/|]+|[\s:·\-–—/|]+$/g, '').trim()).find(Boolean) || (many ? t('app_screen_n', { n: i + 1 }) : t('app_changed'));
const distinct = (list) => new Set(list.map((p, i) => screenName(p, i))).size === list.length;
function shots(show) {
  const bare = (x) => x.caption.replace(sideWords, '').replace(/^[\s:·\-–—/|]+|[\s:·\-–—/|]+$/g, '').trim().toLowerCase();
  const names = [...show.before, ...show.after].map(bare);
  // By name when every capture names its screen and the names are unique on each side; otherwise by position.
  const named = names.every(Boolean) && new Set(show.before.map(bare)).size === show.before.length && new Set(show.after.map(bare)).size === show.after.length;
  const byName = named ? [...new Set(names)].map((n) => ({ before: show.before.find((x) => bare(x) === n) ?? null, after: show.after.find((x) => bare(x) === n) ?? null })) : null;
  const pairs = byName?.every((p) => p.before && p.after)
    ? byName
    : Array.from({ length: Math.max(show.before.length, show.after.length) }, (_, i) => ({ before: show.before[i] ?? null, after: show.after[i] ?? null }));
  // Two screens that would carry the same name are numbered instead.
  const label = (i) => (pairs.length > 1 && !distinct(pairs) ? t('app_screen_n', { n: i + 1 }) : screenName(pairs[i], i, pairs.length > 1));
  let at = 0, kind = 'phone';
  const root = el('section', { className: 'shots', dataset: { device: kind } });
  const name = el('span', { className: 'shots-name' });
  const stage = el('div', { className: 'pair' });
  const pick = (value, buttons, same) => { for (const b of buttons) b.setAttribute('aria-pressed', String(same(b, value))); };
  const kinds = ['phone', 'desktop'].map((k) => {
    const b = el('button', { type: 'button', textContent: t(`app_device_${k}`) });
    b.addEventListener('click', () => { kind = k; draw(); });
    b.dataset.kind = k;
    return b;
  });
  const pills = pairs.map((pair, i) => {
    const b = el('button', { type: 'button', textContent: label(i) });
    b.addEventListener('click', () => { at = i; draw(); });
    b.dataset.at = String(i);
    return b;
  });
  function draw() {
    root.dataset.device = kind;
    name.textContent = label(at);
    stage.replaceChildren(device(pairs[at].before, false), device(pairs[at].after, true));
    pick(kind, kinds, (b, v) => b.dataset.kind === v);
    pick(at, pills, (b, v) => Number(b.dataset.at) === v);
  }
  root.append(...[el('div', { className: 'shots-head' }, name, el('div', { className: 'seg', role: 'group', ariaLabel: t('app_device_label') }, kinds)), stage,
    pairs.length > 1 ? el('div', { className: 'pills', role: 'group', ariaLabel: t('app_screens_label') }, pills, el('span', { className: 'count', textContent: plural('app_cap_screens', pairs.length) })) : null].filter(Boolean));
  draw();
  return root;
}

// The question for a version to clear: one sentence, then what changes for the user, from the team's report
// (never its internal handover). Without a report, the page says so.
const sentences = (text) => text.replace(/\s*\((?:PR|pull request)\s*#?\d+\)/gi, '').match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [];
function impact(d) {
  const first = d.report?.done?.[0];
  if (!first) return null;
  const out = [];
  for (const sentence of sentences(first)) {
    if (out.length && out.join(' ').length + sentence.length > 260) break;
    out.push(sentence.trim());
    if (out.length === 2) break;
  }
  return out.join(' ') || null;
}
function ask(d) {
  const questions = d.kind === 'question' ? d.questions ?? [] : [];
  if (questions.length) {
    return el('section', { className: 'ph-question', ariaLabel: t(questions.length > 1 ? 'app_q_label_many' : 'app_q_label') },
      ...questions.map((q, i) => el('div', { className: 'q' },
        questions.length > 1 ? el('span', { className: 'q-n', textContent: t('app_q_number', { n: i + 1 }) }) : null,
        el('p', { className: 'q-text', textContent: q.text }),
        q.recommendation ? el('p', { className: 'q-rec' }, el('b', { textContent: t('app_q_rec') }), q.recommendation) : null,
        q.options.length ? el('ul', { className: 'q-options' }, ...q.options.map((o) => el('li', { textContent: o }))) : null)));
  }
  if (d.kind === 'ready') {
    const what = impact(d);
    return el('section', { className: 'ph-ask' }, el('p', { className: 'ask-q', textContent: t('app_ask_ready') }), el('p', { className: `ask-a${what ? '' : ' faint'}`, textContent: what ?? t('app_ask_none') }));
  }
  if (d.kind === 'tracker') return el('p', { className: 'box-card tracker-note', textContent: t('app_tracker_explain') });
  return null;
}

// Who wrote, who reviewed, how big the change is (with the link to the pull request), how long the team worked.
function facts(d, c) {
  const rows = [];
  const who = (role) => d.squad.find((x) => x.role === role);
  const team = [who('author') && t('app_wrote', { who: modelName(who('author').model) }), who('reviewer') && t('app_reviewed', { who: modelName(who('reviewer').model) })].filter(Boolean);
  if (team.length) rows.push([t('app_facts_team'), team.join(' · ')]);
  rows.push([t('app_facts_change'), c ? [`${changeParts(c).join(', ')} · `,
    c.pr.url ? el('a', { href: c.pr.url, rel: 'noreferrer noopener', target: '_blank', textContent: t('app_pr_short', { n: c.pr.number }) }) : t('app_pr_short', { n: c.pr.number }),
    c.draft ? el('span', { className: 'tag', textContent: t('app_pr_draft') }) : null] : t('app_no_pr')]);
  const checks = c?.checks ? [el('span', { className: checksClass(c), textContent: t(`app_checks_${c.checks}`) }), d.tests ? ` · ${t('app_srv_tests_green', { n: String(d.tests).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') })}` : null] : [t('app_not_measured')];
  rows.push([t('app_checks'), checks]);
  if (d.flightMinutes) rows.push([t('app_facts_work'), t('app_work_time', { d: dur(d.flightMinutes) })]);
  if (d.quotaShare != null) rows.push([cap(t('app_share_label')), pct(d.quotaShare)]);
  return el('dl', { className: 'facts' }, rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', {}, v)]));
}

// The porthole of one ticket, in this order: the title; the question asked of the human and what it changes for the
// user; the before / after pair; a few facts. The team's report, its squad and the black box are folded below.
function porthole(d) {
  const out = [];
  out.push(el('div', {}, d.waiting ? el('div', { className: 'amber-bar' }) : null, el('h2', { id: 'ph-title', textContent: d.title }),
    d.waiting && d.since ? el('p', { className: 'ph-since' }, el('time', { dateTime: d.since, textContent: `${t('app_since', { time: since(d.since) })} (${dur(minutesSince(d.since))})` })) : null));
  const asked = ask(d);
  if (asked) out.push(asked);
  const c = d.change ?? (d.pr ? { pr: d.pr, files: null, additions: null, deletions: null, lines: null, checks: null, draft: null } : null);
  // What changed: the captures of a screen, or one concrete example and the tests.
  if (d.show.kind === 'screen') {
    if (d.show.before.length || d.show.after.length) out.push(shots(d.show));
    else out.push(el('p', { className: 'no-capture', textContent: t(`app_no_capture_${d.show.missing ?? 'none_kept'}`) }));
  }
  const changed = [];
  const example = d.show.example;
  if (example) changed.push(el('div', { className: 'example box-card' }, el('p', {}, el('b', { textContent: `${t('app_before')}: ` }), example.before), el('p', {}, el('b', { textContent: `${t('app_after')}: ` }), example.after)));
  if (d.show.kind === 'code' && d.show.tests.length) changed.push(el('ul', { className: 'tests box-card' }, ...d.show.tests.map((x) => el('li', {}, x.name, ` · ${t(`app_test_${x.change}`)} · `, el('span', { className: x.state === 'pass' ? 'success' : x.state === 'fail' ? 'danger' : 'faint', textContent: t(`app_state_${x.state}`) })))));
  if (d.show.kind === 'code' && d.show.touches) changed.push(el('p', { textContent: d.show.touches }));
  if (changed.length) out.push(el('section', {}, el('h3', { className: 'sec-title', textContent: t('app_changed') }), changed));
  out.push(facts(d, c));

  // Folded: the team's report to the user (Done, Still to do), never its internal handover; the squad; the black box.
  const where = [];
  if (d.report) {
    where.push(el('p', { className: 'report-at faint', textContent: t('app_report_title', { time: since(d.report.at) }) }));
    const list = (label, items) => (items.length ? [el('h3', { className: 'report-h', textContent: label }), el('ul', { className: 'report' }, ...items.map((x) => el('li', { textContent: x })))] : []);
    where.push(...list(t('app_report_done'), d.report.done), ...list(t('app_report_remaining'), d.report.remaining));
    if (d.report.other?.length) where.push(el('ul', { className: 'report' }, ...d.report.other.map((x) => el('li', { textContent: x }))));
  } else where.push(el('p', { className: 'empty', textContent: t('app_no_report') }));
  out.push(el('details', { className: 'more' }, el('summary', { textContent: t('app_more') }),
    section(t('app_where'), where),
    section(t('app_squad'), d.squad.length
      ? el('ul', { className: 'squad' }, ...d.squad.map((x) => el('li', {}, el('span', { className: `sq ${harnessClass(x.harness)}` }), el('span', { className: 'role', textContent: t(`app_role_${x.role.replace(/ /g, '_')}`) }), el('span', { className: 'who', textContent: `${x.harness} · ${x.model}` }))))
      : el('p', { className: 'empty', textContent: t('app_no_squad') })),
    section(t('app_blackbox'), el('ol', { className: 'timeline' }, ...d.blackBox.map((e) =>
      el('li', { className: `st-${e.stage ?? 'progress'}` }, el('time', { dateTime: e.at, textContent: clock(e.at) }),
        el('details', {}, el('summary', { textContent: e.text }), el('pre', { textContent: JSON.stringify(e.raw, null, 2) }))))))));
  return out;
}

// --- live updates -----------------------------------------------------------
function connection(ok) {
  state.connected = ok;
  const c = $('conn');
  c.hidden = ok;
  if (!ok) c.textContent = state.last ? t(state.reason === 'data' ? 'app_data_unavailable' : 'app_lost', { time: clock(state.last) }) : t('app_connecting');
}
function apply(e) {
  state.last = e.at;
  const s = state.snap;
  if (e.type === 'snapshot') return render(e.data);
  if (!s) return;
  if (e.type === 'ticket.updated') { const i = s.tickets.findIndex((x) => x.id === e.data.id); if (i < 0) s.tickets.push(e.data); else s.tickets[i] = e.data; }
  if (e.type === 'ticket.removed') s.tickets = s.tickets.filter((x) => x.id !== e.data.id);
  if (e.type === 'fuel.updated') s.fuel = e.data;
  if (e.type === 'health.updated') { s.health = e.data.health; s.mode = e.data.mode; s.generatedAt = e.data.generatedAt; }
  if (e.type === 'stats.updated') { s.stats = e.data.stats; s.landed = e.data.landed; s.owner = e.data.owner; }
  render(s);
}
function live() {
  const source = new EventSource('/events');
  let beat = setTimeout(() => { state.reason = 'data'; connection(false); }, 40000);
  const stamp = () => { clearTimeout(beat); beat = setTimeout(() => { state.reason = 'link'; connection(false); }, 40000); connection(true); };
  for (const type of ['snapshot', 'ticket.updated', 'ticket.removed', 'fuel.updated', 'health.updated', 'stats.updated', 'heartbeat'])
    source.addEventListener(type, (m) => { const e = JSON.parse(m.data); stamp(); if (e.type !== 'heartbeat') apply(e); else state.last = e.at; });
  source.onerror = async () => {
    state.reason = 'link'; connection(false);
    // A restart or an expired session refuses the stream: go back to sign in instead of staying "lost".
    try { if ((await fetch('/api/snapshot', { credentials: 'same-origin' })).status === 401) location.replace('/login'); } catch { /* still unreachable */ }
  };
}

(async () => {
  try { M = await (await fetch('/api/messages', { credentials: 'same-origin' })).json(); } catch { /* English keys */ }
  theme();
  await actions.load();
  const first = await fetch('/api/snapshot', { credentials: 'same-origin' }).catch(() => null);
  if (first?.status === 401) return location.replace('/login');
  if (!first?.ok) { state.reason = 'data'; connection(false); $('conn').textContent = t('app_connecting'); live(); return; }
  const s = await first.json();
  document.documentElement.lang = s.language === 'fr' ? 'fr' : 'en';
  for (const n of document.querySelectorAll('[data-i]')) n.textContent = t(n.dataset.i);
  $('zoom').setAttribute('aria-label', t('app_ph_close_zoom'));
  $('ph-close').setAttribute('aria-label', t('app_back'));
  $('ph-expand').setAttribute('aria-label', t('app_ph_expand'));
  syncThemeButton();
  state.last = s.generatedAt;
  render(s);
  live();
  openFromAddress();
  initNotify({ t, $ });
})();
