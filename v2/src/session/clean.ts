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
import { CUSTOM_NAMES, isSubsetType, toolArgs, toolResult, type AgUiEvent, type ToolInput, type ToolOutput } from './events.ts';

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
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0);

function parseKind(text: string): Record<string, unknown> | undefined {
  try {
    const value = record(JSON.parse(text));
    return typeof value?.kind === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

export type Cleaner = {
  clean(event: AgUiEvent): AgUiEvent | null;
};

// One cleaner per session: it remembers each tool call's kind and path from
// its ARGS, so that a result is cleaned by what the call was, whatever the
// result carries. A result whose call it never saw keeps no content.
export function createCleaner(options: CleanOptions = {}): Cleaner {
  const calls = new Map<string, ToolInput>();
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
    const parsed = parseKind(content);
    const kind = call?.kind ?? (typeof parsed?.kind === 'string' ? parsed.kind : 'other');
    const own = parsed?.kind === kind ? parsed : undefined;
    if (kind === 'read') {
      const path = call?.kind === 'read' ? call.path : text(own?.path);
      return { kind: 'read', path, bytes: own ? count(own.bytes) : parsed ? 0 : Buffer.byteLength(content) };
    }
    if (kind === 'execute') {
      // Without a call, a raw string is never kept: it could be anything.
      const raw = own ? own.output : call && !parsed ? content : '';
      const kept = cut(text(raw));
      return { kind: 'execute', output: kept.text, cut: count(own?.cut) + kept.cut, isError: own?.isError === true };
    }
    const other = (['edit', 'delete', 'move', 'search', 'think', 'fetch', 'switch_mode'] as const).find((k) => k === kind) ?? 'other';
    const ok = typeof own?.ok === 'boolean' ? own.ok : true;
    return typeof own?.error === 'string' ? { kind: other, ok, error: short(own.error) } : { kind: other, ok };
  }

  function clean(event: AgUiEvent): AgUiEvent | null {
    const e = event as unknown as Record<string, unknown>;
    if (typeof e.type !== 'string' || !isSubsetType(e.type)) return null;
    const stamp = typeof e.timestamp === 'number' ? { timestamp: e.timestamp } : {};
    switch (event.type) {
      case 'RUN_STARTED':
        return { type: event.type, threadId: event.threadId, runId: event.runId, ...stamp };
      case 'RUN_FINISHED':
        return {
          type: event.type, threadId: event.threadId, runId: event.runId,
          outcome: event.outcome?.type === 'cancelled' ? { type: 'cancelled' } : { type: 'success' },
          usage: (event.usage ?? []).map((u) => Object.fromEntries(Object.entries(u).filter(([k, v]) => (k === 'model' ? typeof v === 'string' : typeof v === 'number')))),
          result: { stopReason: event.result.stopReason, total_cost_usd: typeof event.result.total_cost_usd === 'number' ? event.result.total_cost_usd : null },
          ...stamp,
        };
      case 'RUN_ERROR':
        return { type: event.type, message: short(event.message), ...(typeof event.code === 'string' ? { code: text(event.code) } : {}), ...stamp };
      case 'STEP_STARTED': case 'STEP_FINISHED':
        return { type: event.type, stepName: event.stepName, ...stamp };
      case 'TEXT_MESSAGE_START':
        return { type: event.type, messageId: event.messageId, role: event.role === 'user' ? 'user' : 'assistant', ...(typeof event.name === 'string' ? { name: event.name } : {}), ...stamp };
      case 'TEXT_MESSAGE_CONTENT':
        return { type: event.type, messageId: event.messageId, delta: text(event.delta), ...stamp };
      case 'TEXT_MESSAGE_END':
        return { type: event.type, messageId: event.messageId, ...stamp };
      case 'TOOL_CALL_START':
        return { type: event.type, toolCallId: event.toolCallId, toolCallName: text(event.toolCallName), ...(typeof event.parentMessageId === 'string' ? { parentMessageId: event.parentMessageId } : {}), ...stamp };
      case 'TOOL_CALL_ARGS': {
        const input = shapeInput(parseKind(event.delta));
        calls.set(event.toolCallId, input);
        return { ...toolArgs(event.toolCallId, input), ...stamp };
      }
      case 'TOOL_CALL_END':
        return { type: event.type, toolCallId: event.toolCallId, ...stamp };
      case 'TOOL_CALL_RESULT': {
        const content = typeof event.content === 'string' ? event.content : '';
        return { ...toolResult(event.messageId, event.toolCallId, shapeOutput(calls.get(event.toolCallId), content)), ...stamp };
      }
      case 'REASONING_START': case 'REASONING_END':
        return { type: event.type, messageId: event.messageId, ...stamp };
      case 'STATE_SNAPSHOT':
        return { type: event.type, snapshot: deep(event.snapshot) as typeof event.snapshot, ...stamp };
      case 'STATE_DELTA':
        return { type: event.type, delta: deep(event.delta) as typeof event.delta, ...stamp };
      case 'CUSTOM': {
        if (!(CUSTOM_NAMES as readonly string[]).includes(event.name)) return null;
        const value = deep(event.value) as Record<string, unknown>;
        if (event.name === 'cleared.permission_request') value.input = shapeInput(record(event.value.input));
        return { type: 'CUSTOM', name: event.name, value, ...stamp } as AgUiEvent;
      }
    }
  }

  return { clean };
}
