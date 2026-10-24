// The ledger's MCP server (issue 292): Model Context Protocol over stdio,
// newline-delimited JSON-RPC 2.0, written here rather than taken from the
// SDK, since the service has no runtime dependency (v2/README.md). It
// answers initialize, ping, tools/list and tools/call, and offers three
// tools that only read: search_sessions, search_events and
// get_session_timeline (history.ts). Its words are its own catalog's
// (messages/ledger.<language>.json), over the shell's for the units of a
// duration, which app/web/lib/time.ts says as the app says it.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { loadCatalog, type Language } from '../../app/src/catalog.ts';
import { translator, type Catalog, type Translate } from '../../app/web/lib/i18n.ts';
import { lasted } from '../../app/web/lib/time.ts';
import { DEFAULT_LIMIT, HistoryError, MAX_LIMIT, type LedgerHistory, type SessionView } from './history.ts';

// Newest first: the version answered to a client that asks for another.
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MESSAGES_DIR = new URL('./messages/', import.meta.url).pathname;
const SERVER_INFO = { name: 'cleared-ledger', version: '1.0.0' };

function catalogOf(language: Language): Catalog {
  const read = (lang: Language) => JSON.parse(readFileSync(`${MESSAGES_DIR}ledger.${lang}.json`, 'utf8')) as Record<string, string>;
  return { ...loadCatalog('shell', language), ...read('en'), ...(language === 'en' ? {} : read(language)) };
}

type Kind = 'string' | 'integer';
type Argument = { readonly kind: Kind; readonly description: string; readonly enum?: readonly string[] };
type Tool = { readonly name: string; readonly description: string; readonly args: Readonly<Record<string, Argument>>; readonly required?: readonly string[] };

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function tools(t: Translate): Tool[] {
  const limits = { default: DEFAULT_LIMIT, max: MAX_LIMIT };
  const common: Record<string, Argument> = {
    ticket: { kind: 'string', description: t('arg_ticket') },
    project: { kind: 'string', description: t('arg_project') },
    from: { kind: 'string', description: t('arg_from') },
    to: { kind: 'string', description: t('arg_to') },
    limit: { kind: 'integer', description: t('arg_limit', limits) },
    cursor: { kind: 'string', description: t('arg_cursor') },
  };
  return [
    {
      name: 'search_sessions', description: t('tool_search_sessions'),
      args: { text: { kind: 'string', description: t('arg_text_sessions') }, ...common, role: { kind: 'string', description: t('arg_role'), enum: ['author', 'reviewer', 'lead', 'reader'] }, status: { kind: 'string', description: t('arg_status') } },
    },
    {
      name: 'search_events', description: t('tool_search_events'),
      args: { text: { kind: 'string', description: t('arg_text_events') }, ...common, session_id: { kind: 'string', description: t('arg_session_filter') }, type: { kind: 'string', description: t('arg_type') } },
    },
    {
      name: 'get_session_timeline', description: t('tool_get_session_timeline'), required: ['session_id'],
      args: { session_id: { kind: 'string', description: t('arg_session_id') }, after_seq: { kind: 'integer', description: t('arg_after_seq') }, limit: common.limit as Argument },
    },
  ];
}

const schema = (tool: Tool) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(tool.args).map(([name, arg]) => [name, { type: arg.kind, description: arg.description, ...(arg.enum ? { enum: arg.enum } : {}) }])),
  ...(tool.required ? { required: tool.required } : {}),
  additionalProperties: false,
});

type Id = string | number | null;
type Response = { readonly jsonrpc: '2.0'; readonly id: Id; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string } };

export type LedgerServer = {
  // The answer to one message, or undefined for a notification.
  handle(message: unknown): Response | undefined;
  // The answer to a line that is not JSON.
  unparsable(): Response;
};

