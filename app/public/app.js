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
const dur = (m) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`);
const pct = (n) => `${String(n).replace('.', fr() ? ',' : '.')}%`;
const mono = (text, cls = '') => el('span', { className: `mono ${cls}`.trim(), textContent: text });
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

// --- header, greeting band, stat strip --------------------------------------
function renderHeader(s) {
  const pr = $('project');
  const projects = s.projects ?? [];
  if (projects.length > 1) {
    const sel = el('select', { ariaLabel: t('app_project') }, ...projects.map((p) => el('option', { value: p.id, textContent: p.name, selected: p.id === (state.project ?? s.project) })));
    sel.addEventListener('change', () => { state.project = sel.value; });
    pr.replaceChildren(sel);
  } else pr.textContent = s.project;
  const h = $('health');
  h.className = `pill${s.health.ok ? '' : ' bad'}`;
  h.replaceChildren(el('i'), s.health.ok ? t('app_health_ok') : s.health.problems.map((p) => p.message).join(' · '));
  const name = s.owner?.name ?? '';
  $('avatar').hidden = !name;
  $('avatar').textContent = name ? [...name][0].toUpperCase() : '';
  // Places for what is not built yet: dimmed, not clickable, and said to be coming ("soon") in words for a screen reader and on the buttons.
  for (const n of document.querySelectorAll('.views [data-soon], .view-all')) n.replaceChildren(t(n.dataset.soon), el('span', { className: 'sr-only', textContent: ` ${t('app_soon')}` }));
}
function tickClock() {
  $('clock').textContent = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const at = state.snap?.generatedAt;
  $('health-age').textContent = at ? t('app_status_age', { age: ageText(at) }) : '';
}
function ageText(iso) {
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return sec < 90 ? t('app_age_s', { n: sec }) : sec < 5400 ? t('app_age_min', { n: Math.round(sec / 60) }) : t('app_age_h', { n: Math.round(sec / 3600) });
}
setInterval(tickClock, 5000);

function renderGreeting(s) {
  const now = new Date();
  const hour = now.getHours();
  const greet = t(hour < 12 ? 'app_greet_morning' : hour < 18 ? 'app_greet_afternoon' : 'app_greet_evening');
  const date = new Intl.DateTimeFormat(fr() ? 'fr-FR' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(now).replace(/[.,]/g, '');
  $('dateline').textContent = `${date} · ${s.mode.short ?? ''}`;
  const waiting = s.tickets.filter((x) => x.waiting);
  const allReady = waiting.length > 0 && waiting.every((x) => x.kind === 'ready');
  const n = waiting.length;
  const second = n === 0 ? [null, t('app_wait_none')]
    : [t(`app_wait_${allReady ? 'ready' : 'need'}_${n === 1 ? 'one' : 'other'}_tone`, { n: word(n) }), t(`app_wait_${allReady ? 'ready' : 'need'}_key_${n === 1 ? 'one' : 'other'}`)];
  const h1 = $('greeting');
  h1.replaceChildren(`${greet}${s.owner?.name ? `, ${s.owner.name}` : ''}.`, el('br'),
    second[0] ? el('span', { className: 'tone', textContent: second[0] }) : null, el('span', { className: n ? 'key' : 'tone', textContent: second[1] }));
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
        f.measured ? mono(`${f.left}%`, 'p') : el('span', { className: 'p faint', textContent: t('app_not_measured') }));
    }));
  $('stats').replaceChildren(stat(t('app_stat_flight'), String(s.stats?.inFlight ?? 0)), stat(t('app_stat_landed'), String(landed.length)),
    stat(t('app_stat_clean'), s.stats?.firstTimeClean == null ? '–' : String(s.stats.firstTimeClean), s.stats?.firstTimeClean == null ? null : el('small', { textContent: '%' })), fuel);
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
function card(ticket) {
  const col = COLUMNS.indexOf(ticket.column);
  const top = el('div', { className: 'top-row' }, el('span', { className: 'id', textContent: ticket.id }));
  if (ticket.kind === 'ready') top.append(el('span', { className: 'chip', textContent: t('app_chip_ready') }));
  else if (ticket.kind === 'question') top.append(el('span', { className: 'chip q', textContent: t('app_chip_question') }));
  else if (ticket.kind === 'tracker') top.append(el('span', { className: 'hint', textContent: t('app_tracker_hint') }));
  else if (ticket.kind === 'queued') top.append(el('span', { className: 'hint', textContent: cap(t('app_queued_tag')) }));
  else if (ticket.live) top.append(el('span', { className: 'hint progress' }, el('i', { className: 'live' }), t('app_hint_building')));
  else if (ticket.column === 'checks' && ticket.tests) top.append(el('span', { className: 'hint checks', textContent: String(ticket.tests) }));
  else if (ticket.round > 1) top.append(el('span', { className: 'hint round', textContent: t('app_hint_round', { n: ticket.round }) }));
  const parts = [top];
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
    if (first.options.length || more) parts.push(el('p', { className: 'q-meta', textContent: [first.options.length ? t('app_q_choices', { n: first.options.length }) : null, more ? t(more === 1 ? 'app_q_more_one' : 'app_q_more', { n: more }) : null].filter(Boolean).join(' · ') }));
    parts.push(el('p', { className: 'q-ticket', textContent: ticket.title }));
  } else parts.push(el('h3', { textContent: ticket.title }));
  if (ticket.kind === 'ready' && ticket.captures) {
    parts.push(el('div', { className: 'tiles' },
      el('div', { className: 'tile' }, el('div', { className: 't', textContent: t('app_before') }), el('img', { src: ticket.captures.before, alt: '' })),
      el('div', { className: 'tile after' }, el('div', { className: 't', textContent: t('app_after') }), el('img', { src: ticket.captures.after, alt: '' }))));
  }
  if (ticket.kind === 'ready' && ticket.change) {
    parts.push(el('p', { className: 'change-line' }, mono(`PR #${ticket.change.pr.number}`), ` · ${changeParts(ticket.change).join(' · ')} · `, el('span', { className: checksClass(ticket.change), textContent: checksText(ticket.change) })));
  }
  const showRail = ticket.kind === 'normal' && col >= 0 && col < 3;
  if (showRail) parts.push(el('div', { className: 'rail' }, ...['progress', 'checks', 'review', null].map((stage, i) => el('span', { className: i <= col && stage ? `s-${stage}` : '' }))));
  if (!['question', 'queued', 'tracker'].includes(ticket.kind)) {
    parts.push(el('div', { className: 'meta' }, el('span', { className: 'm' }, el('span', { className: `sq ${harnessClass(ticket.harness)}` }), ticket.model),
      mono(dur(ticket.flightMinutes)),
      ticket.quotaShare == null ? null : el('span', { className: 'share', title: t('app_share_label') }, pct(ticket.quotaShare), el('span', { className: 'sr-only', textContent: ` ${t('app_share_label')}` }))));
  }
  const sentence = actions.noteFor(ticket.id) ?? (ticket.kind === 'question' && questions.length ? null : cap(ticket.queued || ticket.kind === 'question' || ticket.kind === 'tracker' ? ticket.reason : ticket.statusLine));
  if (sentence) parts.push(el('div', { className: 'line', textContent: sentence }));
  if (ticket.waiting) {
    parts.push(el('div', { className: 'foot' }, ticket.since ? el('span', { className: 'age' }, el('time', { dateTime: ticket.since, textContent: t('app_since', { time: since(ticket.since) }) })) : null,
      ticket.kind === 'question' ? el('span', { className: 'open', textContent: t('app_q_open') }) : null));
  }
  const btn = el('button', { type: 'button' }, parts);
  btn.addEventListener('click', () => openTicket(ticket.id));
  return el('li', { className: `card ${ticket.kind}`, dataset: { id: ticket.id } }, btn);
}
function renderTower(s) {
  // What waits for the human first, the longest waiting first; a ticket the tracker alone holds comes after, apart.
  const rank = (x) => (x.waiting ? 0 : x.kind === 'tracker' ? 2 : 1);
  const tickets = [...s.tickets].sort((a, b) => rank(a) - rank(b) || (a.waiting && b.waiting ? (a.since ?? '~').localeCompare(b.since ?? '~') : 0));
  $('tower').replaceChildren(...COLUMNS.map((c) => {
    const mine = tickets.filter((x) => x.column === c);
    const main = mine.filter((x) => x.kind !== 'tracker'), apart = mine.filter((x) => x.kind === 'tracker');
    const shown = c === 'awaiting' ? mine.filter((x) => x.waiting).length : mine.length;
    return el('section', { className: 'col', dataset: { col: c } },
      el('div', { className: 'col-head' }, el('i', { className: `d-${c}` }), el('h2', { textContent: t(`app_col_${c}`) }), mono(String(shown), 'n')),
      main.length ? el('ul', { className: 'cards' }, ...main.map(card)) : el('p', { className: 'empty', textContent: t('app_none') }),
      apart.length ? el('h3', { className: 'apart', textContent: t('app_tracker_group') }) : null,
      apart.length ? el('ul', { className: 'cards' }, ...apart.map(card)) : null);
  }));
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
    return el('div', { role: 'row' }, el('div', { className: 'time', role: 'cell' }, el('time', { dateTime: r.at, textContent: clock(r.at) })), el('div', { className: 'what', role: 'cell', textContent: r.title }),
      el('div', { className: 'model', role: 'cell', textContent: r.model }), el('div', { className: 'out', role: 'cell' }, el('span', { className: out[0] }, el('i'), out[1])));
  });
  $('landed-rows').replaceChildren(...(lines.length ? [el('div', { role: 'row' }, heads), ...lines] : [el('p', { className: 'empty', textContent: t('app_landed_empty') })]));
}

