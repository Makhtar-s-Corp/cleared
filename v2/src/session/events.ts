// The events a session produces: a fixed subset of AG-UI 1.0, with Cleared's
// own items as CUSTOM events (docs/v2/milestone-1-plan.md, section 4). Field
// names are AG-UI's, as @ag-ui/core 1.0.3 declares them; where AG-UI carries
// a string (TOOL_CALL_ARGS delta, TOOL_CALL_RESULT content), Cleared puts
// the JSON of a typed value in it, read back with readToolInput and
// readToolOutput. Nothing here depends on @ag-ui/core at run time; a test
// checks every type name against its EventType.
import type { PublishFailureCode } from '../flow/publish-failure.ts';
import type { ChangesReport, HumanEdit, ProductionCheck, SessionPlan, TerminalMode } from '../api/types.ts';
import type { Decision, Harness, SessionId, StopReason, ToolKind, UserId } from './contract.ts';
import type { Verdict } from './policy.ts';

export const EVENT_TYPES = [
  'RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR',
  'STEP_STARTED', 'STEP_FINISHED',
  'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END',
  'TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END', 'TOOL_CALL_RESULT',
  'REASONING_START', 'REASONING_END',
  'STATE_SNAPSHOT', 'STATE_DELTA',
  'CUSTOM',
] as const;
export type EventTypeName = (typeof EVENT_TYPES)[number];

const SUBSET: ReadonlySet<string> = new Set(EVENT_TYPES);
export function isSubsetType(type: string): type is EventTypeName {
  return SUBSET.has(type);
}

// The measured steps of the proof (section 1). `plan_gate`: the author's
// session plan waiting for its Go, between two `author` steps, so that it
// is counted apart from the working time (milestone 2 replanned, decision 22).
export const STEP_NAMES = ['workspace', 'author', 'waiting_human', 'review', 'approval', 'release', 'watch', 'plan_gate'] as const;
export type StepName = (typeof STEP_NAMES)[number];

export const CUSTOM_NAMES = [
  'cleared.permission_request',
  'cleared.permission_answered',
  'cleared.question',
  'cleared.answered',
  'cleared.review_verdict',
  'cleared.handover_captured',
  // Milestone 2 (docs/v2/milestone-2-plan.md, section 3.1).
  'cleared.host_call',
  'cleared.context_usage',
  'cleared.compacted',
  'cleared.rate_limit',
  'cleared.lead_refreshed',
  // The replanned milestone 2 (docs/v2/milestone-2-plan.md, lane 17): the
  // author's session plan and its report of its changes (decisions 22 and
  // 23), journaled by the flow; the web terminal and the human's edits
  // (decisions 32 and 33), which lane 31 emits.
  'cleared.session_plan',
  'cleared.changes',
  'cleared.terminal_opened',
  'cleared.terminal_input',
  'cleared.terminal_closed',
  'cleared.human_edit',
  // Milestone 3 (issue 291): a message of a ticket's author-reviewer
  // channel, journaled by the flow on the sender's session and the receiver's.
  'cleared.review_channel',
  // Milestone 3 (issue #272): the tip of the author's branch, journaled by
  // the flow at the start and after a tool call that moved it; and a ticket
  // resumed from a step, journaled on the session left and on the new one.
  'cleared.checkpoint',
  'cleared.replay',
  // Milestone 3 (M4, lane j3-contract-notes): a note a step's session left
  // for the ticket's other steps, and the notes a session was handed.
  'cleared.step_note',
  'cleared.step_notes_read',
  // Milestone 3 (B6.3, P152): an author's work handed to the other harness,
  // journaled by the flow on the session left and on the new one.
  'cleared.handed_over',
  // Milestone 3 (P210, issue #326): the proof receipt's captures of a
  // service, journaled by the flow on the author's session when it is done.
  'cleared.proof_captured',
  // Milestone 3 (P218, issue #334): the production page of a service,
  // checked once the release landed healthy, journaled by the flow on the
  // session the release was approved on.
  'cleared.production_checked',
  // Milestone 5 (C15, issue #422): the session waits for its service's
  // prepared image, built because what it holds changed.
  'cleared.prepared_image',
  // Issue #501: the step of its plan the author says it has reached.
  'cleared.plan_step',
  // Issue #507: the review passed and the publication failed.
  'cleared.publish_failed',
  // Milestone 6 (issue #453): the flow recreated the session's container
  // after it stopped, and resumed the session in it.
  'cleared.container_recreated',
] as const;
export type CustomName = (typeof CUSTOM_NAMES)[number];