export type ServerOptions = {
  readonly history: LedgerHistory;
  readonly language: Language;
  readonly log?: (line: string) => void;      // what failed to read, for the operator; never sent to the client
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function createLedgerServer(options: ServerOptions): LedgerServer {
  const t = translator(catalogOf(options.language));
  const list = tools(t);
  const ok = (id: Id, result: unknown): Response => ({ jsonrpc: '2.0', id, result });
  const fail = (id: Id, code: number, message: string): Response => ({ jsonrpc: '2.0', id, error: { code, message } });
  const refused = (key: string, values?: Record<string, string | number>) => ({ content: [{ type: 'text', text: t(key, values) }], isError: true });
  const answer = (value: Record<string, unknown>) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
  const said = (session: SessionView) => ({ ...session, duration: session.durationMs === null ? null : lasted(session.durationMs, t) });

  // The arguments as the schema declares them: an unknown name, a wrong
  // type or a missing required one is refused with its name.
  function read(tool: Tool, input: unknown): Record<string, string | number> {
    const args = isRecord(input) ? input : {};
    for (const [name, value] of Object.entries(args)) {
      const arg = tool.args[name];
      if (!arg) throw new HistoryError('error_unknown_argument', { name });
      if (arg.kind === 'string' ? typeof value !== 'string' : !Number.isInteger(value)) throw new HistoryError('error_argument_type', { name });
      if (arg.enum && !arg.enum.includes(value as string)) throw new HistoryError('error_argument_type', { name });
    }
    for (const name of tool.required ?? []) if (args[name] === undefined) throw new HistoryError('error_required', { name });
    return args as Record<string, string | number>;
  }

  function run(tool: Tool, input: unknown) {
    const a = read(tool, input);
    const s = (name: string) => a[name] as string | undefined;
    const n = (name: string) => a[name] as number | undefined;
    const { history } = options;
    if (tool.name === 'search_sessions') {
      const page = history.searchSessions({ text: s('text'), ticket: s('ticket'), project: s('project'), role: s('role'), status: s('status'), from: s('from'), to: s('to'), limit: n('limit'), cursor: s('cursor') });
      return answer({ sessions: page.items.map(said), next: page.next, partial: page.partial });
    }
    if (tool.name === 'search_events') {
      const page = history.searchEvents({ text: s('text'), ticket: s('ticket'), project: s('project'), sessionId: s('session_id'), type: s('type'), from: s('from'), to: s('to'), limit: n('limit'), cursor: s('cursor') });
      return answer({ events: page.items, next: page.next, partial: page.partial });
    }
    const timeline = history.timeline(s('session_id') as string, { afterSeq: n('after_seq'), limit: n('limit') });
    if (!timeline) return refused('error_no_session');
    return answer({ session: said(timeline.session), events: timeline.events, next: timeline.next });
  }

  function call(id: Id, params: unknown): Response {
    const name = isRecord(params) ? params.name : undefined;
    const tool = list.find((candidate) => candidate.name === name);
    if (!tool) return fail(id, -32602, t('error_unknown_tool', { name: typeof name === 'string' ? name.slice(0, 64) : '' }));
    try {
      return ok(id, run(tool, isRecord(params) ? params.arguments : undefined));
    } catch (error) {
      if (error instanceof HistoryError) return ok(id, refused(error.key, error.values));
      options.log?.(`cleared-v2 ledger-mcp: ${tool.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      return ok(id, refused('error_read'));
    }
  }

  return {
    handle(message) {
      if (!isRecord(message)) return fail(null, -32600, t('rpc_invalid'));
      const notification = !('id' in message);
      const id: Id = typeof message.id === 'string' || typeof message.id === 'number' ? message.id : null;
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') return notification ? undefined : fail(id, -32600, t('rpc_invalid'));
      if (notification) return undefined;
      const params = message.params;
      switch (message.method) {
        case 'initialize': {
          const asked = isRecord(params) ? params.protocolVersion : undefined;
          const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
          return ok(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: t('instructions') });
        }
        case 'ping': return ok(id, {});
        case 'tools/list': return ok(id, { tools: list.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: schema(tool), annotations: ANNOTATIONS })) });
        case 'tools/call': return call(id, params);
        default: return fail(id, -32601, t('rpc_method', { name: message.method.slice(0, 64) }));
      }
    },
    unparsable: () => fail(null, -32700, t('rpc_parse')),
  };
}

// Serves one client: a message per line in, an answer per line out, until
// the input closes. Nothing else is written to the output. A client that
// closed its end of the output (EPIPE) is gone: the input is let go and the
// call ends as if the input had closed; any other failure of the output is
// thrown once the reading has stopped.
export async function serveStdio(input: Readable, output: Writable, server: LedgerServer): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity });
  let failure: NodeJS.ErrnoException | undefined;
  output.on('error', (error: NodeJS.ErrnoException) => {
    failure ??= error;
    lines.close();
    input.destroy();
  });
  for await (const line of lines) {
    if (failure) break;
    if (!line.trim()) continue;
    let message: unknown;
    let parsed = true;
    try { message = JSON.parse(line); } catch { parsed = false; }
    const response = parsed ? server.handle(message) : server.unparsable();
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
  if (failure && failure.code !== 'EPIPE') throw failure;
}
