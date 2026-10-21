// The inbox (inbox.png): what waits for the human, oldest first by kind, then
// what was handled today, and the detail of the item chosen: a release to
// approve or send back, a permission to allow or deny, a question to answer.
// The render functions are pure (data and a translator in, escaped HTML out)
// so the tests run them under Node; the gestures are functions of the
// shell's api(), so the tests run them against the app; mount wires both to
// the page.
//
// Every gesture goes through lane 6's forwarding (/api/service/*) with the
// signed-in user: the answer route of lane 7, and the approval route of
// lane 8 with its Undo. Lane 8 holds the 60-second grace in the service, so
// "Approve" calls the route at once with the versions shown and the screen
// counts down to the `dueAt` it answers; Undo is the service's Undo route.
//
// A request the policy refused never waited for the human: lane 7's inbox
// does not list it (issue 145, item 4), and the session screen shows it as a
// row of its own. What the inbox handles is a request settled without the
// person while it was on screen: the answer route then says nothing waits,
// and the screen says so instead of offering buttons that cannot work.
import type { ApproveBody, InboxItem, PermissionItem, QuestionItem, ReleaseItem, SessionSummary } from '../../../src/api/types.ts';
import type { Decision } from '../../../src/session/contract.ts';
import type { Question, ToolInput } from '../../../src/session/events.ts';
import type { Ticket } from '../../../src/tickets/contract.ts';
import { esc } from '../html.ts';
import type { Translate } from '../i18n.ts';
import { ApiError, type ScreenContext } from '../screen.ts';

// The local tracker's default name of the state a ticket is sent back to
// (DEFAULT_STATES.todo of src/tickets/contract.ts, which the browser cannot
// import; a test keeps the two equal).
export const TODO_STATE = 'Todo';
// The grace lane 8's service holds before it writes an approval, used only
// when its answer gives no `dueAt`.
export const GRACE_MS = 60_000;
const RECOMMENDED = /\s*\(Recommended\)\s*$/i;

// What a gesture of this page left on an item until the service's list catches up.
export type Local =
  | { readonly kind: 'busy' }                                  // a call is on its way
  | { readonly kind: 'confirm' }                               // Send back asked once
  | { readonly kind: 'grace'; readonly dueAt: string }         // approved, Undo possible until dueAt
  | { readonly kind: 'approved'; readonly at: string }
  | { readonly kind: 'sent_back'; readonly at: string }
  | { readonly kind: 'answered'; readonly decision: Decision['kind'] }
  | { readonly kind: 'settled' };                              // settled without the person

export type InboxView = {
  readonly items: readonly InboxItem[];
  readonly tickets: readonly Ticket[];
  readonly sessions: readonly SessionSummary[];
  readonly selected: string | undefined;                       // the item the address names
  readonly open: boolean;                                      // chosen in the address: on a phone the detail is its own page
  readonly me: { readonly id: string; readonly name: string };
  readonly now: Date;
  readonly local: ReadonlyMap<string, Local>;
  readonly frame: 'desktop' | 'phone';
};

// ---------------------------------------------------------------- the model

const RANK: Readonly<Record<InboxItem['kind'], number>> = { release: 0, permission: 1, question: 2 };
// The catalog names a release's checks by colour, as the tower's does.
const CHECKS = { passed: 'green', pending: 'running', failed: 'red' } as const;

// What waits, releases first, then permissions, then questions, each oldest
// first; then what was handled, in the service's order (latest first).
export function ordered(items: readonly InboxItem[]): { readonly waiting: InboxItem[]; readonly handled: InboxItem[] } {
  const waiting = items.filter((item) => item.state === 'waiting')
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || Date.parse(a.since) - Date.parse(b.since));
  return { waiting, handled: items.filter((item) => item.state === 'handled') };
}

// The item shown: the one the address names, else the first that waits.
export function chosen(view: InboxView): InboxItem | undefined {
  if (view.selected !== undefined) return view.items.find((item) => item.id === view.selected);
  const { waiting, handled } = ordered(view.items);
  return waiting[0] ?? handled[0];
}

