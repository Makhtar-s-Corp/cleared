// The Cockpit page. Everything from the server is put on the page as text
// (never as HTML), and nothing is fetched from another site.
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
  for (const n of document.querySelectorAll('.soon-btn')) n.textContent = `${t(n.dataset.soon)} · ${t('app_soon')}`;
}
function tickClock() {
  $('clock').textContent = new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const at = state.snap?.health?.recordedAt;
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
function card(ticket) {
  const col = COLUMNS.indexOf(ticket.column);
  const top = el('div', { className: 'top-row' }, el('span', { className: 'id', textContent: ticket.id }));
  if (ticket.kind === 'ready') top.append(el('span', { className: 'chip', textContent: t('app_chip_ready') }));
  else if (ticket.kind === 'question') top.append(el('span', { className: 'chip q', textContent: t('app_chip_question') }));
  else if (ticket.kind === 'queued') top.append(el('span', { className: 'hint', textContent: cap(t('app_queued_tag')) }));
  else if (ticket.live) top.append(el('span', { className: 'hint progress' }, el('i', { className: 'live' }), t('app_hint_building')));
  else if (ticket.column === 'checks' && ticket.tests) top.append(el('span', { className: 'hint checks', textContent: String(ticket.tests) }));
  else if (ticket.round > 1) top.append(el('span', { className: 'hint round', textContent: t('app_hint_round', { n: ticket.round }) }));
  const parts = [top, el('h3', { textContent: ticket.title })];
  if (ticket.kind === 'ready' && ticket.captures) {
    parts.push(el('div', { className: 'tiles' },
      el('div', { className: 'tile' }, el('div', { className: 't', textContent: t('app_before') }), el('img', { src: ticket.captures.before, alt: '' })),
      el('div', { className: 'tile after' }, el('div', { className: 't', textContent: t('app_after') }), el('img', { src: ticket.captures.after, alt: '' }))));
  }
  const showRail = ticket.kind === 'normal' && col >= 0 && col < 3;
  if (showRail) parts.push(el('div', { className: 'rail' }, ...['progress', 'checks', 'review', null].map((stage, i) => el('span', { className: i <= col && stage ? `s-${stage}` : '' }))));
  if (ticket.kind !== 'question' && ticket.kind !== 'queued') {
    parts.push(el('div', { className: 'meta' }, el('span', { className: 'm' }, el('span', { className: `sq ${harnessClass(ticket.harness)}` }), ticket.model),
      ticket.kind === 'queued' ? null : mono(dur(ticket.flightMinutes)),
      el('span', { className: 'share', title: t('app_share_label') }, pct(ticket.quotaShare), el('span', { className: 'sr-only', textContent: ` ${t('app_share_label')}` }))));
  }
  const sentence = cap(ticket.queued || ticket.kind === 'question' ? ticket.reason : ticket.statusLine);
  if (sentence) parts.push(el('div', { className: 'line', textContent: sentence }));
  const btn = el('button', { type: 'button' }, parts);
  btn.addEventListener('click', () => openTicket(ticket.id));
  return el('li', { className: `card ${ticket.kind}`, dataset: { id: ticket.id } }, btn);
}
function renderTower(s) {
  const tickets = [...s.tickets].sort((a, b) => Number(b.waiting) - Number(a.waiting));
  $('tower').replaceChildren(...COLUMNS.map((c) => {
    const mine = tickets.filter((x) => x.column === c);
    return el('section', { className: 'col', dataset: { col: c } },
      el('div', { className: 'col-head' }, el('i', { className: `d-${c}` }), el('h2', { textContent: t(`app_col_${c}`) }), mono(String(mine.length), 'n')),
      mine.length ? el('ul', { className: 'cards' }, ...mine.map(card)) : el('p', { className: 'empty', textContent: t('app_none') }));
  }));
}
function renderLanded(s) {
  const rows = todayLanded(s);
  const back = rows.filter((r) => r.rolledBackAt).length;
  const share = Math.round(rows.reduce((n, r) => n + (r.share ?? 0), 0) * 10) / 10;
  $('landed-summary').textContent = rows.length
    ? t(rows.length === 1 ? 'app_landed_summary_one' : 'app_landed_summary', { n: rows.length, r: back, p: String(share).replace('.', fr() ? ',' : '.') })
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
  const tower = JSON.stringify(s.tickets);
  const landed = JSON.stringify(s.landed);
  if (top !== shown.top) { shown.top = top; renderHeader(s); renderGreeting(s); renderStats(s); }
  if (landed !== shown.landed) { shown.landed = landed; renderLanded(s); renderStats(s); }
  if (tower !== shown.tower) {
    shown.tower = tower;
    const focused = document.activeElement?.closest?.('.card')?.dataset.id;
    renderTower(s);
    if (focused) document.querySelector(`.card[data-id="${CSS.escape(focused)}"] button`)?.focus();
  }
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
    chip.textContent = d.kind === 'ready' ? t('app_chip_ready') : d.kind === 'question' ? t('app_chip_question') : t(`app_col_${d.column}`);
    $('ph-body').replaceChildren(...porthole(d));
    $('ph-close').focus();
  } catch { $('ph-body').replaceChildren(el('p', { className: 'danger', textContent: t('app_unavailable') })); }
}
function closeTicket() {
  $('porthole').hidden = true; document.body.classList.remove('has-ph'); state.open = null; setCovered(false);
  const back = state.opener?.isConnected ? state.opener : document.querySelector('.card button');
  back?.focus(); state.opener = null;
}
$('ph-close').addEventListener('click', closeTicket);
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

