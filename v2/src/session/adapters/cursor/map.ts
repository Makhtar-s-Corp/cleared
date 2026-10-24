// Cursor's `agent -p --output-format stream-json` lines, mapped to the
// session events (docs/adapters.md, Cursor; the format is the one documented
// at cursor.com/docs/cli/reference/output-format, not yet recorded from a
// real run). The stream has:
//   system/init        the chat's id (session_id) and the model's display name
//   user               the prompt, not mapped (the adapter shows the message it sent)
//   assistant          one complete message between tool calls
//   tool_call          started, then completed, correlated by call_id; the
//                      call is keyed by its tool (readToolCall, writeToolCall,
//                      ...) or is a `function` with a name and arguments
//   result/success     the end of the turn: text, duration; NO token counts
//                      and NO cost, so the usage reported is the model only
//                      and total_cost_usd is null: nothing is estimated
// A failed turn has no result line: the adapter ends it with turnFailed().
//
// The mapper also turns each tool call into the Claude-shaped request the
// policy evaluates (policy.ts is harness-neutral by that name; B5.1d).
import { WORKDIR_MOUNT } from '../../../container/session-runtime.ts';
import { posix } from 'node:path';
import type { StopReason } from '../../contract.ts';
import { toolArgs, toolResult, type AgUiEvent, type SessionPhase, type SessionState, type ToolInput, type ToolOutput } from '../../events.ts';
import type { ToolRequest, Verdict } from '../../policy.ts';
import { toolInput } from '../claude-code/map.ts';

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export type CursorCall = { readonly callId: string; readonly name: string; readonly request: ToolRequest };

// A path as the policy reads it: absolute, in the checkout when relative.
const absolute = (path: unknown): string => {
  const text = str(path) ?? '';
  return text.startsWith('/') ? posix.normalize(text) : posix.join(WORKDIR_MOUNT, text);
};

// The call of a tool_call line (started or completed), as the policy's
// request, or undefined when the line carries none.
export function cursorCall(line: Record<string, unknown>): CursorCall | undefined {
  const call = record(line.tool_call);
  const callId = str(line.call_id);
  if (!call || callId === undefined) return undefined;
  const [key, body] = Object.entries(call)[0] ?? [];
  const value = record(body);
  if (key === undefined || !value) return undefined;
  let name = key.replace(/ToolCall$/, '');
  let args = record(value.args) ?? {};
  if (key === 'function') {
    name = str(value.name) ?? 'unknown';
    const raw = value.arguments;
    if (typeof raw === 'string') {
      try { args = record(JSON.parse(raw)) ?? {}; } catch { args = {}; }
    } else args = record(raw) ?? {};
  }
  const path = args.path ?? args.file_path ?? args.filePath;
  switch (name.toLowerCase()) {
    case 'read':
      return { callId, name, request: { tool: 'Read', input: { file_path: absolute(path) } } };
    case 'write':
      return { callId, name, request: { tool: 'Write', input: { file_path: absolute(path), content: str(args.fileText) ?? str(args.content) ?? '' } } };
    case 'edit': case 'strreplace': case 'str_replace':
      return { callId, name, request: { tool: 'Edit', input: { file_path: absolute(path), old_string: str(args.oldString) ?? str(args.old_string) ?? '', new_string: str(args.newString) ?? str(args.new_string) ?? '' } } };
    case 'shell': case 'bash': case 'run_terminal_cmd': case 'terminal':
      return { callId, name, request: { tool: 'Bash', input: { command: str(args.command) ?? '' } } };
    case 'grep':
      return { callId, name, request: { tool: 'Grep', input: { pattern: str(args.pattern) ?? str(args.query) ?? '', ...(path === undefined ? {} : { path: absolute(path) }) } } };
    case 'glob': case 'ls': case 'list':
      return { callId, name, request: { tool: 'Glob', input: { pattern: str(args.globPattern) ?? str(args.pattern) ?? '*', path: absolute(args.path ?? args.target_directory) } } };
    case 'webfetch': case 'web_fetch':
      return { callId, name, request: { tool: 'WebFetch', input: { url: str(args.url) ?? '' } } };
    default:
      // A tool the policy has no rule for (delete, MCP, ...): it answers ask or deny.
      return { callId, name, request: { tool: name, input: args } };
  }
}

function statusOf(input: ToolInput, name: string): string {
  const short = (text: string) => (text.length > 80 ? `${text.slice(0, 77)}...` : text);
  switch (input.kind) {
    case 'read': return `Reading ${input.path}`;
    case 'edit': return `Editing ${input.path}`;
    case 'execute': return `Running ${short(input.command)}`;
    case 'search': return `Searching for ${short(input.pattern)}`;
    case 'fetch': return `Fetching ${short(input.target)}`;
    default: return `Using ${name}`;
  }
}