export function itemFromHash(hash: string): string | undefined {
  const raw = hash.replace(/^#/, '');
  if (!raw) return undefined;
  try { return decodeURIComponent(raw); } catch { return undefined; }
}

// A capture is shown only from this site: the page runs under default-src 'self'.
export function sameOrigin(url: string | null): string | undefined {
  return url && url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') ? url : undefined;
}

export function elapsed(iso: string, now: Date, t: Translate): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return t('now');
  if (minutes < 60) return t('minutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t('hours', { n: hours }) : t('days', { n: Math.floor(hours / 24) });
}

function took(minutes: number, t: Translate): string {
  if (minutes < 60) return t('took_minutes', { n: Math.max(0, Math.round(minutes)) });
  const m = Math.round(minutes) % 60;
  const h = Math.floor(Math.round(minutes) / 60);
  return m === 0 ? t('took_hours_flat', { h }) : t('took_hours', { h, m: String(m).padStart(2, '0') });
}

// 'claude-sonnet-5-5' reads 'Sonnet', as the capture names a model.
function family(model: string): string {
  const match = /(opus|sonnet|haiku|fable)/i.exec(model);
  return match ? (match[1] as string).charAt(0).toUpperCase() + (match[1] as string).slice(1).toLowerCase() : model;
}

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const short = (head: string) => head.slice(0, 7);
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ---------------------------------------------------------------- gestures

type Api = ScreenContext['api'];
const ticketPath = (item: InboxItem) => `/tickets/${encodeURIComponent(item.ticket)}`;
const requestPath = (item: PermissionItem | QuestionItem) =>
  `/sessions/${encodeURIComponent(item.sessionId)}/requests/${encodeURIComponent(item.requestId)}/answer`;

// The versions the approval is bound to: exactly what the release shows.
export function approveBody(item: ReleaseItem): ApproveBody {
  return { requestedAt: item.requestedAt, heads: item.heads.map(({ pr, head }) => ({ pr, head })) };
}

export async function approve(api: Api, item: ReleaseItem, now: Date): Promise<Local> {
  const answer = await api<{ readonly accepted: true; readonly dueAt?: string }>(`${ticketPath(item)}/approve`, { method: 'POST', body: approveBody(item) });
  const dueAt = typeof answer?.dueAt === 'string' && !Number.isNaN(Date.parse(answer.dueAt)) ? answer.dueAt : new Date(now.getTime() + GRACE_MS).toISOString();
  return { kind: 'grace', dueAt };
}

// POST /api/tickets/:id/approve/undo is lane 8's route; api/types.ts does not
// list it yet (lane 8's log names that follow-up), so its answer is typed here.
export async function undoApproval(api: Api, item: ReleaseItem): Promise<void> {
  await api<{ readonly undone: true }>(`${ticketPath(item)}/approve/undo`, { method: 'POST', body: null });
}

// The inbox's "Send back" has no route of its own: the ticket moves back to
// Todo, which starts a new flow (decisions log, lane 7, choice 2).
export async function sendBack(api: Api, item: ReleaseItem): Promise<void> {
  await api(`${ticketPath(item)}/move`, { method: 'POST', body: { status: TODO_STATE } });
}

export function decisionFor(kind: 'allow_once' | 'allow_always' | 'reject_once', message: string, t: Translate): Decision {
  if (kind === 'allow_once') return { kind: 'allow_once' };
  if (kind === 'allow_always') return { kind: 'allow_always', scope: 'project' };
  return { kind: 'reject_once', message: message.trim() || t('deny_default') };
}

export async function answerRequest(api: Api, item: PermissionItem | QuestionItem, decision: Decision): Promise<Local> {
  await api(requestPath(item), { method: 'POST', body: { decision } });
  return { kind: 'answered', decision: decision.kind };
}

// A question's answers, keyed by the question's text as the harness asked
// it. A free answer wins over the choices; several choices of a multiple
// choice question are joined with a comma; every question needs an answer.
export function answersFor(questions: readonly Question[], picks: readonly (readonly string[])[], free: readonly string[]):
  { readonly answers: Record<string, string>; readonly missing?: undefined } | { readonly missing: number; readonly answers?: undefined } {
  const answers: Record<string, string> = {};
  for (const [index, question] of questions.entries()) {
    const own = (free[index] ?? '').trim();
    const value = own || (picks[index] ?? []).join(', ');
    if (!value) return { missing: index };
    answers[question.question] = value;
  }
  return { answers };
}

export type Gesture = 'approve' | 'undo' | 'send_back' | 'answer';

// How a refusal of the service reads. An answer to a request that no longer
// waits (404, or 409 for a session that stopped) was settled without the
// person: an interrupt, the session's end, or an answer from the session screen.
export function failure(error: unknown, gesture: Gesture): { readonly key: string; readonly settled: boolean } {
  const status = error instanceof ApiError ? error.status : 0;
  switch (gesture) {
    case 'answer':
      return status === 404 || status === 409 ? { key: 'answer_settled', settled: true } : { key: 'answer_failed', settled: false };
    case 'approve':
      if (status === 403) return { key: 'approve_owner', settled: false };
      if (status === 404 || status === 409) return { key: 'approve_conflict', settled: false };
      return { key: status === 503 ? 'approve_setup' : 'approve_failed', settled: false };
    case 'undo':
      return { key: status === 409 ? 'undo_late' : 'undo_failed', settled: false };
    case 'send_back':
      return { key: status === 409 ? 'send_back_conflict' : 'send_back_failed', settled: false };
  }
}

// ------------------------------------------------------------------ render

const sessionOf = (view: InboxView, id: string) => view.sessions.find((s) => s.id === id);
const ticketTitle = (view: InboxView, id: string) => view.tickets.find((ticket) => ticket.id === id)?.title;
const sessionLink = (id: string) => `/sessions/${encodeURIComponent(id)}`;

// The session to open for a release: its ticket's author, the latest one.
function releaseSession(view: InboxView, ticket: string): SessionSummary | undefined {
  const mine = view.sessions.filter((s) => s.ticket === ticket).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return mine.find((s) => s.role === 'author') ?? mine[0];
}

function target(input: ToolInput): string {
  switch (input.kind) {
    case 'read': case 'edit': case 'delete': case 'move': return input.path;
    case 'execute': return input.command;
    case 'search': return input.pattern;
    case 'fetch': return input.target;
    default: return '';
  }
}

function itemTitle(item: InboxItem): string {
  switch (item.kind) {
    case 'release': return item.title;
    case 'permission': return item.input.kind === 'execute' && item.input.description ? item.input.description : target(item.input) || item.tool;
    case 'question': return item.questions[0]?.question ?? '';
  }
}

function recommendation(item: QuestionItem): string | undefined {
  for (const question of item.questions) for (const option of question.options ?? []) if (RECOMMENDED.test(option.label)) return option.label.replace(RECOMMENDED, '');
  return undefined;
}

function itemLine(item: InboxItem, view: InboxView, t: Translate): string {
  if (item.state === 'handled') return t('handled_line', { ticket: item.ticket });
  switch (item.kind) {
    case 'release': {
      const reviewer = item.sessions.find((s) => s.role === 'reviewer');
      const checks = CHECKS[item.pr.checks];
      return reviewer ? t(`release_reviewed_${checks}`, { model: family(reviewer.model) }) : t(`release_unreviewed_${checks}`);
    }
    case 'permission': {
      const role = sessionOf(view, item.sessionId)?.role;
      return t(role ? `paused_${role}` : 'paused_session', { ticket: item.ticket });
    }
    case 'question': {
      const label = recommendation(item);
      if (label) return t('recommends', { ticket: item.ticket, label });
      const n = item.questions.reduce((sum, q) => sum + (q.options?.length ?? 0), 0);
      return n > 0 ? t('question_choices', { ticket: item.ticket, n }) : t('question_free', { ticket: item.ticket });
    }
  }
}

function card(item: InboxItem, current: boolean, view: InboxView, t: Translate): string {
  return `<li><a class="item${current ? ' current' : ''}${item.state === 'handled' ? ' handled' : ''}" href="#${esc(encodeURIComponent(item.id))}"${current ? ' aria-current="true"' : ''} data-item="${esc(item.id)}">
<span class="item-head"><span class="chip">${esc(t(`kind_${item.kind}`))}</span><span class="since">${esc(elapsed(item.since, view.now, t))}</span></span>
<span class="item-title">${esc(itemTitle(item))}</span>
<span class="item-line">${esc(itemLine(item, view, t))}</span>
</a></li>`;
}

export function renderList(view: InboxView, t: Translate): string {
  const { waiting, handled } = ordered(view.items);
  const shown = chosen(view);
  const head = `<div class="inbox-head"><h1 id="inbox-title">${esc(t('inbox_title'))}</h1>${waiting.length > 0 ? `<span class="faint">${esc(t('waiting_count', { n: waiting.length }))}</span>` : ''}</div>`;
  if (view.items.length === 0) return `${head}<p class="empty"><strong>${esc(t('empty_title'))}</strong> ${esc(t('empty_note'))}</p>`;
  const list = (items: InboxItem[]) => `<ul class="items">${items.map((item) => card(item, item.id === shown?.id, view, t)).join('')}</ul>`;
  return `${head}
${waiting.length > 0 ? list(waiting) : `<p class="empty"><strong>${esc(t('empty_title'))}</strong> ${esc(t('empty_note'))}</p>`}
${handled.length > 0 ? `<h2 class="handled-title">${esc(t('handled_title'))}</h2>${list(handled)}` : ''}`;
}

const code = (text: string) => `<code>${esc(text)}</code>`;
const link = (url: string, label: string) => /^https?:\/\//i.test(url) ? `<a href="${esc(url)}" rel="noopener noreferrer">${esc(label)}</a>` : esc(label);
const fact = (label: string, value: string) => `<dt>${esc(label)}</dt><dd>${value}</dd>`;

function eyebrow(item: InboxItem, kindKey: string, open: SessionSummary | undefined, openKey: string, t: Translate): string {
  const live = item.state === 'waiting' ? ' waits' : '';
  return `<p class="d-eyebrow"><span class="d-kind${live}">${esc(t(kindKey))}</span><span class="id">${esc(item.ticket)}</span>${open ? `<a class="d-link" href="${esc(sessionLink(open.id))}">${esc(t(openKey))}</a>` : ''}</p>`;
}

function shot(item: ReleaseItem, side: 'before' | 'after', frame: InboxView['frame'], t: Translate): string {
  const url = sameOrigin(item.captures[side][frame]);
  const inside = url ? `<img class="shot-img" src="${esc(url)}" alt="${esc(t(`alt_${side}`))}" loading="lazy">` : `<span class="shot-none">${esc(t('shot_none'))}</span>`;
  return `<figure class="shot ${side}"><div class="device">${inside}</div><figcaption>${esc(t(side))}</figcaption></figure>`;
}

function sessionsLine(item: ReleaseItem, t: Translate): string {
  return item.sessions.map((s) => {
    const values = { model: family(s.model), time: took(s.minutes, t) };
    if (s.role !== 'reviewer') return t('wrote', values);
    if (s.rounds === undefined) return t('reviewed', values);
    return s.rounds === 1 ? t('reviewed_rounds_one', values) : t('reviewed_rounds_other', { ...values, n: s.rounds });
  }).join(' · ');
}

function releaseBody(item: ReleaseItem, view: InboxView, t: Translate): string {
  const switcher = (['desktop', 'phone'] as const).map((frame) =>
    `<button type="button" data-frame="${frame}" aria-pressed="${view.frame === frame}">${esc(t(`frame_${frame}`))}</button>`).join('');
  const change = `${link(item.pr.url, t('pr_link', { n: item.pr.number }))}<span class="sep" aria-hidden="true">·</span><span>${esc(t(`checks_${CHECKS[item.pr.checks]}`))}</span>`;
  return `${eyebrow(item, item.state === 'waiting' ? 'eyebrow_release' : 'kind_release', releaseSession(view, item.ticket), 'open_sessions', t)}
<h2 class="d-title">${esc(item.title)}</h2>
${item.announcement ? `<p class="announce">${esc(item.announcement)}</p>` : ''}
<div class="shots-head"><h3>${esc(t('shots_title'))}</h3><div class="switch" role="group" aria-label="${esc(t('frame_label'))}">${switcher}</div></div>
<div class="shots frame-${view.frame}">${shot(item, 'before', view.frame, t)}${shot(item, 'after', view.frame, t)}</div>
<dl class="facts">${item.sessions.length > 0 ? fact(t('facts_sessions'), esc(sessionsLine(item, t))) : ''}${fact(t('facts_change'), change)}</dl>`;
}

// Who asks, and for how long its session has been paused; a handled request pauses nothing.
function pausedLine(item: InboxItem, session: SessionSummary, now: Date, t: Translate): string {
  const model = family(session.model);
  if (item.state === 'handled') return t(`session_${session.role}_plain`, { model });
  const minutes = (now.getTime() - Date.parse(item.since)) / 60_000;
  return minutes < 1 ? t(`session_${session.role}_now`, { model }) : t(`session_${session.role}`, { model, time: elapsed(item.since, now, t) });
}

function permissionBody(item: PermissionItem, view: InboxView, t: Translate): string {
  const input = item.input;
  const verb = input.kind === 'think' || input.kind === 'switch_mode' || input.kind === 'other' ? 'other' : input.kind;
  const shown = target(input);
  const session = sessionOf(view, item.sessionId);
  const title = ticketTitle(view, item.ticket);
  const facts = [
    input.kind === 'execute' && input.description ? fact(t('facts_what_for'), esc(input.description)) : '',
    item.suggestion.decision === 'ask' && item.suggestion.reason ? fact(t('facts_why'), esc(sentence(item.suggestion.reason))) : '',
    session ? fact(t('facts_session'), esc(pausedLine(item, session, view.now, t))) : '',
  ].join('');
  return `${eyebrow(item, 'eyebrow_permission', session ?? { id: item.sessionId } as SessionSummary, 'open_session', t)}
<h2 class="d-title">${esc(t(`wants_${verb}`, { tool: item.tool }))}${shown ? ` ${code(shown)}` : ''}</h2>
${title ? `<p class="d-ticket">${esc(title)}</p>` : ''}
${facts ? `<dl class="facts">${facts}</dl>` : ''}`;
}

function questionBody(item: QuestionItem, view: InboxView, t: Translate): string {
  const waiting = item.state === 'waiting';
  const questions = item.questions.map((question, index) => {
    const options = (question.options ?? []).map((option) => {
      const recommended = RECOMMENDED.test(option.label);
      return `<button type="button" class="option" data-q="${index}" data-option="${esc(option.label)}" aria-pressed="false"${waiting ? '' : ' disabled'}>`
        + `<span class="o-label">${esc(option.label.replace(RECOMMENDED, ''))}</span>`
        + `${recommended ? `<span class="o-rec">${esc(t('recommended'))}</span>` : ''}`
        + `${option.description ? `<span class="o-desc">${esc(option.description)}</span>` : ''}</button>`;
    }).join('');
    const free = waiting ? `<label class="free"><span>${esc(t('free_answer'))}</span><input type="text" data-free="${index}" maxlength="2000" autocomplete="off"></label>` : '';
    return `<fieldset class="q"${question.multiSelect ? ' data-multi="true"' : ''}><legend class="q-text">${question.header ? `<span class="q-header">${esc(question.header)}</span>` : ''}<span>${esc(question.question)}</span></legend>
${options ? `<div class="options">${options}</div>` : ''}${free}</fieldset>`;
  }).join('');
  const title = ticketTitle(view, item.ticket);
  const session = sessionOf(view, item.sessionId) ?? { id: item.sessionId } as SessionSummary;
  // The question first, on the colour of what waits; the ticket under it (DESIGN.md, 4).
  return `${eyebrow(item, 'eyebrow_question', session, 'open_session', t)}
<h2 class="sr-only">${esc(t('kind_question'))}</h2>
<div class="questions${waiting ? ' waits' : ''}">${questions}</div>
${title ? `<p class="d-ticket for-question">${esc(title)}</p>` : ''}`;
}

const button = (act: string, label: string, primary = false, disabled = false, extra = '') =>
  `<button type="button" class="btn${primary ? ' primary' : ''}" data-act="${act}"${disabled ? ' disabled' : ''}${extra}>${label}</button>`;

export function graceLeft(dueAt: string, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(dueAt) - now.getTime()) / 1000));
}

