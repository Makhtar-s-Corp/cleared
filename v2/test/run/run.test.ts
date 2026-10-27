// `cleared run` as an API (docs/v2/milestone-5-plan.md, section 8, C18):
// POST /api/run makes a ticket and starts it as a batch of one, the chat's
// path (P212), so it waits for the lanes and the week stop as the chat's
// does; GET /api/run/:id says its state, its session, its pull request and
// its times. Both take `authorization: Bearer <token>` and nothing else;
// the tokens are made, listed and revoked through the app (the proof and
// the person's id). Driven over loopback on the fake harness.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import type { Levers } from '../../src/consumption/levers.ts';
import { BatchRunner } from '../../src/flow/batch.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { RunLauncher } from '../../src/run/runs.ts';
import { runRoutes } from '../../src/run/routes.ts';
import { ApiTokens, accessHash } from '../../src/run/tokens.ts';
import { ACCESS_PATH, RUN_LABEL, RUN_PATH, type MadeApiToken, type Run } from '../../src/run/types.ts';
import { handle } from '../../src/server.ts';
import { REPORT_PASS, authorScript, quickAuthor, reviewerScript, setup, until, type Setup } from '../flow/support.ts';

const PROOF = 'proof-for-the-run-tests-only';
const APP = 'http://127.0.0.1:8792';

type Served = { t: Setup; runner: BatchRunner; launcher: RunLauncher; tokens: ApiTokens; base: string; close: () => Promise<void> };
const open: Served[] = [];
after(async () => { for (const served of open) await served.close(); });

