import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER_CAPS, LEAD_TICKET, LEAD_TOOLS, LEAD_TOOL_NAMES, bindLeadTools, capAnswer,
  type LeadToolInput, type LeadToolName,
} from '../../src/lead/contract.ts';
import { HostToolRefused, type JsonSchema } from '../../src/session/contract.ts';
import { ticketBranch } from '../../src/workspace/checkout.ts';

// The keywords of the schema subset the runner converts (milestone 2 plan,
// section 3.1): object, string, number, boolean, enum, array, required.
const KEYWORDS: Readonly<Record<JsonSchema['type'], readonly string[]>> = {
  object: ['type', 'properties', 'required', 'description'],
  array: ['type', 'items', 'description'],
  string: ['type', 'enum', 'description'],
  number: ['type', 'description'],
  boolean: ['type', 'description'],
};

function inSubset(schema: JsonSchema, where: string): void {
  const allowed = KEYWORDS[schema.type];
  assert.ok(allowed, `${where}: type ${String(schema.type)}`);
  for (const key of Object.keys(schema)) assert.ok(allowed.includes(key), `${where}: ${key} is not in the subset`);
  if (schema.type === 'object') {
    for (const name of schema.required ?? []) assert.ok(name in schema.properties, `${where}: ${name} is required and not declared`);
    for (const [name, property] of Object.entries(schema.properties)) inSubset(property, `${where}.${name}`);
  }
  if (schema.type === 'array') inSubset(schema.items, `${where}[]`);
}

const shape = (schema: JsonSchema): unknown => {
  if (schema.type === 'object') return { required: [...(schema.required ?? [])].sort(), properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, shape(v)])) };
  if (schema.type === 'array') return [shape(schema.items)];
  if (schema.type === 'string' && schema.enum) return [...schema.enum];
  return schema.type;
};

test('the lead has the thirteen host tools of section 3.2, then the service map\'s (milestone 4, section 12), in its order, each in the schema subset', () => {
  assert.deepEqual([...LEAD_TOOL_NAMES], [
    'state', 'ticket', 'session', 'search_memory', 'propose_plan', 'start_ticket', 'stop_session',
    'message_session', 'answer_question', 'commit', 'fulfil', 'tell_owner', 'handover', 'service_impact',
  ]);
  assert.deepEqual(LEAD_TOOLS.map((tool) => tool.name), [...LEAD_TOOL_NAMES]);
  for (const tool of LEAD_TOOLS) {
    assert.match(tool.name, /^[a-z_]+$/);
    assert.ok(tool.description.length > 20 && !tool.description.includes('—'), tool.name);
    assert.equal(tool.inputSchema.type, 'object', tool.name);
    inSubset(tool.inputSchema, tool.name);
  }
});

test('each tool takes the input of section 3.2', () => {
  const schemas = Object.fromEntries(LEAD_TOOLS.map((tool) => [tool.name, shape(tool.inputSchema)]));
  const object = (properties: Record<string, unknown>, required: string[]) => ({ required: required.sort(), properties });
  assert.deepEqual(schemas, {
    state: object({}, []),
    ticket: object({ id: 'string' }, ['id']),
    session: object({ id: 'string' }, ['id']),
    search_memory: object({ query: 'string' }, ['query']),
    propose_plan: object({
      goal: 'string', title: 'string', summary: 'string',
      items: [object({
        title: 'string', body: 'string', lane: ['fast', 'full'], size: ['xs', 's', 'm', 'l'], after: ['number'],
        // Lane 23: the steps of a ticket across services, optional.
        steps: [object({ kind: ['contract', 'service', 'integration'], service: 'string', after: ['number'] }, ['kind', 'service', 'after'])],
      }, ['title', 'body', 'lane', 'size', 'after'])],
    }, ['goal', 'title', 'summary', 'items']),
    start_ticket: object({ id: 'string', reason: 'string' }, ['id', 'reason']),
    stop_session: object({ id: 'string', reason: 'string' }, ['id', 'reason']),
    message_session: object({ id: 'string', text: 'string' }, ['id', 'text']),
    answer_question: object({ session: 'string', requestId: 'string', answers: [object({ question: 'string', answer: 'string' }, ['question', 'answer'])] }, ['session', 'requestId', 'answers']),
    commit: object({ text: 'string', ticket: 'string', due: 'string' }, ['text']),
    fulfil: object({ id: 'string', note: 'string' }, ['id', 'note']),
    tell_owner: object({ text: 'string' }, ['text']),
    handover: object({ summary: 'string' }, ['summary']),
    service_impact: object({ services: ['string'] }, ['services']),
  });
});