// A tool call's input after cleaning: what the session screen shows, and no
// more. A read is its path, an edit its path and counts, a command its text.
export type ToolInput =
  | { readonly kind: 'read'; readonly path: string }
  | { readonly kind: 'edit'; readonly path: string; readonly added: number; readonly removed: number }
  | { readonly kind: 'delete' | 'move'; readonly path: string }
  | { readonly kind: 'execute'; readonly command: string; readonly description?: string }
  | { readonly kind: 'search'; readonly pattern: string; readonly path?: string }
  | { readonly kind: 'fetch'; readonly target: string }  // a URL, or a search query
  | { readonly kind: 'think' | 'switch_mode' | 'other' };

// A tool call's result after cleaning. A read never keeps the content of the
// file; a command keeps its output, cut to COMMAND_OUTPUT_LIMIT (clean.ts),
// `cut` saying how many characters went.
export type ToolOutput =
  | { readonly kind: 'read'; readonly path: string; readonly bytes: number }
  | { readonly kind: 'execute'; readonly output: string; readonly cut: number; readonly isError: boolean }
  | { readonly kind: Exclude<ToolKind, 'read' | 'execute'>; readonly ok: boolean; readonly error?: string };

// AG-UI's TokenUsage fields that the SDK's result gives.
export type Usage = {
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
};

export type SessionPhase = 'starting' | 'working' | 'waiting_human' | 'reviewing' | 'done' | 'stopped' | 'failed';
// The phases of a session that runs: the flow's, and the doctor's orphans line.
export const LIVE_PHASES: ReadonlySet<string> = new Set<SessionPhase>(['starting', 'working', 'waiting_human', 'reviewing']);

// The STATE_SNAPSHOT of a session: what the session screen shows above its timeline.
export type SessionState = {
  readonly status: string;                                 // the status phrase, for example 'Running the tests'
  readonly phase: SessionPhase;
  readonly steps: readonly { readonly name: StepName; readonly startedAt: string; readonly finishedAt: string | null }[];
  readonly files: readonly { readonly path: string; readonly added: number; readonly removed: number }[];
  readonly checks: readonly { readonly name: string; readonly state: 'pending' | 'passed' | 'failed' }[];
  readonly usage: Usage;
  readonly context?: ContextShare;                         // milestone 2: the last measure of the session's context
};

// How much of its context window a session uses, as the harness measures it.
export type ContextShare = { readonly percent: number; readonly totalTokens: number; readonly maxTokens: number };

// RFC 6902, as AG-UI's STATE_DELTA carries it.
export type JsonPatchOperation =
  | { readonly op: 'add' | 'replace' | 'test'; readonly path: string; readonly value: unknown }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'move' | 'copy'; readonly path: string; readonly from: string };

// A question as the harness asks it.
export type Question = {
  readonly question: string;
  readonly header?: string;
  readonly options?: readonly { readonly label: string; readonly description?: string }[];
  readonly multiSelect?: boolean;
};