// Redrawing keeps the keyboard where it was, and skips what did not change.
let shown = { top: '', tower: '', landed: '' };
function render(s) {
  state.snap = s;
  const top = JSON.stringify([s.projects, s.fuel, s.health, s.mode, s.owner, s.stats, s.tickets.map((x) => [x.waiting, x.kind])]);
  const tower = JSON.stringify([s.tickets, s.generatedAt]);
  const landed = JSON.stringify(s.landed);
  if (top !== shown.top) { shown.top = top; renderHeader(s); renderGreeting(s); renderStats(s); }
  if (landed !== shown.landed) { shown.landed = landed; renderLanded(s); renderStats(s); }
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
  for (const sel of ['.top', '.band', '.tower', '.landed']) document.querySelector(sel).inert = on && covers;
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
    chip.className = `chip${d.kind === 'question' ? ' q' : d.kind === 'ready' ? '' : ' stage'}`;
    chip.textContent = d.kind === 'ready' ? t('app_chip_ready') : d.kind === 'question' ? t('app_chip_question') : d.kind === 'tracker' ? t('app_tracker_hint') : t(`app_col_${d.column}`);
    $('ph-body').replaceChildren(...porthole(d));
    await actions.load();
    if (state.open !== id) return;
    actions.mount(state.snap?.tickets.find((x) => x.id === id), { fresh: true });
    $('ph-close').focus();
  } catch { $('ph-body').replaceChildren(el('p', { className: 'danger', textContent: t('app_unavailable') })); }
}
function closeTicket() {
  actions.mount(null);
  $('porthole').hidden = true; document.body.classList.remove('has-ph'); state.open = null; setCovered(false);
  const back = state.opener?.isConnected ? state.opener : document.querySelector('.card button');
  back?.focus(); state.opener = null;
}
$('ph-close').addEventListener('click', closeTicket);
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