async function serve(options: { t?: Setup; lanes?: number; off?: boolean } = {}): Promise<Served> {
  const t = options.t ?? await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });
  const levers = { read: (): Levers => ({ model: null, maxLanes: options.lanes ?? null, paused: false }) };
  const runner = new BatchRunner({ db: t.store.db, tickets: t.tickets, flow: t.engine, project: 'guestbook', levers, weekStopPercent: 85, now: () => new Date(t.clock.now) });
  runner.listen();
  const launcher = new RunLauncher({
    db: t.store.db, runner, flow: t.engine, tickets: t.tickets, project: 'guestbook', services: () => ['guestbook'], appOrigin: APP, now: () => new Date(t.clock.now),
  });
  launcher.listen();
  const tokens = new ApiTokens(t.store.db, () => new Date(t.clock.now));
  const routes = runRoutes({ tokens: () => tokens, launcher: () => (options.off ? undefined : launcher), proof: () => PROOF });
  const app: App = { registry: t.engine.registry, tables: [], routes };
  const server: Server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const served: Served = {
    t, runner, launcher, tokens, base,
    close: async () => {
      await launcher.close();
      await runner.close();
      await t.engine.settled();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  open.push(served);
  return served;
}

type Answer = { status: number; json: any; headers: Headers };
async function call(base: string, method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Answer> {
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
    ...(options.body === undefined ? {} : { body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers };
}

const fromApp = (user = 'u1') => ({ [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: user });
const bearer = (value: string) => ({ authorization: `Bearer ${value}` });

async function madeToken(s: Served, name = 'script', user = 'u1'): Promise<MadeApiToken> {
  const answer = await call(s.base, 'POST', ACCESS_PATH, { body: { name }, headers: fromApp(user) });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  return answer.json as MadeApiToken;
}

const runTickets = async (t: Setup) => (await t.tickets.list({ project: 'guestbook' })).filter((ticket) => ticket.labels.includes(RUN_LABEL));

test('the routes: the run and its state behind a token, the tokens behind the app', () => {
  assert.equal(RUN_PATH, '/api/run');
  assert.equal(ACCESS_PATH, '/api/tokens');
  const routes = runRoutes({ tokens: () => undefined, launcher: () => undefined, proof: () => PROOF });
  assert.deepEqual(routes.map((route) => `${route.method} ${route.path}`).sort(), [
    'GET /api/run/:id', 'GET /api/tokens', 'POST /api/run', 'POST /api/tokens', 'POST /api/tokens/:id/revoke',
  ]);
});

test('the app makes a token for the signed-in person: its value answered once, its hash alone in the ledger, the list without either', async () => {
  const s = await serve();
  const made = await madeToken(s, 'Nightly');
  assert.match(made.value, /^clr_/);
  assert.equal(made.token.name, 'Nightly');
  const listed = await call(s.base, 'GET', ACCESS_PATH, { headers: fromApp() });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json, [made.token]);
  assert.ok(!JSON.stringify(listed.json).includes(made.value) && !JSON.stringify(listed.json).includes(accessHash(made.value)));
  const dump = JSON.stringify(s.t.store.db.prepare('SELECT * FROM api_tokens').all());
  assert.ok(dump.includes(accessHash(made.value)) && !dump.includes(made.value), 'the hash only');
  assert.deepEqual((await call(s.base, 'GET', ACCESS_PATH, { headers: fromApp('u2') })).status, 403, 'a person the service does not know');
});

test('the token routes want the app: no proof, a wrong proof, a token in its place, or no person, and nothing is made', async () => {
  const s = await serve();
  const made = await madeToken(s);
  const sent: Record<string, string>[] = [{}, { [SERVICE_PROOF_HEADER]: 'wrong', [SERVICE_USER_HEADER]: 'u1' }, bearer(made.value), { ...bearer(made.value), [SERVICE_USER_HEADER]: 'u1' }];
  for (const headers of sent) {
    assert.equal((await call(s.base, 'POST', ACCESS_PATH, { body: { name: 'more' }, headers })).status, 401, JSON.stringify(headers));
    assert.equal((await call(s.base, 'GET', ACCESS_PATH, { headers })).status, 401);
    assert.equal((await call(s.base, 'POST', `${ACCESS_PATH}/${made.token.id}/revoke`, { headers })).status, 401);
  }
  assert.equal((await call(s.base, 'POST', ACCESS_PATH, { body: { name: 'more' }, headers: { [SERVICE_PROOF_HEADER]: PROOF } })).status, 403);
  assert.equal(s.tokens.list('u1').length, 1);
  for (const body of [{}, { name: '' }, { name: 'x'.repeat(61) }, { name: 'ok', other: 1 }, 'not json']) {
    const answer = await call(s.base, 'POST', ACCESS_PATH, { body, headers: fromApp() });
    assert.equal(answer.status, 400, JSON.stringify(body));
  }
});

test('a run made with a token: a ticket in the service\'s project by the token\'s person, a batch of one, answered with its id and address, then its session and its pull request', async () => {
  const s = await serve();
  const made = await madeToken(s);
  const answer = await call(s.base, 'POST', RUN_PATH, { body: { title: 'Show the newest entry first', description: 'The guestbook lists entries newest first.' }, headers: bearer(made.value) });
  assert.equal(answer.status, 200, JSON.stringify(answer.json));
  const run = answer.json as Run;
  const [ticket, ...others] = await runTickets(s.t);
  assert.ok(ticket);
  assert.equal(others.length, 0);
  assert.equal(run.ticket, ticket.id);
  assert.equal(run.title, 'Show the newest entry first');
  assert.equal(ticket.body, 'The guestbook lists entries newest first.');
  assert.equal(ticket.project, 'guestbook');
  assert.ok(ticket.labels.some((label) => label.startsWith('batch:')), 'a batch of one, within the lanes and the stop');
  assert.equal((await s.t.tickets.history(ticket.id))[0]?.by.id, 'u1', 'made by the token\'s person');
  assert.equal(run.address, `${APP}/`);
  assert.ok(['starting', 'working'].includes(run.state), run.state);
  assert.equal(run.createdAt, '2026-10-21T10:00:00.000Z');

  await until(() => s.t.flowEvents.some((event) => event.type === 'release_requested'), 'the release request', 5000);
  await s.t.engine.settled();
  const state = await call(s.base, 'GET', `${RUN_PATH}/${ticket.id}`, { headers: bearer(made.value) });
  assert.equal(state.status, 200);
  const session = s.t.startedSessions[0]!.id;
  assert.deepEqual(state.json, {
    ticket: ticket.id, title: 'Show the newest entry first', status: (await s.t.tickets.get(ticket.id))!.status, state: 'approval', hold: null, note: null,
    address: `${APP}/sessions/${session}`, session, pullRequest: { number: 7, url: 'https://example.invalid/pull/7' },
    createdAt: run.createdAt, startedAt: state.json.startedAt, approvalAt: state.json.approvalAt, liveAt: null,
  });
  assert.ok(Date.parse(state.json.startedAt) >= Date.parse(run.createdAt));
  assert.ok(Date.parse(state.json.approvalAt) >= Date.parse(state.json.startedAt));
  assert.equal(s.tokens.list('u1')[0]!.lastUsedAt, '2026-10-21T10:00:00.000Z', 'its last use');
});

test('a template gives the ticket its type, a service its part; an unknown one, an empty title, a long one or another field is refused before any ticket', async () => {
  const s = await serve();
  const made = await madeToken(s);
  // The scheme is read in any case (RFC 7235).
  const typed = await call(s.base, 'POST', RUN_PATH, { body: { title: 'The footer overlaps', template: 'bug', service: 'guestbook' }, headers: { authorization: `bearer ${made.value}` } });
  assert.equal(typed.status, 200, JSON.stringify(typed.json));
  const ticket = (await s.t.tickets.get(typed.json.ticket))!;
  assert.ok(ticket.labels.includes('type:bug'));
  assert.ok(ticket.labels.includes(RUN_LABEL));
  assert.deepEqual(ticket.services?.map((service) => service.name), ['guestbook']);
  const refused: [unknown, RegExp][] = [
    [{ title: 'x', template: 'feature' }, /template/],
    [{ title: 'x', service: 'billing' }, /billing is not a service/],
    [{ title: '  ' }, /title/],
    [{ title: 'x'.repeat(201) }, /title/],
    [{ title: 'x', description: 'y'.repeat(20_001) }, /description/],
    [{ title: 'x', labels: ['a'] }, /labels/],
    [{ title: 'x', project: 'other' }, /project/],
    [[], /object/],
  ];
  for (const [body, why] of refused) {
    const answer = await call(s.base, 'POST', RUN_PATH, { body, headers: bearer(made.value) });
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.match(answer.json.error, why);
  }
  assert.equal((await runTickets(s.t)).length, 1);
});

test('a run waits for a lane as the chat\'s ticket does, and says why', async () => {
  const t = await setup({ scripts: { author: authorScript, reviewers: [reviewerScript(REPORT_PASS)] } });
  const s = await serve({ t, lanes: 1 });
  const made = await madeToken(s);
  const first = await call(s.base, 'POST', RUN_PATH, { body: { title: 'First' }, headers: bearer(made.value) });
  await until(async () => (await s.t.tickets.get(first.json.ticket))?.status === s.t.tickets.states.progress, 'the first in progress');
  const second = await call(s.base, 'POST', RUN_PATH, { body: { title: 'Second' }, headers: bearer(made.value) });
  assert.equal(second.status, 200);
  assert.equal(second.json.state, 'queued');
  assert.deepEqual(second.json.hold, { reason: 'lanes', running: 1, lanes: 1 });
  const read = await call(s.base, 'GET', `${RUN_PATH}/${second.json.ticket}`, { headers: bearer(made.value) });
  assert.equal(read.json.state, 'queued');
  await s.t.engine.close();
});

test('no token, a wrong one, a revoked one or one of a person gone is refused, and nothing is made', async () => {
  const s = await serve();
  const made = await madeToken(s);
  const gone = await madeToken(s, 'gone');
  const revoked = await madeToken(s, 'revoked');
  const answer = await call(s.base, 'POST', `${ACCESS_PATH}/${revoked.token.id}/revoke`, { headers: fromApp() });
  assert.deepEqual([answer.status, answer.json], [200, { revoked: true }]);
  assert.equal((await call(s.base, 'POST', `${ACCESS_PATH}/${revoked.token.id}/revoke`, { headers: fromApp() })).status, 404, 'once');
  s.t.users.users.delete('u1');
  s.t.users.users.set('u3', { id: 'u3', name: 'Other' });
  const kept = await madeToken(s, 'kept', 'u3');
  assert.equal((await call(s.base, 'POST', `${ACCESS_PATH}/${kept.token.id}/revoke`, { headers: fromApp('u3') })).status, 200);
  const cases: [Record<string, string>, number][] = [
    [{}, 401], [{ authorization: 'Bearer' }, 401], [{ authorization: `Basic ${made.value}` }, 401], [bearer(`${made.value}x`), 401],
    [bearer(revoked.value), 401], [bearer(kept.value), 401], [bearer(gone.value), 403], [bearer(made.value), 403],
    [{ [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'u3' }, 401],
  ];
  for (const [headers, status] of cases) {
    const posted = await call(s.base, 'POST', RUN_PATH, { body: { title: 'Nothing' }, headers });
    assert.equal(posted.status, status, JSON.stringify(headers));
    if (status === 401) assert.equal(posted.headers.get('www-authenticate'), 'Bearer');
    assert.ok(!JSON.stringify(posted.json).includes(made.value), 'the value is never answered back');
  }
  assert.deepEqual(await runTickets(s.t), []);
});

test('a person revokes their own tokens only', async () => {
  const s = await serve();
  s.t.users.users.set('u2', { id: 'u2', name: 'Other' });
  const theirs = await madeToken(s, 'theirs', 'u2');
  assert.equal((await call(s.base, 'POST', `${ACCESS_PATH}/${theirs.token.id}/revoke`, { headers: fromApp('u1') })).status, 404);
  assert.ok(s.tokens.verify(theirs.value));
  assert.deepEqual((await call(s.base, 'GET', ACCESS_PATH, { headers: fromApp('u1') })).json, []);
});

test('a ticket not made by a run, or none, is not a run; without a flow the run answers 503', async () => {
  const s = await serve();
  const made = await madeToken(s);
  assert.equal((await call(s.base, 'GET', `${RUN_PATH}/${s.t.ticket.id}`, { headers: bearer(made.value) })).status, 404);
  assert.equal((await call(s.base, 'GET', `${RUN_PATH}/LOCAL-999`, { headers: bearer(made.value) })).status, 404);
  const off = await serve({ off: true });
  const other = await madeToken(off);
  const answer = await call(off.base, 'POST', RUN_PATH, { body: { title: 'x' }, headers: bearer(other.value) });
  assert.equal(answer.status, 503);
  assert.equal((await call(off.base, 'GET', `${RUN_PATH}/x`, { headers: {} })).status, 401, 'the token first');
});

test('a run\'s state follows the flow after a restart: what was recorded is read back from the ledger', async () => {
  const s = await serve();
  const made = await madeToken(s);
  const answer = await call(s.base, 'POST', RUN_PATH, { body: { title: 'Kept' }, headers: bearer(made.value) });
  await until(() => s.t.flowEvents.some((event) => event.type === 'release_requested'), 'the release request', 5000);
  await s.t.engine.settled();
  await s.launcher.settled();
  const again = new RunLauncher({ db: s.t.store.db, runner: s.runner, flow: s.t.engine, tickets: s.t.tickets, project: 'guestbook', services: () => ['guestbook'], appOrigin: null });
  const run = await again.get(answer.json.ticket);
  assert.equal(run?.state, 'approval');
  assert.equal(run?.pullRequest?.number, 7);
  assert.equal(run?.address, null, 'no app address known, no link');
});