// The bottom of the detail: what the person can do now, or what they did.
export function renderActions(item: InboxItem, view: InboxView, t: Translate): string {
  const local = view.local.get(item.id);
  const busy = local?.kind === 'busy';
  const note = `<p class="d-note" id="d-note" role="status"></p>`;
  const done = (text: string) => `<p class="d-done">${esc(text)}</p>${note}`;
  if (local?.kind === 'settled') return done(t('settled'));
  if (local?.kind === 'answered') return done(t(`answered_${local.decision}`));
  if (local?.kind === 'approved') return done(t('approved', { time: clock(local.at) }));
  if (local?.kind === 'sent_back') return done(t('sent_back', { time: clock(local.at) }));
  if (item.state === 'handled') return done(t('handled_note'));
  switch (item.kind) {
    case 'release': {
      if (local?.kind === 'grace') {
        const left = graceLeft(local.dueAt, view.now);
        return `<div class="grace" data-due="${esc(local.dueAt)}"><div class="grace-track" role="presentation"><div class="grace-fill"></div></div>
<span class="grace-text" aria-label="${esc(t('grace_label'))}">${esc(t('grace_text', { n: left }))}</span>${button('undo', esc(t('undo')), true)}</div>${note}`;
      }
      if (local?.kind === 'confirm') {
        return `<p class="d-confirm">${esc(t('confirm_send_back'))}</p><div class="d-buttons">${button('keep', esc(t('keep')))}${button('send_back_confirm', esc(t('send_back_confirm')), true)}</div>${note}`;
      }
      const versions = item.heads.map((h) => t('version', { pr: h.pr, head: h.head })).join(', ');
      const first = item.heads[0];
      const label = `<span>${esc(t('approve'))}</span>${first ? `<span class="commit">${esc(short(first.head))}</span>` : ''}`;
      return `<span class="signed">${esc(t('signed_in', { name: view.me.name }))}</span><div class="d-buttons">${button('send_back', esc(t('send_back')), false, busy)}`
        + `${button('approve', label, true, busy, ` aria-label="${esc(t('approve_label', { versions }))}" title="${esc(versions)}"`)}</div>${note}`;
    }
    case 'permission':
      return `<label class="deny-reason" for="deny-reason"><span class="sr-only">${esc(t('deny_reason'))}</span><input id="deny-reason" type="text" maxlength="2000" autocomplete="off" placeholder="${esc(t('deny_reason'))}"${busy ? ' disabled' : ''}></label>`
        + `<div class="d-buttons">${button('reject_once', esc(t('deny')), false, busy)}${button('allow_always', esc(t('allow_always')), false, busy)}${button('allow_once', esc(t('allow_once')), true, busy)}</div>${note}`;
    case 'question':
      // Disabled until every question has a choice or a free answer: mount enables it.
      return `<span class="signed">${esc(t('signed_in', { name: view.me.name }))}</span><div class="d-buttons">${button('answer', esc(t('send_answer')), true, true)}</div>${note}`;
  }
}

