// The ledger's MCP server (issue 292): Model Context Protocol over stdio,
// newline-delimited JSON-RPC 2.0, written here rather than taken from the
// SDK, since the service has no runtime dependency (v2/README.md). It
// answers initialize, ping, tools/list and tools/call (rpc.ts, the core it
// shares with the lanes' server), and offers three tools that only read:
// search_sessions, search_events and get_session_timeline (history.ts). Its words are its own catalog's
// (messages/ledger.<language>.json), over the shell's for the units of a
// duration, which app/web/lib/time.ts says as the app says it.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { loadCatalog, type Language } from '../../app/src/catalog.ts';
import { translator, type Catalog, type Translate } from '../../app/web/lib/i18n.ts';
import { lasted } from '../../app/web/lib/time.ts';
import { DEFAULT_LIMIT, HistoryError, MAX_LIMIT, type LedgerHistory, type SessionView } from './history.ts';
import { answer, createToolServer, type Args, type Argument, type Tool, type ToolServer } from './rpc.ts';

export { PROTOCOL_VERSIONS } from './rpc.ts';
export const MESSAGES_DIR = new URL('./messages/', import.meta.url).pathname;
const SERVER_INFO = { name: 'cleared-ledger', version: '1.0.0' };

function catalogOf(language: Language): Catalog {
  const read = (lang: Language) => JSON.parse(readFileSync(`${MESSAGES_DIR}ledger.${lang}.json`, 'utf8')) as Record<string, string>;
  return { ...loadCatalog('shell', language), ...read('en'), ...(language === 'en' ? {} : read(language)) };
}

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

export type LedgerServer = ToolServer;

export type ServerOptions = {
  readonly history: LedgerHistory;
  readonly language: Language;
  readonly log?: (line: string) => void;      // what failed to read, for the operator; never sent to the client
};

export function createLedgerServer(options: ServerOptions): LedgerServer {
  const t = translator(catalogOf(options.language));
  const said = (session: SessionView) => ({ ...session, duration: session.durationMs === null ? null : lasted(session.durationMs, t) });

  function run(tool: Tool, a: Args) {
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
    if (!timeline) throw new HistoryError('error_no_session');
    return answer({ session: said(timeline.session), events: timeline.events, next: timeline.next });
  }

  return createToolServer({ t, info: SERVER_INFO, tools: tools(t), run, label: 'ledger-mcp', ...(options.log ? { log: options.log } : {}) });
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
    const response = parsed ? await server.handle(message) : server.unparsable();
    if (response) output.write(`${JSON.stringify(response)}\n`);
  }
  if (failure && failure.code !== 'EPIPE') throw failure;
}
