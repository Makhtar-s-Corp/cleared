// The lead and plan screen (/lead, /plans/<id>) of lead-and-plan.png
// (milestone 2, section 7.2): on the left the lead's card, with its state
// line, what it remembers, the owner's thread and the reply field; on the
// right the plan panel (plan-panel.ts, shared with the inbox) and the other
// plans. Below 1024 px the panel goes under the thread.
//
// The reply field sends through POST /api/lead/messages: a goal when Goal is
// pressed (the tower bar's New goal presses it), else the answer to the
// lead's pending question when one waits, else a message. The session
// answer route is not used: it answers 409 for the lead's session (issue
// 168, item 3), and the lead engine answers the pending question from that
// route (decision 8). The plan's gestures call the plan routes at once:
// approving a plan starts tickets, which is reversible, so there is no grace
// (decision 6).
//
// Everything but mount is pure, so the tests run it under Node.
import type { LeadMemory, LeadMessage, LeadMessageBody, LeadState, LeadStreamFrame, Plan } from '../../../src/api/types.ts';
import type { Question } from '../../../src/session/events.ts';
import { esc } from '../html.ts';
import type { Translate } from '../i18n.ts';
import { planStateLine, renderPlanPanel, type PlanAction } from '../plan-panel.ts';
import { ApiError, type ScreenContext } from '../screen.ts';

export type LeadDraft = { readonly text: string; readonly goal: boolean };

export const DRAFT_MAX = 2000;
const TEXT_MAX = 20_000;                                   // what POST /api/lead/messages accepts
const RECOMMENDED = /\s*\(Recommended\)\s*$/i;
const GAP_MS = 30 * 60_000;                                // a time line in the thread after a silence this long

// The tower bar's draft, from the page's query string.
export function draftFrom(search: string): LeadDraft {
  const query = new URLSearchParams(search);
  return { text: (query.get('draft') ?? '').slice(0, DRAFT_MAX), goal: query.get('goal') === '1' };
}

// The plan named by /plans/<id>, or null on /lead.
export function planFrom(path: string): string | null {
  return /^\/plans\/([A-Za-z0-9_-]{1,64})$/.exec(path)?.[1] ?? null;
}

export type LeadView = {
  readonly state: LeadState;
  readonly messages: readonly LeadMessage[];
  readonly plans: readonly Plan[];
  readonly planId: string | null;                          // from /plans/<id>
  readonly now: Date;
  readonly language: 'en' | 'fr';
  readonly memory: LeadMemory | 'loading' | 'failed' | null;   // null: the panel is closed
};

const pad = (n: number) => String(n).padStart(2, '0');