export function renderDetail(view: InboxView, t: Translate): string {
  const item = chosen(view);
  const back = `<a class="back" href="#" aria-label="${esc(t('back_label'))}"><span aria-hidden="true">←</span> ${esc(t('back'))}</a>`;
  if (!item) return `${back}<div class="d-body"><p class="empty">${esc(t('gone'))}</p></div>`;
  const body = item.kind === 'release' ? releaseBody(item, view, t) : item.kind === 'permission' ? permissionBody(item, view, t) : questionBody(item, view, t);
  return `${back}<div class="d-body" data-kind="${item.kind}">${body}</div>
<div class="d-actions" id="d-actions">${renderActions(item, view, t)}</div>`;
}

export function renderInbox(view: InboxView, t: Translate): string {
  if (view.items.length === 0) return `<div class="inbox empty-inbox" data-open="false"><aside class="inbox-list" id="inbox-list" aria-labelledby="inbox-title">${renderList(view, t)}</aside></div>`;
  return `<div class="inbox" data-open="${view.open}">
<aside class="inbox-list" id="inbox-list" aria-label="${esc(t('list_label'))}">${renderList(view, t)}</aside>
<section class="detail" id="detail" tabindex="-1" aria-label="${esc(t('detail_label'))}">${renderDetail(view, t)}</section>
</div>`;
}

