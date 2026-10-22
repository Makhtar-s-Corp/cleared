// The web terminal of a session taken over (docs/v2/milestone-2-plan.md,
// decision 32, lane 31), through its routes, on the fake adapter: the
// checks (the proof, a person who took the session over, one terminal at a
// time), the input journaled line by line through the cleaner, the output
// streamed and never journaled, the idle close that leaves the session
// paused, and no host tool of the lead or of an author naming a terminal or
// a file write route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER, TERMINAL_INPUT_MAX_BYTES } from '../../src/api/types.ts';
import { AUTHOR_TOOLS } from '../../src/flow/author-tools.ts';
import { takeoverRoutes } from '../../src/flow/takeover.ts';
import { LEAD_TOOLS } from '../../src/lead/contract.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionId } from '../../src/session/contract.ts';
import { HumanSide } from '../../src/terminal/human.ts';
import { terminalRoutes } from '../../src/terminal/routes.ts';
import { finished, permission, setup, started, text, until, type Setup } from '../flow/support.ts';
import { LocalContainer } from './support.ts';

const PROOF = 'a'.repeat(64);
const waits: readonly FakeStep[] = [started, ...text('a1', 'I will sort the entries.'), permission, { awaitMessage: true }, finished(0.4)];

type Harness = Setup & { readonly base: string; readonly human: HumanSide; readonly container: LocalContainer; readonly session: SessionId; close(): Promise<void> };

async function harness(options: { takeOver?: boolean } = {}): Promise<Harness> {
  const t = await setup({ scripts: { author: waits } });
  t.users.users.set('u2', { id: 'u2', name: 'Second' });
  t.users.users.set('cleared', { id: 'cleared', name: 'Cleared' });
  t.users.users.set('lead', { id: 'lead', name: 'Lead' });
  const root = mkdtempSync(join(tmpdir(), 'cleared-terminal-'));
  const container = new LocalContainer(root);
  container.answer = () => ({ code: 1, stdout: '', stderr: 'no git here' });
  const human = new HumanSide({ engine: t.engine, store: t.store, container, now: () => new Date(t.clock.now), env: {} });
  const deps = { engine: () => t.engine, proof: () => PROOF, human: () => human };
  const app: App = { registry: t.engine.registry, tables: [], routes: [...terminalRoutes(deps), ...takeoverRoutes(deps)] };
  const server: Server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.inbox.waitingFor(t.startedSessions[0]?.id ?? '') > 0, 'the permission');
  await t.engine.settled();
  const session = t.startedSessions[0]!.id;
  if (options.takeOver !== false) {
    const taken = await fetch(`${base}/api/sessions/${session}/takeover`, { method: 'POST', headers: as('u1') });
    assert.equal(taken.status, 200);
    await t.engine.settled();
  }
  return {
    ...t, base, human, container, session,
    async close() {
      await human.terminals.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await t.engine.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const as = (user: string) => ({ [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: user, 'content-type': 'application/json' });

async function post(h: Harness, path: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${h.base}${path}`, { method: 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

const terminalEvents = (h: Harness) => h.store.events.after(h.session).flatMap(({ event }) =>
  event.type === 'CUSTOM' && event.name.startsWith('cleared.terminal_') ? [{ name: event.name, value: event.value as Record<string, unknown> }] : []);

test('the terminal routes ask for the proof, a person who took the session over, a session taken over, and one terminal at a time', async () => {
  const h = await harness({ takeOver: false });
  try {
    const routes = ['open', 'input', 'resize', 'close'].map((name) => `/api/sessions/${h.session}/terminal/${name}`);
    for (const path of routes) {
      assert.equal((await post(h, path, { [SERVICE_USER_HEADER]: 'u1' })).status, 401, `${path} without the proof`);
      assert.equal((await post(h, path, as('ghost'))).status, 403, `${path} for an unknown user`);
      assert.equal((await post(h, path, as('cleared'))).status, 403, `${path} for the flow's identity`);
      assert.equal((await post(h, path, as('lead'))).status, 403, `${path} for the lead`);
      assert.equal((await post(h, path, as('u1'), { cols: 80, rows: 24 })).status, 409, `${path} on a session not taken over`);
    }
    assert.equal((await fetch(`${h.base}/api/sessions/${h.session}/terminal/stream`, { headers: { [SERVICE_USER_HEADER]: 'u1' } })).status, 401, 'the stream without the proof');
    assert.equal((await post(h, '/api/sessions/none/terminal/open', as('u1'), { cols: 80, rows: 24 })).status, 404);

    assert.equal((await post(h, `/api/sessions/${h.session}/takeover`, as('u1'))).status, 200);
    await h.engine.settled();
    assert.equal((await post(h, `/api/sessions/${h.session}/terminal/open`, as('u2'), { cols: 80, rows: 24 })).status, 403, 'another signed-in account');
    assert.equal((await post(h, `/api/sessions/${h.session}/terminal/open`, as('u1'), { cols: 0, rows: 24 })).status, 400, 'a size that is not one');
    const opened = await post(h, `/api/sessions/${h.session}/terminal/open`, as('u1'), { cols: 100, rows: 30 });
    assert.deepEqual(opened, { status: 200, json: { opened: true, cols: 100, rows: 30, resume: `claude --resume ${h.session}` } });
    assert.deepEqual(h.container.terminals[0]?.sizes, [{ cols: 100, rows: 30 }]);
    assert.equal((await post(h, `/api/sessions/${h.session}/terminal/open`, as('u1'), { cols: 100, rows: 30 })).status, 409, 'a second open');
    assert.equal(h.container.terminals.length, 1);
    assert.equal((await post(h, `/api/sessions/${h.session}/terminal/input`, as('u1'), { data: 'x'.repeat(TERMINAL_INPUT_MAX_BYTES + 1) })).status, 413);
    assert.deepEqual(await post(h, `/api/sessions/${h.session}/terminal/resize`, as('u1'), { cols: 120, rows: 40 }), { status: 200, json: { accepted: true } });
    assert.deepEqual(h.container.terminals[0]?.sizes.at(-1), { cols: 120, rows: 40 });
    assert.deepEqual(terminalEvents(h)[0], { name: 'cleared.terminal_opened', value: { by: 'u1', cols: 100, rows: 30 } });
  } finally {
    await h.close();
  }
});