test('the inputs type check with the values the engine will receive', () => {
  const plan: LeadToolInput['propose_plan'] = {
    goal: 'g1', title: 'Make a long guestbook readable', summary: 'Pages of 20.',
    items: [{ title: 'Day headings', body: 'Headings.\n\n- [ ] one heading per day', lane: 'full', size: 'm', after: [] }],
  };
  const answer: LeadToolInput['answer_question'] = { session: 's1', requestId: 'q1', answers: [{ question: 'Which order?', answer: 'Newest first' }] };
  const commitment: LeadToolInput['commit'] = { text: 'Tell the owner how long the first ticket took', due: '2026-10-23T08:00:00.000Z' };
  assert.equal(plan.items[0]?.lane, 'full');
  assert.equal(answer.answers.length, 1);
  assert.equal(commitment.ticket, undefined);
});

test('the lead\'s sentinel ticket is a word the ticket branch rule accepts', () => {
  assert.equal(LEAD_TICKET, 'lead');
  assert.equal(ticketBranch(LEAD_TICKET), 'cleared/lead');
});

test('an answer is cut at its cap, on a character boundary, with a line saying how much was cut', () => {
  assert.deepEqual(ANSWER_CAPS, { state: 2048, ticket: 8192, session: 8192, search_memory: 8192, service_impact: 8192 });
  assert.equal(capAnswer('short', 8192), 'short');
  const long = 'é'.repeat(10_000);                               // 20 000 bytes
  const cut = capAnswer(long, 8192);
  assert.ok(Buffer.byteLength(cut) <= 8192, `${Buffer.byteLength(cut)} bytes`);
  assert.ok(!cut.includes('�'), 'no character is cut in half');
  const line = /\n\[cleared: (\d+) bytes cut\]$/.exec(cut);
  assert.ok(line, cut.slice(-60));
  const kept = cut.slice(0, cut.length - (line?.[0].length ?? 0));
  assert.equal(Number(line?.[1]), 20_000 - Buffer.byteLength(kept));
});

test('the bound tools cut the answers of state, ticket, session and search_memory, and pass refusals through', async () => {
  const context = { sessionId: 'lead-1', turn: 'turn-1' };
  const big = 'x'.repeat(20_000);
  const seen: unknown[] = [];
  const tools = bindLeadTools({
    state: async () => big,
    ticket: async (input) => { seen.push(input); return big; },
    session: async () => big,
    search_memory: async () => big,
    commit: async () => ({ id: 'c1' }),
    fulfil: async () => { throw new HostToolRefused('the commitment c9 is not open'); },
  });
  assert.deepEqual(tools.map((tool) => tool.name), ['state', 'ticket', 'session', 'search_memory', 'commit', 'fulfil']);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const [name, cap] of [['state', 2048], ['ticket', 8192], ['session', 8192], ['search_memory', 8192]] as const) {
    const answer = await byName.get(name)?.handle({ id: 'LOCAL-1', query: 'q' }, context) as string;
    assert.ok(Buffer.byteLength(answer) <= cap, name);
    assert.match(answer, /\[cleared: \d+ bytes cut\]$/, name);
  }
  assert.deepEqual(seen, [{ id: 'LOCAL-1', query: 'q' }]);
  assert.deepEqual(await byName.get('commit')?.handle({ text: 'x' }, context), { id: 'c1' });
  await assert.rejects(byName.get('fulfil')?.handle({ id: 'c9', note: 'done' }, context) as Promise<unknown>, HostToolRefused);
  const definition = LEAD_TOOLS.find((tool) => tool.name === 'commit');
  assert.equal(byName.get('commit')?.description, definition?.description);
  assert.equal(byName.get('commit')?.inputSchema, definition?.inputSchema);
  const names: readonly LeadToolName[] = tools.map((tool) => tool.name as LeadToolName);
  assert.equal(names.length, 6);
});