// ------------------------------------------------------------------- mount

const REFRESH_MS = 10_000;
const STORE_KEY = 'cleared-v2-inbox';

function ensureStylesheet(): void {
  if (document.head.querySelector('link[data-screen="inbox"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/screens/inbox.css';
  link.dataset.screen = 'inbox';
  document.head.append(link);
}

// The grace and its outcome survive a reload of this tab: the service still
// holds the approval, and its list shows the release until its next tick.
function restore(): Map<string, Local> {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '{}') as Record<string, Local>;
    return new Map(Object.entries(saved).filter(([, local]) => local.kind === 'grace' || local.kind === 'approved' || local.kind === 'sent_back'));
  } catch {
    return new Map();
  }
}

function save(local: ReadonlyMap<string, Local>): void {
  try {
    const kept = [...local].filter(([, l]) => l.kind === 'grace' || l.kind === 'approved' || l.kind === 'sent_back');
    sessionStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch { /* the state lasts for this page only */ }
}

export function mount(root: HTMLElement, context: ScreenContext): () => void {
  ensureStylesheet();
  const { t, api } = context;
  let stopped = false;
  const local = restore();
  let data: Pick<InboxView, 'items' | 'tickets' | 'sessions'> | undefined;
  // On a phone the captures start in their phone frame; the switch changes the frame only.
  let frame: InboxView['frame'] = window.matchMedia('(max-width: 767px)').matches ? 'phone' : 'desktop';
  let detailKey = '';

  const view = (): InboxView => {
    const selected = itemFromHash(location.hash);
    return {
      items: data?.items ?? [], tickets: data?.tickets ?? [], sessions: data?.sessions ?? [], selected, open: selected !== undefined,
      me: context.me.user, now: context.now(), local, frame,
    };
  };
  const $ = <E extends HTMLElement>(selector: string) => root.querySelector<E>(selector);
  const say = (key: string) => { const note = $('#d-note'); if (note) note.textContent = key ? t(key) : ''; };

  // The detail is redrawn only when what it shows changed, so a reason or a
  // free answer being typed is not lost to a refresh.
  const keyOf = (v: InboxView) => {
    const item = chosen(v);
    return JSON.stringify([v.items.length === 0, item?.id, item?.state, item ? v.local.get(item.id)?.kind : undefined, v.frame, v.selected]);
  };
  const draw = (force = false) => {
    if (stopped || !data) return;
    const v = view();
    const inbox = $('.inbox');
    const key = keyOf(v);
    if (!inbox || !$('#inbox-list') || force || (v.items.length === 0) !== inbox.classList.contains('empty-inbox')) {
      root.innerHTML = renderInbox(v, t);
      detailKey = key;
    } else {
      inbox.dataset.open = String(v.open);
      ($('#inbox-list') as HTMLElement).innerHTML = renderList(v, t);
      if (key !== detailKey) {
        ($('#detail') as HTMLElement).innerHTML = renderDetail(v, t);
        detailKey = key;
      }
    }
    ready();
    tick();
  };

  // The grace counts down each second; at its end the approval is written.
  const tick = () => {
    const grace = $('.grace');
    if (!grace) return;
    const dueAt = grace.dataset.due ?? '';
    const left = graceLeft(dueAt, context.now());
    const fill = $('.grace-fill');
    if (fill) fill.style.transform = `scaleX(${Math.min(1, left / (GRACE_MS / 1000))})`;
    const text = $('.grace-text');
    if (text) text.textContent = t('grace_text', { n: left });
    if (left === 0) {
      const item = chosen(view());
      if (item) local.set(item.id, { kind: 'approved', at: dueAt });
      save(local);
      draw();
      context.inboxChanged();
    }
  };

  const load = async () => {
    try {
      const [items, tickets, sessions] = await Promise.all([
        api<InboxItem[]>('/inbox'), api<Ticket[]>('/tickets').catch(() => []), api<SessionSummary[]>('/sessions').catch(() => []),
      ]);
      if (stopped) return;
      // A grace whose release is gone from the list ended elsewhere.
      for (const [id, l] of local) if (!items.some((item) => item.id === id) && l.kind !== 'busy') local.delete(id);
      save(local);
      data = { items, tickets, sessions };
      draw();
    } catch {
      if (!stopped && !data) root.innerHTML = `<div class="inbox-error"><p class="empty error">${esc(t('inbox_load_failed'))}</p></div>`;
    }
  };

  const act = async (item: InboxItem, gesture: Gesture, run: () => Promise<Local | undefined>) => {
    const before = local.get(item.id);
    local.set(item.id, { kind: 'busy' });
    draw();
    try {
      const after = await run();
      if (after) local.set(item.id, after);
      else local.delete(item.id);
      save(local);
      draw();
      context.inboxChanged();
      void load();                                   // the list shows the item handled at once
    } catch (error) {
      const { key, settled } = failure(error, gesture);
      if (settled) local.set(item.id, { kind: 'settled' });
      else if (gesture === 'undo' && key === 'undo_late' && before?.kind === 'grace') local.set(item.id, { kind: 'approved', at: before.dueAt });
      else if (before) local.set(item.id, before);
      else local.delete(item.id);
      save(local);
      draw();
      say(key);
      if (settled) context.inboxChanged();
      if (settled || key === 'approve_conflict') void load();
    }
  };

  // What the person chose and typed for each question of the item shown.
  const given = (item: QuestionItem): [string[][], string[]] => [
    item.questions.map((_, index) => [...root.querySelectorAll<HTMLButtonElement>(`[data-q="${index}"][aria-pressed="true"]`)].map((b) => b.dataset.option ?? '')),
    item.questions.map((_, index) => $<HTMLInputElement>(`[data-free="${index}"]`)?.value ?? ''),
  ];
  const ready = () => {
    const item = data ? chosen(view()) : undefined;
    const send = $<HTMLButtonElement>('[data-act="answer"]');
    if (!send || item?.kind !== 'question' || local.get(item.id)?.kind === 'busy') return;
    send.disabled = answersFor(item.questions, ...given(item)).missing !== undefined;
  };
  root.addEventListener('input', (event) => { if ((event.target as Element).closest('[data-free]')) ready(); });

  root.addEventListener('click', (event) => {
    const target = event.target as Element;
    const switcher = target.closest<HTMLButtonElement>('[data-frame]');
    if (switcher) {
      frame = switcher.dataset.frame === 'phone' ? 'phone' : 'desktop';
      draw();
      return;
    }
    const option = target.closest<HTMLButtonElement>('[data-option]');
    if (option) {
      const pressed = option.getAttribute('aria-pressed') === 'true';
      if (!option.closest('[data-multi]')) for (const other of root.querySelectorAll<HTMLButtonElement>(`[data-q="${option.dataset.q}"]`)) other.setAttribute('aria-pressed', 'false');
      option.setAttribute('aria-pressed', String(!pressed));
      ready();
      return;
    }
    const button = target.closest<HTMLButtonElement>('[data-act]');
    const item = data ? chosen(view()) : undefined;
    if (!button || !item || button.disabled) return;
    const now = context.now();
    switch (button.dataset.act) {
      case 'approve':
        if (item.kind === 'release') void act(item, 'approve', () => approve(api, item, now));
        return;
      case 'undo':
        if (item.kind === 'release') void act(item, 'undo', async () => { await undoApproval(api, item); return undefined; });
        return;
      case 'send_back':
        local.set(item.id, { kind: 'confirm' });
        draw();
        return;
      case 'keep':
        local.delete(item.id);
        draw();
        return;
      case 'send_back_confirm':
        if (item.kind === 'release') void act(item, 'send_back', async () => { await sendBack(api, item); return { kind: 'sent_back', at: context.now().toISOString() }; });
        return;
      case 'allow_once': case 'allow_always': case 'reject_once': {
        if (item.kind !== 'permission') return;
        const reason = $<HTMLInputElement>('#deny-reason')?.value ?? '';
        const decision = decisionFor(button.dataset.act as 'allow_once' | 'allow_always' | 'reject_once', reason, t);
        void act(item, 'answer', () => answerRequest(api, item, decision));
        return;
      }
      case 'answer': {
        if (item.kind !== 'question') return;
        const result = answersFor(item.questions, ...given(item));
        if (result.missing !== undefined) { say('answer_missing'); return; }
        void act(item, 'answer', () => answerRequest(api, item, { kind: 'answer', answers: result.answers }));
        return;
      }
      default:
        return;
    }
  });

  const onHash = () => {
    draw(true);
    if (itemFromHash(location.hash) !== undefined) {
      $('#detail')?.focus({ preventScroll: true });
      if (window.matchMedia('(max-width: 1023px)').matches) window.scrollTo(0, 0);
    }
  };
  window.addEventListener('hashchange', onHash);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && location.hash && !(event.target as Element | null)?.closest?.('input')) location.hash = '';
  };
  document.addEventListener('keydown', onKey);

  root.innerHTML = `<div class="inbox-loading" aria-busy="true"></div>`;
  void load();
  const timers = [setInterval(() => void load(), REFRESH_MS), setInterval(tick, 1000)];

  return () => {
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    window.removeEventListener('hashchange', onHash);
    document.removeEventListener('keydown', onKey);
  };
}