test('a typed line reaches the shell\'s input and the journal once, cleaned as a whole even when typed in three posts; the output is never journaled', async () => {
  const h = await harness();
  try {
    await post(h, `/api/sessions/${h.session}/terminal/open`, as('u1'), { cols: 80, rows: 24 });
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    for (const data of ['export KEY=sk-ant-ap', 'i03-abcdefghijklmnopq', 'rstuvwxyz0123456789']) {
      assert.equal((await post(h, `/api/sessions/${h.session}/terminal/input`, as('u1'), { data })).status, 200);
    }
    assert.deepEqual(terminalEvents(h).filter((e) => e.name === 'cleared.terminal_input'), [], 'nothing before the Enter');
    await post(h, `/api/sessions/${h.session}/terminal/input`, as('u1'), { data: '\r' });
    await post(h, `/api/sessions/${h.session}/terminal/input`, as('u1'), { data: 'pwd\r' });
    const terminal = h.container.terminals[0]!;
    assert.equal(terminal.written.join(''), `export KEY=${secret}\rpwd\r`, 'every key reached the shell\'s input');
    const lines = terminalEvents(h).filter((e) => e.name === 'cleared.terminal_input').map((e) => e.value);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]?.by, 'u1');
    assert.match(String(lines[0]?.line), /^export KEY=\[removed: API key\]$/, 'masked once, as a whole line');
    assert.deepEqual(lines[1], { by: 'u1', line: 'pwd' });

    terminal.print('/workspace\r\nsecret file content\r\n');
    terminal.print(Buffer.from([0xc3]));       // half of an é, then the rest
    terminal.print(Buffer.from([0xa9, 0x0a]));
    await post(h, `/api/sessions/${h.session}/terminal/input`, as('u1'), { data: 'cat notes' });
    assert.deepEqual(await post(h, `/api/sessions/${h.session}/terminal/close`, as('u1')), { status: 200, json: { accepted: true } });
    assert.equal(terminal.ended, 1, 'the shell was ended');
    const events = terminalEvents(h);
    assert.deepEqual(events.at(-2), { name: 'cleared.terminal_input', value: { by: 'u1', line: 'cat notes' } }, 'the rest at the close');
    assert.deepEqual(events.at(-1), { name: 'cleared.terminal_closed', value: { by: 'u1', reason: 'closed', outputBytes: Buffer.byteLength('/workspace\r\nsecret file content\r\n') + 3 } });
    const stored = JSON.stringify(h.store.events.after(h.session));
    assert.ok(!stored.includes('secret file content') && !stored.includes(secret), 'neither the output nor the secret is stored');
    assert.equal((await post(h, `/api/sessions/${h.session}/terminal/input`, as('u1'), { data: 'ls\r' })).status, 409, 'closed');
  } finally {
    await h.close();
  }
});

