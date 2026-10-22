// The fixture source (CLEARED_V2_APP_SOURCE=fixtures): the service's read
// routes answered in the app's process from the tower fixture and, for the
// lead and its plans (milestone 2, section 7.1), from the lead fixture; and
// ticket creation into an in-memory ticket store, so the screens work
// before the service does. It approves, answers, moves and sends nothing:
// every other write is a 404. The session tabs' routes (lane 20) are
// answered too: the workspace, a session's files (the session fixture's
// contents), and Take over and Give back, kept in memory; no session of the
// tower's has a plan waiting, so a Go or a Change is a 409.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { leadFrame, sseFrame, type CreateTicketBody, type SessionDetail, type TakenOver } from '../../src/api/types.ts';
import { changedFiles } from '../../src/flow/files.ts';
import type { SessionState } from '../../src/session/events.ts';
import { MemoryTicketStore, type Ticket } from '../../src/tickets/contract.ts';
import { sendJson, type DataSource } from '../src/proxy.ts';
import { leadFixture } from './lead.ts';
import { PREVIEW_KEY, fixtureFile, workspaceFixture } from './session.ts';
import { towerFixture } from './tower.ts';

const BODY_LIMIT = 16 * 1024;
export const TITLE_LIMIT = 200;

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let text = '';
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) text += chunk.toString('utf8');
    });
    request.on('end', () => {
      if (size > BODY_LIMIT) return resolve(undefined);
      try { resolve(JSON.parse(text)); }
      catch { resolve(undefined); }
    });
    request.on('error', () => resolve(undefined));
  });
}

function ticketBody(value: unknown, project: string): CreateTicketBody | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { title, body } = value as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim() || title.length > TITLE_LIMIT) return undefined;
  if (body !== undefined && typeof body !== 'string') return undefined;
  return { title: title.trim(), ...(typeof body === 'string' ? { body } : {}), project };
}

