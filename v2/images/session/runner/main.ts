// The session runner (milestone 1 plan, section 6): the one process the
// session container runs. It calls the Agent SDK's query() once, in
// streaming input mode, and relays JSON lines:
//   stdin  (from the host side of the adapter): RunnerInput, `start` first
//   stdout (to it): RunnerOutput, every SDK message as it comes, the
//          permission requests and questions canUseTool receives, a
//          tool_check before every tool call, `exit` last
// Anything else the runner or the CLI prints goes to stderr. The runner holds
// no policy and no cleaning: the host side (src/session/adapters/claude-code.ts)
// decides every request and cleans every event.
//
// In the `default` permission mode Claude Code runs a read without asking
// (canUseTool never sees it), so the policy's deny rules would not apply to
// it. A PreToolUse hook of the runner's own therefore sends a tool_check for
// every tool call and waits for the host's verdict: a deny stops the call,
// anything else lets Claude Code's own permission flow go on. It runs before
// lane 5's hooks (hooks.ts).
//
// The SDK is installed in the image only, so it is loaded at run time and
// its types are mirrored here, as hooks.ts does: query() is injected, and the
// test drives run() with a stand-in.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Decision } from '../../../src/session/contract.ts';
import { hooks as clearedHooks, type HookCallback, type Hooks } from './hooks.ts';

// The login, mounted read only by the service: a `claude setup-token` token,
// or the credentials file of an existing Claude Code login (decisions log,
// 2026-10-21). Of the second, only the access token is given to the CLI: the
// refresh token stays in the file, so the session never refreshes, and so
// never rotates, the login it was given.
export const LOGIN_FILE = '/run/cleared/claude.token';
export const CLAUDE_BIN = '/usr/local/bin/claude';
export const WORKDIR = '/workspace';
const SDK = '@anthropic-ai/claude-agent-sdk';

export type RunnerStart = {
  readonly type: 'start';
  readonly sessionId: string;
  readonly model: string;
  readonly resume: boolean;                       // true: the session exists in the config volume
  readonly maxBudgetUsd?: number;
};

export type RunnerInput =
  | RunnerStart
  | { readonly type: 'user'; readonly uuid: string; readonly text: string }
  | { readonly type: 'answer'; readonly requestId: string; readonly decision: Decision }
  | { readonly type: 'tool_verdict'; readonly requestId: string; readonly deny?: string }
  | { readonly type: 'interrupt' }
  | { readonly type: 'stop' };

export type RunnerOutput =
  | { readonly type: 'sdk'; readonly message: unknown }
  | { readonly type: 'permission_request'; readonly requestId: string; readonly toolName: string; readonly toolUseId: string; readonly input: Record<string, unknown>; readonly agentId?: string; readonly decisionReason?: string }
  | { readonly type: 'question'; readonly requestId: string; readonly toolUseId: string; readonly questions: unknown }
  | { readonly type: 'tool_check'; readonly requestId: string; readonly toolName: string; readonly toolUseId: string; readonly input: unknown }
  | { readonly type: 'request_cancelled'; readonly requestId: string }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'exit'; readonly code: number };

// The parts of the SDK 0.3.306 types (sdk.d.ts) the runner uses.
type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
type CanUseTool = (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string; agentID?: string; decisionReason?: string }) => Promise<PermissionResult>;
type SdkUserMessage = {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  uuid: string;
  origin: { kind: 'human' };
};
export type QueryLike = AsyncIterable<unknown> & { interrupt(): Promise<unknown>; close(): void };
export type QueryFn = (args: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => QueryLike;

export type RunnerDeps = {
  readonly query: QueryFn;
  readonly lines: AsyncIterable<string>;
  readonly write: (line: string) => void;
  readonly readFile: (path: string) => string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hooks?: Hooks;
  readonly newId?: () => string;
  readonly log?: (text: string) => void;          // stderr
};

// The user turns, as the async iterable query() reads.
function turnQueue() {
  const queue: SdkUserMessage[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const iterable: AsyncIterable<SdkUserMessage> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next) { yield next; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    },
  };
  return {
    iterable,
    push(message: SdkUserMessage) { queue.push(message); wake?.(); },
    end() { ended = true; wake?.(); },
  };
}

