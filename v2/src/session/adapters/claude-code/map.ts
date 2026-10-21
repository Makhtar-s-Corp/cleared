// The runner's lines, mapped to the event subset (milestone 1 plan,
// section 4). One mapper per session; it keeps what the events need across
// lines: whether a turn runs, each tool call's kind and path, the requests
// that wait for a human, the files changed and the usage so far. Its events
// go to the cleaner next, which has the last word on every payload.
//
// The SDK frames read here, as Claude Code 2.1.306 printed them through the
// runner (test/session/claude-code/fixtures):
//   command_lifecycle  state 'started' for each user message a turn takes,
//                      with the message's uuid as command_uuid
//   system/init        at the start of every turn
//   assistant          one content block per frame: text, thinking, tool_use
//   user               tool_result blocks, with the tool's own output in
//                      tool_use_result (a read's file, a command's stdout)
//   result             the end of the turn: per-turn usage, the session's
//                      total cost and its usage per model so far
// Everything else (rate_limit_event, hook and status frames) maps to nothing.
import type { RunnerOutput } from '../../../../images/session/runner/main.ts';
import type { Answer, SessionId, StopReason } from '../../contract.ts';
import { toolArgs, toolResult, type AgUiEvent, type Question, type SessionPhase, type SessionState, type ToolInput, type ToolOutput, type Usage } from '../../events.ts';
import type { ToolRequest, Verdict } from '../../policy.ts';

export const WORKDIR = '/workspace';

type PermissionLine = Extract<RunnerOutput, { type: 'permission_request' }>;
type QuestionLine = Extract<RunnerOutput, { type: 'question' }>;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

// A path as the session screen shows it: relative to the workdir when inside it.
function shown(path: unknown): string {
  const text = str(path) ?? '';
  if (text === WORKDIR) return '.';
  return text.startsWith(`${WORKDIR}/`) ? text.slice(WORKDIR.length + 1) : text;
}

const lines = (text: unknown): string[] => {
  const value = str(text) ?? '';
  if (value === '') return [];
  const parts = value.split('\n');
  return value.endsWith('\n') ? parts.slice(0, -1) : parts;
};

// Lines added and removed by replacing `before` with `after`: what is left
// once the lines both share at the start and at the end are set aside.
function counts(before: unknown, after: unknown): { added: number; removed: number } {
  const a = lines(before);
  const b = lines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { removed: a.length - start - end, added: b.length - start - end };
}

// The cleaned-to-be input of a tool call, by Claude Code's tool name
// (section 3's ToolKind column).
export function toolInput(name: string, input: Record<string, unknown>): ToolInput {
  switch (name) {
    case 'Read':
      return { kind: 'read', path: shown(input.file_path) };
    case 'Edit':
      return { kind: 'edit', path: shown(input.file_path), ...counts(input.old_string, input.new_string) };
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits.map(record).filter((edit) => edit !== undefined) : [];
      const total = edits.map((edit) => counts(edit.old_string, edit.new_string)).reduce((sum, c) => ({ added: sum.added + c.added, removed: sum.removed + c.removed }), { added: 0, removed: 0 });
      return { kind: 'edit', path: shown(input.file_path), ...total };
    }
    case 'Write':
      return { kind: 'edit', path: shown(input.file_path), added: lines(input.content).length, removed: 0 };
    case 'NotebookEdit':
      return { kind: 'edit', path: shown(input.notebook_path), added: lines(input.new_source).length, removed: 0 };
    case 'Bash': {
      const command = str(input.command) ?? '';
      const description = str(input.description);
      return description === undefined ? { kind: 'execute', command } : { kind: 'execute', command, description };
    }
    case 'Glob': case 'Grep':
      return typeof input.path === 'string' ? { kind: 'search', pattern: str(input.pattern) ?? '', path: shown(input.path) } : { kind: 'search', pattern: str(input.pattern) ?? '' };
    case 'WebFetch':
      return { kind: 'fetch', target: str(input.url) ?? '' };
    case 'WebSearch':
      return { kind: 'fetch', target: str(input.query) ?? '' };
    case 'TodoWrite':
      return { kind: 'think' };
    default:
      return { kind: 'other' };
  }
}

// What the policy evaluates for a permission request.
export function toolRequest(line: PermissionLine): ToolRequest {
  return { tool: line.toolName, input: line.input };
}

