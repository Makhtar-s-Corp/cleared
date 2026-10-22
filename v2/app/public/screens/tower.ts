// The tower (tower.png, milestone 1's part of it): the bar to create a
// ticket, what needs the human, the live sessions with their current
// phrase, the lead and plans in their milestone 1 state, and what landed
// today with its duration. towerModel and renderTower are pure, so the
// tests run them without a browser; mount wires them to the service.
import type { InboxItem, PlanItemInbox, SessionSummary } from '../../../src/api/types.ts';
import type { Harness, Role } from '../../../src/session/contract.ts';
import type { SessionPhase } from '../../../src/session/events.ts';
import type { Ticket } from '../../../src/tickets/contract.ts';
import { esc } from '../html.ts';
import type { Translate } from '../i18n.ts';
import { ApiError, type ScreenContext } from '../screen.ts';

export type TowerData = {
  readonly sessions: readonly SessionSummary[];
  readonly inbox: readonly InboxItem[];
  readonly tickets: readonly Ticket[];
};

// The local tracker's default done state (DEFAULT_STATES.done in
// src/tickets/contract.ts, which the browser cannot import at run time).
export const DONE_STATE = 'Done';

const LIVE_PHASES: ReadonlySet<string> = new Set(['starting', 'working', 'waiting_human', 'reviewing']);

export type NeedCard = {
  readonly kind: InboxItem['kind'];
  readonly id: string;
  readonly ticket: string;
  readonly minutes: number;
  readonly title: string;
  readonly detail: string;                      // from the data; may be empty
  readonly detailKey: string | undefined;       // a catalog sentence after it
  readonly detailValues: Readonly<Record<string, string>>;
};

export type LiveCard = {
  readonly id: string;
  readonly role: Role;
  readonly ticket: string;
  readonly title: string;
  readonly status: string;
  readonly harness: Harness;
  readonly model: string;
  readonly minutes: number;
  readonly phase: SessionPhase;
};

export type LandedRow = { readonly ticket: string; readonly title: string; readonly time: string; readonly minutes: number };

export type TowerModel = {
  readonly needs: readonly NeedCard[];
  readonly live: readonly LiveCard[];
  readonly landed: readonly LandedRow[];
};

const minutesSince = (from: string, now: Date) => Math.max(0, Math.floor((now.getTime() - Date.parse(from)) / 60_000));

// 'claude-opus-5-5' reads 'claude · opus-5.5'; another harness's model is kept as it is.
export function formatModel(harness: Harness, model: string): string {
  const name = harness === 'claude-code' ? 'claude' : harness;
  const short = model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, '-$1.$2');
  return `${name} · ${short}`;
}

// 'claude-sonnet-5-5' reads 'Sonnet', as the capture names a reviewer.
function family(model: string): string {
  const match = /(opus|sonnet|haiku|fable)/i.exec(model);
  return match ? (match[1] as string).charAt(0).toUpperCase() + (match[1] as string).slice(1).toLowerCase() : model;
}

const pad = (n: number) => String(n).padStart(2, '0');

// The catalog names a release's checks by colour.
const CHECKS = { passed: 'green', pending: 'running', failed: 'red' } as const;

function need(item: Exclude<InboxItem, PlanItemInbox>, now: Date): NeedCard {
  const base = { kind: item.kind, id: item.id, ticket: item.ticket, minutes: minutesSince(item.since, now) };
  switch (item.kind) {
    case 'release': {
      const reviewer = item.sessions.find((s) => s.role === 'reviewer');
      const checks = CHECKS[item.pr.checks];
      const key = reviewer ? `release_reviewed_${checks}` : `release_unreviewed_${checks}`;
      return { ...base, title: item.title, detail: '', detailKey: key, detailValues: reviewer ? { model: family(reviewer.model) } : {} };
    }
    case 'permission': {
      const input = item.input;
      let title = item.tool;
      if (input.kind === 'execute') title = input.description || input.command;
      else if ('path' in input && input.path) title = input.path;
      return { ...base, title, detail: 'reason' in item.suggestion ? item.suggestion.reason : '', detailKey: 'permission_paused', detailValues: {} };
    }
    case 'question': {
      const [first, ...others] = item.questions;
      return { ...base, title: first?.question ?? '', detail: others.map((q) => q.question).join(' '), detailKey: 'question_paused', detailValues: {} };
    }
  }
}

