// The knowledge routes (docs/v2/milestone-2-plan.md, decision 27, lane 24):
// Approve and Reject of a knowledge item, and "Update the skill now", with
// the checks of every write of the service's API: the app's proof, then the
// knowledge being set up, then a user the service knows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { KNOWLEDGE_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { InboxStore, INBOX_TABLE } from '../../src/inbox/store.ts';
import { knowledgeRoutes } from '../../src/knowledge/routes.ts';
import { Knowledge } from '../../src/knowledge/service.ts';
import { KNOWLEDGE_TABLES } from '../../src/knowledge/store.ts';
import knowledgeModule, { createKnowledgeModule } from '../../src/modules/knowledge.ts';
import { MemoryUsers, defaultRegistry, dispatch, type Registry } from '../../src/modules/registry.ts';
import { handle as health } from '../../src/server.ts';
import { MemoryTicketStore } from '../../src/tickets/contract.ts';
import type { ServiceConfig } from '../../src/workspace/config.ts';

const PROOF = 'proof-of-the-app';
const HANDOVER = '## Done\nx\n## Tried and failed, and why\nx\n## Left to do\nx\n## Where the artifacts are (screenshots, logs, branches)\nx\n## Open questions\nx\n';
const service = (name: string): ServiceConfig => ({
  name, kind: 'repository', repo: `example/${name}`, url: '', base: 'main', path: null, healthUrl: null, sensitivity: 'normal',
  consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null, dir: `/srv/${name}`,
});

async function serve(options: { knowledge?: boolean } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(INBOX_TABLE);
  for (const table of KNOWLEDGE_TABLES) db.exec(table);
  const inbox = new InboxStore(db);
  const tickets = new MemoryTicketStore();
  const written: string[] = [];
  const knowledge = new Knowledge({
    db, inbox, tickets, workspace: { id: 'guestbook', name: 'Guestbook', file: null, services: [service('guestbook')] },
    memory: { project: '/srv/guestbook' }, ownerId: 'owner', clean: (text) => text,
    write: async (_context, entry) => { written.push(entry.content); return 'm1'; },
  });
  const started: [string, string][] = [];
  const users = new MemoryUsers();
  users.users.set('u1', { id: 'u1', name: 'owner' });
  users.users.set('u2', { id: 'u2', name: 'someone' });
  const registry: Registry = { ...defaultRegistry(), users, ticketStore: tickets };
  const routes = knowledgeRoutes({
    knowledge: () => (options.knowledge === false ? undefined : knowledge), proof: () => PROOF,
    start: async (_registry, ticket, by) => { started.push([ticket, by]); },
  });
  const server: Server = createServer((request, response) => dispatch({ registry, tables: [], routes }, request, response, health));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, user: string | null = 'u1', proof: string | null = PROOF) => {
    const headers: Record<string, string> = {};
    if (proof !== null) headers[SERVICE_PROOF_HEADER] = proof;
    if (user !== null) headers[SERVICE_USER_HEADER] = user;
    const response = await fetch(`${base}${path}`, { method: 'POST', headers });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const propose = (text: string) => knowledge.propose({ ticket: 'DEMO-8', sessionId: '7a1d3c5e-2b4f-4e6a-8c0d-1e2f3a4b5c6d', content: `${HANDOVER}## Lessons for the workspace\n${text}\n` });
  return { post, propose, inbox, written, started, routes, tickets };
}

const path = (id: string, action: string) => `/api/knowledge/${encodeURIComponent(id)}/${action}`;

test('the module serves exactly the knowledge routes of the API', async () => {
  const { routes } = await serve();
  assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`).sort(), [...KNOWLEDGE_ROUTES].sort());
  assert.deepEqual(knowledgeModule.routes.map((r) => `${r.method} ${r.path}`).sort(), [...KNOWLEDGE_ROUTES].sort());
});

test('Approve: the app\'s proof, then a known user, then the owner; once', async () => {
  const s = await serve();
  const [item] = s.propose('Keep words.txt sorted.');
  assert.ok(item);
  assert.equal((await s.post(path(item.id, 'approve'), 'u1', null)).status, 401);
  assert.equal((await s.post(path(item.id, 'approve'), 'u1', 'wrong')).status, 401);
  assert.equal((await s.post(path(item.id, 'approve'), null)).status, 403);
  assert.equal((await s.post(path(item.id, 'approve'), 'u9')).status, 403);
  const other = await s.post(path(item.id, 'approve'), 'u2');
  assert.equal(other.status, 403);
  assert.match(String(other.body.error), /owner/);
  assert.equal((await s.post(path('knowledge:none:1', 'approve'))).status, 404);
  assert.deepEqual(await s.post(path(item.id, 'approve')), { status: 200, body: { accepted: true } });
  assert.equal((await s.post(path(item.id, 'approve'))).status, 409);
  assert.equal((await s.post(path(item.id, 'reject'))).status, 409);
  assert.deepEqual(s.written, ['Lesson: Keep words.txt sorted.']);
});

test('Reject answers accepted and writes nothing', async () => {
  const s = await serve();
  const [item] = s.propose('Keep words.txt sorted.');
  assert.ok(item);
  assert.deepEqual(await s.post(path(item.id, 'reject')), { status: 200, body: { accepted: true } });
  assert.deepEqual(s.written, []);
  assert.equal(s.inbox.item(item.id)?.state, 'handled');
});

test('"Update the skill now" makes the ticket and starts it for the owner who asked; nothing queued, no ticket', async () => {
  const s = await serve();
  assert.deepEqual(await s.post('/api/services/guestbook/skill'), { status: 200, body: { accepted: true, ticket: null } });
  assert.equal((await s.post('/api/services/payments/skill')).status, 404);
  assert.equal((await s.post('/api/services/guestbook/skill', 'u2')).status, 403);
  const [item] = s.propose('Keep words.txt sorted.');
  assert.ok(item);
  await s.post(path(item.id, 'approve'));
  const made = await s.post('/api/services/guestbook/skill');
  assert.equal(made.status, 200);
  assert.equal(typeof made.body.ticket, 'string');
  assert.deepEqual(s.started, [[made.body.ticket, 'u1']]);
  assert.equal((await s.tickets.list()).length, 1);
});

test('without a workspace the routes answer 503, and the module provides no slot', async () => {
  const s = await serve({ knowledge: false });
  assert.equal((await s.post(path('knowledge:x:1', 'approve'))).status, 503);
  assert.equal((await s.post('/api/services/guestbook/skill')).status, 503);
  const module = createKnowledgeModule({ env: {} });
  assert.deepEqual(module.provide({ store: undefined as never }), {});
  assert.equal(module.knowledge(), undefined);
});
