import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { API_ROUTES, ASK_ROUTES, KNOWLEDGE_ROUTES, MILESTONE_2_ROUTES, RECIPE_ROUTES, SERVICE_PROOF_HEADER, SESSION_PLAN_ROUTES, SESSION_PREVIEW_ROUTE, SESSION_TABS_ROUTES, STEP_ROUTES, SERVICE_USER_HEADER, TERMINAL_ROUTES, type ApiRoute, type InboxItem, type SessionDetail, type SessionSummary } from '../../src/api/types.ts';
import { createApiRoutes } from '../../src/api/routes.ts';
import { filesRoutes } from '../../src/flow/files.ts';
import { planGateRoutes } from '../../src/flow/plan-gate.ts';
import { stepRoutes } from '../../src/flow/steps.ts';
import { takeoverRoutes } from '../../src/flow/takeover.ts';
import { terminalRoutes } from '../../src/terminal/routes.ts';
import { dispatch, matchRoute, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { quickAuthor, setup, until, type Setup } from './support.ts';

const PROOF = 'b'.repeat(64);
let t: Setup;
let parked: Ticket;   // a ticket in Todo that no flow has started
let server: Server;
let base = '';

before(async () => {
  t = await setup();
  parked = await t.tickets.create({ title: 'Parked', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  const routes = createApiRoutes({ engine: () => t.engine, proof: () => PROOF });
  const app: App = { registry: t.engine.registry, tables: [], routes };
  server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const signed = { [SERVICE_PROOF_HEADER]: PROOF };
const person = { ...signed, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' };

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

test('the service declares every route of the API but the approval, which is lane 8\'s', () => {
  // The flow's API: the routes of api/routes.ts, the session plan's Go and
  // Change (lane 17, flow/plan-gate.ts), and the Editor tab's files and Take
  // over and Give back (lane 20, flow/files.ts and flow/takeover.ts), the
  // web terminal and the editor's save (lane 31, terminal/routes.ts and
  // flow/files.ts), which the flow module registers. A file's route is one
  // route per depth, since the registry matches a fixed number of segments:
  // it is files/* here.
  const deps = { engine: () => t.engine, proof: () => PROOF, human: () => undefined };
  const routes = [...createApiRoutes(deps), ...planGateRoutes(deps), ...takeoverRoutes(deps), ...filesRoutes(deps), ...stepRoutes(deps), ...terminalRoutes(deps)];
  const declared = [...new Set(routes.map((r) => `${r.method} ${r.path.replace(/\/files\/:p0(?:\/:p\d+)*$/, '/files/*')}`))].sort();
  // The preview is lane 15's (container/preview.ts). The ticket's steps and
  // the contract item's Approve and Send back are lane 23's (flow/steps.ts).
  // Written ahead by lane 17: the knowledge
  // items and the skill, lane 24's (knowledge/); the questions to the code,
  // lane 25's (reader/); the recipes and the schedules, lane 26's
  // (recipes/, schedules/), each of which rewrites this comment to name its
  // module.
  const ahead = [...KNOWLEDGE_ROUTES, ...ASK_ROUTES, ...RECIPE_ROUTES];
  assert.ok(SESSION_PLAN_ROUTES.every((route) => declared.includes(route)), 'lane 17 serves the Go and the Change');
  assert.ok(SESSION_TABS_ROUTES.every((route) => declared.includes(route)), 'lane 20 serves the files, the take over and the give back');
  assert.ok(STEP_ROUTES.every((route) => declared.includes(route)), 'lane 23 serves the steps and the contract item');
  assert.ok(TERMINAL_ROUTES.every((route) => declared.includes(route)), 'lane 31 serves the web terminal and the editor\'s save');
  const wanted = API_ROUTES.filter((r) => r !== 'POST /api/tickets/:id/approve' && r !== SESSION_PREVIEW_ROUTE && !MILESTONE_2_ROUTES.includes(r) && !ahead.includes(r)).sort();
  assert.deepEqual(declared, wanted);
});

// One request per route, with the paths filled in, and what a signed one answers.
type Case = { route: ApiRoute; path: () => string; body?: () => unknown; ok: number };
const cases = (): Case[] => {
  const session = t.startedSessions[0]?.id ?? 'none';
  return [
    { route: 'GET /api/sessions', path: () => '/api/sessions', ok: 200 },
    { route: 'GET /api/sessions/:id', path: () => `/api/sessions/${session}`, ok: 200 },
    { route: 'GET /api/sessions/:id/events', path: () => `/api/sessions/${session}/events?after=999`, ok: 200 },
    { route: 'POST /api/sessions/:id/messages', path: () => `/api/sessions/${session}/messages`, body: () => ({ text: 'hello' }), ok: 200 },
    { route: 'POST /api/sessions/:id/requests/:requestId/answer', path: () => `/api/sessions/${session}/requests/request-1/answer`, body: () => ({ decision: { kind: 'allow_once' } }), ok: 200 },
    { route: 'POST /api/sessions/:id/interrupt', path: () => `/api/sessions/${session}/interrupt`, ok: 200 },
    { route: 'GET /api/tickets', path: () => '/api/tickets', ok: 200 },
    { route: 'POST /api/tickets', path: () => '/api/tickets', body: () => ({ title: 'Second', project: 'guestbook' }), ok: 200 },
    { route: 'GET /api/tickets/:id', path: () => `/api/tickets/${t.ticket.id}`, ok: 200 },
    { route: 'POST /api/tickets/:id/move', path: () => `/api/tickets/${parked.id}/move`, body: () => ({ status: 'In Review' }), ok: 200 },
    { route: 'GET /api/inbox', path: () => '/api/inbox', ok: 200 },
  ];
};

test('every route refuses a request without the proof, and one with a wrong proof, before anything else', async () => {
  // A session to point at.
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().length === 1);
  for (const c of cases()) {
    const method = c.route.split(' ')[0] as string;
    const none = await call(method, c.path(), { 'content-type': 'application/json', [SERVICE_USER_HEADER]: 'u1' }, c.body?.());
    assert.equal(none.status, 401, `${c.route} without the proof`);
    assert.deepEqual(none.json, { error: 'unauthorized' });
    const wrong = await call(method, c.path(), { ...person, [SERVICE_PROOF_HEADER]: 'c'.repeat(64) }, c.body?.());
    assert.equal(wrong.status, 401, `${c.route} with a wrong proof`);
  }
  // Nothing was done by the refused ones.
  assert.equal(t.inbox.list()[0]?.state, 'waiting');
  assert.equal((await t.tickets.list()).length, 2);
});

test('every route answers a signed request', async () => {
  for (const c of cases()) {
    const method = c.route.split(' ')[0] as string;
    if (c.route.endsWith('/events')) {
      // A stream does not end by itself: the status and type are enough here.
      const controller = new AbortController();
      const response = await fetch(`${base}${c.path()}`, { headers: person, signal: controller.signal });
      assert.equal(response.status, c.ok, c.route);
      controller.abort();
      continue;
    }
    const result = await call(method, c.path(), person, c.body?.());
    assert.equal(result.status, c.ok, `${c.route}: ${JSON.stringify(result.json)}`);
  }
});

test('a write needs a user the service knows; a read does not', async () => {
  const id = t.startedSessions[0]!.id;
  const writes = [
    ['POST', `/api/sessions/${id}/messages`, { text: 'x' }],
    ['POST', `/api/sessions/${id}/interrupt`, undefined],
    ['POST', `/api/sessions/${id}/requests/r/answer`, { decision: { kind: 'allow_once' } }],
    ['POST', '/api/tickets', { title: 'x', project: 'guestbook' }],
    ['POST', `/api/tickets/${parked.id}/move`, { status: 'In Review' }],
  ] as const;
  for (const [method, path, body] of writes) {
    assert.equal((await call(method, path, { ...signed, 'content-type': 'application/json' }, body)).status, 403, `${path} without a user`);
    assert.equal((await call(method, path, { ...person, [SERVICE_USER_HEADER]: 'ghost' }, body)).status, 403, `${path} with an unknown user`);
  }
  assert.equal((await call('GET', '/api/sessions', signed)).status, 200);
});

test('sessions: the list, the detail, an unknown id', async () => {
  const list = (await call('GET', '/api/sessions', signed)).json as SessionSummary[];
  const mine = list.find((s) => s.id === t.startedSessions[0]!.id);
  assert.equal(mine?.role, 'author');
  assert.equal(mine?.ticket, t.ticket.id);
  const detail = (await call('GET', `/api/sessions/${mine?.id}`, signed)).json as SessionDetail;
  assert.equal(detail.state.phase, detail.phase);
  assert.equal((await call('GET', '/api/sessions/nope', signed)).status, 404);
  assert.equal((await call('GET', '/api/sessions/nope/events', signed)).status, 404);
});

test('messages and answers: bodies are checked, the unknown session and request are refused', async () => {
  const id = t.startedSessions[0]!.id;
  assert.equal((await call('POST', `/api/sessions/${id}/messages`, person, { text: '' })).status, 400);
  assert.equal((await call('POST', `/api/sessions/${id}/messages`, person, { text: 5 })).status, 400);
  assert.equal((await call('POST', `/api/sessions/${id}/messages`, person, undefined)).status, 400);
  assert.equal((await call('POST', `/api/sessions/nope/messages`, person, { text: 'x' })).status, 404);
  assert.equal((await call('POST', `/api/sessions/${id}/requests/r/answer`, person, { decision: { kind: 'maybe' } })).status, 400);
  assert.equal((await call('POST', `/api/sessions/${id}/requests/r/answer`, person, { decision: { kind: 'reject_once' } })).status, 400, 'a deny carries its message');
  assert.equal((await call('POST', `/api/sessions/${id}/requests/nope/answer`, person, { decision: { kind: 'allow_once' } })).status, 404);
  assert.equal((await call('POST', `/api/sessions/nope/requests/r/answer`, person, { decision: { kind: 'allow_once' } })).status, 404);
});

test('a body that is not JSON is 400, and one over 64 KiB is 413', async () => {
  const id = t.startedSessions[0]!.id;
  const bad = await fetch(`${base}/api/sessions/${id}/messages`, { method: 'POST', headers: person, body: '{not json' });
  assert.equal(bad.status, 400);
  const big = await fetch(`${base}/api/sessions/${id}/messages`, { method: 'POST', headers: person, body: JSON.stringify({ text: 'x'.repeat(70_000) }) });
  assert.equal(big.status, 413);
});

test('tickets: create, list, get, move; the move to go is refused; an unknown ticket is 404', async () => {
  const created = (await call('POST', '/api/tickets', person, { title: 'Third', body: 'b', project: 'guestbook' })).json as Ticket;
  assert.equal(created.title, 'Third');
  assert.equal(created.status, 'Todo');
  assert.equal((await call('POST', '/api/tickets', person, { title: '', project: 'guestbook' })).status, 400);
  assert.equal((await call('POST', '/api/tickets', person, { title: 'x' })).status, 400);
  assert.equal(((await call('GET', '/api/tickets', signed)).json as Ticket[]).some((x) => x.id === created.id), true);
  assert.equal(((await call('GET', `/api/tickets/${created.id}`, signed)).json as Ticket).id, created.id);
  assert.equal((await call('GET', '/api/tickets/LOCAL-99', signed)).status, 404);
  assert.equal((await call('POST', '/api/tickets/LOCAL-99/move', person, { status: 'Todo' })).status, 404);
  const idle = await t.tickets.create({ title: 'Idle', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  assert.equal((await call('POST', `/api/tickets/${idle.id}/move`, person, { status: 'Ready to Ship' })).status, 409, 'the move to go is the approval only');
  assert.equal((await call('POST', `/api/tickets/${idle.id}/move`, person, { status: 'Nowhere' })).status, 409);
  assert.equal((await call('POST', `/api/tickets/${idle.id}/move`, person, {})).status, 400);
  assert.equal((await call('POST', `/api/tickets/${created.id}/move`, person, { status: 'In Review' })).status, 409, 'a ticket being worked on is not moved by hand');
});

test('creating a ticket, or moving one to Todo, starts its flow in the background, and the move is the human\'s', async () => {
  const before = t.startedSessions.length;
  const created = (await call('POST', '/api/tickets', person, { title: 'Fourth', project: 'guestbook' })).json as Ticket;
  await until(() => t.startedSessions.length === before + 1, 'the author session of the new ticket');
  assert.equal(t.startedSessions.at(-1)?.input.ticket, created.id);
  assert.equal((await t.tickets.history(created.id))[0]?.by.kind, 'human');
});

test('moving a parked ticket to Todo starts it, as the human who moved it', async () => {
  const idle = await t.tickets.create({ title: 'Parked too', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  await call('POST', `/api/tickets/${idle.id}/move`, person, { status: 'In Review' });
  const before = t.startedSessions.length;
  assert.equal((await call('POST', `/api/tickets/${idle.id}/move`, person, { status: 'Todo' })).status, 200);
  await until(() => t.startedSessions.length === before + 1, 'the author session');
  assert.equal(t.startedSessions.at(-1)?.input.ticket, idle.id);
  assert.deepEqual((await t.tickets.history(idle.id)).slice(0, 3).map((h) => [h.status, h.by.kind]), [['Todo', 'human'], ['In Review', 'human'], ['Todo', 'human']]);
});

test('inbox: the waiting permission is listed with its request', async () => {
  const items = (await call('GET', '/api/inbox', signed)).json as InboxItem[];
  assert.ok(items.some((i) => i.kind === 'permission' && i.requestId === 'request-1'));
});

test('events: a stream from a sequence number, resumed with Last-Event-ID, and released when the client leaves', async () => {
  const id = t.startedSessions[0]!.id;
  const total = t.store.events.after(id).length;
  assert.ok(total >= 3);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/sessions/${id}/events?after=1`, { headers: signed, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  while (!seen.includes(`id: ${total}\n`)) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  assert.ok(!seen.includes('id: 1\n'), 'the stream starts after the number given');
  assert.ok(seen.includes('id: 2\n'));
  assert.match(seen, /event: [A-Z_]+\ndata: \{"seq":2,/);
  assert.equal(t.engine.watchers(id), 1);

  // A live event reaches the open stream.
  await t.engine.send(id, 'a live message', 'u1');
  while (!seen.includes('a live message')) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  assert.match(seen, /a live message/);
  controller.abort();
  await until(() => t.engine.watchers(id) === 0, 'the watcher released');

  // Last-Event-ID wins over a missing ?after.
  const resumed = await fetch(`${base}/api/sessions/${id}/events`, { headers: { ...signed, 'last-event-id': String(total) } });
  const resumedReader = resumed.body!.getReader();
  const first = await resumedReader.read();
  assert.ok(!new TextDecoder().decode(first.value).includes(`id: ${total}\n`));
  await resumedReader.cancel();
  assert.equal((await call('GET', `/api/sessions/${id}/events?after=abc`, signed)).status, 400);
});

test('the module routes of the flow never collide with each other (assemble would stop the service)', () => {
  const routes = createApiRoutes({ engine: () => t.engine, proof: () => PROOF });
  assert.equal(new Set(routes.map((r) => `${r.method} ${r.path}`)).size, routes.length);
  assert.ok(matchRoute(routes, 'POST', '/api/tickets/LOCAL-1/approve') === undefined || 'allow' in (matchRoute(routes, 'POST', '/api/tickets/LOCAL-1/approve') ?? {}));
});

test('with no flow configured every route answers 503 once the proof is checked', async () => {
  const routes = createApiRoutes({ engine: () => undefined, proof: () => PROOF });
  const app: App = { registry: t.engine.registry, tables: [], routes };
  const bare = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
  try {
    const list = await fetch(`${url}/api/sessions`, { headers: signed });
    assert.equal(list.status, 503);
    assert.deepEqual(await list.json(), { error: 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md' });
    assert.equal((await fetch(`${url}/api/sessions`)).status, 401, 'unsigned is still refused first');
  } finally {
    await new Promise<void>((resolve) => { bare.closeAllConnections(); bare.close(() => resolve()); });
  }
});


test('a ticket waiting for approval can be sent back from the inbox with a move to Todo, which starts a new flow', async () => {
  const own = await setup({ scripts: { author: quickAuthor } });
  const app: App = { registry: own.engine.registry, tables: [], routes: createApiRoutes({ engine: () => own.engine, proof: () => PROOF }) };
  const sending = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => sending.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(sending.address() as AddressInfo).port}`;
  try {
    await own.engine.start(own.ticket.id, 'u1');
    await until(() => own.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release item');
    const before = own.startedSessions.length;
    const moved = await fetch(`${url}/api/tickets/${own.ticket.id}/move`, { method: 'POST', headers: person, body: JSON.stringify({ status: 'Todo' }) });
    assert.equal(moved.status, 200);
    await until(() => own.startedSessions.length > before, 'the new author session');
    await own.engine.tick();
    assert.equal(own.inbox.list().find((i) => i.kind === 'release' && i.state === 'handled') !== undefined, true, 'the old release is settled');
  } finally {
    sending.closeAllConnections();
    await new Promise<void>((resolve) => sending.close(() => resolve()));
  }
});