export function towerModel(data: TowerData, now: Date): TowerModel {
  const titles = new Map(data.tickets.map((ticket) => [ticket.id, ticket.title]));
  // A plan item (milestone 2) is the plan card of lane 9; until then it is not a need.
  const needs = data.inbox.filter((item): item is Exclude<InboxItem, PlanItemInbox> => item.state === 'waiting' && item.kind !== 'plan')
    .map((item) => need(item, now))
    .sort((a, b) => b.minutes - a.minutes);
  const live = data.sessions.filter((s) => LIVE_PHASES.has(s.phase)).map((s): LiveCard => ({
    id: s.id, role: s.role, ticket: s.ticket, title: titles.get(s.ticket) ?? s.ticket, status: s.status, harness: s.harness, model: s.model,
    minutes: minutesSince(s.startedAt, now), phase: s.phase,
  }));
  const today = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  const landed = data.tickets.filter((ticket) => {
    if (ticket.status !== DONE_STATE) return false;
    const at = new Date(ticket.updatedAt);
    return `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}` === today;
  }).sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)).map((ticket): LandedRow => {
    const at = new Date(ticket.updatedAt);
    return { ticket: ticket.id, title: ticket.title, time: `${pad(at.getHours())}:${pad(at.getMinutes())}`, minutes: minutesSince(ticket.createdAt, at) };
  });
  return { needs, live, landed };
}

// "18 min", "1 h 24".
function duration(minutes: number, t: Translate): string {
  if (minutes < 60) return t('minutes', { n: minutes });
  return t('hours_minutes', { h: Math.floor(minutes / 60), m: pad(minutes % 60) });
}

function heading(count: number, t: Translate): string {
  return count <= 5 ? t(`needs_${count}`) : t('needs_many', { n: count });
}

const plural = (n: number, key: string, t: Translate) => t(n === 1 ? `${key}_one` : `${key}_other`, { n });

export function renderBar(t: Translate): string {
  return `<form class="ask" id="ask" autocomplete="off">
<input id="ask-input" name="title" maxlength="200" placeholder="${esc(t('bar_placeholder'))}" aria-label="${esc(t('bar_label'))}">
<div class="ask-actions">
<button class="chip-button" type="button" data-later="goal" aria-disabled="true" aria-describedby="ask-note">${esc(t('bar_new_goal'))}</button>
<button class="chip-button" type="button" data-later="lead" aria-disabled="true" aria-describedby="ask-note">${esc(t('bar_ask_lead'))}</button>
<button class="chip-button primary" type="submit">${esc(t('bar_new_ticket'))}</button>
</div>
<textarea id="ask-body" name="body" maxlength="20000" rows="5" placeholder="${esc(t('bar_body_placeholder'))}" aria-label="${esc(t('bar_body_label'))}"></textarea>
</form>
<p class="ask-note" id="ask-note" role="status"></p>`;
}

// What the bar sends to create a ticket: the title, and the description
// only when one was written.
export function newTicket(title: string, body: string, project: string): { title: string; project: string; body?: string } {
  const text = body.trim();
  return { title: title.trim(), project, ...(text ? { body: text } : {}) };
}

function needCard(card: NeedCard, t: Translate): string {
  const detail = [card.detail ? esc(card.detail) : '', card.detailKey ? esc(t(card.detailKey, card.detailValues)) : ''].filter(Boolean).join(' ');
  return `<li><a class="need" href="/inbox#${esc(card.id)}">
<span class="need-head"><span class="wait-line">${esc(t(`need_${card.kind}`, { age: duration(card.minutes, t) }))}</span><span class="id">${esc(card.ticket)}</span></span>
<span class="need-title">${esc(card.title)}</span>
<span class="need-detail">${detail}</span>
</a></li>`;
}

function liveCard(card: LiveCard, t: Translate): string {
  const square = card.harness === 'claude-code' ? 'claude' : card.harness === 'codex' ? 'codex' : 'other';
  return `<li class="session-card">
<span class="session-head"><span class="live${card.phase === 'waiting_human' ? ' waiting' : card.role === 'reviewer' ? ' review' : ''}" aria-hidden="true"></span><span class="role">${esc(t(`role_${card.role}`))}</span><span class="id">${esc(card.ticket)}</span></span>
<span class="session-title">${esc(card.title)}</span>
<span class="phrase">${esc(card.status)}</span>
<span class="session-foot"><span class="model"><span class="sq ${square}" aria-hidden="true"></span>${esc(formatModel(card.harness, card.model))}</span><span class="elapsed">${esc(duration(card.minutes, t))}</span><a class="open" href="/sessions/${esc(card.id)}">${esc(t('open_session'))}</a></span>
</li>`;
}

