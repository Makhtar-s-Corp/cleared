// The session screen (session.png): a ticket's author or reviewer session,
// live. The model adds the stored events up into rows, a state and a list of
// what waits for the human; the render functions turn them into escaped
// HTML. Both are pure, so the tests run them under Node; mount wires them to
// the service's stream and routes.
//
// The browser may only `import type` from v2/src, so the names of the AG-UI
// subset are copied here and a test keeps the copy equal to EVENT_TYPES.
import type { SessionSummary } from '../../../src/api/types.ts';
import type { Decision } from '../../../src/session/contract.ts';
import type { AgUiEvent, JsonPatchOperation, Question, SessionEvent, SessionPhase, SessionState, ToolInput, ToolOutput } from '../../../src/session/events.ts';
import type { Verdict } from '../../../src/session/policy.ts';
import type { Ticket } from '../../../src/tickets/contract.ts';
import { esc } from '../html.ts';
import type { Translate } from '../i18n.ts';
import type { ScreenContext } from '../screen.ts';
import { formatModel } from './tower.ts';

export const EVENT_NAMES = [
  'RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR',
  'STEP_STARTED', 'STEP_FINISHED',
  'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
  'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
  'REASONING_START', 'REASONING_END',
  'STATE_SNAPSHOT', 'STATE_DELTA',
  'CUSTOM',
] as const;

// The message the plan's first user turn carries: the ticket, shown on the ticket card.
const PROMPT_AUTHOR = 'cleared';

// ---------------------------------------------------------------- the model

export type RequestState = {
  readonly requestId: string;
  readonly suggestion: Verdict;
  state: 'waiting' | 'answered';
  decision?: Decision['kind'];
  by?: string;
  rule?: string;                                  // the rule that decided, when the policy did
};

export type ToolRow = {
  readonly kind: 'tool';
  readonly id: string;
  readonly at: string;
  readonly name: string;
  input: ToolInput | undefined;
  output: ToolOutput | undefined;
  request?: RequestState;
};
export type MessageRow = { readonly kind: 'message'; readonly id: string; readonly at: string; readonly role: 'assistant' | 'user'; readonly by: string | undefined; text: string };
export type QuestionRow = { readonly kind: 'question'; readonly id: string; readonly requestId: string; readonly at: string; readonly questions: readonly Question[]; answeredBy?: string };
export type ReadRow = { readonly kind: 'read'; readonly at: string; readonly paths: readonly string[] };
export type Row =
  | ToolRow
  | ReadRow
  | MessageRow
  | QuestionRow
  | { readonly kind: 'denied'; readonly at: string; readonly requestId: string; readonly rule: string }
  | { readonly kind: 'interrupted'; readonly at: string }
  | { readonly kind: 'error'; readonly at: string; readonly message: string }
  | { readonly kind: 'verdict'; readonly at: string; readonly verdict: 'pass' | 'changes_requested'; readonly round: number };

type Step = { name: SessionState['steps'][number]['name']; startedAt: string; finishedAt: string | null };

export type SessionModel = {
  lastSeq: number;
  lastAt: string | undefined;                       // the time of the last event seen
  state: SessionState | undefined;
  readonly rows: Exclude<Row, ReadRow>[];
  pending: string[];                                // request ids (permissions and questions) that wait for the human
  readonly steps: Map<string, Step>;                // from STEP_STARTED and STEP_FINISHED
  readonly tools: Map<string, ToolRow>;
  readonly texts: Map<string, MessageRow>;
  readonly requests: Map<string, ToolRow>;
  readonly questions: Map<string, QuestionRow>;
};

