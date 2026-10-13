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
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
};
const locale = () => (document.documentElement.lang === 'fr' ? 'fr-FR' : 'en-US');
const clock = (iso) => new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const when = (iso) => new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
const dur = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`);
const mono = (text) => el('span', { className: 'mono', textContent: text });

function ageText(iso) {
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return sec < 90 ? t('app_age_s', { n: sec }) : sec < 5400 ? t('app_age_min', { n: Math.round(sec / 60) }) : t('app_age_h', { n: Math.round(sec / 3600) });
}
// The age of the recorded status is shown, and keeps counting between updates.
function tickAge() {
  const node = $('health-age');
  const at = state.snap?.health?.recordedAt;
  if (node) node.textContent = at ? t('app_status_age', { age: ageText(at) }) : '';
}
setInterval(tickAge, 5000);

const COLUMNS = ['progress', 'checks', 'review', 'awaiting'];
const state = { snap: null, last: null, open: null, project: null, connected: false, opener: null };

function theme() {
  const saved = (() => { try { return localStorage.getItem('cleared-theme'); } catch { return null; } })();
  if (saved) document.documentElement.dataset.theme = saved;
}
$('theme').addEventListener('click', () => {
  const dark = (document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('cleared-theme', next); } catch { /* the choice is just not remembered */ }
});

function renderTop(s) {
  const tabs = $('projects');
  tabs.hidden = (s.projects?.length ?? 0) < 2;
  tabs.replaceChildren(...(s.projects ?? []).map((p) => el('button', { type: 'button', textContent: p.name, ariaCurrent: String(p.id === (state.project ?? s.project)) })));
  $('fuel').replaceChildren(...s.fuel.map((f) => el('li', {},
    el('b', { textContent: f.adapter }), ' ',
    f.measured ? [mono(`${f.used} %`), ` ${t('app_of_window', { window: f.window })} · ${t('app_resets')} `, el('time', { className: 'mono', dateTime: f.resetsAt, textContent: when(f.resetsAt) })] : t('app_not_measured'))));
  const h = $('health');
  h.replaceChildren(s.health.ok ? el('span', { className: 'ok' }, el('span', { className: 'dot' }), t('app_all_good'))
    : el('ul', {}, ...s.health.problems.map((p) => el('li', { className: 'bad', textContent: p.message }))),
  el('div', { className: 'age mono', id: 'health-age' }));
  tickAge();
  $('mode').textContent = s.mode.label;
}

function card(ticket) {
  const meta = el('span', { className: 'meta' },
    el('span', { textContent: `${ticket.harness} · ${ticket.model}`.replace(/^ · $/, '') }),
    el('span', { textContent: `✈ ${dur(ticket.flightMinutes)}` }),
    el('span', { textContent: `${String(ticket.quotaShare).replace('.', locale() === 'fr-FR' ? ',' : '.')} % ${t('app_quota')}` }));
  const btn = el('button', { type: 'button' },
    el('span', { className: 'id', textContent: ticket.id }), el('span', { className: 'title', textContent: ticket.title }), meta,
    el('span', { className: 'line', textContent: ticket.queued ? ticket.reason : ticket.waiting ? `${t('app_waiting')}: ${ticket.reason}` : ticket.statusLine }));
  btn.addEventListener('click', () => openTicket(ticket.id));
  return el('li', { className: `card${ticket.waiting ? ' waiting' : ''}${ticket.queued ? ' queued' : ''}`, dataset: { id: ticket.id } }, btn);
}

function renderTower(s) {
  const tickets = [...s.tickets].sort((a, b) => Number(b.waiting) - Number(a.waiting));
  $('tower').replaceChildren(...COLUMNS.map((c) => {
    const mine = tickets.filter((x) => x.column === c);
    return el('section', { className: 'col', dataset: { col: c } },
      el('h2', {}, el('span', { textContent: t(`app_col_${c}`) }), mono(String(mine.length))),
      mine.length ? el('ul', { className: 'cards' }, ...mine.map(card)) : el('p', { className: 'empty', textContent: t('app_none') }));
  }));
}
// Redrawing keeps the keyboard where it was, and skips what did not change.
let shown = { top: '', tower: '' };
function render(s) {
  state.snap = s;
  const top = JSON.stringify([s.projects, s.fuel, s.health, s.mode]);
  const tower = JSON.stringify(s.tickets);
  if (top !== shown.top) { shown.top = top; renderTop(s); }
  if (tower !== shown.tower) {
    shown.tower = tower;
    const focused = document.activeElement?.closest?.('.card')?.dataset.id;
    renderTower(s);
    if (focused) document.querySelector(`.card[data-id="${CSS.escape(focused)}"] button`)?.focus();
  }
}

async function openTicket(id) {
  const ph = $('porthole');
  state.opener = document.activeElement;
  state.open = id;
  ph.hidden = false;
  document.body.classList.add('has-ph');
  $('ph-title').textContent = id;
  $('ph-body').replaceChildren(el('p', { textContent: '…' }));
  try {
    const r = await fetch(`/api/tickets/${encodeURIComponent(id)}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('x');
    const d = await r.json();
    if (state.open !== id) return; // another ticket was opened meanwhile
    $('ph-title').textContent = `${d.id} · ${d.title}`;
    $('ph-body').replaceChildren(...porthole(d));
    $('ph-close').focus();
  } catch { $('ph-body').replaceChildren(el('p', { className: 'bad', textContent: t('app_unavailable') })); }
}
function closeTicket() {
  $('porthole').hidden = true; document.body.classList.remove('has-ph'); state.open = null;
  const back = state.opener?.isConnected ? state.opener : document.querySelector('.card button');
  back?.focus(); state.opener = null;
}
$('ph-close').addEventListener('click', closeTicket);
function closeZoom() { $('zoom').hidden = true; state.zoomer?.focus(); }
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('zoom').hidden) closeZoom(); else if (!$('porthole').hidden) closeTicket(); }
  if (e.key === 'Tab' && !$('zoom').hidden) { e.preventDefault(); $('zoom-close').focus(); } // the enlarged capture holds the focus
});

