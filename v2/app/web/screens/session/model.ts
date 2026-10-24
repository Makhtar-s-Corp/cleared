// The session screen (session.png): a ticket's author or reviewer session,
// live. The model adds the stored events up into rows, a state and a list of
// what waits for the human; the wording functions say them. Both are pure,
// so the tests run them under Node. agent.ts follows the service's stream
// into the model for CopilotKit, and Session.tsx draws what the agent holds.
//
// The browser may only `import type` from v2/src, so the names of the AG-UI
// subset are copied here and a test keeps the copy equal to EVENT_TYPES.
import type { Interrupt } from '@ag-ui/core';
import type { SessionPlan, SessionSummary, TakenOver, TicketStep } from '../../../../src/api/types.ts';
import type { Decision } from '../../../../src/session/contract.ts';
import type { AgUiEvent, CustomValue, JsonPatchOperation, Question, SessionEvent, SessionPhase, SessionState, ToolInput, ToolOutput } from '../../../../src/session/events.ts';
import type { Verdict } from '../../../../src/session/policy.ts';
import type { Ticket } from '../../../../src/tickets/contract.ts';
import type { ChoiceStatus } from '../../components/choices/model.ts';
import type { Filter, TicketPart } from './ticket.ts';
import { hasMark, type Translate } from '../../lib/i18n.ts';
import { sessionStatus } from '../../lib/status.ts';
import { clock, count, lasted } from '../../lib/time.ts';

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

// The author's host call that proposes its session plan: the plan's own
// row says it (lane 17's cleared.session_plan), so the call is not a row.
const PLAN_TOOL = 'mcp__cleared__propose_session_plan';

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
export type QuestionRow = {
  readonly kind: 'question'; readonly id: string; readonly requestId: string; readonly at: string; readonly questions: readonly Question[];
  answeredBy?: string;
  cancelled?: boolean;                              // the turn was interrupted while it waited
};
export type ReadRow = { readonly kind: 'read'; readonly at: string; readonly paths: readonly string[] };
// Consecutive edits of one file nobody was asked about, as one row (lane 36, Devin's merged edits).
export type EditsRow = {
  readonly kind: 'edits'; readonly at: string; readonly path: string; readonly added: number; readonly removed: number;
  readonly count: number; readonly ids: readonly string[];
  readonly each: readonly { readonly at: string; readonly added: number; readonly removed: number }[];   // every edit, for the Editor's last turn
};
// A message of the ticket's review channel (issue 291): the reviewer's
// request or the author's answer, with how long the request waited for it
// when this session logged both.
export type ChannelRow = {
  readonly kind: 'channel'; readonly at: string; readonly from: 'reviewer' | 'author'; readonly round: number; readonly limit: number; readonly text: string;
  readonly afterMs?: number;
};
// A ticket resumed from a step (issue #272): on the session left, where
// the ticket went on; on the new session, where it came from.
export type ReplayRow = { readonly kind: 'replay'; readonly at: string; readonly side: 'left' | 'resumed' } & CustomValue['cleared.replay'];
// `seq`: the stored event that began the row, which Resume from here names.
export type Row = (
  | ToolRow
  | ReadRow
  | EditsRow
  | MessageRow
  | QuestionRow
  | { readonly kind: 'denied'; readonly at: string; readonly requestId: string; readonly rule: string }
  | { readonly kind: 'interrupted'; readonly at: string }
  | { readonly kind: 'error'; readonly at: string; readonly message: string }
  | { readonly kind: 'verdict'; readonly at: string; readonly verdict: 'pass' | 'changes_requested'; readonly round: number }
  | ChannelRow
  | { readonly kind: 'plan'; readonly at: string; readonly confidence: SessionPlan['confidence']; readonly go: SessionPlan['go'] }
  | ReplayRow
) & { readonly seq?: number };

// The tip of the author's branch the flow journaled (issue #272), at its event's seq.
export type Checkpoint = CustomValue['cleared.checkpoint'] & { readonly seq: number };

export type Step = { name: SessionState['steps'][number]['name']; startedAt: string; finishedAt: string | null };

// A step as the Checks card shows it: every span of that step added up. The
// author works again after a review, and the wait for the human comes back
// at each request, so a step can happen several times in one session.
export type StepTotal = { readonly name: Step['name']; readonly startedAt: string; readonly ms: number; readonly count: number; readonly open: boolean };

