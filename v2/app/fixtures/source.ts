// The fixture source (CLEARED_V2_APP_SOURCE=fixtures): the service's read
// routes answered in the app's process from the tower fixture and, for the
// lead and its plans (milestone 2, section 7.1), from the lead fixture; and
// ticket creation into an in-memory ticket store, so the screens work
// before the service does. It approves, moves and sends nothing: every
// other write is a 404, but a session request's answer (lane 37), kept in
// memory, which hands its inbox item as handled. The session tabs' routes (lane 20) are
// answered too: the workspace, a session's files (the session fixture's
// contents), and Take over and Give back, kept in memory; no session of the
// tower's has a plan waiting, so a Go or a Change is a 409. Lane 27's
// routes are answered too: a ticket's steps, the contract and knowledge
// items with their Approve, Send back and Reject (kept in memory), the asks
// (a new one starts and stays starting; a follow-up runs), the recipes with
// their run, and the schedules. Lane 32's too: the web terminal of a
// session taken over (a stand-in shell) and the editor's save, kept in
// memory (fixtureHuman of fixtures/session.ts). Lane 34's change stream
// (GET /api/events) is answered as the service does: open, a comment every
// KEEPALIVE_MS, and an event for each fixture write (a decision, a take
// over, a give back, a new ticket, an ask) and for each changed() a test
// or a lane's fixture calls. Lane 36's ticket LOCAL-152 has its author's
// session, done, before the reviewer the tower shows (envelopeStory of
// fixtures/session.ts), so its view follows the ticket from one to the other.
// The batches (requirement C6) are the service's own runner (flow/batch.ts)
// over the created tickets and the consumption fixture's levers and windows;
// its flow only moves a ticket to In Progress, and each read runs a pass.
// A ticket's cost (P211) is the service's own ticketCost over the ledger
// that holds the ticket's sessions; with `resolved`, the landed ticket
// LOCAL-149 has its author's and its reviewer's sessions (fixtures/cost.ts),
// and its production page's check (P218), read by the service's own reader.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { KEEPALIVE_MS } from '../../src/api/events.ts';
import { changeFrame, leadFrame, sseFrame, type Ask, type ChangeKind, type ContractItem, type CreateTicketBody, type KnowledgeItem, type NextInboxItem, type QuestionItem, type SessionDetail, type TakenOver } from '../../src/api/types.ts';
import { ticketCost } from '../../src/consumption/ticket-cost.ts';
import { productionChecksOf } from '../../src/flow/production.ts';
import { BatchError, BatchRunner } from '../../src/flow/batch.ts';
import { changedFiles } from '../../src/flow/files.ts';
import type { SessionState } from '../../src/session/events.ts';
import { MemoryTicketStore, type Ticket } from '../../src/tickets/contract.ts';
import { typeLabelProblem } from '../../src/tickets/templates.ts';
import { applyAll, emptyModel } from '../web/screens/session/model.ts';
import { sendJson, type DataSource } from '../src/proxy.ts';
import { leadFixture } from './lead.ts';
import { ENVELOPE_BODY, ENVELOPE_RESUMED, ENVELOPE_TICKET, PREVIEW_KEY, envelopeStory, fixtureFile, fixtureHuman, workspaceFixture } from './session.ts';
import { askFixture } from './ask.ts';
import { consumptionFixture } from './consumption.ts';
import { RESOLVED_TICKET, resolvedStory } from './cost.ts';
import { contractItem, knowledgeItem, requestItems } from './inbox.ts';
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
  const { title, body, labels } = value as Record<string, unknown>;
  if (typeof title !== 'string' || !title.trim() || title.length > TITLE_LIMIT) return undefined;
  if (body !== undefined && typeof body !== 'string') return undefined;
  // A ready-made ticket's type label (P214), checked as the service checks it.
  if (labels !== undefined && (!Array.isArray(labels) || labels.some((l) => typeof l !== 'string') || typeLabelProblem(labels as string[]))) return undefined;
  return { title: title.trim(), ...(typeof body === 'string' ? { body } : {}), ...(labels === undefined ? {} : { labels: labels as string[] }), project };
}