function porthole(d) {
  const out = [];
  out.push(el('div', {}, d.waiting ? el('div', { className: 'amber-bar' }) : null, el('h2', { id: 'ph-title', textContent: d.title })));
  out.push(el('div', { className: 'pstats' },
    el('div', {}, el('div', { className: 'k', textContent: t('app_stat_p_flight') }), el('div', { className: 'v', textContent: dur(d.flightMinutes) })),
    el('div', {}, el('div', { className: 'k', textContent: t('app_stat_p_usage') }), el('div', { className: 'v', textContent: pct(d.quotaShare) })),
    el('div', {}, el('div', { className: 'k', textContent: t('app_stat_p_tests') }), el('div', { className: `v${d.tests ? ' success' : ''}`, textContent: d.tests ? new Intl.NumberFormat(locale()).format(d.tests) : '–' }))));
  const show = [];
  if (d.show.kind === 'screen') {
    show.push(el('div', { className: 'devs' }, ...d.show.before.map((i) => device(i, false)), ...d.show.after.map((i) => device(i, true))));
    if (!d.show.before.length && !d.show.after.length) show.push(el('p', { className: 'empty', textContent: t('app_no_capture') }));
  } else {
    const box = [];
    if (d.show.example) box.push(el('div', { className: 'example' }, el('p', {}, el('b', { textContent: `${t('app_before')}: ` }), mono(d.show.example.before)), el('p', {}, el('b', { textContent: `${t('app_after')}: ` }), mono(d.show.example.after))));
    if (d.show.tests.length) box.push(el('ul', { className: 'tests' }, ...d.show.tests.map((x) => el('li', {}, mono(x.name), ` · ${t(`app_test_${x.change}`)} · `, el('span', { className: x.state === 'pass' ? 'success' : x.state === 'fail' ? 'danger' : 'faint', textContent: t(`app_state_${x.state}`) })))));
    if (d.show.touches) box.push(el('p', { textContent: d.show.touches }));
    show.push(box.length ? el('div', { className: 'box-card' }, box) : el('p', { className: 'empty', textContent: t('app_nothing_yet') }));
  }
  if (d.pr) show.push(d.pr.url ? el('p', {}, el('a', { href: d.pr.url, rel: 'noreferrer noopener', target: '_blank', textContent: `PR #${d.pr.number}` })) : el('p', {}, mono(`PR #${d.pr.number}`)));
  out.push(section(t('app_show'), show));
  out.push(el('section', { className: 'box-card sec' }, el('span', { className: 'label', textContent: t('app_where') }), el('p', { textContent: d.where.join(' ') })));
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
  if (e.type === 'health.updated') { s.health = e.data.health; s.mode = e.data.mode; }
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
})();