function figure(img) {
  const b = el('button', { type: 'button', ariaLabel: `${t('app_enlarge')}: ${img.caption}` }, el('img', { src: img.url, alt: img.caption }));
  b.addEventListener('click', () => { state.zoomer = b; $('zoom').querySelector('img').src = img.url; $('zoom').querySelector('img').alt = img.caption; $('zoom').hidden = false; $('zoom-close').focus(); });
  return el('figure', {}, b, el('figcaption', { textContent: img.caption }));
}
$('zoom-close').addEventListener('click', closeZoom);

function porthole(d) {
  const out = [];
  out.push(el('section', {}, el('h3', { textContent: t('app_where') }), ...d.where.map((s) => el('p', { textContent: s })), d.pr ? (d.pr.url ? el('a', { href: d.pr.url, rel: 'noreferrer noopener', target: '_blank', textContent: `PR #${d.pr.number}` }) : mono(`PR #${d.pr.number}`)) : null));
  out.push(el('section', {}, el('h3', { textContent: t('app_squad') }),
    d.squad.length ? el('ul', { className: 'squad' }, ...d.squad.map((s) => el('li', {}, `${t(`app_role_${s.role.replace(/ /g, '_')}`)} · `, mono(`${s.harness} ${s.model}`)))) : el('p', { className: 'empty', textContent: t('app_no_squad') })));
  const show = el('section', {}, el('h3', { textContent: t('app_show') }));
  if (d.show.kind === 'screen') {
    show.append(el('div', { className: 'pair' }, el('div', {}, ...d.show.before.map(figure)), el('div', {}, ...d.show.after.map(figure))));
    if (!d.show.before.length && !d.show.after.length) show.append(el('p', { className: 'empty', textContent: t('app_no_capture') }));
  } else {
    if (d.show.example) show.append(el('p', {}, el('b', { textContent: `${t('app_before')}: ` }), mono(d.show.example.before)), el('p', {}, el('b', { textContent: `${t('app_after')}: ` }), mono(d.show.example.after)));
    if (d.show.tests.length) show.append(el('ul', { className: 'tests' }, ...d.show.tests.map((x) => el('li', {}, mono(x.name), ` · ${t(`app_test_${x.change}`)} · `, el('span', { className: x.state === 'pass' ? 'ok' : x.state === 'fail' ? 'bad' : '', textContent: t(`app_state_${x.state}`) })))));
    if (d.show.touches) show.append(el('p', { textContent: d.show.touches }));
    if (!d.show.example && !d.show.tests.length && !d.show.touches) show.append(el('p', { className: 'empty', textContent: t('app_nothing_yet') }));
  }
  out.push(show);
  out.push(el('section', {}, el('h3', { textContent: t('app_blackbox') }), el('ol', { className: 'box' }, ...d.blackBox.map((e) =>
    el('li', {}, el('time', { className: 'mono', dateTime: e.at, textContent: when(e.at) }),
      el('details', {}, el('summary', { textContent: e.text }), el('pre', { textContent: JSON.stringify(e.raw, null, 2) })))))));
  out.push(el('section', { className: 'reserved' }, t('app_reserved')));
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
  render(s);
}
function live() {
  const source = new EventSource('/events');
  let beat = setTimeout(() => { state.reason = 'data'; connection(false); }, 40000);
  const stamp = () => { clearTimeout(beat); beat = setTimeout(() => { state.reason = 'link'; connection(false); }, 40000); connection(true); };
  for (const type of ['snapshot', 'ticket.updated', 'ticket.removed', 'fuel.updated', 'health.updated', 'heartbeat'])
    source.addEventListener(type, (m) => { const e = JSON.parse(m.data); stamp(); if (e.type !== 'heartbeat') apply(e); else state.last = e.at; });
  source.onerror = async () => {
    state.reason = 'link'; connection(false);
    // A restart or an expired session refuses the stream: go back to sign in instead of staying "lost".
    try { if ((await fetch('/api/snapshot', { credentials: 'same-origin' })).status === 401) location.replace('/login'); } catch { /* still unreachable */ }
  };
}

(async () => {
  theme();
  try { M = await (await fetch('/api/messages', { credentials: 'same-origin' })).json(); } catch { /* English keys */ }
  const first = await fetch('/api/snapshot', { credentials: 'same-origin' }).catch(() => null);
  if (first?.status === 401) return location.replace('/login');
  if (!first?.ok) { state.reason = 'data'; connection(false); $('conn').textContent = t('app_connecting'); live(); return; }
  const s = await first.json();
  document.documentElement.lang = s.language === 'fr' ? 'fr' : 'en';
  for (const n of document.querySelectorAll('[data-i]')) n.textContent = t(n.dataset.i);
  $('zoom').setAttribute('aria-label', t('app_ph_close_zoom'));
  state.last = s.generatedAt;
  render(s);
  live();
})();
