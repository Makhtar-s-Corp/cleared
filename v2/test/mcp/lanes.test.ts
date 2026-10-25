// The lanes' MCP tools (P216): a local Claude Code asks the service which
// lanes run, which tickets are open and which files a session holds, before
// it edits. Read over a scripted engine (test/flow/support.ts), through the
// tool server's own handle; the HTTP side is lanes-http.test.ts's.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { createLanesServer, type LanesDeps } from '../../src/mcp/lanes.ts';
import { createRedactor } from '../../src/mcp/redact.ts';
import { finished, permission, setup, started, until, type Setup } from '../flow/support.ts';

type Answer = { result?: Record<string, unknown> & { structuredContent?: Record<string, unknown>; isError?: boolean; content?: { text: string }[] }; error?: { code: number; message: string } };
type Lane = { ticket: string; title: string; status: string; running: boolean; startedAt: string; runningFor: string; sessions: { sessionId: string; role: string; phase: string; for: string }[] };
type Held = { path: string; service: string | null; ticket: string; title: string; sessionId: string; role: string; why: string[]; since: string; heldFor: string };

const edit = (id: string, path: string): FakeStep[] => [
  { emit: { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'Edit' } },
  { emit: { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify({ kind: 'edit', path, added: 3, removed: 1 }) } },
];
const plan = (files: string[]): FakeStep => ({
  emit: { type: 'CUSTOM', name: 'cleared.session_plan', value: { steps: ['Sort the entries'], files, confidence: 'high', reason: 'One function.', proposedAt: '2026-10-21T10:00:00.000Z', go: { by: 'delay', at: '2026-10-21T10:00:00.000Z' } } },
});
// An author that edits a file, says it plans another, then waits for a person.
const holding: readonly FakeStep[] = [started, plan(['src/view.ts', 'src/entries.ts']), ...edit('e1', '/workspace/src/entries.ts'), permission, { awaitMessage: true }];

function serverOf(t: Setup, overrides: Partial<LanesDeps> = {}) {
  let id = 0;
  const server = createLanesServer({ engine: t.engine, store: t.store, redactor: createRedactor({ env: {}, paths: [] }), language: 'en', now: () => new Date(t.clock.now), ...overrides });
  const call = async (name: string, args: Record<string, unknown> = {}) => await server.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) as Answer;
  const content = async (name: string, args: Record<string, unknown> = {}) => {
    const answer = await call(name, args);
    assert.equal(answer.result?.isError, undefined, JSON.stringify(answer));
    return answer.result?.structuredContent as Record<string, unknown>;
  };
  return { server, call, content };
}

async function holdingLane() {
  const t = await setup({ scripts: { author: holding }, eventClock: true });
  await t.engine.start(t.ticket.id, 'u1');
  const id = t.startedSessions[0]!.id;
  await until(() => t.inbox.waitingFor(id) === 1, 'the author waiting for a person');
  return { t, id };
}

test('initialize names the server and says what it is for, in English and in French; every tool only reads', async () => {
  const t = await setup();
  const en = serverOf(t).server;
  const fr = serverOf(t, { language: 'fr' }).server;
  const init = async (server: typeof en) => (await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }) as Answer).result as { protocolVersion: string; serverInfo: { name: string }; instructions: string; capabilities: Record<string, unknown> };
  const a = await init(en);
  const b = await init(fr);
  assert.equal(a.protocolVersion, '2025-06-18');
  assert.equal(a.serverInfo.name, 'cleared-lanes');
  assert.deepEqual(a.capabilities, { tools: {} });
  assert.match(a.instructions, /before (you )?edit/i);
  assert.match(b.instructions, /avant de modifier/i);
  const list = (await en.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as Answer).result as { tools: { name: string; description: string; annotations: Record<string, boolean>; inputSchema: { additionalProperties: boolean } }[] };
  assert.deepEqual(list.tools.map((tool) => tool.name), ['list_lanes', 'list_tickets', 'locked_files']);
  for (const tool of list.tools) {
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, tool.name);
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
    assert.ok(tool.description.trim(), tool.name);
  }
  const frList = (await fr.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) as Answer).result as { tools: { description: string }[] };
  assert.notEqual(frList.tools[0]?.description, list.tools[0]?.description, 'the French descriptions are French');
  assert.equal(await en.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
});

