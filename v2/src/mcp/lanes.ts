// The lanes' MCP tools (P216): what a local Claude Code asks before it
// edits a checkout of the project. Three tools that only read, over the
// engine and the ledger the service already holds:
//
//   list_lanes    the tickets whose branch is not landed (out of Todo, not
//                 Done), with whether a flow runs and the sessions of it;
//   list_tickets  the open tickets (Done only when asked), never a body;
//   locked_files  the files a lane's session edited or its plan named,
//                 relative to the checkout's root, or whether one is held.
//
// Cleared takes no lock on a file: a file is "held" from the moment a lane's
// session edits it or names it in its session plan, for as long as the
// lane's ticket is out of Todo and not Done. The flow ends when the release
// waits for a person, but the pull request still holds the edits, so a file
// stays held through Needs Approval and Ready to Ship. A lane's sessions are
// those started since the ticket last left Todo: a ticket put back and
// started again holds only what its new flow touched. An edit counts once
// its arguments are journaled, as the session screen's Changes card counts
// it (flow/state.ts), so a refused edit still holds its file until the lane
// ends: the safer side for an agent about to edit it.
//
// Every string of an answer goes through the ledger's cleaner (redact.ts).
// The words are messages/lanes.<language>.json, over the shell's for a
// duration, said as the app says it (app/web/lib/time.ts); a duration from a
// date that is none is null. A call reads the tickets once and their history
// once (TicketStore.histories), whatever the number of lanes.
import { readFileSync } from 'node:fs';
import { loadCatalog, type Language } from '../../app/src/catalog.ts';
import { translator, type Catalog, type Translate } from '../../app/web/lib/i18n.ts';
import { lasted } from '../../app/web/lib/time.ts';
import type { SessionDetail } from '../api/types.ts';
import type { FlowEngine } from '../flow/engine.ts';
import { checkoutPath } from '../flow/files.ts';
import type { Store } from '../store/db.ts';
import type { StatusChange, Ticket } from '../tickets/contract.ts';
import type { Redactor } from './redact.ts';
import { ToolError, answer, createToolServer, type Args, type Tool, type ToolServer } from './rpc.ts';

const MESSAGES_DIR = new URL('./messages/', import.meta.url).pathname;
const SERVER_INFO = { name: 'cleared-lanes', version: '1.0.0' };
export const MAX_TICKETS = 100;

const catalogs = new Map<Language, Catalog>();
export function lanesCatalog(language: Language): Catalog {
  const known = catalogs.get(language);
  if (known) return known;
  const read = (lang: Language) => JSON.parse(readFileSync(`${MESSAGES_DIR}lanes.${lang}.json`, 'utf8')) as Record<string, string>;
  const catalog = { ...loadCatalog('shell', language), ...read('en'), ...(language === 'en' ? {} : read(language)) };
  catalogs.set(language, catalog);
  return catalog;
}

function tools(t: Translate): Tool[] {
  return [
    { name: 'list_lanes', description: t('tool_list_lanes'), args: {} },
    { name: 'list_tickets', description: t('tool_list_tickets', { max: MAX_TICKETS }), args: { status: { kind: 'string', description: t('arg_status') } } },
    {
      name: 'locked_files', description: t('tool_locked_files'),
      args: { path: { kind: 'string', description: t('arg_path') }, service: { kind: 'string', description: t('arg_service') } },
    },
  ];
}

export type LanesDeps = {
  readonly engine: FlowEngine | undefined;    // undefined: the flow is not set up (CLEARED_V2_PROJECT)
  readonly store: Store | undefined;
  readonly redactor: Redactor;
  readonly language: Language;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
};

type Lane = { readonly ticket: Ticket; readonly since: string; readonly sessions: SessionDetail[] };

// When the ticket's current flow began: the first move after it last was in Todo.
function flowStart(history: readonly StatusChange[], todo: string, ticket: Ticket): string {
  let start: string | undefined;
  for (const change of history) {
    if (change.status === todo) start = undefined;
    else start ??= change.at;
  }
  return start ?? ticket.createdAt;
}

// A path relative to the checkout's root, as a session names it, without a
// last slash; undefined for a path outside the checkout.
function relative(path: string): string | undefined {
  return checkoutPath(path)?.replace(/\/+$/, '') || undefined;
}

