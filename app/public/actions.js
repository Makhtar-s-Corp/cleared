// The three gestures on the porthole: Clear to land, Send back, Answer. The
// page never decides anything: it asks the server, which checks the session,
// the anti-forgery token, the version on screen and (for the first two) the
// passkey. Text from the server is put on the page as text, never as HTML.
const bytes = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)).buffer;
const text64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sameVersions = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function initActions({ t, el, $, state, clock, redraw, reopen }) {
  const box = $('ph-actions');
  let me = null;
  let seen = null; // the versions of the request for agreement on screen when the porthole was opened
  let mode = { name: 'idle' }; // idle | sendback | busy | grace
  let ticker = null;
  let formKey = '';
  const notes = new Map(); // ticket id -> { text, generatedAt }: shown until the next snapshot

  const api = async (path, body) => {
    const response = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': me?.csrf ?? '' }, body: JSON.stringify(body ?? {}) });
    const json = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, json };
  };
  const failure = (json) => t(`app_err_${json?.error ?? json?.code ?? 'failed'}`).startsWith('app_err_') ? t('app_err_failed') : t(`app_err_${json?.error ?? json?.code}`);
  async function load() {
    try { const r = await fetch('/api/me', { credentials: 'same-origin' }); if (r.ok) me = await r.json(); } catch { /* the buttons stay off */ }
    return me;
  }

  async function passkey(challenge) {
    if (!window.PublicKeyCredential || !navigator.credentials) throw Object.assign(new Error('x'), { code: 'insecure' });
    const k = challenge.publicKey;
    const got = await navigator.credentials.get({ publicKey: { challenge: bytes(k.challenge), rpId: k.rpId, timeout: k.timeout, userVerification: 'required',
      allowCredentials: k.allowCredentials.map((c) => ({ type: c.type, id: bytes(c.id) })) } });
    return { id: got.id, response: { clientDataJSON: text64(got.response.clientDataJSON), authenticatorData: text64(got.response.authenticatorData), signature: text64(got.response.signature) } };
  }
  // Asks, has the passkey confirm, and returns the server's answer to the confirmation.
  async function confirmed(gesture, card, extra = {}) {
    const asked = await api('/api/actions/challenge', { gesture, ticket: card.ref, versions: seen, ...extra });
    if (!asked.ok) return asked;
    let assertion;
    try { assertion = await passkey(asked.json); } catch (error) { return { ok: false, json: { error: error.code === 'insecure' ? 'insecure' : 'cancelled' } }; }
    return api('/api/actions/confirm', { challengeId: asked.json.challengeId, assertion, ...extra });
  }

  const note = (card, message) => { notes.set(card.id, { text: message, generatedAt: state.snap?.generatedAt }); mode = { name: 'idle' }; redraw(); mount(card); };

  function stopTicker() { clearInterval(ticker); ticker = null; }
  function grace(card, pending) {
    stopTicker();
    // The server's remaining time, not its clock: a phone whose clock is off must not see Undo after the write.
    if (pending.leftMs !== undefined) pending = { ...pending, dueAt: Date.now() + pending.leftMs };
    mode = { name: 'grace', pending };
    const total = me.actions.graceMs;
    const fill = el('i');
    const label = el('span', { className: 'grace-text mono' });
    const undo = el('button', { type: 'button', className: 'undo', textContent: t('app_act_undo') });
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      const r = await api('/api/actions/undo', { pendingId: pending.id });
      stopTicker();
      if (r.ok) { mode = { name: 'idle' }; await load(); mount(card); } else { mode = { name: 'error', text: failure(r.json) }; mount(card); }
    });
    box.replaceChildren(el('div', { className: 'grace' }, el('div', { className: 'grace-line' }, label, undo), el('div', { className: 'grace-bar', role: 'progressbar', ariaLabel: t('app_act_grace') }, fill)));
    const tick = async () => {
      const left = Math.max(0, pending.dueAt - Date.now());
      fill.style.width = `${Math.round((left / total) * 100)}%`;
      label.textContent = t('app_act_grace_left', { n: Math.ceil(left / 1000) });
      if (left > 0) return;
      stopTicker();
      mode = { name: 'busy' };
      label.textContent = t('app_act_writing'); undo.disabled = true;
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        await load();
        const mineNow = me?.actions?.pending?.find((p) => p.id === pending.id);
        if (mineNow && ['written', 'failed', 'undone'].includes(mineNow.state)) {
          if (mineNow.state === 'written') return note(card, t('app_act_cleared_note', { time: clock(new Date().toISOString()) }));
          mode = { name: 'error', text: failure(mineNow.result ?? { code: 'failed' }) };
          return mount(card);
        }
      }
    };
    ticker = setInterval(tick, 250); tick();
  }

  function button(label, kind, onClick, disabled = false) {
    const b = el('button', { type: 'button', className: `act ${kind}`, textContent: label, disabled });
    if (disabled) b.setAttribute('aria-disabled', 'true');
    b.addEventListener('click', onClick);
    return b;
  }

  async function sendBackForm(card) {
    mode = { name: 'sendback' };
    const area = el('textarea', { className: 'act-text', rows: 3, maxLength: 4000, required: true, id: 'sb-text', placeholder: t('app_act_send_back_hint') });
    const go = button(t('app_act_confirm_key'), 'ink', async () => {
      go.disabled = true;
      const r = await confirmed('sendback', card, { text: area.value });
      if (r.ok && r.json.ok) return note(card, t('app_act_sent_back_note', { time: clock(new Date().toISOString()) }));
      mode = { name: 'sendback' }; go.disabled = false; err.textContent = failure(r.json);
    }, true);
    const err = el('p', { className: 'act-error danger', role: 'alert' });
    area.addEventListener('input', () => { go.disabled = !area.value.trim(); go.toggleAttribute('aria-disabled', go.disabled); });
    const cancel = button(t('app_act_cancel'), 'ghost', () => { mode = { name: 'idle' }; mount(card); });
    box.replaceChildren(el('label', { className: 'act-label', htmlFor: 'sb-text', textContent: t('app_act_send_back_label') }), area, err, el('div', { className: 'act-row' }, cancel, go));
    area.focus();
  }

  // The answer to a question: one tap to follow the team's recommendation (only when it gave one),
  // one tap per choice it offered, or the owner's own words. Each is sent as written here, as a comment.
  function answerForm(card) {
    const area = el('textarea', { className: 'act-text', rows: 2, maxLength: 4000, id: 'an-text', placeholder: t('app_act_answer_hint') });
    const err = el('p', { className: 'act-error danger', role: 'alert' });
    const all = [];
    const send = async (value) => {
      if (!value.trim()) return;
      for (const b of all) b.disabled = true;
      const r = await api('/api/actions/answer', { ticket: card.ref, text: value });
      if (r.ok && r.json.ok) return note(card, t('app_act_answered_note', { time: clock(new Date().toISOString()) }));
      for (const b of all) b.disabled = false;
      go.disabled = !area.value.trim();
      err.textContent = failure(r.json);
    };
    const questions = card.questions?.length ? card.questions : [{ text: '', recommendation: null, options: card.options ?? [] }];
    const many = questions.length > 1;
    const blocks = questions.map((q, i) => {
      const n = i + 1;
      const buttons = [];
      if (q.recommendation) buttons.push(button(many ? `${t('app_q_number', { n })} · ${t('app_act_follow')}` : t('app_act_follow'), 'ink',
        () => send(t(many ? 'app_act_follow_text_n' : 'app_act_follow_text', { n, rec: q.recommendation }))));
      for (const o of q.options) buttons.push(button(many ? `${n}. ${o}` : o, 'ghost', () => send(many ? t('app_act_option_text_n', { n, option: o }) : o)));
      all.push(...buttons);
      return buttons.length ? el('div', { className: 'act-options' }, buttons) : null;
    }).filter(Boolean);
    const go = button(t('app_act_send'), 'ink', () => send(area.value), true);
    area.addEventListener('input', () => { go.disabled = !area.value.trim(); go.toggleAttribute('aria-disabled', go.disabled); });
    all.push(go);
    box.replaceChildren(...blocks, el('label', { className: 'act-label', htmlFor: 'an-text', textContent: t('app_act_answer_label') }), area, err, el('div', { className: 'act-row' }, go));
  }

  // Called when a ticket is opened (fresh) and each time the board changes under it.
  function mount(card, { fresh = false } = {}) {
    if (!card || !me?.actions || !['ready', 'question'].includes(card.kind) || !card.ref) { stopTicker(); mode = { name: 'idle' }; box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    if (fresh) { seen = card.approval?.versions ?? null; mode = { name: 'idle' }; stopTicker(); formKey = ''; }
    const done = notes.get(card.id);
    if (done && done.generatedAt === state.snap?.generatedAt) { box.replaceChildren(el('p', { className: 'act-note success', textContent: done.text })); return; }
    const pending = (me.actions.pending ?? []).find((p) => p.ticket === card.ref && p.state === 'waiting');
    if (pending && mode.name !== 'grace') return grace(card, pending);
    if (mode.name === 'grace' || mode.name === 'busy') return;
    if (card.kind === 'question') {
      // A redraw of the board must not wipe what is being typed.
      const key = `${card.ref}|${JSON.stringify(card.questions ?? card.options ?? [])}`;
      if (!fresh && key === formKey && box.querySelector('#an-text')) return;
      formKey = key;
      return answerForm(card);
    }
    if (mode.name === 'sendback') return;
    const why = !card.approval ? 'app_act_no_request' : me.actions.confirm ? null : `app_act_${me.actions.reason === 'insecure' ? 'insecure' : 'no_passkey'}`;
    if (!why && !sameVersions(seen, card.approval.versions)) {
      box.replaceChildren(el('p', { className: 'act-warn', textContent: t('app_act_new_version_hint') }),
        button(t('app_act_new_version'), 'ink', () => { seen = card.approval.versions; reopen(card.id); }));
      return;
    }
    const label = card.approval ? `${t('app_clear')} · ${card.approval.versions.map((v) => v.head.slice(0, 7)).join(' + ')}` : t('app_clear');
    const row = el('div', { className: 'act-row' },
      button(t('app_send_back'), 'ghost', () => sendBackForm(card), Boolean(why)),
      button(label, 'ink', async (e) => {
        const b = e.currentTarget; b.disabled = true;
        const r = await confirmed('clear', card);
        if (r.ok && r.json.pendingId) { await load(); return grace(card, me.actions.pending.find((p) => p.id === r.json.pendingId) ?? { id: r.json.pendingId, leftMs: r.json.graceMs }); }
        b.disabled = false;
        if (r.json?.error === 'new_version') { await load(); redraw(); }
        mode = { name: 'error', text: failure(r.json) }; mount(card);
      }, Boolean(why)));
    box.replaceChildren(...(mode.name === 'error' ? [el('p', { className: 'act-error danger', role: 'alert', textContent: mode.text })] : []), ...(why ? [el('p', { className: 'act-why', textContent: t(why) })] : []), row);
    if (mode.name === 'error') mode = { name: 'idle' };
  }

  return { load, mount, noteFor: (id) => { const n = notes.get(id); return n && n.generatedAt === state.snap?.generatedAt ? n.text : null; }, stop: stopTicker };
}