function statusOf(name: string, input: ToolInput): string {
  const short = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);
  switch (input.kind) {
    case 'read': return `Reading ${input.path}`;
    case 'edit': return `Editing ${input.path}`;
    case 'execute': return `Running ${short(input.command)}`;
    case 'search': return `Searching for ${short(input.pattern)}`;
    case 'fetch': return `Fetching ${short(input.target)}`;
    case 'think': return 'Planning';
    default: return `Using ${name}`;
  }
}

// A tool result's text: a string, or the text blocks of a list.
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(record).map((block) => (block?.type === 'text' ? str(block.text) ?? '' : '')).join('');
}

const STOP_REASONS: ReadonlySet<string> = new Set<StopReason>(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']);

function turnUsage(model: string, usage: Record<string, unknown> | undefined): Usage {
  const value: Record<string, unknown> = { model };
  const set = (key: keyof Usage, from: unknown) => { if (num(from) !== undefined) value[key] = from; };
  set('inputTokens', usage?.input_tokens);
  set('outputTokens', usage?.output_tokens);
  set('cachedInputTokens', usage?.cache_read_input_tokens);
  set('cacheWriteInputTokens', usage?.cache_creation_input_tokens);
  return value as Usage;
}

function sessionUsage(model: string, perModel: Record<string, unknown> | undefined): Usage | undefined {
  const usage = record(perModel?.[model]);
  if (!usage) return undefined;
  const value: Record<string, unknown> = { model };
  const set = (key: keyof Usage, from: unknown) => { if (num(from) !== undefined) value[key] = from; };
  set('inputTokens', usage.inputTokens);
  set('outputTokens', usage.outputTokens);
  set('cachedInputTokens', usage.cacheReadInputTokens);
  set('cacheWriteInputTokens', usage.cacheCreationInputTokens);
  return value as Usage;
}

// The questions as the inbox shows them; anything unreadable is left out.
function questionsOf(value: unknown): Question[] {
  if (!Array.isArray(value)) return [];
  return value.map(record).flatMap((q): Question[] => {
    const question = str(q?.question);
    if (q === undefined || question === undefined) return [];
    const options = Array.isArray(q.options)
      ? q.options.map(record).flatMap((o) => {
        const label = str(o?.label);
        if (label === undefined) return [];
        const description = str(o?.description);
        return [description === undefined ? { label } : { label, description }];
      })
      : undefined;
    return [{
      question,
      ...(str(q.header) === undefined ? {} : { header: str(q.header) }),
      ...(options === undefined ? {} : { options }),
      ...(typeof q.multiSelect === 'boolean' ? { multiSelect: q.multiSelect } : {}),
    }];
  });
}

export type Mapper = {
  // The session's first event: its state.
  start(model: string): AgUiEvent[];
  // A message the app sent, as the timeline shows it.
  userMessage(messageId: string, text: string, by: string): AgUiEvent[];
  // A runner line other than a request: an SDK frame, a cancelled request, an error, the exit.
  line(line: RunnerOutput): AgUiEvent[];
  // A permission request with the policy's verdict: only an `ask` shows.
  permissionRequest(line: PermissionLine, verdict: Verdict): AgUiEvent[];
  question(line: QuestionLine): AgUiEvent[];
  answered(requestId: string, answer: Answer): AgUiEvent[];
  // The adapter asked the runner to interrupt: the turn's result is a cancel.
  interrupting(): void;
  // A copy of the state, for a STATE_SNAPSHOT on reconnect.
  state(): SessionState;
};

export function createMapper(options: { readonly sessionId: SessionId }): Mapper {
  const { sessionId } = options;
  let model = '';
  let run: string | undefined;                    // the running turn's id
  let runs = 0;
  let interrupted = false;
  const calls = new Map<string, { name: string; input: ToolInput }>();
  const waiting = new Set<string>();              // asked requests and questions
  const questions = new Set<string>();
  let state: SessionState = { status: 'Starting', phase: 'starting', steps: [], files: [], checks: [], usage: {} };

  // A STATE_DELTA replacing these fields, and the state updated.
  function change(values: Partial<Pick<SessionState, 'status' | 'phase' | 'files' | 'usage'>>): AgUiEvent {
    state = { ...state, ...values };
    return { type: 'STATE_DELTA', delta: Object.entries(values).map(([key, value]) => ({ op: 'replace', path: `/${key}`, value })) };
  }
  const working = () => change({ phase: 'working', status: 'Working' });

  function begin(runId: string | undefined): AgUiEvent[] {
    if (run !== undefined) return [];
    runs++;
    run = runId ?? `${sessionId}-run-${runs}`;
    interrupted = false;
    return [{ type: 'RUN_STARTED', threadId: sessionId, runId: run }, working()];
  }

  function end(events: AgUiEvent[], phase: SessionPhase, status: string, usage?: Usage): AgUiEvent[] {
    run = undefined;
    interrupted = false;
    return [...events, change(usage === undefined ? { phase, status } : { phase, status, usage })];
  }

  function assistant(frame: Record<string, unknown>): AgUiEvent[] {
    const uuid = str(frame.uuid) ?? `${sessionId}-${runs}`;
    const content = record(frame.message)?.content;
    const events: AgUiEvent[] = [];
    (Array.isArray(content) ? content : []).forEach((raw, index) => {
      const block = record(raw);
      const messageId = `${uuid}-${index}`;
      if (block?.type === 'text') {
        events.push(
          { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: str(block.text) ?? '' },
          { type: 'TEXT_MESSAGE_END', messageId },
        );
      } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        events.push({ type: 'REASONING_START', messageId }, { type: 'REASONING_END', messageId });
      } else if (block?.type === 'tool_use') {
        const toolCallId = str(block.id) ?? messageId;
        const name = str(block.name) ?? 'unknown';
        const input = toolInput(name, record(block.input) ?? {});
        calls.set(toolCallId, { name, input });
        events.push(
          { type: 'TOOL_CALL_START', toolCallId, toolCallName: name },
          toolArgs(toolCallId, input),
          { type: 'TOOL_CALL_END', toolCallId },
          change({ status: statusOf(name, input) }),
        );
      }
    });
    return events;
  }

  function toolResults(frame: Record<string, unknown>): AgUiEvent[] {
    const uuid = str(frame.uuid) ?? `${sessionId}-${runs}`;
    const content = record(frame.message)?.content;
    const own = record(frame.tool_use_result);
    const events: AgUiEvent[] = [];
    (Array.isArray(content) ? content : []).forEach((raw, index) => {
      const block = record(raw);
      if (block?.type !== 'tool_result') return;
      const toolCallId = str(block.tool_use_id) ?? '';
      const call = calls.get(toolCallId);
      const isError = block.is_error === true;
      const text = resultText(block.content);
      let output: ToolOutput;
      if (call?.input.kind === 'read') {
        const file = str(record(own?.file)?.content);
        output = { kind: 'read', path: call.input.path, bytes: Buffer.byteLength(file ?? text) };
      } else if (call?.input.kind === 'execute') {
        const stdout = str(own?.stdout);
        const stderr = str(own?.stderr) ?? '';
        const shownOutput = stdout === undefined ? text : stderr ? `${stdout}\n${stderr}` : stdout;
        output = { kind: 'execute', output: shownOutput, cut: 0, isError };
      } else {
        const kind = call?.input.kind ?? 'other';
        output = isError ? { kind, ok: false, error: text } : { kind, ok: true };
      }
      events.push(toolResult(`${uuid}-${index}`, toolCallId, output));
      if (call?.input.kind === 'edit' && !isError) {
        const { path, added, removed } = call.input;
        const before = state.files.find((file) => file.path === path);
        const files = before
          ? state.files.map((file) => (file.path === path ? { path, added: file.added + added, removed: file.removed + removed } : file))
          : [...state.files, { path, added, removed }];
        events.push(change({ files }));
      }
    });
    return events;
  }

  function result(frame: Record<string, unknown>): AgUiEvent[] {
    const runId = run ?? `${sessionId}-run-${runs}`;
    const perModel = record(frame.modelUsage);
    const usedModel = Object.keys(perModel ?? {})[0] ?? model;
    const usage = turnUsage(usedModel, record(frame.usage));
    const total = sessionUsage(usedModel, perModel) ?? usage;
    const cost = typeof frame.total_cost_usd === 'number' ? frame.total_cost_usd : null;
    const subtype = str(frame.subtype);
    const finished = (stopReason: StopReason, outcome: 'success' | 'cancelled'): AgUiEvent =>
      ({ type: 'RUN_FINISHED', threadId: sessionId, runId, outcome: { type: outcome }, usage: [usage], result: { stopReason, total_cost_usd: cost } });
    const waitingForMessage = (event: AgUiEvent) => end([event], 'waiting_human', 'Waiting for a message', total);

    if (interrupted) return waitingForMessage(finished('cancelled', 'cancelled'));
    if (subtype === 'success' && frame.is_error !== true) {
      const reason = str(frame.stop_reason) ?? 'end_turn';
      return waitingForMessage(finished((STOP_REASONS.has(reason) ? reason : 'end_turn') as StopReason, 'success'));
    }
    if (subtype === 'error_max_turns') return waitingForMessage(finished('max_turn_requests', 'success'));
    if (subtype === 'error_max_budget_usd')
      return end([{ type: 'RUN_ERROR', message: 'the session reached its budget', code: 'max_budget_usd' }], 'failed', 'Stopped: budget reached', total);
    const errors = Array.isArray(frame.errors) ? frame.errors.filter((e): e is string => typeof e === 'string') : [];
    const message = subtype === 'success' ? str(frame.result) ?? 'the model answered with an error' : errors.join('; ') || (subtype ?? 'the turn failed');
    return waitingForMessage({ type: 'RUN_ERROR', message, code: subtype === 'success' ? 'api_error' : subtype ?? 'error' });
  }

  function sdk(message: unknown): AgUiEvent[] {
    const frame = record(message);
    if (!frame) return [];
    switch (frame.type) {
      case 'command_lifecycle':
        return frame.state === 'started' ? begin(str(frame.command_uuid)) : [];
      case 'system':
        return frame.subtype === 'init' ? begin(Array.isArray(frame.user_message_uuids) ? str(frame.user_message_uuids.at(-1)) : undefined) : [];
      case 'assistant':
        return [...begin(undefined), ...assistant(frame)];
      case 'user':
        return [...begin(undefined), ...toolResults(frame)];
      case 'result':
        return [...begin(undefined), ...result(frame)];
      default:
        return [];
    }
  }

  // A request no longer waits: the session works again when none does.
  function settled(requestId: string): AgUiEvent[] {
    const was = waiting.delete(requestId);
    questions.delete(requestId);
    return was && waiting.size === 0 ? [working()] : [];
  }

  return {
    start(name) {
      model = name;
      state = { ...state, usage: { model } };
      return [{ type: 'STATE_SNAPSHOT', snapshot: state }];
    },
    userMessage(messageId, text, by) {
      return [
        { type: 'TEXT_MESSAGE_START', messageId, role: 'user', name: by },
        { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text },
        { type: 'TEXT_MESSAGE_END', messageId },
      ];
    },
    line(line) {
      switch (line.type) {
        case 'sdk':
          return sdk(line.message);
        case 'request_cancelled':
          return [
            { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: line.requestId, decision: 'cancelled', by: 'policy', rule: 'interrupt' } },
            ...settled(line.requestId),
          ];
        case 'error':
          return [{ type: 'RUN_ERROR', message: line.message, code: 'runner' }];
        case 'exit': {
          if (line.code !== 0) return end([{ type: 'RUN_ERROR', message: `the runner exited with code ${line.code}`, code: 'runner_exit' }], 'failed', 'Stopped on an error');
          const open: AgUiEvent[] = run === undefined ? [] : [{
            type: 'RUN_FINISHED', threadId: sessionId, runId: run, outcome: { type: 'cancelled' }, usage: [], result: { stopReason: 'cancelled', total_cost_usd: null },
          }];
          return end(open, 'stopped', 'Stopped');
        }
        default:
          return [];
      }
    },
    permissionRequest(line, verdict) {
      if (verdict.decision !== 'ask') return [];
      waiting.add(line.requestId);
      return [
        { type: 'CUSTOM', name: 'cleared.permission_request', value: { requestId: line.requestId, toolCallId: line.toolUseId, tool: line.toolName, input: toolInput(line.toolName, line.input), suggestion: verdict } },
        change({ phase: 'waiting_human', status: 'Waiting for you' }),
      ];
    },
    question(line) {
      waiting.add(line.requestId);
      questions.add(line.requestId);
      return [
        { type: 'CUSTOM', name: 'cleared.question', value: { requestId: line.requestId, questions: questionsOf(line.questions) } },
        change({ phase: 'waiting_human', status: 'Waiting for you' }),
      ];
    },
    answered(requestId, answer) {
      const event: AgUiEvent = questions.has(requestId) && answer.by !== 'policy'
        ? { type: 'CUSTOM', name: 'cleared.answered', value: { requestId, by: answer.by } }
        : { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId, decision: answer.decision.kind, by: answer.by, ...(answer.rule === undefined ? {} : { rule: answer.rule }) } };
      return [event, ...settled(requestId)];
    },
    interrupting() {
      if (run !== undefined) interrupted = true;
    },
    state() {
      return state;
    },
  };
}
