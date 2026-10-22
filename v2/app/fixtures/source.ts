// The fixture source (CLEARED_V2_APP_SOURCE=fixtures): the service's read
// routes answered in the app's process from the tower fixture and, for the
// lead and its plans (milestone 2, section 7.1), from the lead fixture; and
// ticket creation into an in-memory ticket store, so the screens work
// before the service does. It approves, answers, moves and sends nothing:
// every other write is a 404. The session tabs' routes (lane 20) are
// answered too: the workspace, a session's files (the session fixture's
// contents), and Take over and Give back, kept in memory; no session of the
// tower's has a plan waiting, so a Go or a Change is a 409. Lane 27's
// routes are answered too: a ticket's steps, the contract and knowledge
// items with their Approve, Send back and Reject (kept in memory), the asks
// (a new one starts and stays starting; a follow-up runs), the recipes with
// their run, and the schedules. Lane 32's too: the web terminal of a
// session taken over (a stand-in shell) and the editor's save, kept in
// memory (fixtureHuman of fixtures/session.ts).
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { leadFrame, sseFrame, type Ask, type ContractItem, type CreateTicketBody, type KnowledgeItem, type SessionDetail, type TakenOver } from '../../src/api/types.ts';
import { changedFiles } from '../../src/flow/files.ts';
import type { SessionState } from '../../src/session/events.ts';
import { MemoryTicketStore, type Ticket } from '../../src/tickets/contract.ts';
import { sendJson, type DataSource } from '../src/proxy.ts';
import { leadFixture } from './lead.ts';
import { PREVIEW_KEY, fixtureFile, fixtureHuman, workspaceFixture } from './session.ts';
import { askFixture } from './ask.ts';
import { contractItem, knowledgeItem } from './inbox.ts';
import { RECIPES, schedulesFixture, ticketSteps, towerFixture } from './tower.ts';

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
  const human = fixtureHuman();
  const decided: (ContractItem | KnowledgeItem)[] = [contractItem(now()), knowledgeItem(now())];
  const asks = new Map<string, Ask>([[askFixture(now()).id, askFixture(now())]]);
  // The first author's ticket and LOCAL-163 run in four steps, each live
  // author on the service step of the filter API (lane 23's shape).
  const steps = (ticket: string) => (ticket === fixture.sessions[0]?.ticket || ticket === 'LOCAL-163' ? ticketSteps(fixture.sessions, ticket) : []);

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
    if (method === 'GET' && collection === 'inbox' && parts.length === 1) return sendJson(response, 200, [...fixture.inbox.filter((item) => item.kind !== 'plan'), ...decided, ...lead.inbox]);
    if (method === 'GET' && collection === 'recipes' && parts.length === 1) return sendJson(response, 200, RECIPES);
    if (method === 'GET' && collection === 'schedules' && parts.length === 1) return sendJson(response, 200, schedulesFixture(now()));
    if (method === 'POST' && collection === 'recipes' && id && sub === 'run' && parts.length === 3) {
      const recipe = RECIPES.find((r) => r.name === decodeURIComponent(id));
      if (!recipe) return sendJson(response, 404, { error: `no recipe ${id}` });
      const parameters = ((await readJson(request)) as { parameters?: Record<string, unknown> } | undefined)?.parameters ?? {};
      const missing = recipe.parameters.find((p) => p.required && (typeof parameters[p.name] !== 'string' || !(parameters[p.name] as string).trim()));
      if (missing) return sendJson(response, 400, { error: `the parameter ${missing.name} is missing` });
      return sendJson(response, 200, recipe.kind === 'ticket' ? { accepted: true, plan: lead.plans[0]?.id ?? 'plan-1' } : { accepted: true, message: 1 });
    }
    if (method === 'POST' && (collection === 'contracts' || collection === 'knowledge') && id && parts.length === 3) {
      const index = decided.findIndex((item) => item.id === decodeURIComponent(id) && item.kind === (collection === 'contracts' ? 'contract' : 'knowledge'));
      const item = decided[index];
      if (!item) return sendJson(response, 404, { error: `no item ${id}` });
      if (item.state !== 'waiting') return sendJson(response, 409, { error: `item ${id} is answered` });
      const at = now().toISOString();
      if (item.kind === 'contract' && sub === 'sendback') {
        const message = ((await readJson(request)) as { message?: unknown } | undefined)?.message;
        if (typeof message !== 'string' || !message.trim() || message.length > 2000) return sendJson(response, 400, { error: 'message must be a non-empty text of at most 2000 characters' });
        decided[index] = { ...item, state: 'handled', outcome: { decision: 'send_back', message, by: user, at } };
      } else if (sub === 'approve') decided[index] = item.kind === 'contract' ? { ...item, state: 'handled', outcome: { decision: 'approve', by: user, at } } : { ...item, state: 'handled', outcome: { decision: 'approve', by: user, at } };
      else if (item.kind === 'knowledge' && sub === 'reject') decided[index] = { ...item, state: 'handled', outcome: { decision: 'reject', by: user, at } };
      else return sendJson(response, 404, { error: 'not in the fixtures' });
      return sendJson(response, 200, { accepted: true });
    }
    if (collection === 'asks') {
      if (method === 'GET' && id && parts.length === 2) {
        const ask = asks.get(decodeURIComponent(id));
        return ask ? sendJson(response, 200, ask) : sendJson(response, 404, { error: 'no such ask' });
      }
      if (method === 'POST') {
        const question = ((await readJson(request)) as { question?: unknown } | undefined)?.question;
        if (typeof question !== 'string' || !question.trim() || question.length > 4000) return sendJson(response, 400, { error: 'a question is a non-empty text of at most 4000 characters' });
        const at = now().toISOString();
        const turn = { question: question.trim(), answer: null, at, costUsd: null, inputTokens: 0, outputTokens: 0 };
        if (parts.length === 1) {
          const ask: Ask = { id: `ask-${randomUUID()}`, question: question.trim(), service: null, target: null, session: null, state: 'starting', turns: [turn], costUsd: 0, inputTokens: 0, outputTokens: 0, weekPercent: null, createdAt: at, by: user };
          asks.set(ask.id, ask);
          return sendJson(response, 200, ask);
        }
        const ask = id ? asks.get(decodeURIComponent(id)) : undefined;
        if (!ask || sub !== 'follow' || parts.length !== 3) return sendJson(response, 404, { error: 'no such ask' });
        if (ask.state === 'starting' || ask.state === 'running') return sendJson(response, 409, { error: 'a turn of this ask runs: wait for its answer' });
        const next: Ask = { ...ask, state: 'running', turns: [...ask.turns, turn] };
        asks.set(ask.id, next);
        return sendJson(response, 200, next);
      }
    }
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
        const path = parts.slice(3).map(decodeURIComponent).join('/');
        const found = version === 'base' ? fixtureFile(path, 'base') : version === null ? human.file(path) : undefined;
        return found ? sendJson(response, 200, found) : sendJson(response, 404, { error: 'no such file in the checkout' });
      }
      if (await human.handle(request, response, { method, url, parts, user, taken })) return;
      if (method === 'POST' && sub === 'takeover' && parts.length === 3) {
        // An author's or a reviewer's, as the service (owner decision of 2026-10-22 22:01).
        if (session.role !== 'author' && session.role !== 'reviewer') return sendJson(response, 409, { error: 'only an author\'s or a reviewer\'s session is taken over' });
        if (taken) return sendJson(response, 409, { error: `session ${id} is already taken over` });
        takenOver.set(id, { by: user, at: now().toISOString() });
        return sendJson(response, 200, { accepted: true, by: user });
      }
      if (method === 'POST' && sub === 'giveback' && parts.length === 3) {
        if (!taken) return sendJson(response, 409, { error: `session ${id} is not taken over` });
        if (taken.by !== user) return sendJson(response, 403, { error: 'only the account that took the session over gives it back' });
        human.close(id, 'give_back');
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
      if (method === 'GET' && sub === 'steps' && parts.length === 3) return sendJson(response, 200, steps(decodeURIComponent(id ?? '')));
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
