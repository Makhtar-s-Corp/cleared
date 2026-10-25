// The session runner (milestone 1 plan, section 6): the one process the
// session container runs. It calls the Agent SDK's query() in streaming
// input mode, and relays JSON lines:
//   stdin  (from the host side of the adapter): RunnerInput, `start` first
//   stdout (to it): RunnerOutput, every SDK message as it comes, the
//          permission requests and questions canUseTool receives, a
//          tool_check before every tool call, the host tool calls, the
//          context measures, the login's state, `exit` last
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
// Milestone 2 (lane 4):
//   - Host tools. The start line may carry tools (name, description, input
//     schema; the lead's, src/lead/contract.ts). They become the in-process
//     MCP server `cleared` (createSdkMcpServer and tool() of the SDK, the
//     schema converted by schema.ts), so the model sees mcp__cleared__<name>.
//     Each call goes out as a host_call line and waits for the host's
//     host_result: the host runs the handler; the container reaches nothing.
//   - The context. After every turn's result, and after every tool call
//     from a PostToolUse hook that does not hold the call, getContextUsage()
//     is asked and a context line printed (milestone 2 plan, section 4.1).
//   - The role. A lead and a reviewer get no Stop hook (hooks.ts, hooksFor).
//   - The login. A turn that fails on an authentication error ends; the
//     runner reads the login file again until its token changes, then
//     recreates the query with `resume` in the same container, and says so
//     to the model in a message of its own.
//
// Take over with the harness (owner request of 2026-10-22 17:26): `release`
// ends the harness's process (the query is closed), so that the human who
// took the session over runs the same session in a terminal of this
// container, and says `released`; the runner, the container's command,
// stays up. `reload` starts the harness again with `resume`, from the
// transcript as the human's harness left it; a turn sent meanwhile waits
// for it. Only one harness writes the session at a time.
//
// The SDK is installed in the image only, so it is loaded at run time and
// its types are mirrored here, as hooks.ts does: query() and the MCP
// functions are injected, and the test drives run() with stand-ins.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import type { Decision, Role } from '../../../src/session/contract.ts';
import { hooksFor, type HookCallback, type Hooks } from './hooks.ts';
import { hostToolsOf, toZodShape, type HostToolSpec, type ZodLike, type ZodTypeLike } from './schema.ts';

// The login, mounted read only by the service: a `claude setup-token` token,
// or the credentials file of an existing Claude Code login (decisions log,
// 2026-10-21). Of the second, only the access token is given to the CLI: the
// refresh token stays in the file, so the session never refreshes, and so
// never rotates, the login it was given.
export const LOGIN_FILE = '/run/cleared/claude.token';
export const CLAUDE_BIN = '/usr/local/bin/claude';
export const WORKDIR = '/workspace';
const SDK = '@anthropic-ai/claude-agent-sdk';
const ZOD = 'zod';

// How long a host tool call may take before the SDK gives up on it, so a
// host that never answers cannot hold a turn for ever.
export const HOST_CALL_TIMEOUT_MS = 300_000;
// How often the login file is read again after an authentication error.
export const LOGIN_POLL_MS = 10_000;
// A context measure slower than this runs after every third tool call only.
export const SLOW_MEASURE_MS = 200;
// A context measure that does not answer within this is given up, so the
// end-of-turn measure, which the relay awaits, cannot hold the session.
export const MEASURE_TIMEOUT_MS = 5_000;
// The commit identity of every session: a name and no address. Git 2.39
// (the image's) accepts an empty address from these variables, and the
// guard has nothing to refuse in it (lib/guard/codex-guard.mjs, "email
// address"); without them a commit fails, since HOME has no git config.
export const GIT_IDENTITY = { GIT_AUTHOR_NAME: 'Cleared', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'Cleared', GIT_COMMITTER_EMAIL: '' } as const;
// What the model reads after its login was renewed: the turn that failed is
// not sent again, it is in the resumed session already.
export const LOGIN_RENEWED = 'Cleared: the login was renewed after an authentication error, which stopped your last turn. Go on with your task where it stopped.';