// 09:31 today; with the day before that.
function clockOf(iso: string, now: Date, language: 'en' | 'fr'): string {
  const at = new Date(iso);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString(language, { day: 'numeric', month: 'short' })} ${time}`;
}

function ago(iso: string, now: Date, t: Translate): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return t('lead_ago_now');
  if (minutes < 60) return t('lead_ago_minutes', { n: minutes });
  if (minutes < 48 * 60) return t('lead_ago_hours', { h: Math.floor(minutes / 60) });
  return t('lead_ago_days', { n: Math.floor(minutes / (24 * 60)) });
}

// ------------------------------------------------------------------ header

export type HeaderLine = { readonly text: string; readonly tone: 'on' | 'quiet' | 'down' };

// "Always on · context 31 % · refreshed from memory 10 min ago", or
// "Starting", or the danger pill when no generation is live.
export function headerLine(state: LeadState, now: Date, t: Translate): HeaderLine {
  switch (state.phase) {
    case 'starting': return { text: t('lead_state_starting'), tone: 'quiet' };
    case 'refreshing': return { text: t('lead_state_refreshing'), tone: 'quiet' };
    case 'down': return { text: t('lead_state_down'), tone: 'down' };
    case 'idle':
    case 'working': {
      const parts = [t('lead_state_on')];
      if (state.context) parts.push(t('lead_context', { n: Math.round(state.context.percent) }));
      if (state.refreshedAt) parts.push(t('lead_refreshed', { ago: ago(state.refreshedAt, now, t) }));
      return { text: parts.join(' · '), tone: 'on' };
    }
  }
}

function renderHeaderLine(state: LeadState, now: Date, t: Translate): string {
  const line = headerLine(state, now, t);
  return `<p class="lead-line${line.tone === 'down' ? ' lead-down' : ''}" id="lead-line">${esc(line.text)}</p>`;
}

// ------------------------------------------------------------------ thread

// A question that waits shows its header, its options and how to answer;
// once settled it reads as the lead's other lines, as in the capture, the
// owner's answer following it.
function renderQuestion(message: LeadMessage, state: LeadState, t: Translate): string {
  const asked = message.question;
  const pending = asked !== undefined && asked.state === 'waiting' && state.pendingQuestion?.requestId === asked.requestId;
  if (!asked || !pending) return `<p class="bubble-text">${esc(asked ? asked.questions.map((q) => q.question).join('\n\n') : message.text)}</p>`;
  // One text answers every question of an ask (the lead engine's rule), so
  // options are buttons only when the ask has one question.
  const buttons = asked.questions.length === 1;
  const body = asked.questions.map((question: Question) => {
    const head = question.header ? `<span class="q-header">${esc(question.header)}</span>` : '';
    const options = question.options ?? [];
    const list = options.length === 0 ? ''
      : buttons ? `<div class="options">${options.map((option) => `<button type="button" class="option" data-answer="${esc(option.label)}"><span>${esc(option.label.replace(RECOMMENDED, ''))}</span>${RECOMMENDED.test(option.label) ? `<span class="recommended">${esc(t('lead_question_recommended'))}</span>` : ''}</button>`).join('')}</div>`
      : `<ul class="q-options">${options.map((option) => `<li>${esc(option.label.replace(RECOMMENDED, ''))}${RECOMMENDED.test(option.label) ? ` <span class="recommended">${esc(t('lead_question_recommended'))}</span>` : ''}</li>`).join('')}</ul>`;
    return `<p class="q-text">${head}<span>${esc(question.question)}</span></p>${list}`;
  }).join('');
  return `${body}<p class="q-hint">${esc(t(buttons ? 'lead_question_answer_below' : 'lead_question_several'))}</p>`;
}

export function renderThread(view: LeadView, t: Translate): string {
  if (view.messages.length === 0) return `<li class="thread-empty">${esc(t('lead_thread_empty'))}</li>`;
  const shown = choosePlan(view.plans, view.planId)?.id;
  let previous: number | undefined;
  return view.messages.map((message) => {
    const at = Date.parse(message.at);
    const gap = previous !== undefined && at - previous >= GAP_MS && message.kind !== 'refresh'
      ? `<li class="time-line"><time datetime="${esc(message.at)}">${esc(clockOf(message.at, view.now, view.language))}</time></li>` : '';
    previous = at;
    if (message.by === 'system') {
      const line = message.kind === 'refresh'
        ? t('lead_refresh_line', { generation: message.generation ?? '', time: clockOf(message.at, view.now, view.language) })
        : t('lead_system_line', { text: message.text, time: clockOf(message.at, view.now, view.language) });
      return `${gap}<li class="system-line"><span>${esc(line)}</span></li>`;
    }
    if (message.by === 'owner') return `${gap}<li class="owner-row"><p class="bubble owner">${esc(message.text)}</p></li>`;
    const question = message.kind === 'question';
    const waits = question && message.question?.state === 'waiting' && view.state.pendingQuestion?.requestId === message.question.requestId;
    // The plan beside the thread is reached by its anchor where the panel
    // goes under the thread (below 1024 px); another plan by its address.
    const link = message.kind !== 'plan' || !message.planId ? ''
      : message.planId === shown ? `<a class="bubble-link to-panel" href="#plan-title-${esc(message.planId)}">${esc(t('lead_see_plan'))}</a>`
      : `<a class="bubble-link" href="/plans/${encodeURIComponent(message.planId)}">${esc(t('lead_see_plan'))}</a>`;
    return `${gap}<li class="lead-row"><span class="lead-mark small" aria-hidden="true">${esc(t('lead_initial'))}</span><div class="bubble lead${question ? ' question' : ''}${waits ? ' waits' : ''}">${question ? renderQuestion(message, view.state, t) : `<p class="bubble-text">${esc(message.text)}</p>`}${link}</div></li>`;
  }).join('');
}

// ------------------------------------------------------------------ memory

// 'claude-opus-5-5' reads 'claude · opus-5.5', as the tower writes a model
// (tower.ts imports this file, so its formatModel is not imported here).
const modelName = (model: string) => (model.startsWith('claude-') ? `claude · ${model.slice('claude-'.length).replace(/-(\d+)-(\d+)$/, '-$1.$2')}` : model);

export function renderMemory(memory: LeadMemory, state: LeadState, now: Date, t: Translate, language: 'en' | 'fr' = 'en'): string {
  const stats = [
    esc(state.refreshCount === 0 ? t('lead_memory_refreshes_none') : state.refreshCount === 1 ? t('lead_memory_refreshes_one') : t('lead_memory_refreshes', { n: state.refreshCount })),
    ...(state.highestPercent === null ? [] : [esc(t('lead_memory_highest', { n: Math.round(state.highestPercent) }))]),
    ...(state.model ? [`<span class="nowrap">${esc(modelName(state.model))}</span>`] : []),
  ].join(' · ');
  const { handover } = memory;
  const last = handover === null ? `<p class="faint">${esc(t('lead_memory_no_handover'))}</p>`
    : handover.machine ? `<p class="memory-meta">${esc(t('lead_memory_handover_machine', { generation: handover.generation, time: clockOf(handover.at, now, language) }))}</p>`
    : `<p class="memory-meta">${esc(t('lead_memory_handover_meta', { generation: handover.generation, time: clockOf(handover.at, now, language) }))}</p><p class="memory-text">${esc(handover.summary)}</p>`;
  const open = memory.commitments.filter((c) => c.state === 'open');
  const done = memory.commitments.filter((c) => c.state === 'done');
  const openList = open.length === 0 ? `<p class="faint">${esc(t('lead_memory_none_open'))}</p>`
    : `<ul class="commitments">${open.map((c) => {
      const meta = [t('lead_memory_promised', { time: clockOf(c.createdAt, now, language) }), ...(c.due ? [t('lead_memory_due', { time: clockOf(c.due, now, language) })] : [])].join(' · ');
      return `<li><p>${esc(c.text)}${c.ticket ? ` <span class="id">${esc(c.ticket)}</span>` : ''}</p><p class="memory-meta">${esc(meta)}</p></li>`;
    }).join('')}</ul>`;
  const doneList = done.length === 0 ? '' : `<h3>${esc(t('lead_memory_done'))}</h3><ul class="commitments done">${done.map((c) => {
    const when = c.fulfilledAt ? clockOf(c.fulfilledAt, now, language) : '';
    const meta = c.note ? t('lead_memory_fulfilled_note', { time: when, note: c.note }) : t('lead_memory_fulfilled', { time: when });
    return `<li><p>${esc(c.text)}${c.ticket ? ` <span class="id">${esc(c.ticket)}</span>` : ''}</p><p class="memory-meta">${esc(meta)}</p></li>`;
  }).join('')}</ul>`;
  return `<p class="memory-stats">${stats}</p>