export function renderTowerBody(model: TowerModel, t: Translate): string {
  const summary = [plural(model.live.length, 'sessions_running', t), plural(model.landed.length, 'landed_today_count', t)].join(' · ');
  const needs = model.needs.length === 0
    ? `<p class="empty">${esc(t('needs_empty'))}</p>`
    : `<ul class="needs">${model.needs.map((card) => needCard(card, t)).join('')}</ul>`;
  const live = model.live.length === 0
    ? `<p class="empty">${esc(t('live_empty'))}</p>`
    : `<ul class="sessions">${model.live.map((card) => liveCard(card, t)).join('')}</ul>`;
  const landed = model.landed.length === 0
    ? `<p class="faint">${esc(t('landed_empty'))}</p>`
    : `<ul class="landed">${model.landed.map((row) => `<li><span class="time">${esc(row.time)}</span><span class="what">${esc(row.title)}</span><span class="took">${esc(duration(row.minutes, t))}</span></li>`).join('')}</ul>`;
  return `<div class="tower">
<div class="tower-main">
<div class="hello"><h1>${esc(heading(model.needs.length, t))}</h1><p class="muted">${esc(summary)}</p></div>
<section class="block" aria-labelledby="needs-title">
<div class="block-head"><span class="dot awaiting" aria-hidden="true"></span><h2 id="needs-title">${esc(t('needs_title'))}</h2><a class="more" href="/inbox">${esc(t('open_inbox'))}</a></div>
${needs}
</section>
<section class="block" aria-labelledby="live-title">
<div class="block-head"><span class="dot progress" aria-hidden="true"></span><h2 id="live-title">${esc(t('live_title'))}</h2><span class="n">${esc(model.live.length)}</span></div>
${live}
</section>
</div>
<aside class="tower-side">
<section class="side-card" aria-labelledby="lead-title">
<div class="lead-head"><span class="lead-mark" aria-hidden="true">${esc(t('lead_initial'))}</span><div><h2 id="lead-title">${esc(t('lead_title'))}</h2><p class="faint small">${esc(t('lead_state'))}</p></div></div>
<p class="note">${esc(t('lead_body'))}</p>
</section>
<section class="side-card" aria-labelledby="plans-title">
<h2 id="plans-title">${esc(t('plans_title'))}</h2>
<p class="faint small">${esc(t('plans_body'))}</p>
</section>
<section class="side-card" aria-labelledby="landed-title">
<h2 id="landed-title">${esc(t('landed_title'))}</h2>
${landed}
</section>
</aside>
</div>`;
}

export function renderTower(model: TowerModel, t: Translate): string {
  return `${renderBar(t)}<div id="tower-body">${renderTowerBody(model, t)}</div>`;
}

const REFRESH_MS = 10_000;

export function mount(root: HTMLElement, context: ScreenContext): () => void {
  const { t } = context;
  root.innerHTML = `${renderBar(t)}<div id="tower-body" aria-busy="true"></div>`;
  const body = root.querySelector<HTMLElement>('#tower-body')!;
  const form = root.querySelector<HTMLFormElement>('#ask')!;
  const input = root.querySelector<HTMLInputElement>('#ask-input')!;
  const description = root.querySelector<HTMLTextAreaElement>('#ask-body')!;
  const note = root.querySelector<HTMLElement>('#ask-note')!;
  let stopped = false;

  const say = (text: string, kind: 'ok' | 'error' | 'later') => {
    note.textContent = text;
    note.dataset.kind = kind;
  };

  const refresh = async () => {
    try {
      const [sessions, inbox, tickets] = await Promise.all([
        context.api<SessionSummary[]>('/sessions'), context.api<InboxItem[]>('/inbox'), context.api<Ticket[]>('/tickets'),
      ]);
      if (stopped) return;
      body.innerHTML = renderTowerBody(towerModel({ sessions, inbox, tickets }, context.now()), t);
    } catch (error) {
      if (stopped) return;
      body.innerHTML = `<p class="empty error">${esc(t(error instanceof ApiError && error.status === 401 ? 'signed_out' : 'load_failed'))}</p>`;
    } finally {
      body.removeAttribute('aria-busy');
    }
  };

  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-later]')) {
    button.addEventListener('click', () => say(t(button.dataset.later === 'goal' ? 'later_goal' : 'later_lead'), 'later'));
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) {
      say(t('ticket_needs_title'), 'error');
      input.focus();
      return;
    }
    try {
      const ticket = await context.api<Ticket>('/tickets', { method: 'POST', body: newTicket(title, description.value, context.me.project) });
      input.value = '';
      description.value = '';
      say(t('ticket_created', { id: ticket.id, status: ticket.status }), 'ok');
      void refresh();
    } catch {
      say(t('ticket_failed'), 'error');
    }
  });

  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
