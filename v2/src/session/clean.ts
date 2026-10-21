// Cleans every event before it is stored or pushed (docs/v2/milestone-1-plan.md,
// section 4): the same filter as the guard, the content of a read file never
// kept, command output cut to COMMAND_OUTPUT_LIMIT, reasoning reduced to its
// ids, and anything outside the AG-UI subset dropped.
//
// The guard's patterns are copied from lib/guard/codex-guard.mjs, not
// imported: that file is a command line that reads its arguments and exits
// when loaded, and lib/guard/private-terms.mjs runs git when loaded. A test
// keeps the copies word for word equal to the guard's.
import { createHash } from 'node:crypto';
import type { StopReason, ToolKind } from './contract.ts';
import { CUSTOM_NAMES, STEP_NAMES, isSubsetType, toolArgs, toolResult, type AgUiEvent, type ToolInput, type ToolOutput } from './events.ts';

// Characters of a command's output that are kept: the first
// COMMAND_OUTPUT_HEAD and the last ones, with a line saying how many were cut.
export const COMMAND_OUTPUT_LIMIT = 4096;
const COMMAND_OUTPUT_HEAD = 1024;

// [category, pattern] as the guard has them: its `always` list, its
// `envAssignments` and its `directOnly` forms (event text is a direct input:
// nothing in it is a code file sent anyway).
export const GUARD_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ['API key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['private key', /BEGIN [A-Z ]*PRIVATE KEY/],
  ['IBAN', /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,3})?\b/],
  ['credentials in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:[^\s@/'"`]+@/i],
  ['email address', /\b[a-z0-9._%+-]+@(?!(?:[a-z0-9-]+\.)*(?:example\.(?:com|org|net)|exemple\.fr|[a-z0-9-]+\.(?:test|invalid|localhost|example))(?![a-z0-9-]|\.[a-z0-9]))[a-z0-9.-]+\.[a-z]{2,}/i],
  ['phone number', /(?<![\d.,])(?:(?:\+|00)33 ?[1-9]|0[1-9])(?:\d{8}|(?: \d{2}){4}|(?:\.\d{2}){4})(?![\d.,])/],
  ['literal secret', /(?:pass(?:word)?|secret|token|api[_-]?key|pepper)\w*["']?\s*[:=]\s*(?:"(?!\$)[^"\s]{8,}"|'[^'\s]{8,}'|`(?!\$)[^`\s]{8,}`)/i],
  ['assigned secret', /^\s*(?:export\s+)?(?=[A-Z])[A-Z0-9_]*(?:PASS(?:WORD)?|SECRET|TOKEN|API_?KEY|PEPPER)[A-Z0-9_]*=[^\s"'$(#]{8,}/],
  ['assigned secret', /(?:pass(?:word)?|secret|token|api[_-]?key|pepper)\w*["']?\s*[:=]\s*["'][^"']*\s[^"']*["']/i],
  ['assigned secret', /^\s*[\w-]*(?:pass(?:word)?|secret|token|api[_-]?key|pepper)[\w-]*\s*:\s*(?![$"'{[(]|process\.env)[^\s#]{8,}/i],
];

// The guard only has to find a key's first line; a cleaner has to remove the
// whole block, up to its end line or, when the output was cut, to the end.
const KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

// Shorter values are not looked for: they would remove ordinary words.
const SHORTEST_SECRET = 8;

export type PrivateTerms = {
  readonly salt: string;                         // [guard] salt of the project
  readonly fingerprints: ReadonlySet<string>;    // sha256(salt + term), as lib/guard/private-terms.mjs makes them
};

export type CleanOptions = {
  readonly secrets?: readonly string[];          // literal values: the credential file, secret environment values
  readonly servicePaths?: readonly string[];     // the service's directories: state, configuration, home
  readonly tokenPrefixes?: readonly string[];    // [guard] token_patterns of the project
  readonly privateTerms?: PrivateTerms;          // names, places and amounts of the project
};

const removed = (what: string) => `[removed: ${what}]`;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Lowercase, accent-free words with digit groups joined, then every run of
// one to four words: the guard's normalizeWords and candidates.
function* candidates(text: string): Generator<string> {
  const words = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/(\d)[\s_\u00a0\u202f.,](?=\d{3}(?!\d))/g, '$1')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (let start = 0; start < words.length; start++)
    for (let size = 1; size <= 4 && start + size <= words.length; size++) yield words.slice(start, start + size).join(' ');
}

function hasPrivateTerm(text: string, terms: PrivateTerms): boolean {
  if (terms.fingerprints.size === 0) return false;
  for (const candidate of candidates(text))
    if (terms.fingerprints.has(createHash('sha256').update(terms.salt + candidate).digest('hex'))) return true;
  return false;
}

// Text with every secret, service path and guard match replaced by a
// [removed: <what>] marker. A private term replaces the whole text: the
// fingerprints say that a term is there, not where.
export function cleanText(text: string, options: CleanOptions): string {
  let out = text;
  const longestFirst = (values: readonly string[]) => [...values].sort((a, b) => b.length - a.length);
  for (const secret of longestFirst(options.secrets ?? []))
    if (secret.length >= SHORTEST_SECRET) out = out.split(secret).join(removed('secret'));
  for (const path of longestFirst((options.servicePaths ?? []).map((p) => p.replace(/\/+$/, ''))))
    if (path.length > 1) out = out.split(path).join(removed('service path'));
  out = out.replace(KEY_BLOCK, removed('private key'));
  for (const [category, pattern] of GUARD_PATTERNS) out = out.replace(new RegExp(pattern.source, pattern.flags + 'gm'), removed(category));
  for (const prefix of options.tokenPrefixes ?? [])
    if (prefix) out = out.replace(new RegExp(`${escape(prefix)}[A-Za-z0-9_-]{8,}`, 'g'), removed('application token'));
  if (options.privateTerms && hasPrivateTerm(out, options.privateTerms)) return removed('private term');
  return out;
}

// The values of the environment whose names say they are secrets.
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => /PASS|SECRET|TOKEN|API_?KEY|PEPPER|CREDENTIAL|PRIVATE_KEY/i.test(name) && value !== undefined && value.length >= SHORTEST_SECRET)
    .map(([, value]) => value as string);
}

// Text cut to the limit: its start and its end, never half a character.
function cut(text: string): { readonly text: string; readonly cut: number } {
  const chars = Array.from(text);
  if (chars.length <= COMMAND_OUTPUT_LIMIT) return { text, cut: 0 };
  const gone = chars.length - COMMAND_OUTPUT_LIMIT;
  const head = chars.slice(0, COMMAND_OUTPUT_HEAD).join('');
  const tail = chars.slice(chars.length - (COMMAND_OUTPUT_LIMIT - COMMAND_OUTPUT_HEAD)).join('');
  return { text: `${head}\n[cleared: ${gone} characters cut]\n${tail}`, cut: gone };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const count = (value: unknown): number => (isCount(value) ? Math.floor(value) : 0);

const KINDS: readonly ToolKind[] = ['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'];
const STOP_REASONS: readonly StopReason[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error'];

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

// A result content in Cleared's own form for this kind, every field of the
// right type; anything else (a command printing JSON with a `kind`) is not.
function ownOutput(kind: ToolKind, parsed: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (parsed?.kind !== kind) return undefined;
  if (kind === 'read') return typeof parsed.path === 'string' && isCount(parsed.bytes) ? parsed : undefined;
  if (kind === 'execute') return typeof parsed.output === 'string' && isCount(parsed.cut) && typeof parsed.isError === 'boolean' ? parsed : undefined;
  return typeof parsed.ok === 'boolean' && (parsed.error === undefined || typeof parsed.error === 'string') ? parsed : undefined;
}

export type Cleaner = {
  // The events to store for one event of the harness: none, one, or, at the
  // end of a text message or of a run, the message's text before its end.
  clean(event: AgUiEvent): AgUiEvent[];
};

// One cleaner per session.
// - It remembers each tool call's kind and path from its ARGS, so that a
//   result is cleaned by what the call was, whatever the result carries. A
//   result whose call it never saw keeps its kind, and for a read its path
//   and size, but no output and no error.
// - It holds the text of a message until TEXT_MESSAGE_END and cleans it
//   whole, so that a secret split across deltas is still found. The text
//   goes out as one TEXT_MESSAGE_CONTENT just before the end; a run that
//   ends or fails first closes its open messages.
export function createCleaner(options: CleanOptions = {}): Cleaner {
  const calls = new Map<string, ToolInput>();
  const messages = new Map<string, string[]>();
  const text = (value: unknown): string => (typeof value === 'string' ? cleanText(value, options) : '');
  const short = (value: unknown): string => cut(text(value)).text;
  const deep = (value: unknown): unknown => {
    if (typeof value === 'string') return cleanText(value, options);
    if (Array.isArray(value)) return value.map(deep);
    const object = record(value);
    if (!object) return value;
    return Object.fromEntries(Object.entries(object).filter(([key]) => key !== 'rawEvent').map(([key, item]) => [key, deep(item)]));
  };

  function shapeInput(raw: Record<string, unknown> | undefined): ToolInput {
    switch (raw?.kind) {
      case 'read': return { kind: 'read', path: text(raw.path) };
      case 'edit': return { kind: 'edit', path: text(raw.path), added: count(raw.added), removed: count(raw.removed) };
      case 'delete': case 'move': return { kind: raw.kind, path: text(raw.path) };
      case 'execute': return typeof raw.description === 'string'
        ? { kind: 'execute', command: short(raw.command), description: short(raw.description) }
        : { kind: 'execute', command: short(raw.command) };
      case 'search': return typeof raw.path === 'string'
        ? { kind: 'search', pattern: text(raw.pattern), path: text(raw.path) }
        : { kind: 'search', pattern: text(raw.pattern) };
      case 'fetch': return { kind: 'fetch', target: text(raw.target) };
      case 'think': case 'switch_mode': return { kind: raw.kind };
      default: return { kind: 'other' };
    }
  }

  function shapeOutput(call: ToolInput | undefined, content: string): ToolOutput {
    const parsed = parseObject(content);
    const kind = call?.kind ?? KINDS.find((k) => ownOutput(k, parsed)) ?? 'other';
    const own = ownOutput(kind, parsed);
    if (kind === 'read') {
      const path = call?.kind === 'read' ? call.path : text(own?.path);
      return { kind: 'read', path, bytes: own ? count(own.bytes) : call ? Buffer.byteLength(content) : 0 };
    }
    if (kind === 'execute') {
      // Without the call's ARGS, no output is kept: it could be anything.
      const kept = cut(text(!call ? '' : own ? own.output : content));
      return { kind: 'execute', output: kept.text, cut: (call ? count(own?.cut) : 0) + kept.cut, isError: own?.isError === true };
    }
    const ok = typeof own?.ok === 'boolean' ? own.ok : true;
    return call && typeof own?.error === 'string' ? { kind, ok, error: short(own.error) } : { kind, ok };
  }

  // The text of a message, cleaned whole, if it has any.
  function flush(messageId: string): AgUiEvent[] {
    const parts = messages.get(messageId);
    messages.delete(messageId);
    return parts && parts.length > 0 ? [{ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text(parts.join('')) }] : [];
  }

  // Every message still open, closed: when the run ends without their end.
  function closeAll(): AgUiEvent[] {
    return [...messages.keys()].flatMap((messageId) => [...flush(messageId), { type: 'TEXT_MESSAGE_END', messageId } as const]);
  }

  function clean(event: AgUiEvent): AgUiEvent[] {
    const e = event as unknown as Record<string, unknown>;
    if (typeof e.type !== 'string' || !isSubsetType(e.type)) return [];
    const stamp = typeof e.timestamp === 'number' ? { timestamp: e.timestamp } : {};
    switch (event.type) {
      case 'RUN_STARTED':
        return [{ type: event.type, threadId: text(event.threadId), runId: text(event.runId), ...stamp }];
      case 'RUN_FINISHED': {
        const result = record(e.result);
        const stopReason = STOP_REASONS.find((reason) => reason === result?.stopReason) ?? 'error';
        const cancelled = record(e.outcome)?.type === 'cancelled' || stopReason === 'cancelled';
        const usage = (Array.isArray(e.usage) ? e.usage : []).map(record).filter((u) => u !== undefined)
          .map((u) => Object.fromEntries(Object.entries(u).filter(([k, v]) => (k === 'model' ? typeof v === 'string' : isCount(v)))));
        return [...closeAll(), {
          type: event.type, threadId: text(e.threadId), runId: text(e.runId),
          outcome: cancelled ? { type: 'cancelled' } : { type: 'success' },
          usage,
          result: { stopReason, total_cost_usd: typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null },
          ...stamp,
        }];
      }
      case 'RUN_ERROR':
        return [...closeAll(), { type: event.type, message: short(event.message), ...(typeof event.code === 'string' ? { code: text(event.code) } : {}), ...stamp }];
      case 'STEP_STARTED': case 'STEP_FINISHED':
        return (STEP_NAMES as readonly string[]).includes(event.stepName) ? [{ type: event.type, stepName: event.stepName, ...stamp }] : [];
      case 'TEXT_MESSAGE_START': {
        const messageId = text(event.messageId);
        messages.set(messageId, []);
        return [{ type: event.type, messageId, role: event.role === 'user' ? 'user' : 'assistant', ...(typeof event.name === 'string' ? { name: text(event.name) } : {}), ...stamp }];
      }
      case 'TEXT_MESSAGE_CONTENT': {
        const messageId = text(event.messageId);
        const parts = messages.get(messageId) ?? [];
        if (typeof event.delta === 'string') parts.push(event.delta);
        messages.set(messageId, parts);
        return [];
      }
      case 'TEXT_MESSAGE_END': {
        const messageId = text(event.messageId);
        return [...flush(messageId), { type: event.type, messageId, ...stamp }];
      }
      case 'TOOL_CALL_START':
        return [{ type: event.type, toolCallId: text(event.toolCallId), toolCallName: text(event.toolCallName), ...(typeof event.parentMessageId === 'string' ? { parentMessageId: text(event.parentMessageId) } : {}), ...stamp }];
      case 'TOOL_CALL_ARGS': {
        const toolCallId = text(event.toolCallId);
        const input = shapeInput(typeof event.delta === 'string' ? parseObject(event.delta) : undefined);
        calls.set(toolCallId, input);
        return [{ ...toolArgs(toolCallId, input), ...stamp }];
      }
      case 'TOOL_CALL_END':
        return [{ type: event.type, toolCallId: text(event.toolCallId), ...stamp }];
      case 'TOOL_CALL_RESULT': {
        const toolCallId = text(event.toolCallId);
        const content = typeof event.content === 'string' ? event.content : '';
        return [{ ...toolResult(text(event.messageId), toolCallId, shapeOutput(calls.get(toolCallId), content)), ...stamp }];
      }
      case 'REASONING_START': case 'REASONING_END':
        return [{ type: event.type, messageId: text(event.messageId), ...stamp }];
      case 'STATE_SNAPSHOT':
        return [{ type: event.type, snapshot: deep(event.snapshot) as typeof event.snapshot, ...stamp }];
      case 'STATE_DELTA':
        return [{ type: event.type, delta: (Array.isArray(event.delta) ? deep(event.delta) : []) as typeof event.delta, ...stamp }];
      case 'CUSTOM': {
        if (!(CUSTOM_NAMES as readonly string[]).includes(event.name)) return [];
        const value = (deep(event.value) ?? {}) as Record<string, unknown>;
        if (event.name === 'cleared.permission_request') value.input = shapeInput(record(record(event.value)?.input));
        return [{ type: 'CUSTOM', name: event.name, value, ...stamp } as AgUiEvent];
      }
    }
  }

  return { clean };
}
