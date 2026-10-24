// Codex's `codex exec --json` lines, mapped to the session events
// (docs/adapters.md, Codex). The stream recorded on this server on
// 2026-10-21 (docs/adapters.md, proofs 7 and 8) has:
//   thread.started     the thread's id (thread_id), resumed by the next turn
//   turn.started       the turn begins
//   item.completed     an agent_message item: the answer's text
//   turn.completed     the end of the turn, with `usage`: input_tokens,
//                      cached_input_tokens, cache_write_input_tokens,
//                      output_tokens, reasoning_output_tokens; NO cost
// and, from the documentation and the TypeScript SDK's item types, NOT
// recorded here: item.started / item.updated / item.completed for the items
// command_execution (command, aggregated_output, exit_code, status),
// file_change (changes: [{ path, kind: add | delete | update }], status),
// mcp_tool_call (server, tool, arguments, status), web_search (query),
// reasoning, todo_list, error; turn.failed ({ error: { message } }) and a
// top-level error ({ message }).
//
// Usage. Codex counts the cached input inside input_tokens and the reasoning
// inside output_tokens (a rollout's total_tokens is input_tokens plus
// output_tokens), while the Consumption screen adds input, output, cache
// read and cache write (consumption/usage.ts). So the turn's usage says the
// input without its cached part, the cached part, and the output as it is:
// their sum is Codex's own total. total_cost_usd is null: nothing is
// estimated.
//
// Rate limits. The recorded exec stream carries none. Codex writes them in
// the thread's rollout file, on its token_count lines: `rate_limits` with a
// `primary` and a `secondary` window, each `used_percent` (a percent, not a
// fraction), `window_minutes` (300 is the five-hour window, 10080 the week)
// and `resets_at` (seconds). rateLimits() reads that shape wherever a line
// carries it (the adapter gives it the rollout's last token_count line).
//
// The mapper also turns each item into the Claude-shaped request the policy
// evaluates (policy.ts is harness-neutral by that name; B5.1d).
import { posix } from 'node:path';
import { WORKDIR_MOUNT } from '../../../container/session-runtime.ts';
import type { StopReason } from '../../contract.ts';
import { toolArgs, toolResult, type AgUiEvent, type CustomValue, type SessionPhase, type SessionState, type ToolInput, type ToolOutput, type Usage } from '../../events.ts';
import type { ToolRequest, Verdict } from '../../policy.ts';
import { toolInput } from '../claude-code/map.ts';

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export type CodexCall = { readonly callId: string; readonly kind: string; readonly request: ToolRequest };

// A path as the policy reads it: absolute, in the checkout when relative.
const absolute = (path: unknown): string => {
  const text = str(path) ?? '';
  return text.startsWith('/') ? posix.normalize(text) : posix.join(WORKDIR_MOUNT, text);
};

// Codex runs a command through a login shell (`bash -lc '<command>'`, the
// shape its documentation shows, not recorded here): the policy reads the
// command inside. Anything else is read as it is.
const WRAPPED = /^(?:\/usr\/bin\/|\/bin\/)?(?:ba|z)?sh\s+-l?c\s+(?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)")\s*$/s;

export function unwrapCommand(command: string): string {
  const match = WRAPPED.exec(command.trim());
  if (!match) return command;
  if (match[1] !== undefined) return match[1].replaceAll(`'\\''`, `'`);
  return (match[2] ?? '').replace(/\\(.)/gs, '$1');
}

const commandOf = (item: Record<string, unknown>): string => {
  const command = item.command;
  if (Array.isArray(command)) {
    const words = command.filter((word): word is string => typeof word === 'string');
    // ["bash", "-lc", "<command>"]: the command inside.
    if (words.length === 3 && /^(?:\/usr\/bin\/|\/bin\/)?(?:ba|z)?sh$/.test(words[0] ?? '') && /^-l?c$/.test(words[1] ?? '')) return words[2] ?? '';
    return words.join(' ');
  }
  return unwrapCommand(str(command) ?? '');
};

// The request of an item the policy has a say on, or undefined (a message,
// a reasoning, a todo list). A file_change names several files: one request
// per file, the first the policy does not allow decides.
export function codexCalls(item: Record<string, unknown>): CodexCall[] {
  const callId = str(item.id);
  const kind = str(item.type);
  if (callId === undefined || kind === undefined) return [];
  switch (kind) {
    case 'command_execution':
      return [{ callId, kind, request: { tool: 'Bash', input: { command: commandOf(item) } } }];
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes.map(record).filter((change) => change !== undefined) : [];
      return changes.map((change) => {
        const file_path = absolute(change.path);
        if (change.kind === 'delete') return { callId, kind, request: { tool: 'Delete', input: { file_path } } };
        if (change.kind === 'add') return { callId, kind, request: { tool: 'Write', input: { file_path, content: '' } } };
        return { callId, kind, request: { tool: 'Edit', input: { file_path, old_string: '', new_string: '' } } };
      });
    }
    case 'mcp_tool_call':
      return [{ callId, kind, request: { tool: `mcp__${str(item.server) ?? 'unknown'}__${str(item.tool) ?? 'unknown'}`, input: record(item.arguments) ?? {} } }];
    case 'web_search':
      return [{ callId, kind, request: { tool: 'WebSearch', input: { query: str(item.query) ?? '' } } }];
    default:
      return [];
  }
}