test('a running author is a lane: its ticket, its status, and how long it has run, said as the app says it', async () => {
  const { t, id } = await holdingLane();
  t.clock.now += 90 * 60_000;
  const { lanes } = await serverOf(t).content('list_lanes') as { lanes: Lane[] };
  assert.equal(lanes.length, 1);
  const lane = lanes[0] as Lane;
  assert.equal(lane.ticket, t.ticket.id);
  assert.equal(lane.title, 'Newest entry first');
  assert.equal(lane.status, 'In Progress');
  assert.equal(lane.running, true);
  assert.equal(lane.startedAt, '2026-10-21T10:00:00.000Z');
  assert.equal(lane.runningFor, '1h 30m');
  assert.deepEqual(lane.sessions.map((s) => [s.sessionId, s.role, s.phase]), [[id, 'author', 'waiting_human']]);
  const fr = await serverOf(t, { language: 'fr' }).content('list_lanes') as { lanes: Lane[] };
  assert.equal(fr.lanes[0]?.runningFor, '1 h 30');
});

test('a file is held by the session that edited it or planned to, from the checkout\'s root; a folder finds the files under it', async () => {
  const { t, id } = await holdingLane();
  const { content } = serverOf(t);
  const all = await content('locked_files') as { locked: boolean; files: Held[] };
  assert.equal(all.locked, true);
  assert.deepEqual(all.files.map((f) => [f.path, f.why]).sort(), [['src/entries.ts', ['edited', 'planned']], ['src/view.ts', ['planned']]]);
  for (const file of all.files) {
    assert.equal(file.ticket, t.ticket.id);
    assert.equal(file.title, 'Newest entry first');
    assert.equal(file.sessionId, id);
    assert.equal(file.role, 'author');
    assert.equal(file.since, '2026-10-21T10:00:00.000Z');
  }
  const one = await content('locked_files', { path: 'src/entries.ts' }) as { locked: boolean; files: Held[] };
  assert.deepEqual(one.files.map((f) => f.path), ['src/entries.ts']);
  const dotted = await content('locked_files', { path: './src/entries.ts' }) as { files: Held[] };
  assert.deepEqual(dotted.files.map((f) => f.path), ['src/entries.ts']);
  const folder = await content('locked_files', { path: 'src/' }) as { files: Held[] };
  assert.equal(folder.files.length, 2);
  const free = await content('locked_files', { path: 'README.md' }) as { locked: boolean; files: Held[] };
  assert.deepEqual(free, { locked: false, files: [] });
  const prefix = await content('locked_files', { path: 'src/entr' }) as { files: Held[] };
  assert.deepEqual(prefix.files, [], 'a folder is matched whole, never a piece of a name');
  t.clock.now += 5 * 60_000;
  const later = await content('locked_files', { path: 'src/view.ts' }) as { files: Held[] };
  assert.equal(later.files[0]?.heldFor, '5 min');
});

test('the files stay held while the pull request waits, and are let go once the ticket is done', async () => {
  const t = await setup({ scripts: { author: [started, plan(['src/entries.ts']), ...edit('e1', '/workspace/src/entries.ts'), finished(0.3)] }, eventClock: true });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.list().some((i) => i.kind === 'release' && i.state === 'waiting'), 'the release item', 5000);
  await t.engine.settled();
  // The flow is over once the release waits for a person; its branch is not merged.
  assert.equal(t.engine.isActive(t.ticket.id), false);
  const { content } = serverOf(t);
  const waiting = await content('locked_files', { path: 'src/entries.ts' }) as { locked: boolean; files: Held[] };
  assert.equal(waiting.locked, true, 'the pull request still holds the edit');
  const lanes = await content('list_lanes') as { lanes: Lane[] };
  assert.equal(lanes.lanes[0]?.running, false);
  assert.equal(lanes.lanes[0]?.status, (await t.tickets.get(t.ticket.id))?.status);
  assert.deepEqual(lanes.lanes[0]?.sessions.map((s) => s.role).sort(), ['author', 'reviewer']);
  await t.tickets.move(t.ticket.id, t.tickets.states.done, { kind: 'agents', id: 'cleared' });
  assert.deepEqual(await content('locked_files'), { locked: false, files: [] });
  assert.deepEqual(await content('list_lanes'), { lanes: [] });
});

test('a ticket put back and started again holds only what its new flow touched', async () => {
  const first: FakeStep[] = [started, ...edit('e1', 'src/old.ts'), finished(0.2)];
  const t = await setup({ scripts: { authors: [first, [started, ...edit('e2', 'src/new.ts'), permission, { awaitMessage: true }]] }, eventClock: true });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.startedSessions.some((s) => s.input.role === 'reviewer'), 'the first review');
  await t.engine.setAside(t.ticket.id, 'u1');
  await until(async () => (await t.tickets.get(t.ticket.id))?.status === t.tickets.states.todo, 'the ticket back in Todo');
  const { content } = serverOf(t);
  assert.deepEqual(await content('locked_files'), { locked: false, files: [] }, 'a ticket in Todo holds nothing');
  t.clock.now += 60_000;
  await t.engine.start(t.ticket.id, 'u1');
  const second = () => t.startedSessions.filter((s) => s.input.role === 'author').at(-1)!.id;
  await until(() => t.startedSessions.filter((s) => s.input.role === 'author').length === 2 && t.inbox.waitingFor(second()) === 1, 'the second author waiting');
  const held = await content('locked_files') as { files: Held[] };
  assert.deepEqual(held.files.map((f) => f.path), ['src/new.ts']);
});

