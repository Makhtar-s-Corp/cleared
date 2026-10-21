// The fixture source (CLEARED_V2_APP_SOURCE=fixtures): the service's read
// routes answered in the app's process from the tower fixture, and ticket
// creation into an in-memory ticket store, so the tower works before lane
// 7's service does. It approves, answers and moves nothing.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sseFrame, type CreateTicketBody, type SessionDetail } from '../../src/api/types.ts';
import type { SessionState } from '../../src/session/events.ts';
import { MemoryTicketStore, type Ticket } from '../../src/tickets/contract.ts';
import { sendJson, type DataSource } from '../src/proxy.ts';
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
  const project = fixture.sessions[0]?.project ?? 'guestbook';
  const created = new MemoryTicketStore({ now: () => now().toISOString() });

  const state = (id: string): SessionState | undefined => {
    let found: SessionState | undefined;
    for (const { event } of fixture.store.events.after(id)) if (event.type === 'STATE_SNAPSHOT') found = event.snapshot;
    return found;
  };

  async function handle(request: IncomingMessage, response: ServerResponse, method: string, url: URL, user: string): Promise<void> {
    const parts = url.pathname.split('/').slice(2);              // after '/api'
    const [collection, id, sub] = parts;
    if (method === 'GET' && collection === 'sessions' && parts.length === 1) return sendJson(response, 200, fixture.sessions);
    if (method === 'GET' && collection === 'inbox' && parts.length === 1) return sendJson(response, 200, fixture.inbox);
    if (collection === 'sessions' && id) {
      const session = fixture.sessions.find((s) => s.id === id);
      if (!session) return sendJson(response, 404, { error: 'no such session' });
      if (method === 'GET' && parts.length === 2) {
        const detail: SessionDetail = { ...session, state: state(id) ?? { status: session.status, phase: session.phase, steps: [], files: [], checks: [], usage: {} } };
        return sendJson(response, 200, detail);
      }
      if (method === 'GET' && sub === 'events' && parts.length === 3) {
        const from = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0);
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        for (const event of fixture.store.events.after(id, Number.isInteger(from) && from >= 0 ? from : 0)) response.write(sseFrame(event));
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
