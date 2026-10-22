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
// Everything here is pure, so the tests run it under Node: agent.ts follows
// the lead's stream for CopilotKit, and Lead.tsx draws what the agent holds.
import type { LeadMemory, LeadMessage, LeadMessageBody, LeadState, LeadStreamFrame, Plan } from '../../../../src/api/types.ts';
import type { Translate } from '../../lib/i18n.ts';
import { ApiError, type ScreenContext } from '../../lib/screen.ts';
import type { PlanAction } from '../../plan-panel/model.ts';

export type LeadDraft = { readonly text: string; readonly goal: boolean };

export const DRAFT_MAX = 2000;
export const TEXT_MAX = 20_000;                                   // what POST /api/lead/messages accepts
export const RECOMMENDED = /\s*\(Recommended\)\s*$/i;
export const GAP_MS = 30 * 60_000;                                // a time line in the thread after a silence this long

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
export function clockOf(iso: string, now: Date, language: 'en' | 'fr'): string {
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

// ------------------------------------------------------------------ thread

// Whether a question of the thread is the one the lead waits on now.
export function waitsOn(message: LeadMessage, state: LeadState): boolean {
  return message.question !== undefined && message.question.state === 'waiting' && state.pendingQuestion?.requestId === message.question.requestId;
}

// ------------------------------------------------------------------ memory

// 'claude-opus-5-5' reads 'claude · opus-5.5', as the tower writes a model
// (tower.ts imports this file, so its formatModel is not imported here).
export const modelName = (model: string) => (model.startsWith('claude-') ? `claude · ${model.slice('claude-'.length).replace(/-(\d+)-(\d+)$/, '-$1.$2')}` : model);

export function memoryStats(state: LeadState, t: Translate): { readonly text: string; readonly model: string | null } {
  const parts = [
    state.refreshCount === 0 ? t('lead_memory_refreshes_none') : state.refreshCount === 1 ? t('lead_memory_refreshes_one') : t('lead_memory_refreshes', { n: state.refreshCount }),
    ...(state.highestPercent === null ? [] : [t('lead_memory_highest', { n: Math.round(state.highestPercent) })]),
  ];
  return { text: parts.join(' · '), model: state.model ? modelName(state.model) : null };
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

// The other plans beside the one shown: to approve first, then running, paused and done.
export function otherPlans(plans: readonly Plan[], shown: Plan | undefined): Plan[] {
  const rank = (plan: Plan) => ['proposed', 'approved', 'paused', 'done'].indexOf(plan.state);
  return plans.filter((plan) => plan !== shown && rank(plan) >= 0).sort((a, b) => rank(a) - rank(b) || newest(a, b));
}

// ------------------------------------------------------------------ reply

export type SideOptions = { readonly busy?: boolean; readonly note?: string | null };

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

export const PLACEHOLDER: Readonly<Record<ComposerMode, string>> = { message: 'lead_placeholder', goal: 'lead_placeholder_goal', answer: 'lead_placeholder_answer' };
export const SEND: Readonly<Record<ComposerMode, string>> = { message: 'lead_send', goal: 'lead_send_goal', answer: 'lead_send_answer' };

export function placeholderKey(mode: ComposerMode, changing: boolean): string {
  return changing && mode === 'message' ? 'lead_placeholder_change' : PLACEHOLDER[mode];
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

export const TICK_MS = 30_000;

// What the screen shows when the lead's state cannot be read: the service
// runs no lead (503) or cannot be reached.
export const NO_LEAD: LeadState = {
  generation: 0, sessionId: null, phase: 'down', model: '', context: null, highestPercent: null,
  refreshedAt: null, refreshCount: 0, openCommitments: 0, pendingQuestion: null,
};