test('list_tickets gives the open tickets with their status, labels and whether a flow runs; never a body, and Done only when asked', async () => {
  const { t } = await holdingLane();
  const other = await t.tickets.create({ title: 'Show the date', body: 'A body the tools never show.', labels: ['type:bug'], project: 'guestbook' }, { kind: 'human', id: 'u1' });
  const done = await t.tickets.create({ title: 'Old work', project: 'guestbook' }, { kind: 'human', id: 'u1' });
  await t.tickets.move(done.id, t.tickets.states.done, { kind: 'human', id: 'u1' });
  const { content } = serverOf(t);
  const open = await content('list_tickets') as { tickets: { ticket: string; title: string; status: string; labels: string[]; running: boolean }[]; more: number };
  assert.deepEqual(open.tickets.map((x) => x.ticket).sort(), [t.ticket.id, other.id].sort());
  assert.equal(open.more, 0);
  const bug = open.tickets.find((x) => x.ticket === other.id);
  assert.deepEqual(bug && { status: bug.status, labels: bug.labels, running: bug.running }, { status: 'Todo', labels: ['type:bug'], running: false });
  assert.equal(open.tickets.find((x) => x.ticket === t.ticket.id)?.running, true);
  assert.doesNotMatch(JSON.stringify(open), /never show|newest first\./i);
  const asked = await content('list_tickets', { status: 'Done' }) as { tickets: { ticket: string }[] };
  assert.deepEqual(asked.tickets.map((x) => x.ticket), [done.id]);
});

test('every string goes through the cleaner: a token in a title is removed', async () => {
  const t = await setup();
  const token = ['gh', 'p_', 'Z'.repeat(36)].join('');
  await t.tickets.create({ title: `Rotate ${token} today`, project: 'guestbook' }, { kind: 'human', id: 'u1' });
  const answer = await serverOf(t).call('list_tickets');
  const text = JSON.stringify(answer);
  assert.ok(!text.includes(token), 'the token is not in the answer');
  assert.match(text, /\[removed: GitHub token\]/);
});

test('a path outside the checkout, an unknown argument or a wrong type is refused, in the server\'s language', async () => {
  const t = await setup();
  const en = serverOf(t);
  const fr = serverOf(t, { language: 'fr' });
  for (const path of ['../secret', '/etc/passwd', 'src/../../x', '']) {
    const answer = await en.call('locked_files', { path });
    assert.equal(answer.result?.isError, true, path);
    assert.match(answer.result?.content?.[0]?.text ?? '', /path/i, path);
  }
  const frAnswer = await fr.call('locked_files', { path: '../x' });
  assert.match(frAnswer.result?.content?.[0]?.text ?? '', /chemin/i);
  assert.equal((await en.call('locked_files', { file: 'a' })).result?.isError, true);
  assert.equal((await en.call('locked_files', { path: 3 })).result?.isError, true);
  assert.equal((await en.call('list_lanes', { ticket: 'LOCAL-1' })).result?.isError, true);
  assert.equal((await en.call('drop_lanes')).error?.code, -32602);
});

test('the tools only read: no row of the ledger changes, whatever is called', async () => {
  const { t } = await holdingLane();
  const tables = (t.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  const counts = () => Object.fromEntries(tables.map((name) => [name, (t.store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n]));
  const before = counts();
  const tickets = JSON.stringify(await t.tickets.list());
  const { content, call } = serverOf(t);
  await content('list_lanes');
  await content('list_tickets');
  await content('list_tickets', { status: 'Done' });
  await content('locked_files');
  await content('locked_files', { path: 'src/entries.ts' });
  await call('locked_files', { path: '../x' });
  assert.deepEqual(counts(), before);
  assert.equal(JSON.stringify(await t.tickets.list()), tickets);
});

test('with no engine, the tools say the flow is not set up', async () => {
  const t = await setup();
  const { call } = serverOf(t, { engine: undefined });
  const answer = await call('list_lanes');
  assert.equal(answer.result?.isError, true);
  assert.match(answer.result?.content?.[0]?.text ?? '', /CLEARED_V2_PROJECT/);
});