export type SessionModel = {
  lastSeq: number;
  lastAt: string | undefined;                       // the time of the last event seen
  state: SessionState | undefined;
  readonly rows: Exclude<Row, ReadRow | EditsRow>[];
  readonly turns: string[];                         // when each turn started (RUN_STARTED), for the Editor's last turn
  pending: string[];                                // request ids (permissions and questions) that wait for the human
  readonly steps: Step[];                           // from STEP_STARTED and STEP_FINISHED, each span
  readonly tools: Map<string, ToolRow>;
  readonly texts: Map<string, MessageRow>;
  readonly requests: Map<string, ToolRow>;
  readonly questions: Map<string, QuestionRow>;
  plan: SessionPlan | null;                         // the last cleared.session_plan: the proposal, or its Go
  readonly checkpoints: Checkpoint[];               // the author's branch at each move (issue #272)
};

export function emptyModel(): SessionModel {
  return { lastSeq: 0, lastAt: undefined, state: undefined, rows: [], turns: [], pending: [], steps: [], tools: new Map(), texts: new Map(), requests: new Map(), questions: new Map(), plan: null, checkpoints: [] };
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
  const count = model.rows.length;
  addEvent(model, stored, at, event);
  for (const row of model.rows.slice(count)) (row as { seq?: number }).seq ??= stored.seq;
  return true;
}

function addEvent(model: SessionModel, stored: SessionEvent, at: string, event: AgUiEvent): void {
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
      model.steps.push({ name: event.stepName, startedAt: at, finishedAt: null });
      break;
    case 'STEP_FINISHED': {
      const step = model.steps.findLast((s) => s.name === event.stepName && s.finishedAt === null);
      if (step) step.finishedAt = at;
      else model.steps.push({ name: event.stepName, startedAt: at, finishedAt: at });
      break;
    }
    case 'RUN_STARTED':
      model.turns.push(at);
      break;
    case 'RUN_FINISHED':
      if (event.outcome.type === 'cancelled') model.rows.push({ kind: 'interrupted', at });
      break;
    case 'RUN_ERROR':
      model.rows.push({ kind: 'error', at, message: event.message });
      break;
    case 'CUSTOM':
      custom(model, stored, at, event);
      break;
    default:
      break;                                        // TEXT_MESSAGE_END, TOOL_CALL_END, REASONING_*: nothing to show
  }
}