export type RunnerStart = {
  readonly type: 'start';
  readonly sessionId: string;
  readonly model: string;
  readonly resume: boolean;                       // true: the session exists in the config volume
  readonly maxBudgetUsd?: number;
  readonly role?: Role;                           // 'author' when absent
  readonly tools?: readonly HostToolSpec[];       // the host's tools, as mcp__cleared__<name>
};

// What getContextUsage() answers that the host uses; the categories and the
// grid are not forwarded.
export type ContextFields = {
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly rawMaxTokens?: number;
  readonly percentage: number;
  readonly autoCompactThreshold?: number;
  readonly isAutoCompactEnabled: boolean;
};

// The plan's rate limit windows, as the experimental usage call answers them.
export type UsageProbe = {
  readonly subscriptionType: string | null;
  readonly rateLimitsAvailable: boolean;
  readonly windows: Readonly<Record<string, { readonly utilization: number | null; readonly resetsAt: string | null }>>;
};

export type RunnerInput =
  | RunnerStart
  | { readonly type: 'user'; readonly uuid: string; readonly text: string }
  | { readonly type: 'answer'; readonly requestId: string; readonly decision: Decision }
  | { readonly type: 'tool_verdict'; readonly requestId: string; readonly deny?: string }
  | { readonly type: 'host_result'; readonly callId: string; readonly ok: boolean; readonly text: string }
  // For the doctor: ten timed context measures of each detail, and the usage once.
  | { readonly type: 'measure' }
  | { readonly type: 'interrupt' }
  // Take over: the harness handed to a human, then taken back from its transcript.
  | { readonly type: 'release' }
  | { readonly type: 'reload' }
  | { readonly type: 'stop' };