export function createLanesServer(deps: LanesDeps): ToolServer {
  const t = translator(lanesCatalog(deps.language));
  const now = deps.now ?? (() => new Date());
  // How long since `at`, as the app says it; null when a date is none, so
  // an answer never says "NaN".
  const since = (at: string) => {
    const ms = now().getTime() - Date.parse(at);
    return Number.isFinite(ms) ? lasted(ms, t) : null;
  };

  function flow(): { engine: FlowEngine; store: Store } {
    if (!deps.engine || !deps.store) throw new ToolError('error_no_flow');
    return { engine: deps.engine, store: deps.store };
  }

  async function lanes(): Promise<Lane[]> {
    const { engine, store } = flow();
    const tickets = engine.registry.ticketStore;
    const { todo, done } = tickets.states;
    const open = (await tickets.list({ project: engine.config.project })).filter((ticket) => ticket.status !== todo && ticket.status !== done);
    // Every open ticket's history in one read, not one per ticket.
    const histories = await tickets.histories(open.map((ticket) => ticket.id));
    const out = open.map((ticket): Lane => {
      const start = flowStart(histories.get(ticket.id) ?? [], todo, ticket);
      const sessions = store.sessions.list({ ticket: ticket.id })
        .filter((row) => row.role !== 'lead' && row.createdAt >= start)
        .flatMap((row) => engine.sessionDetail(row.id) ?? []);
      return { ticket, since: start, sessions };
    });
    return out.sort((a, b) => a.since.localeCompare(b.since) || a.ticket.id.localeCompare(b.ticket.id));
  }

  const services = (ticket: Ticket) => (ticket.services ?? []).map((s) => ({ name: s.name, branch: s.branch, pr: s.pr }));
  const cleaned = (value: Record<string, unknown>) => answer(deps.redactor.value(value) as Record<string, unknown>);

  async function listLanes() {
    const { engine } = flow();
    return cleaned({
      lanes: (await lanes()).map((lane) => ({
        ticket: lane.ticket.id, title: lane.ticket.title, status: lane.ticket.status, running: engine.isActive(lane.ticket.id),
        services: services(lane.ticket), startedAt: lane.since, runningFor: since(lane.since),
        sessions: lane.sessions.map((s) => ({
          sessionId: s.id, role: s.role, harness: s.harness, model: s.model, phase: s.phase, status: s.status, service: s.service ?? null,
          startedAt: s.startedAt, for: since(s.startedAt), dormant: s.dormant === true, takenOver: s.takenOver ?? null,
        })),
      })),
    });
  }

  async function listTickets(status: string | undefined) {
    const { engine } = flow();
    const tickets = engine.registry.ticketStore;
    const found = (await tickets.list({ project: engine.config.project }))
      .filter((ticket) => (status === undefined ? ticket.status !== tickets.states.done : ticket.status === status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    return cleaned({
      tickets: found.slice(0, MAX_TICKETS).map((ticket) => ({
        ticket: ticket.id, title: ticket.title, status: ticket.status, labels: ticket.labels, running: engine.isActive(ticket.id),
        services: services(ticket), updatedAt: ticket.updatedAt,
      })),
      more: Math.max(0, found.length - MAX_TICKETS),
    });
  }

  async function lockedFiles(path: string | undefined, service: string | undefined) {
    const wanted = path === undefined ? undefined : relative(path);
    if (path !== undefined && wanted === undefined) throw new ToolError('error_path');
    const matches = (file: string) => wanted === undefined || file === wanted || file.startsWith(`${wanted}/`);
    const held = new Map<string, { path: string; service: string | null; ticket: string; title: string; sessionId: string; role: string; why: Set<'edited' | 'planned'>; since: string }>();
    for (const lane of await lanes()) {
      const only = lane.ticket.services?.length === 1 ? (lane.ticket.services[0]?.name ?? null) : null;
      for (const session of lane.sessions) {
        const on = session.service ?? only;
        if (service !== undefined && on !== service) continue;
        const add = (named: string, why: 'edited' | 'planned') => {
          const file = relative(named);
          if (file === undefined || !matches(file)) return;
          const key = JSON.stringify([on, file, session.id]);
          const entry = held.get(key) ?? { path: file, service: on, ticket: lane.ticket.id, title: lane.ticket.title, sessionId: session.id, role: session.role, why: new Set(), since: lane.since };
          entry.why.add(why);
          held.set(key, entry);
        };
        for (const file of session.state.files) add(file.path, 'edited');
        for (const file of session.state.plan?.files ?? []) add(file, 'planned');
      }
    }
    const files = [...held.values()]
      .sort((a, b) => a.path.localeCompare(b.path) || String(a.service).localeCompare(String(b.service)) || a.ticket.localeCompare(b.ticket))
      .map((entry) => ({ ...entry, why: (['edited', 'planned'] as const).filter((why) => entry.why.has(why)), heldFor: since(entry.since) }));
    return cleaned({ locked: files.length > 0, files });
  }

  function run(tool: Tool, a: Args) {
    const s = (name: string) => a[name] as string | undefined;
    if (tool.name === 'list_lanes') return listLanes();
    if (tool.name === 'list_tickets') return listTickets(s('status'));
    return lockedFiles(s('path'), s('service'));
  }

  return createToolServer({ t, info: SERVER_INFO, tools: tools(t), run, label: 'lanes-mcp', ...(deps.log ? { log: deps.log } : {}) });
}
