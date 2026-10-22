// The lead's routes (docs/v2/milestone-2-plan.md, section 7.1): the state,
// the thread and its stream, an owner's message or goal, the answer to the
// pending question, the memory; each guarded as milestone 1's are.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MILESTONE_2_ROUTES, SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, type LeadMemory, type LeadMessage, type LeadState } from '../../src/api/types.ts';
import { createLeadRoutes } from '../../src/lead/routes.ts';
import type { LeadEngine } from '../../src/lead/engine.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { context, leadSetup, opening, question, say, turn, until, type LeadSetup } from './support.ts';

const PROOF = 'c'.repeat(64);
let t: LeadSetup;
let server: Server;
let base = '';
let configured = true;

before(async () => {
  t = await leadSetup({
    lead: [[
      ...opening(),
      ...turn('t1', say('r1', 'Hello from the lead.'), context(12)),
      ...turn('t2', question('q1', 'Pages of 20?'), say('r2', 'Pages of 20 it is.')),
    ]],
  });
  const routes = createLeadRoutes({ lead: (): LeadEngine | undefined => (configured ? t.lead : undefined), proof: () => PROOF });
  const app: App = { registry: t.engine.registry, tables: [], routes };
  server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.lead.close();
});

const signed = { [SERVICE_PROOF_HEADER]: PROOF };
const person = { ...signed, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' };

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : undefined };
}

test('the lead module declares the five lead routes of section 7.1, and leaves the plans to lane 7', () => {
  const declared = createLeadRoutes({ lead: () => undefined, proof: () => PROOF }).map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(declared, MILESTONE_2_ROUTES.filter((r) => r.includes('/api/lead')).sort());
});

test('every route needs the proof, a configured lead, and a known user for a write', async () => {
  for (const [method, path] of [['GET', '/api/lead'], ['GET', '/api/lead/messages'], ['GET', '/api/lead/memory'], ['POST', '/api/lead/messages']] as const) {
    assert.equal((await call(method, path, {}, method === 'POST' ? { text: 'x' } : undefined)).status, 401, `${method} ${path}`);
  }
  assert.equal((await call('POST', '/api/lead/messages', { ...signed, 'content-type': 'application/json' }, { text: 'x' })).status, 403);
  assert.equal((await call('POST', '/api/lead/messages', { ...signed, [SERVICE_USER_HEADER]: 'stranger' }, { text: 'x' })).status, 403);
  configured = false;
  try {
    assert.equal((await call('GET', '/api/lead', signed)).status, 503);
  } finally {
    configured = true;
  }
  assert.equal((await call('POST', '/api/lead/messages', person, { text: '' })).status, 400);
  assert.equal((await call('POST', '/api/lead/messages', person, { text: 'x', goal: 'yes' })).status, 400);
  assert.equal((await call('POST', '/api/lead/messages', person, { text: 'x'.repeat(20_001) })).status, 400);
});

test('a message, its reply in the thread, the answer to the pending question, the state and the memory', async () => {
  const sent = await call('POST', '/api/lead/messages', person, { text: 'Hello' });
  assert.equal(sent.status, 200);
  const message = sent.json as LeadMessage;
  assert.deepEqual([message.by, message.user, message.text, message.kind], ['owner', 'u1', 'Hello', 'message']);
  await until(() => t.lead.messages().some((m) => m.text === 'Hello from the lead.'), 'the reply');

  const goal = await call('POST', '/api/lead/messages', person, { text: 'Make the list readable', goal: true });
  assert.equal(goal.status, 200);
  await until(() => t.lead.state().pendingQuestion !== null, 'the question');
  const state = (await call('GET', '/api/lead', signed)).json as LeadState;
  assert.deepEqual(state.pendingQuestion, { sessionId: t.generations[0]?.id, requestId: 'q1' });
  assert.equal(state.generation, 1);
  assert.equal(state.model, 'claude-opus-5-5');

  const answer = await call('POST', '/api/lead/messages', person, { text: 'Yes, pages of 20' });
  assert.equal(answer.status, 200);
  await until(() => t.lead.messages().some((m) => m.text === 'Pages of 20 it is.'), 'the answered turn');

  const all = (await call('GET', '/api/lead/messages', signed)).json as LeadMessage[];
  assert.deepEqual(all.map((m) => m.seq), [1, 2, 3, 4, 5, 6]);
  const later = (await call('GET', '/api/lead/messages?after=4', signed)).json as LeadMessage[];
  assert.deepEqual(later.map((m) => m.seq), [5, 6]);
  assert.equal((await call('GET', '/api/lead/messages?after=x', signed)).status, 400);
  const memory = (await call('GET', '/api/lead/memory', signed)).json as LeadMemory;
  assert.equal(memory.handover, null);
  assert.deepEqual(memory.commitments, []);
});

test('the stream sends the thread after the seq given, then what comes, and a state frame', async () => {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/lead/stream`, { headers: { ...signed, 'last-event-id': '5' }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let text = '';
  const decoder = new TextDecoder();
  const read = async (pattern: RegExp) => {
    while (!pattern.test(text)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
  };
  await read(/id: 6\n/);
  assert.doesNotMatch(text, /id: 5\n/);
  assert.match(text, /event: state\n/);
  await call('POST', '/api/lead/messages', person, { text: 'One more' });
  await read(/id: 7\n/);
  assert.match(text, /"text":"One more"/);
  controller.abort();
  await reader.cancel().catch(() => undefined);
});