export type RunnerOutput =
  | { readonly type: 'sdk'; readonly message: unknown }
  | { readonly type: 'permission_request'; readonly requestId: string; readonly toolName: string; readonly toolUseId: string; readonly input: Record<string, unknown>; readonly agentId?: string; readonly decisionReason?: string }
  | { readonly type: 'question'; readonly requestId: string; readonly toolUseId: string; readonly questions: unknown }
  | { readonly type: 'tool_check'; readonly requestId: string; readonly toolName: string; readonly toolUseId: string; readonly input: unknown }
  | { readonly type: 'request_cancelled'; readonly requestId: string }
  // toolUseId: the tool_use block's id, found from the PreToolUse check of
  // the same call; empty when no check announced it.
  | { readonly type: 'host_call'; readonly callId: string; readonly toolUseId: string; readonly name: string; readonly input: unknown }
  | ({ readonly type: 'context'; readonly after: 'turn' | 'tool'; readonly detail: 'summary' | 'full'; readonly ms: number } & ContextFields)
  | { readonly type: 'login'; readonly state: 'failed' | 'renewed' }
  | { readonly type: 'measure'; readonly summaryMs: readonly number[]; readonly fullMs: readonly number[]; readonly summary?: ContextFields; readonly full?: ContextFields; readonly usage?: UsageProbe; readonly error?: string }
  | { readonly type: 'error'; readonly message: string }
  | { readonly type: 'released' }                      // the harness's process ended: a human may run the session
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
type CallToolResult = { content: { type: 'text'; text: string }[]; isError?: true };
export type QueryLike = AsyncIterable<unknown> & {
  interrupt(): Promise<unknown>;
  close(): void;
  getContextUsage?(opts?: { detail?: 'summary' | 'full' }): Promise<unknown>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<unknown>;
};
export type QueryFn = (args: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => QueryLike;
// createSdkMcpServer() and tool() of the SDK, and the image's zod.
export type McpFunctions = {
  readonly createSdkMcpServer: (options: Record<string, unknown>) => unknown;
  readonly tool: (name: string, description: string, shape: Record<string, ZodTypeLike>, handler: (args: unknown, extra: unknown) => Promise<CallToolResult>, extras?: Record<string, unknown>) => unknown;
  readonly z: ZodLike;
};

export type RunnerDeps = {
  readonly query: QueryFn;
  readonly lines: AsyncIterable<string>;
  readonly write: (line: string) => void;
  readonly readFile: (path: string) => string | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hooks?: Hooks;                         // instead of hooksFor(<the role>)
  readonly mcp?: McpFunctions;                    // needed when the start line has tools
  readonly newId?: () => string;
  readonly log?: (text: string) => void;          // stderr
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: () => number;                  // milliseconds, for the measures' latency
  readonly measureTimeoutMs?: number;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const round = (ms: number) => Math.round(ms * 10) / 10;

// The user turns, as the async iterable query() reads. A query recreated
// after a login error iterates it again; reset() ends the iteration of the
// query before, so a turn never goes to a closed query.
function turnQueue() {
  const queue: SdkUserMessage[] = [];
  const wakes = new Set<() => void>();
  let ended = false;
  let epoch = 0;
  const wakeAll = () => { for (const wake of [...wakes]) wake(); };
  const iterable: AsyncIterable<SdkUserMessage> = {
    async *[Symbol.asyncIterator]() {
      const own = epoch;
      for (;;) {
        if (own !== epoch) return;
        const next = queue.shift();
        if (next) { yield next; continue; }
        if (ended) return;
        await new Promise<void>((resolve) => {
          const wake = () => { wakes.delete(wake); resolve(); };
          wakes.add(wake);
        });
      }
    },
  };
  return {
    iterable,
    push(message: SdkUserMessage) { queue.push(message); wakeAll(); },
    reset() { epoch++; wakeAll(); },
    end() { ended = true; wakeAll(); },
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

// An SDK frame that says the login was refused: the typed error of an
// assistant message or of an API retry (SDKAssistantMessageError), never
// the text. The CLI retries a 401, so only the turn's result tells whether
// the login failed.
function authenticationFailed(message: unknown): boolean {
  const frame = record(message);
  return frame?.error === 'authentication_failed' && (frame.type === 'assistant' || (frame.type === 'system' && frame.subtype === 'api_retry'));
}

function contextFields(value: unknown): ContextFields | undefined {
  const usage = record(value);
  const totalTokens = num(usage?.totalTokens);
  const maxTokens = num(usage?.maxTokens);
  const percentage = num(usage?.percentage);
  if (totalTokens === undefined || maxTokens === undefined || percentage === undefined) return undefined;
  const rawMaxTokens = num(usage?.rawMaxTokens);
  const autoCompactThreshold = num(usage?.autoCompactThreshold);
  return {
    totalTokens, maxTokens, ...(rawMaxTokens === undefined ? {} : { rawMaxTokens }), percentage,
    ...(autoCompactThreshold === undefined ? {} : { autoCompactThreshold }), isAutoCompactEnabled: usage?.isAutoCompactEnabled === true,
  };
}

function usageProbe(value: unknown): UsageProbe {
  const usage = record(value);
  const windows: Record<string, { utilization: number | null; resetsAt: string | null }> = {};
  for (const [name, raw] of Object.entries(record(usage?.rate_limits) ?? {})) {
    const window = record(raw);
    if (!window) continue;
    windows[name] = { utilization: num(window.utilization) ?? null, resetsAt: typeof window.resets_at === 'string' ? window.resets_at : null };
  }
  return { subscriptionType: typeof usage?.subscription_type === 'string' ? usage.subscription_type : null, rateLimitsAvailable: usage?.rate_limits_available === true, windows };
}

// A value as JSON with its keys sorted, to match a host call with the
// PreToolUse check of the same call.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, inner: unknown) => {
  const object = record(inner);
  return object ? Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]])) : inner;
});

const parse = (line: string): RunnerInput | undefined => {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string' ? (value as RunnerInput) : undefined;
  } catch {
    return undefined;
  }
};