export type CustomValue = {
  'cleared.permission_request': { readonly requestId: string; readonly toolCallId: string; readonly tool: string; readonly input: ToolInput; readonly suggestion: Verdict };
  'cleared.permission_answered': { readonly requestId: string; readonly decision: Decision['kind']; readonly by: UserId | 'policy'; readonly rule?: string };
  'cleared.question': { readonly requestId: string; readonly questions: readonly Question[] };
  'cleared.answered': { readonly requestId: string; readonly by: UserId };
  // `tests`: the reviewer's run of the service's declared test command
  // (issue #268, flow/review-tests.ts), read from its session's events; none
  // when the service declares no test command.
  'cleared.review_verdict': {
    readonly session: SessionId; readonly verdict: 'pass' | 'changes_requested'; readonly round: number;
    readonly tests?: { readonly command: string; readonly outcome: 'passed' | 'failed' | 'unclear' | 'not_run'; readonly tail?: string };
  };
  'cleared.handover_captured': { readonly path: string };
  // A call of a host tool (session/contract.ts, HostTool), its input cleaned.
  // `message` is the refusal said to the model, or a generic line for a failure.
  'cleared.host_call': { readonly toolCallId: string; readonly name: string; readonly input: unknown; readonly outcome: 'ok' | 'refused' | 'failed'; readonly message?: string };
  // The harness's measure after a turn or a tool call: tokens in the
  // context, the window (rawMaxTokens before the harness's own reserve), the
  // share in percent, and where and whether the harness compacts on its own.
  'cleared.context_usage': ContextShare & { readonly rawMaxTokens?: number; readonly autoCompactThreshold?: number; readonly isAutoCompactEnabled: boolean };
  // The harness compacted its context on its own; recorded, never relied on.
  'cleared.compacted': { readonly trigger: 'manual' | 'auto'; readonly preTokens: number; readonly postTokens?: number };
  // A usage window the harness reports (the seven-day one is the week share).
  'cleared.rate_limit': { readonly window: 'five_hour' | 'seven_day'; readonly usedPercent: number; readonly resetsAt: string | null };
  // On the old generation's session: the lead goes on in a new one.
  'cleared.lead_refreshed': { readonly generation: number; readonly reason: 'handover_point' | 'threshold' | 'restart' | 'failed'; readonly handoverId: string };
  // The author's session plan as proposed (`go` null), then again when it
  // gets its Go, with who and when: the last one is the plan.
  'cleared.session_plan': SessionPlan;
  // The step the author says it starts (report_plan_step, issue #501), from
  // one, and how many its plan held: the session screen reads the last one.
  'cleared.plan_step': { readonly step: number; readonly total: number };
  // Why the publication failed (flow/publish-failure.ts), the service it failed
  // on in a workspace of several, and the error's words, cleaned, for the fold.
  'cleared.publish_failed': { readonly code: PublishFailureCode; readonly service: string | null; readonly detail: string };
  // The author's report of its changes by intent, as report_changes kept it
  // (the files no group named under "Other changes").
  'cleared.changes': ChangesReport;
  // The web terminal of a session taken over (decision 32): who opened it
  // and its size; each line typed, at its Enter or at the close, through the
  // cleaner as a whole; why it closed and how many bytes it wrote. The
  // output itself is never stored.
  'cleared.terminal_opened': { readonly by: UserId; readonly cols: number; readonly rows: number; readonly mode?: TerminalMode };   // mode: what ran (owner request of 2026-10-22 17:26)
  'cleared.terminal_input': { readonly by: UserId; readonly line: string };
  'cleared.terminal_closed': { readonly by: UserId | 'system'; readonly reason: 'give_back' | 'idle' | 'closed' | 'exit'; readonly outputBytes: number };
  // A file a human changed in the checkout (decision 33): never its content.
  'cleared.human_edit': Omit<HumanEdit, 'at'>;
  // A message of the ticket's author-reviewer channel (issue 291): the
  // reviewer's request for change or the author's answer, cleaned, with the
  // round it belongs to and the rounds the flow allows (`limit`).
  'cleared.review_channel': { readonly round: number; readonly limit: number; readonly from: 'reviewer' | 'author'; readonly text: string };
  // The commit the author's branch points at (issue #272), read from the
  // checkout's files without git: a step of the thread resumes from the last
  // one journaled before it.
  'cleared.checkpoint': { readonly commit: string; readonly branch: string };
  // A ticket resumed from a step (issue #272, flow/replay.ts): the session
  // left (`from`) and the step (`seq`, the first event of the step's row),
  // the commit the new branch starts at, the new session (`to`), who asked
  // and the corrected instruction, cleaned. The same value on both sessions.
  // A note a step's session left for the other steps of its ticket
  // (flow/notes.ts), cleaned: `id` is `<session>:<n>`, `step` the position
  // and `service` the service of the step that left it.
  'cleared.step_note': { readonly id: string; readonly step: number; readonly service: string; readonly text: string };
  // The notes a step's session was handed, by id: at its start or when it
  // was reopened, so a note reaches a session once.
  'cleared.step_notes_read': { readonly ids: readonly string[] };
  'cleared.replay': {
    readonly from: SessionId; readonly to: SessionId; readonly seq: number; readonly commit: string; readonly branch: string; readonly previous: string;
    readonly by: UserId; readonly message: string;
  };
  // An author handed over to the other harness (flow/engine.ts, handOver):
  // the session left, the one that carries on, who asked. The same value on both.
  'cleared.handed_over': {
    readonly from: { readonly session: SessionId; readonly harness: Harness; readonly model: string };
    readonly to: { readonly session: SessionId; readonly harness: Harness; readonly model: string };
    readonly by: UserId;
  };
  // The captures of the proof receipt (flow/proof-capture.ts): the files'
  // names in the ticket's proof folder, and what was not taken, by its code.
  // `need` (P226, flow/capture-need.ts): whether the change needed them and
  // why, with the screens it touches; absent before the rule, or when the
  // flow has no reader of the diff.
  'cleared.proof_captured': {
    readonly service: string;
    readonly before?: string; readonly after?: string; readonly video?: string; readonly videoMs?: number;
    readonly missing: readonly { readonly part: 'before' | 'after' | 'video'; readonly reason: 'no_browser' | 'no_before' | 'no_after' | 'failed' }[];
    readonly need?: { readonly take: boolean; readonly reason: 'screens' | 'no_screen' | 'forced_on' | 'forced_off' | 'unread'; readonly screens: readonly string[] };
  };
  // The production page's check (api/types.ts ProductionCheck): the address
  // without its query, the capture's name in the ticket's proof folder or why
  // there is none.
  'cleared.production_checked': ProductionCheck;
  'cleared.prepared_image': { readonly service: string; readonly state: 'waiting' };
  // Which recreation of the session it was, of how many the flow makes, and
  // how long the flow waited before it. A new process of the harness starts
  // here; Claude Code's running total goes on from the transcript, and
  // consumption/ticket-cost.ts reads a total that starts again as a new process.
  'cleared.container_recreated': { readonly attempt: number; readonly limit: number; readonly waitedMs: number };
};