// A turn's usage as the Consumption screen adds it (see above).
export function usageOf(raw: unknown, model: string): Usage {
  const usage = record(raw);
  const input = num(usage?.input_tokens) ?? 0;
  const cached = num(usage?.cached_input_tokens) ?? 0;
  const written = num(usage?.cache_write_input_tokens) ?? 0;
  return {
    ...(model === '' ? {} : { model }),
    inputTokens: Math.max(0, input - cached - written),
    outputTokens: num(usage?.output_tokens) ?? 0,
    cachedInputTokens: cached,
    cacheWriteInputTokens: written,
  };
}

const WINDOWS: Readonly<Record<number, CustomValue['cleared.rate_limit']['window']>> = { 300: 'five_hour', 10080: 'seven_day' };

// The rate limit windows of a line that carries Codex's `rate_limits`, at
// its top, under `payload` (a rollout line) or under `payload.info`.
export function rateLimits(line: Record<string, unknown>): CustomValue['cleared.rate_limit'][] {
  const payload = record(line.payload);
  const limits = record(line.rate_limits) ?? record(payload?.rate_limits) ?? record(record(payload?.info)?.rate_limits);
  if (!limits) return [];
  return [limits.primary, limits.secondary].flatMap((raw) => {
    const window = record(raw);
    const minutes = num(window?.window_minutes);
    const used = num(window?.used_percent);
    const name = minutes === undefined ? undefined : WINDOWS[minutes];
    if (name === undefined || used === undefined) return [];
    const resets = num(window?.resets_at);
    return [{ window: name, usedPercent: Math.round(used * 10) / 10, resetsAt: resets === undefined ? null : new Date(resets * 1000).toISOString() }];
  });
}

function statusOf(input: ToolInput, name: string): string {
  const short = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);
  switch (input.kind) {
    case 'edit': return `Editing ${input.path}`;
    case 'delete': return `Deleting ${input.path}`;
    case 'execute': return `Running ${short(input.command)}`;
    case 'fetch': return `Searching the web for ${short(input.target)}`;
    default: return `Using ${name}`;
  }
}

const inputOf = (request: ToolRequest): ToolInput =>
  request.tool === 'Delete' ? { kind: 'delete', path: str(request.input.file_path) ?? '' } : toolInput(request.tool, request.input as Record<string, unknown>);

export type CodexMapper = {
  start(model: string): AgUiEvent[];
  userMessage(messageId: string, text: string, by: string): AgUiEvent[];
  // The turn begins when the adapter starts the process.
  beginTurn(): AgUiEvent[];
  line(line: Record<string, unknown>): AgUiEvent[];
  // The windows read after a turn, said only when they changed.
  rateLimits(line: Record<string, unknown>): AgUiEvent[];
  // The guard stopped the turn on this call (policy.ts verdict, or no channel to ask on).
  blocked(callId: string, verdict: Verdict, message: string): AgUiEvent[];
  // The process ended without turn.completed.
  turnFailed(message: string, code: string): AgUiEvent[];
  // The turn ended because it was interrupted or the session stopped.
  cancelled(phase: 'waiting_human' | 'stopped', status: string): AgUiEvent[];
  state(): SessionState;
  turn(): string | undefined;
};