// Returns the exit code: 0 after the session ended or was stopped, 1 when
// the query failed, 2 for a first line that is not `start`, 3 without a
// token, 4 for host tools the runner cannot give the model.
export async function run(deps: RunnerDeps): Promise<number> {
  const out = (value: RunnerOutput) => deps.write(JSON.stringify(value));
  const finish = (code: number, message?: string): number => {
    if (message !== undefined) out({ type: 'error', message });
    out({ type: 'exit', code });
    return code;
  };
  const newId = deps.newId ?? randomUUID;
  const clock = deps.clock ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const lines = deps.lines[Symbol.asyncIterator]();

  const first = await lines.next();
  const start = first.done ? undefined : parse(first.value);
  if (start?.type !== 'start') return finish(2, 'the first line must be start');
  let tools: HostToolSpec[];
  try {
    tools = hostToolsOf(start.tools);
  } catch (error) {
    return finish(4, `the host tools cannot be given to the model: ${(error as Error).message}`);
  }
  const mcp = deps.mcp;
  if (tools.length > 0 && !mcp) return finish(4, 'the host tools cannot be given to the model: the SDK\'s MCP server is not available');
  let token = loginToken(deps.readFile(LOGIN_FILE));
  if (!token) return finish(3, `no token in ${LOGIN_FILE}: neither a token nor a credentials file with an access token`);
  const role = start.role ?? 'author';

  const turns = turnQueue();
  let current: QueryLike | undefined;
  let stopping = false;

  const checks = new Map<string, (deny: string | undefined) => void>();
  // The host tool calls the PreToolUse check let through, oldest first.
  const announced: { name: string; key: string; id: string }[] = [];
  const denied = (reason: string) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
  const toolCheck: HookCallback = (raw, toolUseId, { signal }) =>
    new Promise((resolve) => {
      const input = (typeof raw === 'object' && raw !== null ? raw : {}) as { tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown };
      const requestId = newId();
      const toolName = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
      const id = typeof input.tool_use_id === 'string' ? input.tool_use_id : toolUseId ?? '';
      const settle = (deny: string | undefined) => {
        checks.delete(requestId);
        if (deny === undefined && toolName.startsWith('mcp__cleared__')) announced.push({ name: toolName.slice('mcp__cleared__'.length), key: canonical(input.tool_input), id });
        resolve(deny === undefined ? {} : denied(deny));
      };
      checks.set(requestId, settle);
      // An aborted check fails closed: the call does not run.
      signal.addEventListener('abort', () => { if (checks.has(requestId)) settle('The policy check was cancelled.'); }, { once: true });
      out({ type: 'tool_check', requestId, toolName, toolUseId: id, input: input.tool_input });
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

  // The context, measured with the summary detail, which answers from the
  // last response's usage and local estimates (the full detail counts each
  // category with the token-count API). A slow measure runs after every
  // third tool call only.
  let slow = false;
  let skipped = 0;
  async function measure(after: 'turn' | 'tool'): Promise<void> {
    const query = current;
    if (!query?.getContextUsage) return;
    const began = clock();
    const timeoutMs = deps.measureTimeoutMs ?? MEASURE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([
        query.getContextUsage({ detail: 'summary' }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs); }),
      ]);
      const fields = contextFields(answer);
      const ms = round(clock() - began);
      slow = ms > SLOW_MEASURE_MS;
      if (fields) out({ type: 'context', after, detail: 'summary', ms, ...fields });
    } catch (error) {
      slow = clock() - began > SLOW_MEASURE_MS;
      deps.log?.(`cleared-runner: context measure failed: ${(error as Error).message}\n`);
    } finally {
      clearTimeout(timer);
    }
  }
  // After a tool call: the call goes on at once, the line comes when the measure does.
  const afterTool: HookCallback = async () => {
    if (slow && skipped < 2) skipped++;
    else {
      skipped = 0;
      void measure('tool');
    }
    return {};
  };
  async function measureAll(): Promise<void> {
    const query = current;
    const summaryMs: number[] = [];
    const fullMs: number[] = [];
    let summary: ContextFields | undefined;
    let full: ContextFields | undefined;
    try {
      if (!query?.getContextUsage || !query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) throw new Error('the query has no getContextUsage or usage call');
      for (const detail of ['summary', 'full'] as const) {
        for (let i = 0; i < 10; i++) {
          const began = clock();
          const fields = contextFields(await query.getContextUsage({ detail }));
          (detail === 'summary' ? summaryMs : fullMs).push(round(clock() - began));
          if (detail === 'summary') summary = fields;
          else full = fields;
        }
      }
      const usage = usageProbe(await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
      out({ type: 'measure', summaryMs, fullMs, ...(summary ? { summary } : {}), ...(full ? { full } : {}), usage });
    } catch (error) {
      out({ type: 'measure', summaryMs, fullMs, ...(summary ? { summary } : {}), ...(full ? { full } : {}), error: (error as Error).message });
    }
  }

  // The host tools, as the in-process MCP server `cleared`.
  const hostCalls = new Map<string, (ok: boolean, text: string) => void>();
  let extraLogged = false;
  function hostTool(spec: HostToolSpec, functions: McpFunctions): unknown {
    return functions.tool(spec.name, spec.description, toZodShape(spec.inputSchema, functions.z), (args, extra) =>
      new Promise<CallToolResult>((resolve) => {
        const callId = newId();
        const meta = record(record(extra)?._meta);
        // Which keys the CLI gives a call, names only: whether one carries
        // the tool use id is not documented (docs/adapters.md).
        if (!extraLogged) {
          extraLogged = true;
          deps.log?.(`cleared-runner: a host call's extra has the keys ${Object.keys(record(extra) ?? {}).join(',') || 'none'}; its _meta ${Object.keys(meta ?? {}).join(',') || 'none'}\n`);
        }
        const key = canonical(args);
        let at = announced.findIndex((call) => call.name === spec.name && call.key === key);
        if (at < 0) at = announced.findIndex((call) => call.name === spec.name);
        const found = at < 0 ? undefined : announced.splice(at, 1)[0];
        const metaId = meta?.['claudecode/toolUseId'];
        const toolUseId = typeof metaId === 'string' ? metaId : found?.id ?? '';
        const settle = (ok: boolean, text: string) => {
          if (!hostCalls.delete(callId)) return;
          resolve(ok ? { content: [{ type: 'text', text }] } : { content: [{ type: 'text', text }], isError: true });
        };
        hostCalls.set(callId, settle);
        const signal = record(extra)?.signal;
        if (signal instanceof AbortSignal) signal.addEventListener('abort', () => settle(false, 'The call was cancelled.'), { once: true });
        out({ type: 'host_call', callId, toolUseId, name: spec.name, input: args });
      }));
  }
  let mcpServers: Record<string, unknown> | undefined;
  if (mcp && tools.length > 0) {
    try {
      mcpServers = { cleared: mcp.createSdkMcpServer({ name: 'cleared', version: '1.0.0', tools: tools.map((spec) => hostTool(spec, mcp)), alwaysLoad: true, timeout: HOST_CALL_TIMEOUT_MS }) };
    } catch (error) {
      return finish(4, `the host tools cannot be given to the model: ${(error as Error).message}`);
    }
  }

  // The setting sources: 'user' alone (B5.5b and M7, the owner's decision
  // of 2026-10-25 06:06). In the container it is CLAUDE_CONFIG_DIR, the
  // session's config volume, where the base branch's skills are mounted read
  // only. The project's briefing (CLAUDE.md, written by the service) would
  // load only with the 'project' source, which also loads the checkout's
  // settings, hooks and skills; it is appended to the system prompt instead.
  //
  // The prompt cache serves a prefix only up to its first changed byte
  // (issue #335, P219). The preset's per-session sections (the working
  // directory, git status: the ticket's branch and commits) would stand
  // between its static part and the briefing; excluded, the SDK gives them to
  // the model as the first user message, so two sessions with the same
  // briefing share the whole system prompt. `snapshot`, the SDK's default,
  // is said: the prompt is recorded once and sent as is for the session.
  const briefing = deps.readFile(`${WORKDIR}/CLAUDE.md`);
  const systemPrompt = { type: 'preset', preset: 'claude_code', ...(briefing === undefined ? {} : { append: briefing }), excludeDynamicSections: true, snapshot: true };
  const lane5 = deps.hooks ?? hooksFor(role);
  const hooks: Hooks = {
    ...lane5,
    PreToolUse: [{ hooks: [toolCheck] }, ...(lane5.PreToolUse ?? [])],
    PostToolUse: [{ hooks: [afterTool] }, ...(lane5.PostToolUse ?? [])],
  };
  const optionsFor = (resume: boolean): Record<string, unknown> => {
    const env: Record<string, string | undefined> = { ...deps.env, ...GIT_IDENTITY, CLAUDE_CODE_OAUTH_TOKEN: token };
    delete env.ANTHROPIC_API_KEY;
    return {
      cwd: WORKDIR,
      model: start.model,
      ...(resume ? { resume: start.sessionId } : { sessionId: start.sessionId }),
      settingSources: ['user'],
      // No co-author trailer on commits: its address would make the guard
      // refuse the publish (lib/guard/codex-guard.mjs, "email address").
      settings: { attribution: { commit: '', pr: '' } },
      permissionMode: 'default',
      canUseTool,
      hooks,
      ...(mcpServers === undefined ? {} : { mcpServers }),
      persistSession: true,
      includePartialMessages: false,
      pathToClaudeCodeExecutable: CLAUDE_BIN,
      systemPrompt,
      env,
      stderr: (text: string) => deps.log?.(text),
      ...(start.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: start.maxBudgetUsd }),
    };
  };

  // A new token in the login file, or undefined once the session stops or
  // its harness is handed to a human.
  let wakeLoginWait: () => void = () => {};
  async function renewedLogin(): Promise<string | undefined> {
    for (;;) {
      if (stopping || released) return undefined;
      await Promise.race([sleep(LOGIN_POLL_MS), new Promise<void>((resolve) => { wakeLoginWait = resolve; })]);
      if (stopping || released) return undefined;
      const next = loginToken(deps.readFile(LOGIN_FILE));
      if (next !== undefined && next !== token) return next;
    }
  }

  let stopped: () => void = () => {};
  const stop = new Promise<'stopped'>((resolve) => { stopped = () => resolve('stopped'); });

  // The harness handed to a human: released until a reload, or the end.
  let released = false;
  let inputEnded = false;
  let reloadAsked = false;
  let parked: ((back: boolean) => void) | undefined;
  const park = () => new Promise<boolean>((resolve) => {
    if (stopping || inputEnded) return resolve(false);
    if (reloadAsked) { reloadAsked = false; return resolve(true); }
    parked = resolve;
  });
  const unpark = (back: boolean) => {
    const wake = parked;
    parked = undefined;
    if (wake) wake(back);
    else if (back) reloadAsked = true;
  };

  // Relays the SDK messages; after a login error, waits for a new token and
  // resumes the session in a new query.
  const relaying = (async () => {
    let resume = start.resume;
    // Released: says so, waits for the reload (false: the session ended
    // meanwhile), then resumes the session, the login file read again.
    const reclaim = async (): Promise<boolean> => {
      out({ type: 'released' });
      if (!(await park())) return false;
      released = false;
      resume = true;
      token = loginToken(deps.readFile(LOGIN_FILE)) ?? token;
      return true;
    };
    for (;;) {
      const query = deps.query({ prompt: turns.iterable, options: optionsFor(resume) });
      current = query;
      let refused = false;                        // an authentication error in this turn
      let failed = false;
      try {
        for await (const message of query) {
          const frame = record(message);
          if (authenticationFailed(message)) refused = true;
          if (frame?.type === 'result') {
            // A turn that ends in an error after a refused login waits for a new one.
            failed = refused && (frame.is_error === true || frame.subtype !== 'success');
            refused = false;
            if (failed) out({ type: 'login', state: 'failed' });
          }
          out({ type: 'sdk', message });
          if (frame?.type !== 'result') continue;
          if (failed) break;
          await measure('turn');
        }
      } catch (error) {
        if (!released) throw error;               // a closed query may end its iteration with an error
      }
      if (released && !stopping) {
        if (!(await reclaim())) return 'ended' as const;
        continue;
      }
      if (!failed || stopping) return 'ended' as const;
      turns.reset();
      query.close();
      const next = await renewedLogin();
      if (next === undefined) {
        // A session whose login was cut can be taken over too.
        if (released && !stopping && await reclaim()) continue;
        return 'ended' as const;
      }
      token = next;
      out({ type: 'login', state: 'renewed' });
      resume = true;
      turns.push({ type: 'user', message: { role: 'user', content: LOGIN_RENEWED }, parent_tool_use_id: null, uuid: newId(), origin: { kind: 'human' } });
    }
  })();

  // The host's lines, while the session runs. When stdin ends, no turn comes
  // any more: the session ends after the current one. An interrupt is not
  // awaited, so a verdict sent right after it is not held (issue 145).
  const reading = (async () => {
    for (;;) {
      const next = await lines.next();
      if (next.done) break;
      const line = parse(next.value);
      if (!line) { out({ type: 'error', message: 'unreadable input line' }); continue; }
      if (line.type === 'user') turns.push({ type: 'user', message: { role: 'user', content: line.text }, parent_tool_use_id: null, uuid: line.uuid, origin: { kind: 'human' } });
      else if (line.type === 'answer') pending.get(line.requestId)?.resolve(permissionResult(line.decision, pending.get(line.requestId)?.input ?? {}));
      else if (line.type === 'tool_verdict') checks.get(line.requestId)?.(typeof line.deny === 'string' ? line.deny : undefined);
      else if (line.type === 'host_result') hostCalls.get(line.callId)?.(line.ok === true, typeof line.text === 'string' ? line.text : '');
      else if (line.type === 'measure') void measureAll();
      else if (line.type === 'interrupt') void current?.interrupt().catch((error: Error) => out({ type: 'error', message: `interrupt failed: ${error.message}` }));
      else if (line.type === 'release') {
        if (!released) { released = true; reloadAsked = false; turns.reset(); current?.close(); wakeLoginWait(); }
        else if (parked) out({ type: 'released' });  // asked again: still released
      } else if (line.type === 'reload') { if (released) unpark(true); }
      else if (line.type === 'stop') { stopping = true; current?.close(); unpark(false); wakeLoginWait(); stopped(); return; }
    }
    inputEnded = true;
    unpark(false);
    turns.end();
  })();

  try {
    await Promise.race([relaying, stop]);
  } catch (error) {
    return finish(1, (error as Error).message);
  } finally {
    turns.end();
    void reading.catch(() => undefined);
    void relaying.catch(() => undefined);
  }
  return finish(0);
}

if (import.meta.main) {
  const sdk = (await import(SDK)) as { query: QueryFn; createSdkMcpServer: McpFunctions['createSdkMcpServer']; tool: McpFunctions['tool'] };
  const { z } = (await import(ZOD)) as { z: ZodLike };
  const code = await run({
    query: sdk.query,
    mcp: { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, z },
    lines: createInterface({ input: process.stdin, crlfDelay: Infinity }),
    write: (line) => process.stdout.write(line + '\n'),
    readFile: (path) => { try { return readFileSync(path, 'utf8'); } catch { return undefined; } },
    env: process.env,
    log: (text) => process.stderr.write(text),
  });
  process.exit(code);
}