type Base = { readonly timestamp?: number };
type Custom = { [N in CustomName]: Base & { readonly type: 'CUSTOM'; readonly name: N; readonly value: CustomValue[N] } }[CustomName];

export type AgUiEvent =
  | Base & { readonly type: 'RUN_STARTED'; readonly threadId: SessionId; readonly runId: string }
  | Base & {
    readonly type: 'RUN_FINISHED';
    readonly threadId: SessionId;
    readonly runId: string;
    readonly outcome: { readonly type: 'success' } | { readonly type: 'cancelled' };
    readonly usage: readonly Usage[];
    readonly result: { readonly stopReason: StopReason; readonly total_cost_usd: number | null };
  }
  | Base & { readonly type: 'RUN_ERROR'; readonly message: string; readonly code?: string }
  | Base & { readonly type: 'STEP_STARTED' | 'STEP_FINISHED'; readonly stepName: StepName }
  | Base & { readonly type: 'TEXT_MESSAGE_START'; readonly messageId: string; readonly role: 'assistant' | 'user'; readonly name?: UserId }
  | Base & { readonly type: 'TEXT_MESSAGE_CONTENT'; readonly messageId: string; readonly delta: string }
  | Base & { readonly type: 'TEXT_MESSAGE_END'; readonly messageId: string }
  | Base & { readonly type: 'TOOL_CALL_START'; readonly toolCallId: string; readonly toolCallName: string; readonly parentMessageId?: string }
  | Base & { readonly type: 'TOOL_CALL_ARGS'; readonly toolCallId: string; readonly delta: string }
  | Base & { readonly type: 'TOOL_CALL_END'; readonly toolCallId: string }
  | Base & { readonly type: 'TOOL_CALL_RESULT'; readonly messageId: string; readonly toolCallId: string; readonly content: string; readonly role: 'tool' }
  | Base & { readonly type: 'REASONING_START' | 'REASONING_END'; readonly messageId: string }
  | Base & { readonly type: 'STATE_SNAPSHOT'; readonly snapshot: SessionState }
  | Base & { readonly type: 'STATE_DELTA'; readonly delta: readonly JsonPatchOperation[] }
  | Custom;

export type ToolArgsEvent = Extract<AgUiEvent, { type: 'TOOL_CALL_ARGS' }>;
export type ToolResultEvent = Extract<AgUiEvent, { type: 'TOOL_CALL_RESULT' }>;

// The envelope of every stored event. seq counts from 1 per session; the app
// sends the last one it has back to resume a stream.
export type SessionEvent = {
  readonly seq: number;
  readonly at: string;
  readonly sessionId: SessionId;
  readonly ticket: string;
  readonly project: string;
  readonly event: AgUiEvent;
};

// Where events are kept (store/db.ts keeps them in ledger.db).
export interface EventLog {
  append(entry: Omit<SessionEvent, 'seq'>): SessionEvent;
  after(sessionId: SessionId, seq?: number): SessionEvent[];
}

export function toolArgs(toolCallId: string, input: ToolInput): ToolArgsEvent {
  return { type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify(input) };
}

export function toolResult(messageId: string, toolCallId: string, output: ToolOutput): ToolResultEvent {
  return { type: 'TOOL_CALL_RESULT', messageId, toolCallId, content: JSON.stringify(output), role: 'tool' };
}

const KINDS: ReadonlySet<string> = new Set<ToolKind>(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);

// The JSON object a string carries with a known `kind`, or undefined.
function kindObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    return typeof record.kind === 'string' && KINDS.has(record.kind) ? record : undefined;
  } catch {
    return undefined;
  }
}

// What the ARGS of a tool call say, when they say it in Cleared's form.
export function readToolInput(event: ToolArgsEvent): ToolInput | undefined {
  return kindObject(event.delta) as ToolInput | undefined;
}

// The typed result. The cleaner writes every stored result in this form, so
// for a stored event it never falls back.
export function readToolOutput(event: ToolResultEvent): ToolOutput {
  return (kindObject(event.content) as ToolOutput | undefined) ?? { kind: 'other', ok: true };
}