// What the SDK gets back for a decision. A question's answers go back in the
// tool's own input, as AskUserQuestion reads them (sdk-tools.d.ts).
function permissionResult(decision: Decision, input: Record<string, unknown>): PermissionResult {
  switch (decision.kind) {
    case 'allow_once': case 'allow_always': return { behavior: 'allow', updatedInput: input };
    case 'answer': return { behavior: 'allow', updatedInput: { ...input, answers: decision.answers } };
    case 'reject_once': case 'reject_always': return { behavior: 'deny', message: decision.message };
    case 'cancelled': return { behavior: 'deny', message: 'The request was cancelled.', interrupt: true };
  }
}

// The token in the login file, or undefined. Nothing of the file is printed.
function loginToken(text: string | undefined): string | undefined {
  const trimmed = text?.trim() ?? '';
  if (!trimmed.startsWith('{')) return trimmed || undefined;
  try {
    const oauth = (JSON.parse(trimmed) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth;
    return typeof oauth?.accessToken === 'string' && oauth.accessToken ? oauth.accessToken : undefined;
  } catch {
    return undefined;
  }
}

const parse = (line: string): RunnerInput | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string' ? (value as RunnerInput) : undefined;
  } catch {
    return undefined;
  }
};

// Returns the exit code: 0 after the session ended or was stopped, 1 when
// the query failed, 2 for a first line that is not `start`, 3 without a token.
export async function run(deps: RunnerDeps): Promise<number> {
  const out = (value: RunnerOutput) => deps.write(JSON.stringify(value));
  const finish = (code: number, message?: string): number => {
    if (message !== undefined) out({ type: 'error', message });
    out({ type: 'exit', code });
    return code;
  };
  const newId = deps.newId ?? randomUUID;
  const lines = deps.lines[Symbol.asyncIterator]();

  const first = await lines.next();
  const start = first.done ? undefined : parse(first.value);
  if (start?.type !== 'start') return finish(2, 'the first line must be start');
  const token = loginToken(deps.readFile(LOGIN_FILE));
  if (!token) return finish(3, `no token in ${LOGIN_FILE}: neither a token nor a credentials file with an access token`);

  const turns = turnQueue();
  const checks = new Map<string, (deny: string | undefined) => void>();
  const denied = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  const toolCheck: HookCallback = (raw, toolUseId, { signal }) =>
    new Promise((resolve) => {
      const input = (typeof raw === 'object' && raw !== null ? raw : {}) as { tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown };
      const requestId = newId();
      const settle = (deny: string | undefined) => {
        checks.delete(requestId);
        resolve(deny === undefined ? {} : denied(deny));
      };
      checks.set(requestId, settle);
      // An aborted check fails closed: the call does not run.
      signal.addEventListener('abort', () => { if (checks.has(requestId)) settle('The policy check was cancelled.'); }, { once: true });
      out({
        type: 'tool_check', requestId, toolName: typeof input.tool_name === 'string' ? input.tool_name : 'unknown',
        toolUseId: typeof input.tool_use_id === 'string' ? input.tool_use_id : toolUseId ?? '', input: input.tool_input,
      });
    });
  const pending = new Map<string, { input: Record<string, unknown>; resolve: (result: PermissionResult) => void }>();
  const canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise((resolve) => {
      const requestId = newId();
      const settle = (result: PermissionResult) => {
        pending.delete(requestId);
        resolve(result);
      };
      pending.set(requestId, { input, resolve: settle });
      options.signal.addEventListener('abort', () => {
        if (!pending.has(requestId)) return;
        out({ type: 'request_cancelled', requestId });
        settle(permissionResult({ kind: 'cancelled' }, input));
      }, { once: true });
      if (toolName === 'AskUserQuestion') out({ type: 'question', requestId, toolUseId: options.toolUseID, questions: input.questions });
      else out({
        type: 'permission_request', requestId, toolName, toolUseId: options.toolUseID, input,
        ...(options.agentID === undefined ? {} : { agentId: options.agentID }),
        ...(options.decisionReason === undefined ? {} : { decisionReason: options.decisionReason }),
      });
    });

  // The project's briefing (CLAUDE.md, written by the service) would load
  // only with the 'project' setting source, which also loads the project's
  // settings and hooks; it is appended to the system prompt instead.
  const briefing = deps.readFile(`${WORKDIR}/CLAUDE.md`);
  const env: Record<string, string | undefined> = { ...deps.env, CLAUDE_CODE_OAUTH_TOKEN: token };
  delete env.ANTHROPIC_API_KEY;
  const options: Record<string, unknown> = {
    cwd: WORKDIR,
    model: start.model,
    ...(start.resume ? { resume: start.sessionId } : { sessionId: start.sessionId }),
    settingSources: [],
    permissionMode: 'default',
    canUseTool,
    hooks: (() => {
      const lane5 = deps.hooks ?? clearedHooks;
      return { ...lane5, PreToolUse: [{ hooks: [toolCheck] }, ...(lane5.PreToolUse ?? [])] };
    })(),
    persistSession: true,
    includePartialMessages: false,
    pathToClaudeCodeExecutable: CLAUDE_BIN,
    systemPrompt: briefing === undefined ? { type: 'preset', preset: 'claude_code' } : { type: 'preset', preset: 'claude_code', append: briefing },
    env,
    stderr: (text: string) => deps.log?.(text),
    ...(start.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: start.maxBudgetUsd }),
  };

  let query: QueryLike;
  try {
    query = deps.query({ prompt: turns.iterable, options });
  } catch (error) {
    return finish(1, (error as Error).message);
  }

  let stopped: () => void = () => {};
  const stop = new Promise<'stopped'>((resolve) => { stopped = () => resolve('stopped'); });

  // The host's lines, while the session runs. When stdin ends, no turn comes
  // any more: the session ends after the current one.
  const reading = (async () => {
    for (;;) {
      const next = await lines.next();
      if (next.done) break;
      const line = parse(next.value);
      if (!line) { out({ type: 'error', message: 'unreadable input line' }); continue; }
      if (line.type === 'user') turns.push({ type: 'user', message: { role: 'user', content: line.text }, parent_tool_use_id: null, uuid: line.uuid, origin: { kind: 'human' } });
      else if (line.type === 'answer') pending.get(line.requestId)?.resolve(permissionResult(line.decision, pending.get(line.requestId)?.input ?? {}));
      else if (line.type === 'tool_verdict') checks.get(line.requestId)?.(typeof line.deny === 'string' ? line.deny : undefined);
      else if (line.type === 'interrupt') await query.interrupt().catch((error: Error) => out({ type: 'error', message: `interrupt failed: ${error.message}` }));
      else if (line.type === 'stop') { query.close(); stopped(); return; }
    }
    turns.end();
  })();

  const relaying = (async () => {
    for await (const message of query) out({ type: 'sdk', message });
    return 'ended' as const;
  })();
  try {
    await Promise.race([relaying, stop]);
  } catch (error) {
    return finish(1, (error as Error).message);
  } finally {
    turns.end();
    void reading.catch(() => undefined);
  }
  return finish(0);
}

if (import.meta.main) {
  const { query } = (await import(SDK)) as { query: QueryFn };
  const code = await run({
    query,
    lines: createInterface({ input: process.stdin, crlfDelay: Infinity }),
    write: (line) => process.stdout.write(line + '\n'),
    readFile: (path) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } },
    env: process.env,
    log: (text) => process.stderr.write(text),
  });
  process.exit(code);
}