function custom(model: SessionModel, stored: SessionEvent, at: string, event: Extract<AgUiEvent, { type: 'CUSTOM' }>): void {
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
      const asked = model.questions.get(requestId);
      if (asked) {
        // A question settled without an answer: the adapters cancel a
        // waiting question this way when its turn is interrupted.
        if (decision === 'cancelled') asked.cancelled = true;
        model.pending = model.pending.filter((id) => id !== requestId);
      } else if (row?.request) {
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
    case 'cleared.review_channel': {
      const { from, round, limit, text } = event.value;
      const asked = from === 'author' ? [...model.rows].reverse().find((row): row is ChannelRow => row.kind === 'channel' && row.from === 'reviewer' && row.round === round) : undefined;
      model.rows.push({ kind: 'channel', at, from, round, limit, text, ...(asked ? { afterMs: Math.max(0, Date.parse(at) - Date.parse(asked.at)) } : {}) });
      break;
    }
    case 'cleared.session_plan':
      model.plan = event.value;
      model.rows.push({ kind: 'plan', at, confidence: event.value.confidence, go: event.value.go });
      break;
    case 'cleared.checkpoint':
      model.checkpoints.push({ ...event.value, seq: stored.seq });
      break;
    case 'cleared.replay':
      model.rows.push({ kind: 'replay', at, side: stored.sessionId === event.value.from ? 'left' : 'resumed', ...event.value });
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

// An edit nobody was asked about, which did not fail: one that merges.
const quietEdit = (row: Row): row is ToolRow & { readonly seq?: number; input: Extract<ToolInput, { kind: 'edit' }> } =>
  row.kind === 'tool' && row.input?.kind === 'edit' && !row.request && !(row.output && 'ok' in row.output && !row.output.ok);

const asEdits = (row: Row): EditsRow | undefined => (row.kind === 'edits' ? row
  : quietEdit(row) ? {
    kind: 'edits', at: row.at, path: row.input.path, added: row.input.added, removed: row.input.removed, count: 1, ids: [row.id],
    each: [{ at: row.at, added: row.input.added, removed: row.input.removed }], ...(row.seq === undefined ? {} : { seq: row.seq }),
  } : undefined);

// The rows as the screen shows them: the ticket's prompt and empty messages
// left out, consecutive reads that nobody was asked about as one row, and
// consecutive edits of one file as one row with their sum (lane 36).
export function timeline(model: SessionModel): Row[] {
  const out: Row[] = [];
  for (const row of model.rows) {
    if (row.kind === 'message' && (row.by === PROMPT_AUTHOR || !row.text.trim())) continue;
    if (row.kind === 'tool' && row.name === PLAN_TOOL) continue;
    const previous = out[out.length - 1];
    if (row.kind === 'tool' && row.input?.kind === 'read' && !row.request) {
      if (previous?.kind === 'read') out[out.length - 1] = { ...previous, paths: [...previous.paths, row.input.path] };
      else out.push({ kind: 'read', at: row.at, paths: [row.input.path], ...(row.seq === undefined ? {} : { seq: row.seq }) });
      continue;
    }
    if (quietEdit(row)) {
      const before = previous && asEdits(previous);
      if (before?.path === row.input.path) {
        out[out.length - 1] = {
          ...before, added: before.added + row.input.added, removed: before.removed + row.input.removed, count: before.count + 1, ids: [...before.ids, row.id],
          each: [...before.each, { at: row.at, added: row.input.added, removed: row.input.removed }],
        };
        continue;
      }
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

// The steps the screen shows, each the sum of its spans: the spans the STEP_*
// events told, then those only the state has. A span both know is the
// events', which are newer than a snapshot taken while it ran.
export function stepsOf(model: { readonly steps: readonly Step[]; readonly state: SessionState | undefined }, now: number): readonly StepTotal[] {
  const spans = new Map<string, Step>();
  for (const step of model.steps) spans.set(`${step.name} ${step.startedAt}`, step);
  for (const step of model.state?.steps ?? []) if (!spans.has(`${step.name} ${step.startedAt}`)) spans.set(`${step.name} ${step.startedAt}`, step);
  const totals = new Map<string, { name: Step['name']; startedAt: string; ms: number; count: number; open: boolean }>();
  for (const span of [...spans.values()].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))) {
    const end = span.finishedAt === null ? now : Date.parse(span.finishedAt);
    const total = totals.get(span.name) ?? { name: span.name, startedAt: span.startedAt, ms: 0, count: 0, open: false };
    total.ms += Math.max(0, end - Date.parse(span.startedAt));
    total.count += 1;
    total.open ||= span.finishedAt === null;
    totals.set(span.name, total);
  }
  return [...totals.values()];
}

// ------------------------------------------------------------------ thread

// A question that waits, as the thread's interrupt in AG-UI's shape: its id
// is the request's, and its metadata keeps the questions exactly as the
// harness asked them (AskUserQuestion's header, options, multiSelect).
export type QuestionInterrupt = Interrupt & {
  readonly reason: 'cleared.question';
  readonly message: string;
  readonly metadata: { readonly questions: readonly Question[] };
};

// What the session's agent holds for the screen (agent.ts): the rows as the
// timeline shows them, the state, what waits, the questions that wait as
// interrupts, and the steps. Plain data, as an AG-UI state snapshot carries it.
export type SessionThread = {
  readonly lastSeq: number;
  readonly lastAt: string | undefined;
  readonly state: SessionState | undefined;
  readonly rows: readonly Row[];
  readonly turns: readonly string[];
  readonly pending: readonly string[];
  readonly interrupts: readonly QuestionInterrupt[];
  readonly steps: readonly Step[];
  readonly plan: SessionPlan | null;
  readonly checkpoints: readonly Checkpoint[];
};

export function interruptsOf(model: SessionModel): QuestionInterrupt[] {
  return model.pending.flatMap((id) => {
    const row = model.questions.get(id);
    return row ? [{ id, reason: 'cleared.question' as const, message: row.questions[0]?.question ?? '', metadata: { questions: row.questions } }] : [];
  });
}

export function threadOf(model: SessionModel): SessionThread {
  return {
    lastSeq: model.lastSeq, lastAt: model.lastAt, state: model.state, rows: timeline(model), turns: [...model.turns], pending: [...model.pending], interrupts: interruptsOf(model), steps: [...model.steps], plan: model.plan,
    checkpoints: [...model.checkpoints],
  };
}

// The commit a step of the thread began from (issue #272): the last
// checkpoint before the row's first event, else the session's first, which
// the flow read before the session started; the service's own rule
// (src/flow/replay.ts stepCommit), which a test keeps the same.
export function stepCommit(checkpoints: readonly Checkpoint[], seq: number): Checkpoint | undefined {
  return checkpoints.findLast((c) => c.seq < seq) ?? checkpoints[0];
}

// The longest corrected instruction, as the service takes it (src/flow/replay.ts MAX_REPLAY).
export const REPLAY_MAX = 2000;

// A commit as the thread names it: its first twelve characters.
export const shortCommit = (commit: string): string => commit.slice(0, 12);

// ------------------------------------------------------------------ wording

export type SessionView = {
  readonly summary: SessionSummary;
  readonly thread: SessionThread;
  readonly ticket: Ticket | undefined;
  readonly siblings: readonly SessionSummary[];           // the sessions of the same ticket, this one included
  readonly me: string;                                    // the signed-in user's id
  readonly language: 'en' | 'fr';
  readonly now: Date;
  readonly busy?: ReadonlySet<string>;                    // request ids whose answer is on its way
  readonly answers?: ReadonlyMap<string, LocalAnswer>;     // what this tab knows of its questions' answers
  readonly takenOver?: TakenOver | null;                  // what this tab knows of the take over, newer than the summary's
  readonly steps?: readonly TicketStep[] | null;          // the ticket's steps across services (lane 27); absent until read
  // The view of the ticket (lane 36, ticket.ts): its sessions with their
  // threads, this one among them, and the thread's filter. Absent: this
  // session alone, the whole thread.
  readonly parts?: readonly TicketPart[];
  readonly filter?: Filter;
  readonly unfolded?: ReadonlySet<string>;               // the ticket's sessions this view saw live: never folded
};

// Who took the session over (decision 30, lane 20): what this tab knows,
// else what the service said; null when nobody did.
export const takenOverOf = (view: Pick<SessionView, 'takenOver' | 'summary'>): TakenOver | null =>
  (view.takenOver !== undefined ? view.takenOver : view.summary.takenOver) ?? null;

// The stored events say who answered a question, not with what: what this
// tab sent is kept here, and an answer that came after the question no
// longer waited is settled.
export type LocalAnswer =
  | { readonly kind: 'sent'; readonly sent: string; readonly chosen: readonly string[] }
  | { readonly kind: 'settled' };

export const ENDED: ReadonlySet<SessionPhase> = new Set(['done', 'stopped', 'failed']);
export { clock };

export function family(model: string): string {
  const match = /(opus|sonnet|haiku|fable)/i.exec(model);
  return match ? (match[1] as string).charAt(0).toUpperCase() + (match[1] as string).slice(1).toLowerCase() : model;
}

// "42 s", "18 min", "1 h 30", "2 j 4 h": the app's one formatter (lib/time.ts).
export const duration = lasted;

// A catalog sentence for a key that may not exist (a rule the catalog has not met).
// The translator marks a missing key rather than throwing (lane 34, U10).
export function known(t: Translate, key: string, values?: Record<string, string | number>): string | undefined {
  try {
    const text = t(key, values);
    return hasMark(text) ? undefined : text;
  } catch { return undefined; }
}

export const phaseOf = (view: SessionView): SessionPhase => view.thread.state?.phase ?? view.summary.phase;

export function statusTone(view: SessionView): 'waiting' | 'progress' | 'review' | 'ended' | 'paused' {
  const phase = phaseOf(view);
  if (ENDED.has(phase)) return 'ended';
  if (takenOverOf(view)) return 'paused';
  if (phase === 'waiting_human' && (view.thread.pending.length > 0 || view.thread.plan?.go === null)) return 'waiting';
  return phase === 'reviewing' ? 'review' : 'progress';
}

export function phrase(view: SessionView, t: Translate): string {
  const phase = phaseOf(view);
  const taken = ENDED.has(phase) ? null : takenOverOf(view);
  if (taken) return t(taken.by === view.me ? 'status_taken_over_you' : 'status_taken_over_other');
  if (phase === 'waiting_human') return t(view.thread.pending.length > 0 ? 'status_waiting_human' : view.thread.plan?.go === null ? 'status_waiting_go' : 'status_idle');
  return sessionStatus({ phase, status: view.thread.state?.status || view.summary.status }, t);
}

// "18 min · 35,500 tokens": how long the session ran, and what it used.
export function statusMeta(view: SessionView, t: Translate): string {
  const ended = ENDED.has(phaseOf(view));
  const end = ended ? Date.parse(view.thread.lastAt ?? view.summary.updatedAt) : view.now.getTime();
  const time = duration(end - Date.parse(view.summary.startedAt), t);
  const usage = view.thread.state?.usage ?? {};
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return tokens > 0 ? t('elapsed_usage', { time, tokens: count(tokens, view.language) }) : t('elapsed_only', { time });
}

export function who(by: string | undefined, view: Pick<SessionView, 'me'>, t: Translate): string {
  if (by === 'policy') return t('who_policy');
  return by === view.me ? t('who_you') : t('who_other');
}

// What a question of the timeline is now, for the clickable answers.
export function questionStatus(row: QuestionRow, view: SessionView, t: Translate): ChoiceStatus {
  const local = view.answers?.get(row.requestId);
  if (local?.kind === 'sent') return { kind: 'answered', who: t('who_you'), sent: local.sent, chosen: local.chosen };
  if (row.cancelled) return { kind: 'cancelled' };
  if (row.answeredBy !== undefined) return { kind: 'answered', who: who(row.answeredBy, view, t) };
  if (local?.kind === 'settled') return { kind: 'settled' };
  if (ENDED.has(phaseOf(view))) return { kind: 'ended' };
  if (view.thread.interrupts.some((i) => i.id === row.requestId)) return { kind: 'waiting', busy: view.busy?.has(row.requestId) ?? false };
  return { kind: 'read' };
}

export function answerLine(request: RequestState, view: Pick<SessionView, 'me'>, t: Translate): string {
  switch (request.decision) {
    case 'allow_once': return t('answer_allow_once', { who: who(request.by, view, t) });
    case 'allow_always': return t('answer_allow_always', { who: who(request.by, view, t) });
    case 'reject_once': case 'reject_always': return t('answer_deny', { who: who(request.by, view, t) });
    case 'cancelled': return t('answer_cancelled');
    default: return '';
  }
}

export function target(input: ToolInput | undefined): string {
  if (!input) return '';
  switch (input.kind) {
    case 'read': case 'edit': case 'delete': case 'move': return input.path;
    case 'execute': return input.command;
    case 'search': return input.pattern;
    case 'fetch': return input.target;
    default: return '';
  }
}

export function verb(input: ToolInput | undefined): string {
  return input && input.kind !== 'think' && input.kind !== 'switch_mode' && input.kind !== 'other' ? input.kind : 'other';
}

// What a refusal by the policy says: the rule by its catalog name when the
// catalog knows it, else by its own name.
export function refusal(rule: string, t: Translate): string {
  const key = `rule_${rule.replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace('secret_read', 'read_private')}`;
  const named = rule ? known(t, key) : undefined;
  return named !== undefined ? t('refused', { rule: named }) : rule ? t('refused_rule', { rule }) : t('refused_plain');
}

// What the session answer route is given for a question: the answers keyed
// by the question's text, each label as the harness wrote it.
export function answerBody(answers: Readonly<Record<string, string>>): { readonly decision: Decision } {
  return { decision: { kind: 'answer', answers: { ...answers } } };
}

// The decision a permission's answer button sends.
export function decisionOf(kind: string | undefined, t: Translate): Decision {
  return kind === 'allow_once' ? { kind: 'allow_once' }
    : kind === 'allow_always' ? { kind: 'allow_always', scope: 'project' }
    : { kind: 'reject_once', message: t('deny_message') };
}

// The latest session of a role on the ticket, for the Author and Reviewer tabs.
export function latestOf(siblings: readonly SessionSummary[], role: 'author' | 'reviewer'): SessionSummary | undefined {
  return siblings.filter((s) => s.role === role).sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
}

// ------------------------------------------------------------------ stream

// The part of EventSource the follower uses, so a test can stand in for it.
export interface StreamLike {
  addEventListener(name: string, listener: (event: { data: string }) => void): void;
  close(): void;
  onerror: (() => void) | null;
}

export type Follower = { stop(): void; lastSeq(): number };

export const RETRY_MS = 1500;
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