export function createCodexMapper(options: { readonly sessionId: string }): CodexMapper {
  const { sessionId } = options;
  let model = '';
  let run: string | undefined;
  let runs = 0;
  const calls = new Map<string, ToolInput>();             // the tool calls shown, by item id
  const rates = new Map<string, string>();                // the last rate limit said per window
  let state: SessionState = { status: 'Starting', phase: 'starting', steps: [], files: [], checks: [], usage: {} };

  function change(values: Partial<Pick<SessionState, 'status' | 'phase' | 'files' | 'usage'>>): AgUiEvent {
    state = { ...state, ...values };
    return { type: 'STATE_DELTA', delta: Object.entries(values).map(([key, value]) => ({ op: 'replace', path: `/${key}`, value })) };
  }

  function end(events: AgUiEvent[], phase: SessionPhase, status: string, usage?: Usage): AgUiEvent[] {
    run = undefined;
    return [...events, change(usage === undefined ? { phase, status } : { phase, status, usage })];
  }

  // The session's usage so far: Codex reports each turn's alone.
  function total(turn: Usage): Usage {
    const add = (a: number | undefined, b: number | undefined) => (a ?? 0) + (b ?? 0);
    const so = state.usage;
    return {
      ...(model === '' ? {} : { model }),
      inputTokens: add(so.inputTokens, turn.inputTokens),
      outputTokens: add(so.outputTokens, turn.outputTokens),
      cachedInputTokens: add(so.cachedInputTokens, turn.cachedInputTokens),
      cacheWriteInputTokens: add(so.cacheWriteInputTokens, turn.cacheWriteInputTokens),
    };
  }

  const finished = (stopReason: StopReason, outcome: 'success' | 'cancelled', usage: Usage): AgUiEvent => ({
    type: 'RUN_FINISHED', threadId: sessionId, runId: run ?? `${sessionId}-run-${runs}`, outcome: { type: outcome },
    usage: [usage], result: { stopReason, total_cost_usd: null },
  });

  // The call shown once, when Codex first reports it.
  function shown(item: Record<string, unknown>): AgUiEvent[] {
    const [call] = codexCalls(item);
    if (!call || calls.has(call.callId)) return [];
    const input = inputOf(call.request);
    calls.set(call.callId, input);
    return [
      { type: 'TOOL_CALL_START', toolCallId: call.callId, toolCallName: call.request.tool },
      toolArgs(call.callId, input),
      { type: 'TOOL_CALL_END', toolCallId: call.callId },
      change({ status: statusOf(input, call.request.tool) }),
    ];
  }

  function completed(item: Record<string, unknown>): AgUiEvent[] {
    const id = str(item.id);
    if (item.type === 'agent_message') {
      const text = str(item.text);
      if (id === undefined || text === undefined || text === '') return [];
      const messageId = `${sessionId}-${runs}-${id}`;
      return [{ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text }, { type: 'TEXT_MESSAGE_END', messageId }];
    }
    const events = shown(item);
    const call = codexCalls(item)[0];
    if (!call) return events;
    const input = calls.get(call.callId) ?? { kind: 'other' };
    const failed = item.status === 'failed' || item.status === 'declined';
    const messageId = `${sessionId}-${runs}-r${call.callId}`;
    let output: ToolOutput;
    if (input.kind === 'execute') {
      const code = num(item.exit_code);
      output = { kind: 'execute', output: str(item.aggregated_output) ?? '', cut: 0, isError: failed || (code !== undefined && code !== 0) };
    } else {
      // Codex reports no read: a call is a command, a change, a tool or a search.
      const kind = input.kind === 'read' ? 'other' : input.kind;
      output = failed ? { kind, ok: false, error: str(record(item.error)?.message) ?? 'failed' } : { kind, ok: true };
    }
    events.push(toolResult(messageId, call.callId, output));
    if (item.type === 'file_change' && !failed) {
      let files = state.files;
      for (const each of codexCalls(item)) {
        const path = str(each.request.input.file_path);
        if (path === undefined || each.request.tool === 'Delete' || files.some((file) => file.path === path)) continue;
        files = [...files, { path, added: 0, removed: 0 }];
      }
      if (files !== state.files) events.push(change({ files }));
    }
    return events;
  }

  return {
    start(name) {
      model = name;
      state = { ...state, status: 'Starting', phase: 'starting', usage: { ...state.usage, model } };
      return [{ type: 'STATE_SNAPSHOT', snapshot: state }];
    },
    userMessage(messageId, text, by) {
      return [{ type: 'TEXT_MESSAGE_START', messageId, role: 'user', name: by }, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text }, { type: 'TEXT_MESSAGE_END', messageId }];
    },
    beginTurn() {
      if (run !== undefined) return [];
      runs++;
      run = `${sessionId}-run-${runs}`;
      return [{ type: 'RUN_STARTED', threadId: sessionId, runId: run }, change({ phase: 'working', status: 'Working' })];
    },
    line(line) {
      if (run === undefined) return [];
      const item = record(line.item);
      if (line.type === 'item.started' || line.type === 'item.updated') return item ? shown(item) : [];
      if (line.type === 'item.completed') return item ? completed(item) : [];
      if (line.type === 'turn.completed') {
        const usage = usageOf(line.usage, model);
        return end([finished('end_turn', 'success', usage)], 'waiting_human', 'Waiting for a message', total(usage));
      }
      if (line.type === 'turn.failed' || line.type === 'error') {
        // Codex's own words stay on the host: they may quote the request.
        return end([{ type: 'RUN_ERROR', message: 'the turn ended with an error', code: 'codex_error' }], 'waiting_human', 'Waiting for a message');
      }
      return [];
    },
    rateLimits(line) {
      return rateLimits(line).flatMap((value): AgUiEvent[] => {
        const key = JSON.stringify(value);
        if (rates.get(value.window) === key) return [];
        rates.set(value.window, key);
        return [{ type: 'CUSTOM', name: 'cleared.rate_limit', value }];
      });
    },
    blocked(callId, verdict, message) {
      const rule = verdict.rule;
      return end([
        { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: callId, decision: 'reject_once', by: 'policy', rule } },
        { type: 'RUN_ERROR', message, code: 'policy_stop' },
      ], 'waiting_human', 'Stopped by the guard');
    },
    turnFailed(message, code) {
      if (run === undefined) return [];
      return end([{ type: 'RUN_ERROR', message, code }], 'waiting_human', 'Waiting for a message');
    },
    cancelled(phase, status) {
      if (run === undefined) return phase === 'stopped' ? [change({ phase, status })] : [];
      return end([finished('cancelled', 'cancelled', model === '' ? {} : { model })], phase, status);
    },
    state() { return state; },
    turn() { return run; },
  };
}