function stream(h: Harness, headers: Record<string, string> = {}): Promise<{ status: number; frames: () => string; done: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${h.base}/api/sessions/${h.session}/terminal/stream`, { headers: { ...as('u1'), ...headers } }, (response) => {
      let text = '';
      const done = new Promise<void>((end) => response.on('end', end));
      response.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
      resolve({ status: response.statusCode ?? 0, frames: () => text, done });
    });
    request.on('error', reject);
    request.end();
  });
}

test('the stream sends the output in order, what a reconnection missed, then the close', async () => {
  const h = await harness();
  try {
    assert.equal((await stream(h)).status, 409, 'no terminal open');
    await post(h, `/api/sessions/${h.session}/terminal/open`, as('u1'), { cols: 80, rows: 24 });
    const terminal = h.container.terminals[0]!;
    terminal.print('one\r\n');
    const first = await stream(h);
    assert.equal(first.status, 200);
    await until(() => first.frames().includes('one'), 'the kept output');
    assert.match(first.frames(), /^id: 1\nevent: data\ndata: \{"seq":1,"data":".*claude --resume/m, 'the first line names the resume command');
    terminal.print('two\r\n');
    await until(() => first.frames().includes('two'), 'the live output');
    const again = await stream(h, { 'last-event-id': '2' });
    terminal.print('three\r\n');
    await until(() => again.frames().includes('three'), 'the output after the reconnection');
    assert.ok(!again.frames().includes('one') && !again.frames().includes('"seq":2'), 'only what came after the last id');
    await post(h, `/api/sessions/${h.session}/terminal/close`, as('u1'));
    await first.done;
    assert.match(first.frames(), /event: closed\ndata: \{"reason":"closed"\}\n\n$/);
  } finally {
    await h.close();
  }
});

test('15 minutes without input close the terminal, and the session stays paused; the shell\'s exit closes it too', async () => {
  const h = await harness();
  try {
    await post(h, `/api/sessions/${h.session}/terminal/open`, as('u1'), { cols: 80, rows: 24 });
    h.clock.now += 14 * 60_000;
    await post(h, `/api/sessions/${h.session}/terminal/input`, as('u1'), { data: 'ls\r' });
    h.clock.now += 14 * 60_000;
    await h.human.terminals.sweep();
    assert.equal(h.human.terminals.openBy(h.session), 'u1', 'input 14 minutes ago keeps it open');
    h.clock.now += 60_000;
    await h.human.terminals.sweep();
    assert.equal(h.human.terminals.openBy(h.session), undefined);
    assert.deepEqual(terminalEvents(h).at(-1), { name: 'cleared.terminal_closed', value: { by: 'system', reason: 'idle', outputBytes: 0 } });
    assert.equal(h.engine.takenOver(h.session)?.by, 'u1', 'still taken over');

    await post(h, `/api/sessions/${h.session}/terminal/open`, as('u1'), { cols: 80, rows: 24 });
    h.container.terminals[1]!.exit();
    await until(() => h.human.terminals.openBy(h.session) === undefined, 'the close at the exit');
    assert.equal((terminalEvents(h).at(-1)?.value as { reason: string }).reason, 'exit');
  } finally {
    await h.close();
  }
});

test('Give back closes the terminal before the session resumes', async () => {
  const h = await harness();
  try {
    await post(h, `/api/sessions/${h.session}/terminal/open`, as('u1'), { cols: 80, rows: 24 });
    await post(h, `/api/sessions/${h.session}/terminal/input`, as('u1'), { data: 'git status\r' });
    assert.equal((await post(h, `/api/sessions/${h.session}/giveback`, as('u1'))).status, 200);
    assert.equal(h.container.terminals[0]?.ended, 1);
    const closed = terminalEvents(h).at(-1);
    assert.deepEqual(closed, { name: 'cleared.terminal_closed', value: { by: 'u1', reason: 'give_back', outputBytes: 0 } });
    const all = h.store.events.after(h.session);
    const closedAt = all.findIndex(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.terminal_closed');
    const resumedAt = all.findIndex(({ event }) => event.type === 'TEXT_MESSAGE_CONTENT' && /gave the session back/.test(event.delta));
    assert.ok(closedAt >= 0 && resumedAt > closedAt, 'closed, then told it was given back');
  } finally {
    await h.close();
  }
});

test('no host tool of the lead or of an author names a terminal or a file write route', () => {
  const tools = [...LEAD_TOOLS, ...AUTHOR_TOOLS];
  assert.ok(tools.length >= 5, 'the tools were found');
  for (const tool of tools) {
    const text = JSON.stringify(tool).toLowerCase();
    assert.ok(!/terminal|takeover|take over|giveback|\/files|human_edit/.test(text), `${tool.name} names a terminal or a file route`);
  }
});
