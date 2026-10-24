import test from 'node:test';
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { LedgerHistory, openLedgerReadOnly } from '../../src/mcp/history.ts';
import { createRedactor } from '../../src/mcp/redact.ts';
import { PROTOCOL_VERSIONS, createLedgerServer } from '../../src/mcp/server.ts';
import { ENV, SECRETS, SESSIONS, makeLedger } from './support.ts';

const fixture = makeLedger();
const db = openLedgerReadOnly(fixture.path);
const history = new LedgerHistory(db, createRedactor({ env: ENV, paths: [fixture.dir] }));
after(() => { db.close(); fixture.close(); });

const en = createLedgerServer({ history, language: 'en' });
const fr = createLedgerServer({ history, language: 'fr' });

type Answer = { jsonrpc: string; id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } };
type ToolAnswer = { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
let id = 0;
const ask = async (server: typeof en, method: string, params?: unknown) => await server.handle({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) }) as Answer;
const call = async (server: typeof en, name: string, args: Record<string, unknown> = {}) => (await ask(server, 'tools/call', { name, arguments: args })).result as unknown as ToolAnswer;

test('initialize answers the version the client asks for when it is known, else the newest, with the tools capability', async () => {
  const known = await ask(en, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } });
  assert.equal(known.jsonrpc, '2.0');
  assert.equal(known.result?.protocolVersion, '2025-06-18');
  assert.deepEqual(known.result?.capabilities, { tools: {} });
  assert.deepEqual((known.result?.serverInfo as { name: string }).name, 'cleared-ledger');
  assert.equal(typeof known.result?.instructions, 'string');
  const unknown = await ask(en, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} });
  assert.equal(unknown.result?.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('a notification gets no answer; ping answers empty; an unknown method and a bad request are JSON-RPC errors', async () => {
  assert.equal(await en.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.deepEqual((await ask(en, 'ping')).result, {});
  assert.equal((await ask(en, 'resources/list')).error?.code, -32601);
  assert.equal((await en.handle({ id: 3, method: 'ping' }) as Answer).error?.code, -32600, 'no jsonrpc 2.0');
  assert.equal((await en.handle([{ jsonrpc: '2.0', id: 4, method: 'ping' }]) as Answer).error?.code, -32600, 'no batch');
  assert.equal((await ask(en, 'tools/call', { name: 'drop_everything', arguments: {} })).error?.code, -32602);
});

test('tools/list describes each tool and each argument in the server\'s language, with closed schemas', async () => {
  const list = async (server: typeof en) => (await ask(server, 'tools/list')).result?.tools as { name: string; description: string; inputSchema: { type: string; properties: Record<string, { description: string }>; additionalProperties: boolean; required?: string[] } }[];
  const english = await list(en);
  const french = await list(fr);
  assert.deepEqual(english.map((t) => t.name), ['search_sessions', 'search_events', 'get_session_timeline']);
  for (const [i, tool] of english.entries()) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.notEqual(tool.description, french[i]?.description, `${tool.name}: the French description is not the English one`);
    for (const [arg, schema] of Object.entries(tool.inputSchema.properties)) {
      assert.ok(schema.description && !schema.description.includes('⟦'), `${tool.name}.${arg}`);
      assert.ok(french[i]?.inputSchema.properties[arg]?.description && !french[i]?.inputSchema.properties[arg]?.description.includes('⟦'), `fr ${tool.name}.${arg}`);
    }
  }
  assert.deepEqual(english[2]?.inputSchema.required, ['session_id']);
});

test('search_sessions answers the page as structured content and as its JSON text, with durations said as the app says them', async () => {
  const answer = await call(en, 'search_sessions', { ticket: 'LOCAL-7' });
  assert.equal(answer.isError, undefined);
  assert.deepEqual(JSON.parse(answer.content[0]?.text ?? ''), answer.structuredContent);
  const sessions = answer.structuredContent?.sessions as { id: string; duration: string }[];
  assert.deepEqual(sessions.map((s) => [s.id, s.duration]), [[SESSIONS.S2, '42s'], [SESSIONS.S1, '1h 30m']]);
  assert.equal(answer.structuredContent?.next, null);
  const french = (await call(fr, 'search_sessions', {})).structuredContent?.sessions as { id: string; duration: string }[];
  assert.deepEqual(french.map((s) => s.duration), ['2 j 1 h', '42 s', '1 h 30']);
});

test('search_events and get_session_timeline take the arguments by their snake_case names and page', async () => {
  const page = await call(en, 'search_events', { project: 'blog', limit: 5 });
  assert.equal((page.structuredContent?.events as unknown[]).length, 5);
  const next = page.structuredContent?.next as string;
  const more = await call(en, 'search_events', { project: 'blog', limit: 5, cursor: next });
  assert.equal((more.structuredContent?.events as { seq: number }[])[0]?.seq, 25);
  const verdicts = await call(en, 'search_events', { type: 'cleared.review_verdict', session_id: SESSIONS.S2, from: '2026-10-21', to: '2026-10-21' });
  assert.equal((verdicts.structuredContent?.events as unknown[]).length, 1);
  const timeline = await call(en, 'get_session_timeline', { session_id: SESSIONS.S3, after_seq: 28 });
  assert.deepEqual((timeline.structuredContent?.events as { seq: number }[]).map((e) => e.seq), [29, 30]);
  assert.equal((timeline.structuredContent?.session as { duration: string }).duration, '2d 1h');
});

test('a wrong argument is a tool error in the server\'s language, never a crash', async () => {
  const cases: [string, Record<string, unknown>][] = [
    ['search_sessions', { limit: 'ten' }],
    ['search_sessions', { from: 'yesterday' }],
    ['search_sessions', { owner: 'x' }],
    ['search_events', { cursor: 'nope' }],
    ['search_events', { text: SECRETS.github }],
    ['get_session_timeline', {}],
    ['get_session_timeline', { session_id: '44444444-4444-4444-8444-444444444444' }],
    ['get_session_timeline', { session_id: SESSIONS.S1, after_seq: -1 }],
  ];
  for (const [name, args] of cases) {
    const english = await call(en, name, args);
    const french = await call(fr, name, args);
    assert.equal(english.isError, true, `${name} ${JSON.stringify(Object.keys(args))}`);
    assert.equal(french.isError, true);
    assert.notEqual(english.content[0]?.text, french.content[0]?.text, `${name}: the French error is French`);
    assert.ok(!english.content[0]?.text.includes(SECRETS.github), 'the refused term is not repeated');
    assert.ok(!english.content[0]?.text.includes('⟦'));
  }
});

test('no answer of any tool holds a secret of the fixture', async () => {
  const answers = [
    await call(en, 'search_sessions', {}),
    await call(en, 'search_events', { limit: 100 }),
    await call(en, 'get_session_timeline', { session_id: SESSIONS.S1 }),
    await call(en, 'get_session_timeline', { session_id: SESSIONS.S2 }),
  ];
  const text = JSON.stringify(answers);
  for (const [name, secret] of Object.entries(SECRETS)) assert.ok(!text.includes(secret), name);
});
