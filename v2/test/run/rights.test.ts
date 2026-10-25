// A token's rights (docs/v2/milestone-5-plan.md, decision 11, B5.9c): it
// makes and reads runs, and reaches nothing else. The twelve modules are
// assembled as src/main.ts assembles them, with no project set, and a
// valid token is sent, as `authorization: Bearer` and in the proof's
// header, to every route the service declares: only POST /api/run and
// GET /api/run/:id take it. So a token never approves a release, never
// answers a permission or a question, never reaches the setup or the
// settings, and never makes another token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { ApiTokens } from '../../src/run/tokens.ts';
import { handle } from '../../src/server.ts';
import { applyTables, openStore } from '../../src/store/db.ts';

const state = mkdtempSync(join(tmpdir(), 'cleared-v2-run-rights-'));
for (const name of Object.keys(process.env)) if (name.startsWith('CLEARED_') || name.startsWith('ORCH_') || name === 'GH_TOKEN' || name === 'GITHUB_TOKEN') delete process.env[name];
process.env.CLEARED_STATE_DIR = state;
process.env.CLEARED_V2_STATE_DIR = state;

const modules = {
  sessions: (await import('../../src/modules/sessions.ts')).default,
  users: (await import('../../src/modules/users.ts')).default,
  tickets: (await import('../../src/modules/tickets.ts')).default,
  flow: (await import('../../src/modules/flow.ts')).default,
  approval: (await import('../../src/modules/approval.ts')).default,
  inbox: (await import('../../src/modules/inbox.ts')).default,
  lead: (await import('../../src/modules/lead.ts')).default,
  notify: (await import('../../src/modules/notify.ts')).default,
  knowledge: (await import('../../src/modules/knowledge.ts')).default,
  setup: (await import('../../src/modules/setup.ts')).default,
  run: (await import('../../src/modules/run.ts')).default,
  secrets: (await import('../../src/modules/secrets.ts')).default,
};
const { assemble, dispatch } = await import('../../src/modules/registry.ts');

const RUN_ROUTES = new Set(['POST /api/run', 'GET /api/run/:id']);

test('a valid token is taken by the two run routes alone: every other route of the service refuses it', async (t) => {
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const store = openStore(':memory:');
  applyTables(store.db, Object.values(modules).flatMap((module) => module.tables));
  const app = assemble(modules, { store });
  store.db.prepare("INSERT INTO users (id, name, password, created_at) VALUES ('u1', 'owner', 'x', '2026-10-25T10:00:00.000Z')").run();
  const made = new ApiTokens(store.db).make('u1', 'rights');
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const routes = app.routes.map((route) => ({ method: route.method, path: route.path, key: `${route.method} ${route.path}` }));
    assert.ok(routes.some((route) => route.key === 'POST /api/tickets/:id/approve'), 'the approval route is there to be refused');
    assert.ok(routes.some((route) => route.key.startsWith('POST /api/setup')), 'and the setup\'s');
    for (const key of RUN_ROUTES) assert.ok(routes.some((route) => route.key === key), key);
    const sent: Record<string, string>[] = [
      { authorization: `Bearer ${made.value}` },
      { authorization: `Bearer ${made.value}`, [SERVICE_USER_HEADER]: 'u1' },
      { [SERVICE_PROOF_HEADER]: made.value, [SERVICE_USER_HEADER]: 'u1' },
    ];
    for (const route of routes) {
      const path = route.path.split('/').map((part) => (part.startsWith(':') ? 'x' : part)).join('/');
      for (const headers of sent) {
        const answer = await fetch(`${base}${path}`, {
          method: route.method, headers: { ...headers, 'content-type': 'application/json' },
          ...(route.method === 'GET' ? {} : { body: '{}' }), signal: AbortSignal.timeout(5000),
        });
        const text = await answer.text();
        if (RUN_ROUTES.has(route.key) && headers.authorization && !headers[SERVICE_PROOF_HEADER]) {
          // No project is set: the flow is not configured, after the token was taken.
          assert.equal(answer.status, 503, `${route.key}: ${text}`);
          continue;
        }
        assert.ok(answer.status >= 400 && answer.status < 500 && answer.status !== 409 && answer.status !== 400, `${route.key} answered ${answer.status} to ${Object.keys(headers).join(', ')}: ${text}`);
        assert.ok(!text.includes(made.value), `${route.key} answers no value back`);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.stop?.();
    store.close();
  }
});