export async function fixtureSource(options: { readonly now?: () => Date; readonly project?: string } = {}): Promise<DataSource> {
  const now = options.now ?? (() => new Date());
  const fixture = await towerFixture(now(), options.project === undefined ? {} : { project: options.project });
  const lead = await leadFixture(now(), options.project === undefined ? {} : { project: options.project });
  const project = fixture.sessions[0]?.project ?? 'guestbook';
  const created = new MemoryTicketStore({ now: () => now().toISOString() });
  const takenOver = new Map<string, TakenOver>();

  // The lead and the plan it proposes are the lead fixture's, so the tower
  // and the lead's screen agree; the tower fixture adds its plan under way.
  const plans = [...lead.plans, ...fixture.plans.filter((plan) => plan.state !== 'proposed')];
  const storeOf = (id: string) => (id === lead.session.id ? lead.store : fixture.store);
  const state = (id: string): SessionState | undefined => {
    let found: SessionState | undefined;
    for (const { event } of storeOf(id).events.after(id)) if (event.type === 'STATE_SNAPSHOT') found = event.snapshot;
    return found;
  };
  // The seq a stream or a thread read starts after: ?after=, else Last-Event-ID.
  const after = (request: IncomingMessage, url: URL): number => {
    const from = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0);
    return Number.isInteger(from) && from >= 0 ? from : 0;
  };

  async function handle(request: IncomingMessage, response: ServerResponse, method: string, url: URL, user: string): Promise<void> {
    const parts = url.pathname.split('/').slice(2);              // after '/api'
    const [collection, id, sub] = parts;
    if (method === 'GET' && collection === 'sessions' && parts.length === 1) return sendJson(response, 200, fixture.sessions.map((s) => (takenOver.has(s.id) ? { ...s, takenOver: takenOver.get(s.id) } : s)));
    if (method === 'GET' && collection === 'workspace' && parts.length === 1) return sendJson(response, 200, workspaceFixture(project));
    if (method === 'GET' && collection === 'inbox' && parts.length === 1) return sendJson(response, 200, [...fixture.inbox.filter((item) => item.kind !== 'plan'), ...lead.inbox]);
    if (method === 'GET' && collection === 'lead') {
      if (parts.length === 1) return sendJson(response, 200, lead.state);
      if (id === 'messages' && parts.length === 2) return sendJson(response, 200, lead.messages.filter((m) => m.seq > after(request, url)));
      if (id === 'memory' && parts.length === 2) return sendJson(response, 200, lead.memory);
      if (id === 'stream' && parts.length === 2) {
        const from = after(request, url);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        for (const message of lead.messages) if (message.seq > from) response.write(leadFrame({ kind: 'message', message }));
        response.write(leadFrame({ kind: 'state', state: lead.state }));
        for (const plan of lead.plans) response.write(leadFrame({ kind: 'plan', plan }));
        return void response.end();
      }
    }
    if (method === 'GET' && collection === 'plans') {
      if (parts.length === 1) return sendJson(response, 200, plans);
      const plan = plans.find((p) => p.id === id);
      if (parts.length === 2) return plan ? sendJson(response, 200, plan) : sendJson(response, 404, { error: 'no such plan' });
    }
    if (collection === 'sessions' && id) {
      const session = id === lead.session.id ? lead.session : fixture.sessions.find((s) => s.id === id);
      if (!session) return sendJson(response, 404, { error: 'no such session' });
      const taken = takenOver.get(id);
      const files = () => state(id)?.files ?? [];
      if (method === 'GET' && parts.length === 2) {
        const detail: SessionDetail = {
          ...session, state: state(id) ?? { status: session.status, phase: session.phase, steps: [], files: [], checks: [], usage: {} },
          ...(session.role === 'author' ? { previewKey: PREVIEW_KEY } : {}), ...(taken ? { takenOver: taken } : {}),
        };
        return sendJson(response, 200, detail);
      }
      if (method === 'GET' && sub === 'files') {
        if (parts.length === 3) return sendJson(response, 200, { files: changedFiles(files()) });
        const version = url.searchParams.get('version');
        const found = version === null || version === 'base' ? fixtureFile(parts.slice(3).map(decodeURIComponent).join('/'), version === 'base' ? 'base' : 'current') : undefined;
        return found ? sendJson(response, 200, found) : sendJson(response, 404, { error: 'no such file in the checkout' });
      }
      if (method === 'POST' && sub === 'takeover' && parts.length === 3) {
        if (session.role !== 'author') return sendJson(response, 409, { error: 'only an author\'s session is taken over' });
        if (taken) return sendJson(response, 409, { error: `session ${id} is already taken over` });
        takenOver.set(id, { by: user, at: now().toISOString() });
        return sendJson(response, 200, { accepted: true, by: user });
      }
      if (method === 'POST' && sub === 'giveback' && parts.length === 3) {
        if (!taken) return sendJson(response, 409, { error: `session ${id} is not taken over` });
        if (taken.by !== user) return sendJson(response, 403, { error: 'only the account that took the session over gives it back' });
        takenOver.delete(id);
        return sendJson(response, 200, { accepted: true });
      }
      if (method === 'POST' && sub === 'plan' && parts.length === 4) return sendJson(response, 409, { error: `session ${id} has no session plan waiting for its Go` });
      if (method === 'GET' && sub === 'events' && parts.length === 3) {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        for (const event of storeOf(id).events.after(id, after(request, url))) response.write(sseFrame(event));
        return void response.end();
      }
    }
    if (collection === 'tickets') {
      const all = async (): Promise<Ticket[]> => [...fixture.tickets, ...await created.list()];
      if (method === 'GET' && parts.length === 1) return sendJson(response, 200, await all());
      if (method === 'POST' && parts.length === 1) {
        const body = ticketBody(await readJson(request), project);
        if (!body) return sendJson(response, 400, { error: `a ticket needs a title of 1 to ${TITLE_LIMIT} characters` });
        return sendJson(response, 201, await created.create(body, { kind: 'human', id: user }));
      }
      if (method === 'GET' && parts.length === 2) {
        const ticket = (await all()).find((t) => t.id === id);
        return ticket ? sendJson(response, 200, ticket) : sendJson(response, 404, { error: 'no such ticket' });
      }
    }
    sendJson(response, 404, { error: 'not in the fixtures' });
  }

  return {
    kind: 'fixtures',
    forward(request, response, forward) {
      handle(request, response, forward.method, new URL(forward.path, 'http://fixtures'), forward.user.id).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
        else response.destroy();
      });
    },
  };
}