<h3>${esc(t('lead_memory_handover'))}</h3>${last}
<h3>${esc(t('lead_memory_open'))}</h3>${openList}${doneList}`;
}

function renderMemoryPanel(view: LeadView, t: Translate): string {
  if (view.memory === null) return '';
  const body = view.memory === 'loading' ? `<p class="faint">${esc(t('lead_memory_loading'))}</p>`
    : view.memory === 'failed' ? `<p class="memory-error">${esc(t('lead_memory_failed'))}</p>`
    : renderMemory(view.memory, view.state, view.now, t, view.language);
  return `<section class="memory" aria-labelledby="memory-title"><div class="memory-head"><h2 id="memory-title">${esc(t('lead_memory_title'))}</h2><button type="button" class="plain memory-close" data-memory-close>${esc(t('lead_memory_close'))}</button></div>${body}</section>`;
}

// ------------------------------------------------------------------ plans

const IN_PLAY: readonly Plan['state'][] = ['approved', 'paused'];
const newest = (a: Plan, b: Plan) => Date.parse(b.proposedAt) - Date.parse(a.proposedAt);

// The plan the panel shows: the one the address names; else one to approve,
// else one running or paused, else the last done. A plan superseded or
// rejected is shown only from its address.
export function choosePlan(plans: readonly Plan[], id: string | null): Plan | undefined {
  if (id !== null) return plans.find((plan) => plan.id === id);
  for (const states of [['proposed'], IN_PLAY, ['done']] as const) {
    const found = plans.filter((plan) => (states as readonly string[]).includes(plan.state)).sort(newest)[0];
    if (found) return found;
  }
  return undefined;
}

export type SideOptions = { readonly busy?: boolean; readonly note?: string | null };

export function renderSide(view: LeadView, t: Translate, options: SideOptions = {}): string {
  const shown = choosePlan(view.plans, view.planId);
  const main = shown ? renderPlanPanel(shown, t, { language: view.language, busy: options.busy ?? false, note: options.note ?? null })
    : `<p class="empty plan-empty">${esc(view.planId === null ? t('lead_no_plan') : t('lead_plan_missing', { id: view.planId }))}</p>`;
  const rank = (plan: Plan) => ['proposed', 'approved', 'paused', 'done'].indexOf(plan.state);
  const others = view.plans.filter((plan) => plan !== shown && rank(plan) >= 0).sort((a, b) => rank(a) - rank(b) || newest(a, b));
  const list = others.length === 0 ? '' : `<section class="other-plans" aria-labelledby="other-plans-title"><h2 id="other-plans-title">${esc(t('lead_other_plans'))}</h2><ul>${others.map((plan) =>
    `<li><a href="/plans/${encodeURIComponent(plan.id)}">${esc(plan.title)}</a> <span class="faint${plan.state === 'proposed' ? ' waits' : ''}">${esc(planStateLine(plan, t))}</span></li>`).join('')}</ul></section>`;
  return `${main}${list}`;
}

// ------------------------------------------------------------------ reply

export type ComposerMode = 'message' | 'goal' | 'answer';
export type Reply = { readonly kind: ComposerMode; readonly body: LeadMessageBody };

export function composerMode(state: LeadState, goal: boolean): ComposerMode {
  if (goal) return 'goal';
  return state.pendingQuestion ? 'answer' : 'message';
}

// What the reply field sends, or undefined for nothing to send.
export function replyFor(text: string, state: LeadState, goal: boolean): Reply | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > TEXT_MAX) return undefined;
  const kind = composerMode(state, goal);
  return { kind, body: kind === 'goal' ? { text: trimmed, goal: true } : { text: trimmed } };
}

export function sendReply(api: ScreenContext['api'], reply: Reply): Promise<LeadMessage> {
  return api<LeadMessage>('/lead/messages', { method: 'POST', body: reply.body });
}

export type PlanGesture = Exclude<PlanAction, 'change'>;

export function planGesture(api: ScreenContext['api'], plan: Plan, action: PlanGesture): Promise<Plan> {
  return api<Plan>(`/plans/${encodeURIComponent(plan.id)}/${action}`, { method: 'POST', body: null });
}

const FAILED: Readonly<Record<PlanGesture, string>> = { approve: 'lead_plan_failed_approve', pause: 'lead_plan_failed_pause', resume: 'lead_plan_failed_resume' };

// The catalog key of what to say when a plan gesture fails: a conflict
// means the plan moved meanwhile (approved elsewhere, superseded), and the
// screen reloads it.
export function gestureFailure(error: unknown, action: PlanGesture): string {
  return error instanceof ApiError && error.status === 409 ? 'lead_plan_conflict' : FAILED[action];
}

const PLACEHOLDER: Readonly<Record<ComposerMode, string>> = { message: 'lead_placeholder', goal: 'lead_placeholder_goal', answer: 'lead_placeholder_answer' };
const SEND: Readonly<Record<ComposerMode, string>> = { message: 'lead_send', goal: 'lead_send_goal', answer: 'lead_send_answer' };

function placeholderKey(mode: ComposerMode, changing: boolean): string {
  return changing && mode === 'message' ? 'lead_placeholder_change' : PLACEHOLDER[mode];
}

function renderComposer(mode: ComposerMode, draft: string, t: Translate): string {
  return `<form class="reply" id="reply" novalidate>