export function emptyModel(): SessionModel {
  return { lastSeq: 0, lastAt: undefined, state: undefined, rows: [], pending: [], steps: new Map(), tools: new Map(), texts: new Map(), requests: new Map(), questions: new Map() };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

// The JSON object a string carries with a `kind`, as the cleaner writes tool inputs and outputs.
function kindObject<T>(text: string): T | undefined {
  try {
    const value = record(JSON.parse(text));
    return value && typeof value.kind === 'string' ? value as T : undefined;
  } catch {
    return undefined;
  }
}

// RFC 6902 for the operations the adapter emits (replace on a top-level key)
// and the ones a state could ask for: add, replace and remove. A path that
// leads nowhere is ignored.
function patch(document: Record<string, unknown>, operation: JsonPatchOperation): void {
  if (operation.op !== 'add' && operation.op !== 'replace' && operation.op !== 'remove') return;
  const segments = operation.path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const last = segments.pop();
  if (last === undefined) return;
  let target: unknown = document;
  for (const segment of segments) {
    if (typeof target !== 'object' || target === null) return;
    target = (target as Record<string, unknown>)[segment];
  }
  if (typeof target !== 'object' || target === null) return;
  if (Array.isArray(target)) {
    const index = last === '-' ? target.length : Number(last);
    if (!Number.isInteger(index) || index < 0 || index > target.length) return;
    if (operation.op === 'add') target.splice(index, 0, (operation as { value: unknown }).value);
    else if (index === target.length) return;
    else if (operation.op === 'replace') target[index] = (operation as { value: unknown }).value;
    else target.splice(index, 1);
    return;
  }
  const object = target as Record<string, unknown>;
  if (operation.op === 'remove') delete object[last];
  else object[last] = (operation as { value: unknown }).value;
}

// Adds one stored event; false when its seq was already seen (a reconnect that replays).
export function applyEvent(model: SessionModel, stored: SessionEvent): boolean {
  if (stored.seq <= model.lastSeq) return false;
  model.lastSeq = stored.seq;
  model.lastAt = stored.at;
  const { at } = stored;
  const event: AgUiEvent = stored.event;
  switch (event.type) {
    case 'TEXT_MESSAGE_START': {
      const row: MessageRow = { kind: 'message', id: event.messageId, at, role: event.role, by: event.name, text: '' };
      model.texts.set(event.messageId, row);
      model.rows.push(row);
      break;
    }
    case 'TEXT_MESSAGE_CONTENT': {
      const row = model.texts.get(event.messageId);
      if (row) row.text += event.delta;
      break;
    }
    case 'TOOL_CALL_START': {
      const row: ToolRow = { kind: 'tool', id: event.toolCallId, at, name: event.toolCallName, input: undefined, output: undefined };
      model.tools.set(event.toolCallId, row);
      model.rows.push(row);
      break;
    }
    case 'TOOL_CALL_ARGS': {
      const row = model.tools.get(event.toolCallId);
      const input = kindObject<ToolInput>(event.delta);
      if (row && input) row.input = input;
      break;
    }
    case 'TOOL_CALL_RESULT': {
      const row = model.tools.get(event.toolCallId);
      const output = kindObject<ToolOutput>(event.content);
      if (row && output) row.output = output;
      break;
    }
    case 'STATE_SNAPSHOT':
      model.state = structuredClone(event.snapshot) as SessionState;
      break;
    case 'STATE_DELTA':
      if (model.state) for (const operation of event.delta) patch(model.state as unknown as Record<string, unknown>, operation);
      break;
    case 'STEP_STARTED':
      model.steps.set(event.stepName, { name: event.stepName, startedAt: at, finishedAt: null });
      break;
    case 'STEP_FINISHED': {
      const step = model.steps.get(event.stepName);
      if (step) step.finishedAt = at;
      else model.steps.set(event.stepName, { name: event.stepName, startedAt: at, finishedAt: at });
      break;
    }
    case 'RUN_FINISHED':
      if (event.outcome.type === 'cancelled') model.rows.push({ kind: 'interrupted', at });
      break;
    case 'RUN_ERROR':
      model.rows.push({ kind: 'error', at, message: event.message });
      break;
    case 'CUSTOM':
      custom(model, at, event);
      break;
    default:
      break;                                        // TEXT_MESSAGE_END, TOOL_CALL_END, REASONING_*: nothing to show
  }
  return true;
}

function custom(model: SessionModel, at: string, event: Extract<AgUiEvent, { type: 'CUSTOM' }>): void {
  switch (event.name) {
    case 'cleared.permission_request': {
      const { requestId, toolCallId, tool, input, suggestion } = event.value;
      let row = model.tools.get(toolCallId);
      if (!row) {
        row = { kind: 'tool', id: requestId, at, name: tool, input, output: undefined };
        model.rows.push(row);
      } else if (!row.input) row.input = input;
      row.request = { requestId, suggestion, state: 'waiting' };
      model.requests.set(requestId, row);
      model.pending.push(requestId);
      break;
    }
    case 'cleared.permission_answered': {
      const { requestId, decision, by, rule } = event.value;
      const row = model.requests.get(requestId);
      if (row?.request) {
        row.request.state = 'answered';
        row.request.decision = decision;
        row.request.by = by;
        if (rule !== undefined) row.request.rule = rule;
        model.pending = model.pending.filter((id) => id !== requestId);
      } else if (by === 'policy' && (decision === 'reject_once' || decision === 'reject_always')) {
        // A refusal by the policy has no request before it (the tool is
        // checked before it runs): a row of its own. A policy allow is quiet.
        model.rows.push({ kind: 'denied', at, requestId, rule: rule ?? '' });
      }
      break;
    }
    case 'cleared.question': {
      const row: QuestionRow = { kind: 'question', id: event.value.requestId, requestId: event.value.requestId, at, questions: event.value.questions };
      model.questions.set(row.requestId, row);
      model.rows.push(row);
      model.pending.push(row.requestId);
      break;
    }
    case 'cleared.answered': {
      const row = model.questions.get(event.value.requestId);
      if (row) row.answeredBy = event.value.by;
      model.pending = model.pending.filter((id) => id !== event.value.requestId);
      break;
    }
    case 'cleared.review_verdict':
      model.rows.push({ kind: 'verdict', at, verdict: event.value.verdict, round: event.value.round });
      break;
    default:
      break;
  }
}

// The number of events that were new.
export function applyAll(model: SessionModel, events: readonly SessionEvent[]): number {
  let added = 0;
  for (const event of events) if (applyEvent(model, event)) added++;
  return added;
}

// The rows as the screen shows them: the ticket's prompt and empty messages
// left out, and consecutive reads that nobody was asked about as one row.
export function timeline(model: SessionModel): Row[] {
  const out: Row[] = [];
  for (const row of model.rows) {
    if (row.kind === 'message' && (row.by === PROMPT_AUTHOR || !row.text.trim())) continue;
    const previous = out[out.length - 1];
    if (row.kind === 'tool' && row.input?.kind === 'read' && !row.request) {
      if (previous?.kind === 'read') out[out.length - 1] = { kind: 'read', at: previous.at, paths: [...previous.paths, row.input.path] };
      else out.push({ kind: 'read', at: row.at, paths: [row.input.path] });
      continue;
    }
    out.push(row);
  }
  return out;
}

export type ResultSummary = { readonly tone: 'ok' | 'error'; readonly key: 'passed' | 'failed' | 'done' | 'error'; readonly n?: number };

// What a command or a tool printed, in one phrase: a test run says how many
// passed or failed, anything else that exited well says it is done.
export function resultSummary(output: ToolOutput | undefined): ResultSummary | undefined {
  if (!output || output.kind === 'read') return undefined;
  if (output.kind !== 'execute') return 'ok' in output && !output.ok ? { tone: 'error', key: 'error' } : undefined;
  const text = output.output;
  const number = (pattern: RegExp) => { const match = pattern.exec(text); return match ? Number(match[1]) : undefined; };
  const failed = number(/^#\s*fail\s+(\d+)/m) ?? number(/(\d+) failed/);
  if (failed) return { tone: 'error', key: 'failed', n: failed };
  const passed = number(/^#\s*pass\s+(\d+)/m) ?? number(/(\d+) passed/);
  if (passed !== undefined && !output.isError) return { tone: 'ok', key: 'passed', n: passed };
  return output.isError ? { tone: 'error', key: 'error' } : { tone: 'ok', key: 'done' };
}

const CHECKLIST = /^\s*[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/;

// The criteria of a ticket are the checklist lines of its body; what is left
// is its description, by paragraph.
export function parseCriteria(body: string): { readonly description: string[]; readonly criteria: { readonly text: string; readonly done: boolean }[] } {
  const criteria: { text: string; done: boolean }[] = [];
  const rest: string[] = [];
  for (const line of body.split('\n')) {
    const match = CHECKLIST.exec(line);
    if (match) criteria.push({ text: match[2] as string, done: match[1] !== ' ' });
    else rest.push(line);
  }
  return { description: rest.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean), criteria };
}

// The steps the screen shows: the state's, and the ones only STEP_* events told.
export function stepsOf(model: SessionModel): readonly Step[] {
  const merged = new Map<string, Step>();
  for (const step of model.steps.values()) merged.set(step.name, step);
  for (const step of model.state?.steps ?? []) {
    const seen = merged.get(step.name);
    merged.set(step.name, seen && step.finishedAt === null && seen.finishedAt !== null ? { ...step, finishedAt: seen.finishedAt } : { ...step });
  }
  return [...merged.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

// ------------------------------------------------------------------ render

export type SessionView = {
  readonly summary: SessionSummary;
  readonly model: SessionModel;
  readonly ticket: Ticket | undefined;
  readonly siblings: readonly SessionSummary[];           // the sessions of the same ticket, this one included
  readonly me: string;                                    // the signed-in user's id
  readonly language: 'en' | 'fr';
  readonly now: Date;
  readonly busy?: ReadonlySet<string>;                    // request ids whose answer is on its way
};

const ENDED: ReadonlySet<SessionPhase> = new Set(['done', 'stopped', 'failed']);
const pad = (n: number) => String(n).padStart(2, '0');
const clock = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function family(model: string): string {
  const match = /(opus|sonnet|haiku|fable)/i.exec(model);
  return match ? (match[1] as string).charAt(0).toUpperCase() + (match[1] as string).slice(1).toLowerCase() : model;
}

function duration(ms: number, t: Translate): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t('seconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? t('minutes', { n: minutes }) : t('hours_minutes', { h: Math.floor(minutes / 60), m: pad(minutes % 60) });
}

// A catalog sentence for a key that may not exist (a rule the catalog has not met).
function known(t: Translate, key: string, values?: Record<string, string | number>): string | undefined {
  try { return t(key, values); } catch { return undefined; }
}

const phaseOf = (view: SessionView): SessionPhase => view.model.state?.phase ?? view.summary.phase;

function statusTone(view: SessionView): 'waiting' | 'progress' | 'review' | 'ended' {
  const phase = phaseOf(view);
  if (ENDED.has(phase)) return 'ended';
  if (phase === 'waiting_human' && view.model.pending.length > 0) return 'waiting';
  return phase === 'reviewing' ? 'review' : 'progress';
}

function phrase(view: SessionView, t: Translate): string {
  const phase = phaseOf(view);
  const data = view.model.state?.status || view.summary.status;
  switch (phase) {
    case 'waiting_human': return t(view.model.pending.length > 0 ? 'status_waiting_human' : 'status_idle');
    case 'starting': return t('status_starting');
    case 'done': return t('status_done');
    case 'stopped': return t('status_stopped');
    case 'failed': return t('status_failed');
    case 'reviewing': return data || t('status_reviewing');
    default: return data || t('status_working');
  }
}

export function renderStatus(view: SessionView, t: Translate): string {
  const ended = ENDED.has(phaseOf(view));
  const end = ended ? Date.parse(view.model.lastAt ?? view.summary.updatedAt) : view.now.getTime();
  const time = duration(end - Date.parse(view.summary.startedAt), t);
  const usage = view.model.state?.usage ?? {};
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const meta = tokens > 0 ? t('elapsed_usage', { time, tokens: tokens.toLocaleString(view.language) }) : t('elapsed_only', { time });
  return `<span class="dot ${statusTone(view)}" aria-hidden="true"></span><h2 class="phrase-title">${esc(phrase(view, t))}</h2><span class="meta">${esc(meta)}</span>`;
}

const code = (text: string, title?: string) => `<code${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</code>`;
const counts = (added: number, removed: number) =>
  `<span class="add">+${esc(added)}</span>${removed > 0 ? ` <span class="del">−${esc(removed)}</span>` : ''}`;

function who(by: string | undefined, view: SessionView, t: Translate): string {
  if (by === 'policy') return t('who_policy');
  return by === view.me ? t('who_you') : t('who_other');
}

function answerLine(request: RequestState, view: SessionView, t: Translate): string {
  switch (request.decision) {
    case 'allow_once': return t('answer_allow_once', { who: who(request.by, view, t) });
    case 'allow_always': return t('answer_allow_always', { who: who(request.by, view, t) });
    case 'reject_once': case 'reject_always': return t('answer_deny', { who: who(request.by, view, t) });
    case 'cancelled': return t('answer_cancelled');
    default: return '';
  }
}

function target(input: ToolInput | undefined): string {
  if (!input) return '';
  switch (input.kind) {
    case 'read': case 'edit': case 'delete': case 'move': return input.path;
    case 'execute': return input.command;
    case 'search': return input.pattern;
    case 'fetch': return input.target;
    default: return '';
  }
}

function verb(input: ToolInput | undefined): string {
  return input && input.kind !== 'think' && input.kind !== 'switch_mode' && input.kind !== 'other' ? input.kind : 'other';
}

const GLYPH: Readonly<Record<string, string>> = { read: '◎', edit: '✎', execute: '▶', other: '·', search: '⌕', fetch: '↗', delete: '✕', move: '→' };

function rowFrame(kind: string, at: string, glyph: string, body: string, extra = ''): string {
  return `<div class="row${extra}" data-row="${esc(kind)}"><time datetime="${esc(at)}">${esc(clock(at))}</time><span class="glyph" aria-hidden="true">${glyph}</span><div class="what">${body}</div></div>`;
}

function requestCard(row: ToolRow, request: RequestState, view: SessionView, t: Translate): string {
  const input = row.input;
  const asked = verb(input);
  const key = `wants_${asked}`;
  const lead = known(t, key, { tool: row.name }) ?? t('wants_other', { tool: row.name });
  const description = input?.kind === 'execute' && input.description ? input.description : '';
  const reason = request.suggestion.decision === 'ask' ? request.suggestion.reason : '';
  const off = view.busy?.has(request.requestId) ? ' disabled' : '';
  const why = [description, reason].filter(Boolean).map((part) => `<span>${esc(part)}</span>`).join('');
  return `<div class="request" data-row="request" data-request-id="${esc(request.requestId)}" role="group" aria-label="${esc(t('request_group'))}">
<p class="request-title">${esc(lead)} ${code(target(input))}</p>${why ? `\n<p class="request-why">${why}</p>` : ''}
<div class="request-actions">
<button type="button" class="btn primary" data-answer="allow_once"${off}>${esc(t('allow_once'))}</button>
<button type="button" class="btn" data-answer="allow_always"${off}>${esc(t('allow_always'))}</button>
<button type="button" class="btn" data-answer="reject_once"${off}>${esc(t('deny'))}</button>
</div></div>`;
}

function toolRow(row: ToolRow, view: SessionView, t: Translate): string {
  const request = row.request;
  if (request?.state === 'waiting') return requestCard(row, request, view, t);
  const input = row.input;
  const kind = verb(input);
  const summary = resultSummary(row.output);
  const subs: string[] = [];
  if (input?.kind === 'edit') subs.push(counts(input.added, input.removed));
  if (summary) {
    const text = summary.key === 'passed' || summary.key === 'failed' ? t(summary.key === 'passed' ? 'result_count_ok' : 'result_failed', { n: summary.n ?? 0 }) : t(`result_${summary.key}`);
    subs.push(`<span class="${summary.tone === 'ok' ? 'ok' : 'bad'}">${esc(text)}</span>`);
  }
  if (request) subs.push(`<span class="decided">${esc(answerLine(request, view, t))}</span>`);
  const label = input && input.kind !== 'think' && input.kind !== 'switch_mode' && input.kind !== 'other'
    ? t(`verb_${input.kind}`) : t(input?.kind === 'think' ? 'verb_think' : 'verb_other', { tool: row.name });
  const shown = target(input);
  const title = input?.kind === 'execute' ? input.description : undefined;
  const body = `<div>${esc(label)}${shown ? ` ${code(shown, title)}` : ''}</div>${subs.length ? `<div class="sub">${subs.join(' · ')}</div>` : ''}`;
  const frameKind = kind === 'read' || kind === 'edit' ? kind : kind === 'execute' ? 'run' : 'tool';
  return rowFrame(frameKind, row.at, GLYPH[kind] ?? GLYPH.other as string, body, request?.decision === 'reject_once' || request?.decision === 'reject_always' ? ' refused' : '');
}

function rowHtml(row: Row, view: SessionView, t: Translate): string {
  switch (row.kind) {
    case 'read': {
      const [first = '', ...others] = row.paths;
      const more = others.length > 0 ? ` ${esc(t(others.length === 1 ? 'and_more_one' : 'and_more_other', { n: others.length }))}` : '';
      return rowFrame('read', row.at, GLYPH.read as string, `<div>${esc(t('verb_read'))} ${code(first)}${more}</div>`);
    }
    case 'tool':
      return toolRow(row, view, t);
    case 'message':
      return `<div class="bubble ${row.role}" data-row="message">${esc(row.text)}</div>`;
    case 'question': {
      const [first, ...others] = row.questions;
      const rest = others.map((q) => `<p>${esc(q.question)}</p>`).join('');
      const options = (first?.options ?? []).map((o) => `<li>${esc(o.label)}</li>`).join('');
      const footer = row.answeredBy !== undefined
        ? `<p class="q-foot">${esc(t('question_answered', { who: who(row.answeredBy, view, t) }))}</p>`
        : `<p class="q-foot"><a href="/inbox">${esc(t('question_open'))}</a></p>`;
      return `<div class="request question" data-row="question" data-request-id="${esc(row.requestId)}"><p class="request-title">${esc(first?.question ?? '')}</p>${rest}${options ? `<ul class="options">${options}</ul>` : ''}${footer}</div>`;
    }
    case 'denied': {
      const key = `rule_${row.rule.replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace('secret_read', 'read_private')}`;
      const named = row.rule ? known(t, key) : undefined;
      const text = named !== undefined ? t('refused', { rule: named }) : row.rule ? t('refused_rule', { rule: row.rule }) : t('refused_plain');
      return rowFrame('denied', row.at, '⊘', `<div>${esc(text)}</div>`, ' refused');
    }
    case 'interrupted':
      return rowFrame('interrupted', row.at, '■', `<div>${esc(t('row_interrupted'))}</div>`);
    case 'error':
      return rowFrame('error', row.at, '!', `<div class="bad">${esc(row.message)}</div>`, ' refused');
    case 'verdict':
      return rowFrame('verdict', row.at, '✓', `<div>${esc(t(row.verdict === 'changes_requested' ? 'verdict_changes' : 'verdict_ok', { round: row.round }))}</div>`);
  }
}

export function renderTimeline(view: SessionView, t: Translate): string {
  const rows = timeline(view.model);
  return rows.length === 0 ? `<p class="empty">${esc(t('timeline_empty'))}</p>` : rows.map((row) => rowHtml(row, view, t)).join('\n');
}

export function renderLeft(view: SessionView, t: Translate): string {
  const ticket = view.ticket;
  const parsed = parseCriteria(ticket?.body ?? '');
  const criteria = parsed.criteria.length === 0
    ? `<p class="faint small">${esc(t('criteria_none'))}</p>`
    : `<ul class="criteria">${parsed.criteria.map((c) => `<li class="${c.done ? 'crit-done' : 'crit-open'}"><span class="mark" aria-hidden="true">${c.done ? '✓' : '○'}</span><span>${esc(c.text)}</span><span class="sr-only">${esc(t(c.done ? 'criterion_done' : 'criterion_open'))}</span></li>`).join('')}</ul>`;
  return `<section class="card" aria-labelledby="ticket-title">
<p class="eyebrow">${esc(t('ticket_label'))} <span class="id">${esc(view.summary.ticket)}</span></p>
<h2 id="ticket-title" class="card-title">${esc(ticket?.title ?? view.summary.ticket)}</h2>
${parsed.description.map((p) => `<p class="desc">${esc(p)}</p>`).join('')}
</section>
<section class="card" aria-labelledby="criteria-title"><h3 id="criteria-title" class="card-label">${esc(t('criteria_title'))}</h3>${criteria}</section>
<section class="card" aria-labelledby="plan-title"><h3 id="plan-title" class="card-label">${esc(t('plan_title'))}</h3><p class="faint small">${esc(t('plan_empty'))}</p></section>`;
}

export function renderRight(view: SessionView, t: Translate): string {
  const state = view.model.state;
  const files = state?.files ?? [];
  const checks = state?.checks ?? [];
  const steps = stepsOf(view.model);
  const changes = files.length === 0
    ? `<p class="faint small">${esc(t('changes_none'))}</p>`
    : `<ul class="changes">${files.map((f) => `<li><span class="path">${esc(f.path)}</span><span>${counts(f.added, f.removed)}</span></li>`).join('')}</ul>`;
  const checkList = checks.length === 0 ? '' : `<ul class="checks">${checks.map((c) => `<li><span class="light ${esc(c.state)}" aria-hidden="true"></span><span>${esc(c.name)}</span><span class="state">· ${esc(t(`check_${c.state}`))}</span></li>`).join('')}</ul>`;
  const stepList = steps.length === 0 ? '' : `<h4 class="card-label sub-label">${esc(t('steps_title'))}</h4><ul class="steps">${steps.map((step) => {
    const open = step.finishedAt === null;
    const end = open ? view.now.getTime() : Date.parse(step.finishedAt as string);
    return `<li><span>${esc(t(`step_${step.name}`))}</span><span class="faint">${esc(duration(end - Date.parse(step.startedAt), t))}${open ? ` · ${esc(t('step_running'))}` : ''}</span></li>`;
  }).join('')}</ul>`;
  return `<section class="card" aria-labelledby="changes-title"><h3 id="changes-title" class="card-label">${esc(t('changes_title'))}</h3>${changes}</section>
<section class="card" aria-labelledby="checks-title"><h3 id="checks-title" class="card-label">${esc(t('checks_title'))}</h3>${checkList || `<p class="faint small">${esc(t('checks_none'))}</p>`}${stepList}</section>
<section class="card" aria-labelledby="screen-title"><h3 id="screen-title" class="card-label">${esc(t('screen_title'))}</h3><p class="empty-box">${esc(t('screen_empty'))}</p></section>`;
}

export function renderCrumbs(view: SessionView, t: Translate): string {
  const latest = (role: 'author' | 'reviewer') => view.siblings.filter((s) => s.role === role).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  const tab = (role: 'author' | 'reviewer') => {
    const found = latest(role);
    if (!found) return `<span class="tab" aria-disabled="true">${esc(t(`tab_${role}_waiting`))}</span>`;
    const label = esc(t(`tab_${role}`, { model: family(found.model) }));
    return found.id === view.summary.id
      ? `<a class="tab current" href="/sessions/${esc(found.id)}" aria-current="page">${label}</a>`
      : `<a class="tab" href="/sessions/${esc(found.id)}">${label}</a>`;
  };
  return `<nav class="crumbs" aria-label="${esc(t('crumbs_label'))}"><a href="/">${esc(t('crumb_tower'))}</a><span class="sep" aria-hidden="true">/</span><span class="here">${esc(view.ticket?.title ?? view.summary.ticket)}</span><span class="id">${esc(view.summary.ticket)}</span></nav>
<div class="tabs">${tab('author')}${tab('reviewer')}</div>`;
}

export function renderComposer(view: SessionView, t: Translate): string {
  const off = ENDED.has(phaseOf(view)) ? ' disabled' : '';
  const role = view.summary.role === 'reviewer' ? 'reviewer' : 'author';
  return `<form class="composer" id="composer" autocomplete="off">
<input id="message" name="text" placeholder="${esc(t(`composer_${role}`))}" aria-label="${esc(t(`composer_${role}`))}"${off}>
<button type="button" class="btn" id="handover" aria-disabled="true" aria-describedby="handover-note" title="${esc(t('handover_note'))}">${esc(t('handover'))}</button>
<button type="button" class="btn" id="interrupt"${off}>${esc(t('interrupt'))}</button>
<button type="submit" class="btn primary" id="send"${off}>${esc(t('send'))}</button>
</form>
<span class="sr-only" id="handover-note">${esc(t('handover_note'))}</span>
<p class="composer-note" id="composer-note" role="status"></p>`;
}

export function renderSession(view: SessionView, t: Translate): string {
  return `<div class="session-top" id="crumbs">${renderCrumbs(view, t)}</div>
<div class="session">
<aside class="s-left" id="s-left" aria-label="${esc(t('left_label'))}">${renderLeft(view, t)}</aside>
<section class="panel" aria-label="${esc(t('timeline_label'))}">
<div class="panel-head" id="status">${renderStatus(view, t)}</div>
<div class="timeline" id="timeline" tabindex="0">${renderTimeline(view, t)}</div>
<div class="panel-foot">${renderComposer(view, t)}</div>
</section>
<aside class="s-right" id="s-right" aria-label="${esc(t('right_label'))}">${renderRight(view, t)}</aside>
</div>`;
}

export function renderIndex(data: { readonly sessions: readonly SessionSummary[]; readonly tickets: readonly Ticket[]; readonly now: Date }, t: Translate): string {
  const titles = new Map(data.tickets.map((ticket) => [ticket.id, ticket.title]));
  const minutes = (from: string) => Math.max(0, Math.floor((data.now.getTime() - Date.parse(from)) / 60_000));
  const ordered = [...data.sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const cards = ordered.map((s) => {
    const square = s.harness === 'claude-code' ? 'claude' : s.harness === 'codex' ? 'codex' : 'other';
    const status = s.phase === 'waiting_human' ? t('status_waiting_human') : s.status;
    return `<li class="session-card">
<span class="session-head"><span class="live${s.phase === 'waiting_human' ? ' waiting' : s.role === 'reviewer' ? ' review' : ''}" aria-hidden="true"></span><span class="role">${esc(t(`role_${s.role}`))}</span><span class="id">${esc(s.ticket)}</span></span>
<span class="session-title">${esc(titles.get(s.ticket) ?? s.ticket)}</span>
<span class="phrase">${esc(status)}</span>
<span class="session-foot"><span class="model"><span class="sq ${square}" aria-hidden="true"></span>${esc(formatModel(s.harness, s.model))}</span><span class="elapsed">${esc(t('minutes', { n: minutes(s.startedAt) }))}</span><a class="open" href="/sessions/${esc(s.id)}">${esc(t('open_session'))}</a></span>
</li>`;
  });
  return `<div class="index"><h1>${esc(t('index_title'))}</h1>${cards.length === 0 ? `<p class="empty">${esc(t('index_empty'))}</p>` : `<ul class="sessions">${cards.join('')}</ul>`}</div>`;
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

// Reads a session's stream from `after`. The service names each event by its
// AG-UI type, so a listener per type. When the stream drops it is closed and
// reopened after the last seq seen, never with the old `?after=`, and an
// event whose seq was already seen is not delivered twice.
export function follow(options: {
  readonly url: (after: number) => string;
  readonly after: number;
  readonly open: (url: string) => StreamLike;
  readonly later: (run: () => void, ms: number) => void;
  readonly onEvent: (event: SessionEvent) => void;
}): Follower {
  let last = options.after;
  let stopped = false;
  let current: StreamLike | undefined;
  let wait = RETRY_MS;

  const connect = () => {
    if (stopped) return;
    const stream = options.open(options.url(last));
    current = stream;
    const hear = (message: { data: string }) => {
      let event: SessionEvent;
      try { event = JSON.parse(message.data) as SessionEvent; }
      catch { return; }
      if (typeof event.seq !== 'number' || event.seq <= last) return;
      last = event.seq;
      wait = RETRY_MS;
      options.onEvent(event);
    };
    for (const name of EVENT_NAMES) stream.addEventListener(name, hear);
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

// ------------------------------------------------------------------- mount

const REFRESH_MS = 10_000;
const TICK_MS = 20_000;

function ensureStylesheet(): void {
  if (document.head.querySelector('link[data-screen="session"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/screens/session.css';
  link.dataset.screen = 'session';
  document.head.append(link);
}

function mountIndex(root: HTMLElement, context: ScreenContext): () => void {
  const { t } = context;
  let stopped = false;
  const refresh = async () => {
    try {
      const [sessions, tickets] = await Promise.all([context.api<SessionSummary[]>('/sessions'), context.api<Ticket[]>('/tickets')]);
      if (!stopped) root.innerHTML = renderIndex({ sessions, tickets, now: context.now() }, t);
    } catch {
      if (!stopped) root.innerHTML = `<div class="index"><p class="empty error">${esc(t('load_failed'))}</p></div>`;
    }
  };
  void refresh();
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function mount(root: HTMLElement, context: ScreenContext): () => void {
  ensureStylesheet();
  const id = context.path.split('/')[2];
  if (!id) return mountIndex(root, context);
  const { t } = context;
  let stopped = false;
  let stopStream: (() => void) | undefined;
  const timers: ReturnType<typeof setInterval>[] = [];

  root.innerHTML = `<div class="session-top"></div><div class="session" aria-busy="true"></div>`;

  void (async () => {
    let view: SessionView;
    try {
      const [detail, all] = await Promise.all([context.api<SessionSummary & { state: SessionState }>(`/sessions/${encodeURIComponent(id)}`), context.api<SessionSummary[]>('/sessions')]);
      const ticket = await context.api<Ticket>(`/tickets/${encodeURIComponent(detail.ticket)}`).catch(() => undefined);
      const model = emptyModel();
      model.state = structuredClone(detail.state);
      view = { summary: detail, model, ticket, siblings: all.filter((s) => s.ticket === detail.ticket), me: context.me.user.id, language: context.me.language, now: context.now() };
    } catch {
      if (!stopped) root.innerHTML = `<div class="index"><p class="empty error">${esc(t('load_failed'))}</p></div>`;
      return;
    }
    if (stopped) return;
    root.innerHTML = renderSession(view, t);
    const $ = <E extends HTMLElement>(selector: string) => root.querySelector<E>(selector)!;
    const timelineEl = $('#timeline');
    const note = $('#composer-note');
    const input = $<HTMLInputElement>('#message');
    const send = $<HTMLButtonElement>('#send');
    const interrupt = $<HTMLButtonElement>('#interrupt');
    let first = true;

    const busy = new Set<string>();                  // answers on their way: their buttons stay disabled across redraws
    const say = (text: string) => { note.textContent = text; };
    const draw = () => {
      if (stopped) return;
      view = { ...view, now: context.now(), busy };
      const wasAtEnd = first || timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight < 80;
      timelineEl.innerHTML = renderTimeline(view, t);
      if (wasAtEnd) timelineEl.scrollTop = timelineEl.scrollHeight;
      first = false;
      $('#status').innerHTML = renderStatus(view, t);
      $('#s-right').innerHTML = renderRight(view, t);
      const off = ENDED.has(phaseOf(view));
      input.disabled = off;
      send.disabled = off;
      interrupt.disabled = off;
    };
    let scheduled = false;
    const soon = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; draw(); });
    };

    const handle = follow({
      url: (after) => `/api/service/sessions/${encodeURIComponent(id)}/events?after=${after}`,
      after: 0,
      open: (url) => new EventSource(url) as unknown as StreamLike,
      later: (run, ms) => { setTimeout(run, ms); },
      onEvent: (event) => { if (applyEvent(view.model, event)) soon(); },
    });
    stopStream = () => handle.stop();
    draw();
    $('.session').removeAttribute('aria-busy');

    const post = async (path: string, body: unknown, failure: string): Promise<boolean> => {
      try {
        await context.api(`/sessions/${encodeURIComponent(id)}${path}`, { method: 'POST', body });
        say('');
        return true;
      } catch {
        say(t(failure));
        return false;
      }
    };

    $('#composer').addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      send.disabled = true;
      if (await post('/messages', { text }, 'send_failed')) input.value = '';
      send.disabled = ENDED.has(phaseOf(view));
      input.focus();
    });
    interrupt.addEventListener('click', async () => {
      interrupt.disabled = true;
      await post('/interrupt', null, 'interrupt_failed');
      interrupt.disabled = ENDED.has(phaseOf(view));
    });
    $('#handover').addEventListener('click', () => say(t('handover_note')));
    timelineEl.addEventListener('click', async (event) => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-answer]');
      const card = button?.closest<HTMLElement>('[data-request-id]');
      if (!button || !card) return;
      const kind = button.dataset.answer;
      const decision: Decision = kind === 'allow_once' ? { kind: 'allow_once' }
        : kind === 'allow_always' ? { kind: 'allow_always', scope: 'project' }
        : { kind: 'reject_once', message: t('deny_message') };
      const requestId = card.dataset.requestId ?? '';
      if (busy.has(requestId)) return;
      busy.add(requestId);
      draw();
      if (await post(`/requests/${encodeURIComponent(requestId)}/answer`, { decision }, 'answer_failed')) context.inboxChanged();
      else { busy.delete(requestId); draw(); }
    });

    // The reviewer's session appears once it starts; the clock moves on.
    timers.push(setInterval(async () => {
      try {
        const all = await context.api<SessionSummary[]>('/sessions');
        view = { ...view, siblings: all.filter((s) => s.ticket === view.summary.ticket) };
        $('#crumbs').innerHTML = renderCrumbs(view, t);
      } catch { /* the next tick tries again */ }
    }, REFRESH_MS));
    timers.push(setInterval(draw, TICK_MS));
  })();

  return () => {
    stopped = true;
    stopStream?.();
    for (const timer of timers) clearInterval(timer);
  };
}