// `ask`: a session's question that arrives while the page is open, said on
// the change stream as the service's inbox says it (issue #269's browser test).
// `lanes` and `quota`: the Consumption screen's lanes, and the seven-day
// window of the subscription reported now, which the batches read.
export type FixtureSource = DataSource & {
  changed(kind: ChangeKind, id: string | null): void; ask(item: QuestionItem): void;
  lanes(n: number | null): void; quota(percent: number): void;
};

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

export async function fixtureSource(options: { readonly now?: () => Date; readonly project?: string; readonly resolved?: boolean } = {}): Promise<FixtureSource> {
  const now = options.now ?? (() => new Date());
  const fixture = await towerFixture(now(), options.project === undefined ? {} : { project: options.project });
  const lead = await leadFixture(now(), options.project === undefined ? {} : { project: options.project });
  const project = fixture.sessions[0]?.project ?? 'guestbook';
  const created = new MemoryTicketStore({ now: () => now().toISOString() });
  const takenOver = new Map<string, TakenOver>();
  // LOCAL-152's reviewer resumes on its own story (envelopeReviewer, below).
  const human = fixtureHuman({ resumed: (id) => (id === envelopeReviewer?.id ? ENVELOPE_RESUMED : undefined) });
  const decided: (ContractItem | KnowledgeItem)[] = [contractItem(now()), knowledgeItem(now())];
  // Lane 37: the reviewer's compound request, and two that no longer wait (one answered, one expired).
  const asker = (find: (s: { readonly role: string; readonly ticket: string }) => boolean) => {
    const session = fixture.sessions.find(find) ?? fixture.sessions[0];
    return { id: session?.id ?? '', ticket: session?.ticket ?? '' };
  };
  const requests = requestItems(now(), { reviewer: asker((s) => s.role === 'reviewer'), author: asker((s) => s.ticket === 'LOCAL-160') });
  // The requests answered from the screens, kept in memory: each is handled once (lane 37's art director).
  const answered = new Set<string>();
  const asking: QuestionItem[] = [];
  // The tickets closed from the screens (issue #249), kept in memory: a closed ticket's release card is handled, with the reason.
  const closed = new Map<string, { readonly reason: string; readonly by: string; readonly at: string }>();
  const shut = (item: NextInboxItem): NextInboxItem => {
    const outcome = item.kind === 'release' ? closed.get(item.ticket) : undefined;
    return item.kind === 'release' && outcome ? { ...item, state: 'handled', outcome: { decision: 'close', ...outcome } } : item;
  };
  const asked = (item: NextInboxItem) => (item.kind === 'permission' || item.kind === 'question') && answered.has(`${item.sessionId}\n${item.requestId}`) ? { ...item, state: 'handled' as const } : item;
  const consumption = consumptionFixture(project, now);
  const batches = new BatchRunner({
    db: consumption.db, tickets: created, project, levers: consumption.levers, weekStopPercent: 85, now,
    flow: { launch: async (ticket, by) => { await created.move(ticket, created.states.progress, { kind: 'human', id: by }); }, subscribe: () => () => undefined },
  });
  const asks = new Map<string, Ask>([[askFixture(now()).id, askFixture(now())]]);
  // The first author's ticket and LOCAL-163 run in four steps, each live
  // author on the service step of the filter API (lane 23's shape).
  const steps = (ticket: string) => (ticket === fixture.sessions[0]?.ticket || ticket === 'LOCAL-163' ? ticketSteps(fixture.sessions, ticket) : []);

  // The lead and the plan it proposes are the lead fixture's, so the tower
  // and the lead's screen agree; the tower fixture adds its plan under way.
  const plans = [...lead.plans, ...fixture.plans.filter((plan) => plan.state !== 'proposed')];
  const envelopeReviewer = fixture.sessions.find((s) => s.ticket === ENVELOPE_TICKET && s.role === 'reviewer');
  const envelope = envelopeReviewer ? envelopeStory(now(), envelopeReviewer) : undefined;
  const landed = fixture.tickets.find((ticket) => ticket.id === RESOLVED_TICKET);
  const resolved = options.resolved && landed ? resolvedStory(landed) : undefined;
  const sessions = [...fixture.sessions, ...(envelope ? [envelope.author] : []), ...(resolved?.sessions ?? [])];
  const tickets = fixture.tickets.map((ticket) => (ticket.id === ENVELOPE_TICKET ? { ...ticket, body: ENVELOPE_BODY } : ticket));
  const storeOf = (id: string) => (id === lead.session.id ? lead.store : envelope && (id === envelope.author.id || id === envelopeReviewer?.id) ? envelope.store
    : resolved?.sessions.some((s) => s.id === id) ? resolved.store : fixture.store);
  // The ledger that holds a ticket's sessions.
  const ledgerOf = (ticket: string) => (ticket === ENVELOPE_TICKET && envelope ? envelope.store : ticket === RESOLVED_TICKET && resolved ? resolved.store : fixture.store);
  // What a session's stored events add up to, its deltas applied, as the service's detail says.
  const state = (id: string): SessionState | undefined => {
    const model = emptyModel();
    applyAll(model, storeOf(id).events.after(id));
    return model.state;
  };
  // The seq a stream or a thread read starts after: ?after=, else Last-Event-ID.
  const after = (request: IncomingMessage, url: URL): number => {
    const from = Number(url.searchParams.get('after') ?? request.headers['last-event-id'] ?? 0);
    return Number.isInteger(from) && from >= 0 ? from : 0;
  };

  // The change stream's clients, and what each write says to them.
  const listeners = new Set<ServerResponse>();
  let seq = 0;
  const changed = (kind: ChangeKind, id: string | null) => {
    seq += 1;
    const frame = changeFrame(seq, { kind, id, at: now().toISOString() });
    for (const listener of listeners) listener.write(frame);
  };

  async function handle(request: IncomingMessage, response: ServerResponse, method: string, url: URL, user: string): Promise<void> {
    const parts = url.pathname.split('/').slice(2);              // after '/api'
    const [collection, id, sub] = parts;
    if (method === 'GET' && collection === 'events' && parts.length === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      response.write(': stream open\n\n');
      listeners.add(response);
      const keepalive = setInterval(() => response.write(': keepalive\n\n'), KEEPALIVE_MS);
      keepalive.unref();
      response.on('close', () => { clearInterval(keepalive); listeners.delete(response); });
      return;
    }
    if (method !== 'GET') response.once('finish', () => {
      if (response.statusCode >= 300) return;
      if (collection === 'contracts' || collection === 'knowledge') changed('inbox', null);
      else if (collection === 'sessions' && id) changed('session', decodeURIComponent(id));
      else if (collection === 'tickets') { changed('ticket', id ? decodeURIComponent(id) : null); if (sub === 'close') changed('inbox', null); }
      else if (collection === 'batches') changed('ticket', null);
    });
    if (method === 'GET' && collection === 'sessions' && parts.length === 1) return sendJson(response, 200, sessions.map((s) => (takenOver.has(s.id) ? { ...s, takenOver: takenOver.get(s.id) } : s)));
    if (method === 'GET' && collection === 'workspace' && parts.length === 1) return sendJson(response, 200, workspaceFixture(project));
    if (method === 'GET' && collection === 'inbox' && parts.length === 1) return sendJson(response, 200, [...fixture.inbox.filter((item) => item.kind !== 'plan'), ...requests.filter((item) => item.state === 'waiting'), ...asking, ...decided, ...lead.inbox, ...requests.filter((item) => item.state === 'handled')].map(asked).map(shut));
    // A session's request answered: the item is handled, a second answer is a 409 (the service's answer route).
    if (method === 'POST' && collection === 'sessions' && id && sub === 'requests' && parts[4] === 'answer' && parts.length === 5) {
      const key = `${decodeURIComponent(id)}\n${decodeURIComponent(parts[3] ?? '')}`;
      const item = [...fixture.inbox, ...requests, ...asking].find((i) => (i.kind === 'permission' || i.kind === 'question') && `${i.sessionId}\n${i.requestId}` === key && i.state === 'waiting');
      if (!item) return sendJson(response, 404, { error: 'no request waits' });
      if (answered.has(key)) return sendJson(response, 409, { error: 'answered already' });
      answered.add(key);
      response.once('finish', () => changed('inbox', null));
      return sendJson(response, 200, { accepted: true });
    }
    // Close (issue #249): the reason is mandatory; the ticket's release card is handled with it; a second close is a 409.
    if (method === 'POST' && collection === 'tickets' && id && sub === 'close' && parts.length === 3) {
      const ticket = decodeURIComponent(id);
      const reason = ((await readJson(request)) as { reason?: unknown }).reason;
      if (typeof reason !== 'string' || reason.trim() === '' || reason.length > 2000) return sendJson(response, 400, { error: 'a reason is mandatory' });
      if (!tickets.some((t) => t.id === ticket)) return sendJson(response, 404, { error: 'unknown ticket' });
      if (closed.has(ticket)) return sendJson(response, 409, { error: 'closed already' });
      closed.set(ticket, { reason: reason.trim(), by: user, at: now().toISOString() });
      return sendJson(response, 200, { sessions: 0, items: 1 });
    }
    // The consumption screen (O15): the service's own read and levers over a week of invented turns.
    if (collection === 'consumption') {
      if (method === 'GET' && parts.length === 1) return sendJson(response, 200, consumption.read(url.searchParams.get('tz') ?? undefined));
      if (method === 'POST' && id === 'levers' && parts.length === 2) {
        const body = await readJson(request);
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return sendJson(response, 400, { error: 'the body is an object: { model?, maxLanes?, paused? }' });
        const done = consumption.write(body as Record<string, never>, user);
        return sendJson(response, done.status, done.body);
      }
    }
    // The batches (requirement C6): the service's checks, and a pass before each read.
    if (collection === 'batches') {
      try {
        if (method === 'POST' && parts.length === 1) {
          const body = await readJson(request);
          if (typeof body !== 'object' || body === null || Array.isArray(body)) return sendJson(response, 400, { error: 'the body is an object: { project, tickets }' });
          const { project: named, tickets: lines, ...rest } = body as Record<string, unknown>;
          if (Object.keys(rest).length > 0 || named !== project) return sendJson(response, 400, { error: `a batch has a project, ${project}, and tickets` });
          return sendJson(response, 200, await batches.create({ tickets: lines }, user));
        }
        if (method === 'GET' && parts.length <= 2) {
          await batches.tick();
          return sendJson(response, 200, id ? await batches.get(decodeURIComponent(id)) : await batches.list());
        }
      } catch (error) {
        if (error instanceof BatchError) return sendJson(response, error.kind === 'invalid' ? 400 : 404, { error: error.message });
        throw error;
      }
    }
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
        const turn = { question: question.trim(), answer: null, at, costUsd: null, inputTokens: 0, outputTokens: 0, citations: [] };
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
      const session = id === lead.session.id ? lead.session : sessions.find((s) => s.id === id);
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
      const all = async (): Promise<Ticket[]> => [...tickets, ...await created.list()];
      if (method === 'GET' && parts.length === 1) return sendJson(response, 200, await all());
      if (method === 'POST' && parts.length === 1) {
        const body = ticketBody(await readJson(request), project);
        if (!body) return sendJson(response, 400, { error: `a ticket needs a title of 1 to ${TITLE_LIMIT} characters` });
        return sendJson(response, 201, await created.create(body, { kind: 'human', id: user }));
      }
      if (method === 'GET' && sub === 'steps' && parts.length === 3) return sendJson(response, 200, steps(decodeURIComponent(id ?? '')));
      if (method === 'GET' && sub === 'cost' && parts.length === 3) {
        const ticket = decodeURIComponent(id ?? '');
        return sendJson(response, 200, ticketCost(ledgerOf(ticket).db, { project, ticket }));
      }
      // The production page's checks (P218), and its capture: a blank PNG of one pixel.
      if (method === 'GET' && sub === 'production' && parts.length === 3) {
        const ticket = decodeURIComponent(id ?? '');
        return sendJson(response, 200, productionChecksOf(ledgerOf(ticket), ticket, workspaceFixture(project).services.map((s) => s.name)));
      }
      if (method === 'GET' && sub === 'proof' && parts.length === 5 && parts[4] === 'production.png' && productionChecksOf(ledgerOf(decodeURIComponent(id ?? '')), decodeURIComponent(id ?? ''), [decodeURIComponent(parts[3] ?? '')]).some((c) => c.file)) {
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PIXEL.length), 'cache-control': 'no-store' });
        return void response.end(PIXEL);
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
    changed,
    ask(item) {
      asking.push(item);
      changed('inbox', null);
    },
    lanes(n) {
      consumption.write({ maxLanes: n }, 'fixtures');
    },
    quota(percent) {
      consumption.report('seven_day', percent);
    },
    forward(request, response, forward) {
      handle(request, response, forward.method, new URL(forward.path, 'http://fixtures'), forward.user.id).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: 'internal error' });
        else response.destroy();
      });
    },
  };
}