<button type="button" class="goal-toggle" id="goal-toggle" aria-pressed="${mode === 'goal'}" title="${esc(t('lead_goal_hint'))}">${esc(t('lead_goal'))}</button>
<label class="sr-only" for="reply-text">${esc(t('lead_reply_label'))}</label>
<textarea id="reply-text" rows="1" maxlength="${TEXT_MAX}" placeholder="${esc(t(placeholderKey(mode, false)))}">${esc(draft)}</textarea>
<button type="submit" class="primary" id="reply-send">${esc(t(SEND[mode]))}</button>
<p class="reply-note" id="reply-note" role="status"></p>
</form>`;
}

// ------------------------------------------------------------------ screen

export function renderLead(view: LeadView, t: Translate, draft: LeadDraft = { text: '', goal: false }): string {
  return `<div class="lead-screen">
<section class="lead-card" aria-labelledby="lead-title">
<div class="lead-top"><span class="lead-mark" aria-hidden="true">${esc(t('lead_initial'))}</span>
<div class="lead-who"><h1 id="lead-title">${esc(t('lead_heading'))}</h1>${renderHeaderLine(view.state, view.now, t)}</div>
<button type="button" class="link-button" id="lead-remember" aria-expanded="${view.memory !== null}" aria-controls="lead-memory">${esc(t('lead_remember'))}</button></div>
<div id="lead-memory">${renderMemoryPanel(view, t)}</div>
<ol class="thread" id="thread" aria-label="${esc(t('lead_thread_label'))}">${renderThread(view, t)}</ol>
${renderComposer(composerMode(view.state, draft.goal), draft.text, t)}
</section>
<div class="plan-side" id="plan-side">${renderSide(view, t)}</div>
</div>`;
}

// ------------------------------------------------------------------ stream

// The part of EventSource the follower uses, so a test can stand in for it.
export interface StreamLike {
  addEventListener(name: string, listener: (event: { data: string }) => void): void;
  close(): void;
  onerror: (() => void) | null;
}

export type Follower = { stop(): void; lastSeq(): number };

const RETRY_MS = 1500;
const RETRY_MAX_MS = 10_000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

// Reads the lead's stream from `after`: a thread message (with its seq), the
// state, a plan. When the stream drops it is closed and reopened after the
// last message seen, with a doubling pause, and a message already seen is
// not delivered twice. A state or a plan frame is the whole value: always
// delivered.
export function followLead(options: {
  readonly url: (after: number) => string;
  readonly after: number;
  readonly open: (url: string) => StreamLike;
  readonly later: (run: () => void, ms: number) => void;
  readonly onFrame: (frame: LeadStreamFrame) => void;
}): Follower {
  let last = options.after;
  let stopped = false;
  let current: StreamLike | undefined;
  let wait = RETRY_MS;
  const parse = (data: string): unknown => {
    try { return JSON.parse(data); }
    catch { return undefined; }
  };

  const connect = () => {
    if (stopped) return;
    const stream = options.open(options.url(last));
    current = stream;
    stream.addEventListener('message', ({ data }) => {
      const message = parse(data);
      if (!isObject(message) || typeof message.seq !== 'number' || message.seq <= last) return;
      last = message.seq;
      wait = RETRY_MS;
      options.onFrame({ kind: 'message', message: message as LeadMessage });
    });
    stream.addEventListener('state', ({ data }) => {
      const state = parse(data);
      if (!isObject(state) || typeof state.phase !== 'string') return;
      wait = RETRY_MS;
      options.onFrame({ kind: 'state', state: state as LeadState });
    });
    stream.addEventListener('plan', ({ data }) => {
      const plan = parse(data);
      if (!isObject(plan) || typeof plan.id !== 'string' || !Array.isArray(plan.items)) return;
      wait = RETRY_MS;
      options.onFrame({ kind: 'plan', plan: plan as Plan });
    });
    stream.onerror = () => {
      stream.close();
      if (stopped || current !== stream) return;
      options.later(connect, wait);
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    };
  };
  connect();
  return {
    stop() {
      stopped = true;
      current?.close();
    },
    lastSeq: () => last,
  };
}

// The thread with what came, by seq, the newer copy of a seq winning.
export function mergeMessages(list: readonly LeadMessage[], incoming: readonly LeadMessage[]): LeadMessage[] {
  const bySeq = new Map<number, LeadMessage>();
  for (const message of [...list, ...incoming]) bySeq.set(message.seq, message);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function mergePlan(plans: readonly Plan[], plan: Plan): Plan[] {
  return plans.some((p) => p.id === plan.id) ? plans.map((p) => (p.id === plan.id ? plan : p)) : [...plans, plan];
}

// ------------------------------------------------------------------- mount

const TICK_MS = 30_000;

// What the screen shows when the lead's state cannot be read: the service
// runs no lead (503) or cannot be reached.
const NO_LEAD: LeadState = {
  generation: 0, sessionId: null, phase: 'down', model: '', context: null, highestPercent: null,
  refreshedAt: null, refreshCount: 0, openCommitments: 0, pendingQuestion: null,
};

function ensureStylesheet(): void {
  if (document.head.querySelector('link[data-screen="lead"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/screens/lead.css';
  link.dataset.screen = 'lead';
  document.head.append(link);
}

export function mount(root: HTMLElement, context: ScreenContext): () => void {
  ensureStylesheet();
  const { t } = context;
  const draft = draftFrom(location.search);
  // The draft is read once; the address keeps no typed text (issue 164).
  if (location.search) history.replaceState(history.state, '', location.pathname + location.hash);
  const planId = planFrom(context.path);
  let stopped = false;
  let follower: Follower | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  root.innerHTML = '<div class="lead-screen" aria-busy="true"></div>';

  void (async () => {
    const [state, messages, plans] = await Promise.all([
      context.api<LeadState>('/lead').catch(() => NO_LEAD),
      context.api<LeadMessage[]>('/lead/messages').catch(() => [] as LeadMessage[]),
      context.api<Plan[]>('/plans').catch(() => [] as Plan[]),
    ]);
    if (stopped) return;
    let view: LeadView = { state, messages, plans, planId, now: context.now(), language: context.me.language, memory: null };
    let goal = draft.goal;
    let changing = false;
    let sending = false;
    let planBusy = false;
    let planNote: string | null = null;
    root.innerHTML = renderLead(view, t, draft);
    const $ = <E extends HTMLElement>(selector: string) => root.querySelector<E>(selector)!;
    const thread = $<HTMLOListElement>('#thread');
    const field = $<HTMLTextAreaElement>('#reply-text');
    const send = $<HTMLButtonElement>('#reply-send');
    const toggle = $<HTMLButtonElement>('#goal-toggle');
    const note = $('#reply-note');
    const remember = $<HTMLButtonElement>('#lead-remember');
    const side = $('#plan-side');

    const drawComposer = () => {
      const mode = composerMode(view.state, goal);
      field.placeholder = t(placeholderKey(mode, changing));
      send.textContent = t(SEND[mode]);
      send.disabled = sending;
      toggle.setAttribute('aria-pressed', String(goal));
    };
    const drawThread = () => {
      const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
      thread.innerHTML = renderThread(view, t);
      if (atEnd) thread.scrollTop = thread.scrollHeight;
    };
    const drawHeader = () => { $('#lead-line').outerHTML = renderHeaderLine(view.state, view.now, t); };
    const drawSide = () => { side.innerHTML = renderSide(view, t, { busy: planBusy, note: planNote }); };
    const drawMemory = () => {
      $('#lead-memory').innerHTML = renderMemoryPanel(view, t);
      remember.setAttribute('aria-expanded', String(view.memory !== null));
    };
    thread.scrollTop = thread.scrollHeight;
    $('.lead-screen').removeAttribute('aria-busy');
    if (draft.text || draft.goal) field.focus();

    follower = followLead({
      url: (after) => `/api/service/lead/stream?after=${after}`,
      after: messages.at(-1)?.seq ?? 0,
      open: (url) => new EventSource(url) as unknown as StreamLike,
      later: (run, ms) => { setTimeout(run, ms); },
      onFrame: (frame) => {
        if (stopped) return;
        view = { ...view, now: context.now() };
        if (frame.kind === 'message') {
          view = { ...view, messages: mergeMessages(view.messages, [frame.message]) };
          drawThread();
        } else if (frame.kind === 'state') {
          const asked = view.state.pendingQuestion?.requestId !== frame.state.pendingQuestion?.requestId;
          view = { ...view, state: frame.state };
          drawHeader();
          drawComposer();
          if (asked) drawThread();
          if (frame.state.pendingQuestion) context.inboxChanged();
        } else {
          view = { ...view, plans: mergePlan(view.plans, frame.plan) };
          drawSide();
          context.inboxChanged();
        }
      },
    });
    tick = setInterval(() => { view = { ...view, now: context.now() }; drawHeader(); }, TICK_MS);

    const deliver = async (reply: Reply) => {
      if (sending) return;
      sending = true;
      drawComposer();
      note.textContent = '';
      try {
        const sent = await sendReply(context.api, reply);
        if (stopped) return;
        if (reply.kind === 'answer') {
          // The question is settled now; the stream's next state says so too.
          const asked = view.state.pendingQuestion?.requestId;
          view = {
            ...view, state: { ...view.state, pendingQuestion: null },
            messages: view.messages.map((m) => (m.question && m.question.requestId === asked ? { ...m, question: { ...m.question, state: 'handled' as const } } : m)),
          };
          context.inboxChanged();
        }
        view = { ...view, messages: mergeMessages(view.messages, [sent]) };
        if (field.value.trim() === reply.body.text) field.value = '';
        goal = false;
        changing = false;
        thread.scrollTop = thread.scrollHeight;
        drawThread();
        thread.scrollTop = thread.scrollHeight;
      } catch {
        if (!stopped) note.textContent = t('lead_send_failed');
      } finally {
        sending = false;
        if (!stopped) drawComposer();
      }
    };

    $('#reply').addEventListener('submit', (event) => {
      event.preventDefault();
      const reply = replyFor(field.value, view.state, goal);
      if (!reply) { field.focus(); return; }
      void deliver(reply);
    });
    // Enter sends, Shift+Enter starts a new line, as in a chat.
    field.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      $<HTMLFormElement>('#reply').requestSubmit();
    });
    toggle.addEventListener('click', () => {
      goal = !goal;
      changing = false;
      drawComposer();
      field.focus();
    });
    thread.addEventListener('click', (event) => {
      const option = (event.target as Element).closest<HTMLButtonElement>('[data-answer]');
      if (!option || !view.state.pendingQuestion) return;
      void deliver({ kind: 'answer', body: { text: option.dataset.answer ?? '' } });
    });

    const openMemory = async () => {
      view = { ...view, memory: 'loading' };
      drawMemory();
      try {
        const memory = await context.api<LeadMemory>('/lead/memory');
        if (!stopped && view.memory !== null) view = { ...view, memory };
      } catch {
        if (!stopped && view.memory !== null) view = { ...view, memory: 'failed' };
      }
      if (!stopped && view.memory !== null) drawMemory();
    };
    remember.addEventListener('click', () => {
      if (view.memory !== null) { view = { ...view, memory: null }; drawMemory(); return; }
      void openMemory();
    });
    $('#lead-memory').addEventListener('click', (event) => {
      if (!(event.target as Element).closest('[data-memory-close]')) return;
      view = { ...view, memory: null };
      drawMemory();
      remember.focus();
    });

    side.addEventListener('click', async (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-plan-action]');
      const plan = choosePlan(view.plans, view.planId);
      if (!button || !plan || planBusy) return;
      const action = button.dataset.planAction as PlanAction;
      if (action === 'change') {
        // The lead proposes a new version, which supersedes this one (section 5.4).
        goal = false;
        changing = true;
        drawComposer();
        field.focus();
        field.scrollIntoView({ block: 'nearest' });
        return;
      }
      planBusy = true;
      planNote = null;
      drawSide();
      try {
        const moved = await planGesture(context.api, plan, action);
        if (stopped) return;
        view = { ...view, plans: mergePlan(view.plans, moved) };
        context.inboxChanged();
      } catch (error) {
        if (stopped) return;
        planNote = t(gestureFailure(error, action));
        if (error instanceof ApiError && error.status === 409) {
          const fresh = await context.api<Plan>(`/plans/${encodeURIComponent(plan.id)}`).catch(() => undefined);
          if (fresh) view = { ...view, plans: mergePlan(view.plans, fresh) };
        }
      }
      planBusy = false;
      if (!stopped) {
        drawSide();
        side.querySelector<HTMLButtonElement>('[data-plan-action]:not([data-plan-action="change"])')?.focus();
      }
    });
  })();

  return () => {
    stopped = true;
    follower?.stop();
    if (tick) clearInterval(tick);
  };
}
