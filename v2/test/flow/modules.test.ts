import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER } from '../../src/api/types.ts';
import { BATCH_TABLES } from '../../src/flow/batch.ts';
import { FlowConfigError } from '../../src/flow/config.ts';
import { createRuntime } from '../../src/flow/runtime.ts';
import approval from '../../src/modules/approval.ts';
import flow from '../../src/modules/flow.ts';
import inbox from '../../src/modules/inbox.ts';
import { MODULE_NAMES, assemble, defaultRegistry, emptyModule } from '../../src/modules/registry.ts';
import sessions from '../../src/modules/sessions.ts';
import tickets from '../../src/modules/tickets.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { fakeEffects } from './support.ts';

// A session's preview routes are lane 15's (container/preview.ts), and the
// questions to the code lane 25's (reader/, test/reader/routes.test.ts),
// which the sessions module registers.
// A file of the Editor tab is one route per depth (lane 20, flow/files.ts): files/* here.
const routeKeys = (m: { routes: readonly { method: string; path: string }[] }) =>
  [...new Set(m.routes.filter((r) => !r.path.includes('/preview/') && !r.path.startsWith('/api/asks')).map((r) => `${r.method} ${r.path.replace(/\/files\/:p0(?:\/:p\d+)*$/, '/files/*')}`))].sort();

test('the three modules of lane 7 declare the routes of the API that are theirs, and the inbox its table', () => {
  assert.deepEqual(routeKeys(sessions), [
    'GET /api/sessions', 'GET /api/sessions/:id', 'GET /api/sessions/:id/events',
    'POST /api/sessions/:id/interrupt', 'POST /api/sessions/:id/messages', 'POST /api/sessions/:id/requests/:requestId/answer',
  ]);
  // The session plan's Go and Change (lane 17, flow/plan-gate.ts), the
  // Editor tab's files and Take over and Give back (lane 20), the ticket's
  // steps and the contract item (lane 23, flow/steps.ts), the web terminal
  // and the editor's save (lane 31), a ticket's variants and their choice
  // (issue #271, flow/variants.ts), and Resume from here (issue #272,
  // flow/replay.ts), and a proof receipt's captures (P210, flow/proof-routes.ts) are the flow module's.
  assert.deepEqual(routeKeys(flow), [
    'GET /api/batches', 'GET /api/batches/:id', 'GET /api/sessions/:id/editor', 'GET /api/sessions/:id/files', 'GET /api/sessions/:id/files/*', 'GET /api/sessions/:id/terminal/stream', 'GET /api/tickets', 'GET /api/tickets/:id', 'GET /api/tickets/:id/proof/:service/:file', 'GET /api/tickets/:id/steps',
    'GET /api/tickets/:id/variants', 'POST /api/batches', 'POST /api/contracts/:id/approve', 'POST /api/contracts/:id/sendback',
    'POST /api/sessions/:id/giveback', 'POST /api/sessions/:id/handover', 'POST /api/sessions/:id/plan/change', 'POST /api/sessions/:id/plan/go', 'POST /api/sessions/:id/replay', 'POST /api/sessions/:id/takeover',
    'POST /api/sessions/:id/terminal/close', 'POST /api/sessions/:id/terminal/input', 'POST /api/sessions/:id/terminal/open', 'POST /api/sessions/:id/terminal/resize',
    'POST /api/tickets', 'POST /api/tickets/:id/close', 'POST /api/tickets/:id/move', 'POST /api/tickets/:id/set-aside', 'POST /api/variants/:id/choose', 'PUT /api/sessions/:id/files/*',
  ]);
  assert.ok(BATCH_TABLES.every((table) => flow.tables.includes(table)), 'the batches\' tables are the flow module\'s');
  assert.deepEqual(routeKeys(inbox), ['GET /api/inbox']);
  assert.equal(inbox.tables.length, 1);
  assert.match(inbox.tables[0] as string, /CREATE TABLE IF NOT EXISTS flow_inbox/);
  assert.deepEqual([...MODULE_NAMES], ['sessions', 'users', 'tickets', 'flow', 'approval', 'inbox', 'lead', 'notify', 'knowledge']);
});