export type CursorMapper = {
  start(model: string): AgUiEvent[];
  userMessage(messageId: string, text: string, by: string): AgUiEvent[];
  // The turn begins when the adapter starts the process.
  beginTurn(): AgUiEvent[];
  line(line: Record<string, unknown>): AgUiEvent[];
  // The guard stopped the turn on this call (policy.ts verdict, or no channel to ask on).
  blocked(callId: string, verdict: Verdict, message: string): AgUiEvent[];
  // The process ended without a result line.
  turnFailed(message: string, code: string): AgUiEvent[];
  // The turn ended because it was interrupted or the session stopped.
  cancelled(phase: 'waiting_human' | 'stopped', status: string): AgUiEvent[];
  state(): SessionState;
  turn(): string | undefined;
};

export function createCursorMapper(options: { readonly sessionId: string }): CursorMapper {
  const { sessionId } = options;
  let model = '';
  let run: string | undefined;
  let runs = 0;
  let messages = 0;
  const calls = new Map<string, ToolInput>();
  let state: SessionState = { status: 'Starting', phase: 'starting', steps: [], files: [], checks: [], usage: {} };

  function change(values: Partial<Pick<SessionState, 'status' | 'phase' | 'files' | 'usage'>>): AgUiEvent {
    state = { ...state, ...values };
    return { type: 'STATE_DELTA', delta: Object.entries(values).map(([key, value]) => ({ op: 'replace', path: `/${key}`, value })) };
  }

  function end(events: AgUiEvent[], phase: SessionPhase, status: string): AgUiEvent[] {
    run = undefined;
    return [...events, change({ phase, status })];
  }

  const finished = (stopReason: StopReason, outcome: 'success' | 'cancelled'): AgUiEvent => ({
    type: 'RUN_FINISHED', threadId: sessionId, runId: run ?? `${sessionId}-run-${runs}`, outcome: { type: outcome },
    usage: [model === '' ? {} : { model }], result: { stopReason, total_cost_usd: null },
  });

  function assistant(line: Record<string, unknown>): AgUiEvent[] {
    const content = record(line.message)?.content;
    return (Array.isArray(content) ? content : []).flatMap((raw): AgUiEvent[] => {
      const block = record(raw);
      const text = str(block?.text);
      if (block?.type !== 'text' || text === undefined || text === '') return [];
      const messageId = `${sessionId}-${runs}-m${++messages}`;
      return [{ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' }, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text }, { type: 'TEXT_MESSAGE_END', messageId }];
    });
  }

  function started(line: Record<string, unknown>): AgUiEvent[] {
    const call = cursorCall(line);
    if (!call) return [];
    const input = toolInput(call.request.tool, call.request.input as Record<string, unknown>);
    calls.set(call.callId, input);
    return [
      { type: 'TOOL_CALL_START', toolCallId: call.callId, toolCallName: call.request.tool },
      toolArgs(call.callId, input),
      { type: 'TOOL_CALL_END', toolCallId: call.callId },
      change({ status: statusOf(input, call.name) }),
    ];
  }

  function completed(line: Record<string, unknown>): AgUiEvent[] {
    const call = cursorCall(line);
    if (!call) return [];
    const input = calls.get(call.callId) ?? { kind: 'other' };
    const body = record(Object.values(record(line.tool_call) ?? {})[0]);
    const result = record(body?.result);
    const success = record(result?.success);
    const failed = result !== undefined && success === undefined;
    const messageId = `${sessionId}-${runs}-r${call.callId}`;
    let output: ToolOutput;
    if (input.kind === 'read') output = failed ? { kind: 'read', path: input.path, bytes: 0 } : { kind: 'read', path: input.path, bytes: Buffer.byteLength(str(success?.content) ?? '') };
    else if (input.kind === 'execute') {
      const stdout = str(success?.stdout) ?? str(success?.output) ?? '';
      const stderr = str(success?.stderr) ?? str(record(result?.failure)?.stderr) ?? '';
      const code = typeof success?.exitCode === 'number' ? success.exitCode : failed ? 1 : 0;
      output = { kind: 'execute', output: stderr ? `${stdout}\n${stderr}` : stdout, cut: 0, isError: failed || code !== 0 };
    } else output = failed ? { kind: input.kind, ok: false, error: str(record(result?.failure)?.message) ?? 'failed' } : { kind: input.kind, ok: true };
    const events: AgUiEvent[] = [toolResult(messageId, call.callId, output)];
    if (input.kind === 'edit' && !failed) {
      const { path, added, removed } = input;
      const before = state.files.find((file) => file.path === path);
      const files = before
        ? state.files.map((file) => (file.path === path ? { path, added: file.added + added, removed: file.removed + removed } : file))
        : [...state.files, { path, added, removed }];
      events.push(change({ files }));
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
      if (line.type === 'assistant') return assistant(line);
      if (line.type === 'tool_call') return line.subtype === 'started' ? started(line) : line.subtype === 'completed' ? completed(line) : [];
      if (line.type === 'result') {
        if (line.subtype === 'success' && line.is_error !== true) return end([finished('end_turn', 'success')], 'waiting_human', 'Waiting for a message');
        return end([{ type: 'RUN_ERROR', message: 'the turn ended with an error', code: 'cursor_error' }], 'waiting_human', 'Waiting for a message');
      }
      return [];
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
      return end([finished('cancelled', 'cancelled')], phase, status);
    },
    state() { return state; },
    turn() { return run; },
  };
}