function device(img, after) {
  const b = el('button', { type: 'button', className: 'device', ariaLabel: `${t('app_enlarge')}: ${img.caption}` }, el('img', { src: img.url, alt: img.caption }));
  b.addEventListener('click', () => { state.zoomer = b; $('zoom').querySelector('img').src = img.url; $('zoom').querySelector('img').alt = img.caption; $('zoom').hidden = false; $('zoom-close').focus(); });
  return el('figure', { className: after ? 'after' : 'before' }, b, el('figcaption', { textContent: img.caption }));
}
const section = (label, ...kids) => el('section', { className: 'sec' }, el('span', { className: 'label', textContent: label }), kids);
const minutesSince = (iso) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));

// The porthole of one ticket: what is asked of the human first (the whole question, the
// team's recommendation, or the version to clear), then what changed, then where the work stands.
function porthole(d) {
  const out = [];
  out.push(el('div', {}, d.waiting ? el('div', { className: 'amber-bar' }) : null, el('h2', { id: 'ph-title', textContent: d.title }),
    d.waiting && d.since ? el('p', { className: 'ph-since' }, el('time', { dateTime: d.since, textContent: `${t('app_since', { time: since(d.since) })} (${dur(minutesSince(d.since))})` })) : null));
  const questions = d.kind === 'question' ? d.questions ?? [] : [];
  if (questions.length) {
    out.push(el('section', { className: 'ph-question', ariaLabel: t(questions.length > 1 ? 'app_q_label_many' : 'app_q_label') },
      el('span', { className: 'label', textContent: t(questions.length > 1 ? 'app_q_label_many' : 'app_q_label') }),
      ...questions.map((q, i) => el('div', { className: 'q' },
        questions.length > 1 ? el('span', { className: 'q-n mono', textContent: t('app_q_number', { n: i + 1 }) }) : null,
        el('p', { className: 'q-text', textContent: q.text }),
        q.recommendation ? el('p', { className: 'q-rec' }, el('b', { textContent: t('app_q_rec') }), q.recommendation) : null,
        q.options.length ? el('ul', { className: 'q-options' }, ...q.options.map((o) => el('li', { textContent: o }))) : null))));
  }
  if (d.kind === 'ready' && d.where.length) out.push(el('section', { className: 'box-card sec' }, el('span', { className: 'label', textContent: t('app_asked') }), el('p', { textContent: d.where.join(' ') })));
  if (d.kind === 'tracker') out.push(el('p', { className: 'box-card tracker-note', textContent: t('app_tracker_explain') }));
  // Stats that mean something, or that say plainly they are not measured.
  const stats = [[t('app_stat_p_flight'), dur(d.flightMinutes), '']];
  stats.push([t('app_stat_p_checks'), d.change?.checks ? t(`app_checks_${d.change.checks}`) : t('app_not_measured'), checksClass(d.change)]);
  if (d.quotaShare != null) stats.push([t('app_stat_p_usage'), pct(d.quotaShare), '']);

  // What changed: the pull request, its size and its checks; the captures of a screen; an example.
  const changed = [];
  const c = d.change ?? (d.pr ? { pr: d.pr, files: null, additions: null, deletions: null, lines: null, checks: null, draft: null } : null);
  if (c) {
    changed.push(el('div', { className: 'pr-row' },
      c.pr.url ? el('a', { href: c.pr.url, rel: 'noreferrer noopener', target: '_blank', textContent: t('app_pr_link', { n: c.pr.number }) }) : mono(t('app_pr_link', { n: c.pr.number })),
      c.draft ? el('span', { className: 'tag', textContent: t('app_pr_draft') }) : null),
    el('p', { className: 'pr-facts' }, mono(changeParts(c).join(' · ')), ' · ', el('span', { className: checksClass(c), textContent: checksText(c) }),
      d.tests ? ` · ${t('app_srv_tests_green', { n: String(d.tests).replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f') })}` : null));
  } else changed.push(el('p', { className: 'empty', textContent: t('app_no_pr') }));
  if (d.show.kind === 'screen') {
    if (d.show.before.length || d.show.after.length) changed.push(el('div', { className: 'devs' }, ...d.show.before.map((i) => device(i, false)), ...d.show.after.map((i) => device(i, true))));
    else changed.push(el('p', { className: 'no-capture', textContent: t(`app_no_capture_${d.show.missing ?? 'none_kept'}`) }));
  }
  const example = d.show.example;
  if (example) changed.push(el('div', { className: 'example box-card' }, el('p', {}, el('b', { textContent: `${t('app_before')}: ` }), mono(example.before)), el('p', {}, el('b', { textContent: `${t('app_after')}: ` }), mono(example.after))));
  if (d.show.kind === 'code' && d.show.tests.length) changed.push(el('ul', { className: 'tests box-card' }, ...d.show.tests.map((x) => el('li', {}, mono(x.name), ` · ${t(`app_test_${x.change}`)} · `, el('span', { className: x.state === 'pass' ? 'success' : x.state === 'fail' ? 'danger' : 'faint', textContent: t(`app_state_${x.state}`) })))));
  if (d.show.kind === 'code' && d.show.touches) changed.push(el('p', { textContent: d.show.touches }));
  out.push(section(t('app_changed'), changed));
  // The numbers after what changed: the pull request line and the captures are seen first.
  out.push(el('div', { className: 'pstats' }, ...stats.map(([k, v, cls]) => el('div', {}, el('div', { className: 'k', textContent: k }), el('div', { className: `v ${cls}`.trim(), textContent: v })))));

  // Where we are: the team's report to the user (Done, Still to do), never its internal handover.
  const where = [];
  if (d.report) {
    where.push(el('p', { className: 'report-at faint', textContent: t('app_report_title', { time: since(d.report.at) }) }));
    const list = (label, items) => (items.length ? [el('h3', { className: 'report-h', textContent: label }), el('ul', { className: 'report' }, ...items.map((x) => el('li', { textContent: x })))] : []);
    where.push(...list(t('app_report_done'), d.report.done), ...list(t('app_report_remaining'), d.report.remaining));
    if (d.report.other?.length) where.push(el('ul', { className: 'report' }, ...d.report.other.map((x) => el('li', { textContent: x }))));
  } else where.push(el('p', { className: 'empty', textContent: t('app_no_report') }));
  out.push(el('section', { className: 'box-card sec' }, el('span', { className: 'label', textContent: t('app_where') }), where));

  out.push(section(t('app_squad'), d.squad.length
    ? el('ul', { className: 'squad' }, ...d.squad.map((s) => el('li', {}, el('span', { className: `sq ${harnessClass(s.harness)}` }), el('span', { className: 'role', textContent: t(`app_role_${s.role.replace(/ /g, '_')}`) }), mono(`${s.harness} · ${s.model}`, 'who'))))
    : el('p', { className: 'empty', textContent: t('app_no_squad') })));
  out.push(section(t('app_blackbox'), el('ol', { className: 'timeline' }, ...d.blackBox.map((e) =>
    el('li', { className: `st-${e.stage ?? 'progress'}` }, el('time', { dateTime: e.at, textContent: clock(e.at) }),
      el('details', {}, el('summary', { textContent: e.text }), el('pre', { textContent: JSON.stringify(e.raw, null, 2) })))))));
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
  syncThemeButton();
  state.last = s.generatedAt;
  render(s);
  live();
  openFromAddress();
  initNotify({ t, $ });
})();