test('the modules assemble with the other lanes\' stubs: no route declared twice, the adapters provided', () => {
  const store = openStore(':memory:');
  applyTables(store.db, [...sessions.tables, ...inbox.tables]);
  const app = assemble({ sessions, users: emptyModule, tickets: emptyModule, flow, approval: emptyModule, inbox, lead: emptyModule, notify: emptyModule, knowledge: emptyModule }, { store });
  assert.equal(routeKeys(app).length, 37);   // 20, lane 31's five terminal routes and the save, set aside (lane j2-proof-clean-base), the variants' two (issue #271), and Resume from here (issue #272), Close (issue #249), and Open in an editor (C19), and Hand over (B6.3), and the batches' three (requirement C6), and the proof receipt's captures (P210)
  assert.deepEqual(Object.keys(app.registry.sessionAdapters), ['claude-code', 'cursor', 'codex']);
  assert.ok(!app.routes.some((r) => r.path === '/api/tickets/:id/approve'), 'the approval route is lane 8\'s');
});

test('a runtime without CLEARED_V2_PROJECT has no engine; a badly set up project is an error', () => {
  const store = openStore(':memory:');
  const bare = createRuntime({ env: {} });
  bare.attach({ store });
  assert.equal(bare.engine(defaultRegistry()), undefined);
  const wrong = createRuntime({ env: { CLEARED_V2_PROJECT: 'guestbook' } });
  assert.throws(() => wrong.attach({ store }), FlowConfigError);
});

test('a configured runtime builds one engine over the registry of the request, with its inbox and the adapters', async () => {
  const store = openStore(':memory:');
  applyTables(store.db, inbox.tables);
  const env = {
    CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://example.invalid/guestbook.git',
    CLEARED_V2_REPO: 'example-org/cleared-example-guestbook', CLEARED_V2_STATE_DIR: '/state', CLEARED_V2_BUDGET_USD: '5',
  };
  const runtime = createRuntime({ env, effects: () => fakeEffects([]) });
  runtime.attach({ store });
  const registry = defaultRegistry();
  const engine = runtime.engine(registry);
  assert.ok(engine);
  assert.equal(runtime.engine(registry), engine, 'one engine per process');
  assert.equal(engine.config.budgetUsd, 5);
  assert.equal(engine.registry, registry);
  assert.deepEqual(Object.keys(runtime.adapters()), ['claude-code', 'cursor', 'codex']);
  await engine.close();
});

// The real service, as the app reaches it: the API refuses a request without the proof, and answers "not configured" to one that has it.
const main = new URL('../../src/main.ts', import.meta.url).pathname;
const state = mkdtempSync(join(tmpdir(), 'cleared-v2-flow-main-'));
after(() => rmSync(state, { recursive: true, force: true }));

// A port the system says is free right now, on this machine only.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test('the started service guards /api with the proof, and says the flow is not configured when it is not', async () => {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: state, CLEARED_V2_PORT: String(port) };
  delete env.ORCH_LEDGER;
  delete env.CLEARED_V2_PROJECT;
  const child = spawn(process.execPath, [main], { env });
  try {
    await once(child.stdout, 'data');
    const url = `http://127.0.0.1:${port}`;
    const unsigned = await fetch(`${url}/api/sessions`);
    assert.equal(unsigned.status, 401);
    const proof = readFileSync(join(state, 'v2-app-proof'), 'utf8').trim();
    const signed = await fetch(`${url}/api/sessions`, { headers: { [SERVICE_PROOF_HEADER]: proof } });
    assert.equal(signed.status, 503);
    assert.match(((await signed.json()) as { error: string }).error, /not configured/);
    assert.equal((await fetch(`${url}/health`)).status, 200);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});

test('a badly set up project stops the service with exit code 64 and a message', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: state, CLEARED_V2_PORT: String(await freePort()), CLEARED_V2_PROJECT: 'guestbook' };
  delete env.ORCH_LEDGER;
  const child = spawn(process.execPath, [main], { env });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 64);
  assert.match(stderr, /CLEARED_V2_PROJECT_DIR is not set/);
});

test('the modules stop in reverse order, awaited, and a stop that fails does not hold the others (issue 299)', async () => {
  const order: string[] = [];
  const stopper = (name: string, fail = false) => ({ ...emptyModule, stop: async () => { await Promise.resolve(); order.push(name); if (fail) throw new Error('boom'); } });
  const store = openStore(':memory:');
  try {
    const app = assemble({ sessions: emptyModule, users: stopper('users'), tickets: emptyModule, flow: stopper('flow', true), approval: emptyModule, inbox: emptyModule, lead: stopper('lead'), notify: emptyModule, knowledge: emptyModule }, { store });
    const errors = console.error;
    console.error = () => {};
    try { await app.stop?.(); } finally { console.error = errors; }
    assert.deepEqual(order, ['lead', 'flow', 'users']);
  } finally {
    store.close();
  }
});

test('the flow module stops without having started, and twice', async () => {
  await flow.stop?.();
  await flow.stop?.();
});
