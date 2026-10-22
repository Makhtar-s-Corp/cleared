// Take over attaches the web terminal to the session's own harness (owner
// request of 2026-10-22 17:26), through the harness adapter: the adapter's
// interactive program runs in the session's container, a shell is the
// second choice, a harness the adapter cannot resume answers why, and Give
// back leaves the harness first, then resumes the session from its
// transcript, then tells it to carry on. On the fake adapter, wrapped with
// an interactive resume that records what it is asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { takeoverRoutes } from '../../src/flow/takeover.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import type { SessionAdapter, SessionId } from '../../src/session/contract.ts';
import { HumanSide } from '../../src/terminal/human.ts';
import { SHELL_COMMAND } from '../../src/terminal/container.ts';
import { terminalRoutes } from '../../src/terminal/routes.ts';
import { finished, permission, setup, started, text, until, type Setup } from '../flow/support.ts';
import { LocalContainer } from './support.ts';

const PROOF = 'b'.repeat(64);
const waits: readonly FakeStep[] = [started, ...text('a1', 'I will sort the entries.'), permission, { awaitMessage: true }, finished(0.4)];
const HARNESS_COMMAND = ['claude', '--resume'];

type Harness = Setup & { readonly base: string; readonly human: HumanSide; readonly container: LocalContainer; readonly session: SessionId; readonly order: string[]; close(): Promise<void> };

async function harness(options: { interactive?: boolean } = {}): Promise<Harness> {
  const t = await setup({ scripts: { author: waits } });
  const order: string[] = [];
  const fake = t.registry.sessionAdapters['claude-code'] as SessionAdapter;
  if (options.interactive !== false) {
    const wrapped: SessionAdapter = {
      harness: fake.harness,
      start: (input) => fake.start(input),
      resume: (id) => { order.push('resume'); return fake.resume(id); },
      interactive: async (id) => { order.push('interactive'); return { supported: true, name: 'Claude Code', command: [...HARNESS_COMMAND, id] }; },
    };
    (t.registry.sessionAdapters as Record<string, SessionAdapter>)['claude-code'] = wrapped;
  }
  const root = mkdtempSync(join(tmpdir(), 'cleared-harness-'));
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
  const taken = await fetch(`${base}/api/sessions/${session}/takeover`, { method: 'POST', headers: as('u1') });
  assert.equal(taken.status, 200);
  await t.engine.settled();
  return {
    ...t, base, human, container, session, order,
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

async function post(h: Harness, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${h.base}${path}`, { method: 'POST', headers: as('u1'), body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  return { status: response.status, json: raw ? JSON.parse(raw) : {} };
}

const opened = (h: Harness) => h.store.events.after(h.session).flatMap(({ event }) =>
  event.type === 'CUSTOM' && event.name === 'cleared.terminal_opened' ? [event.value] : []);

// What the terminal's stream gives first: its own line.
async function firstLine(h: Harness): Promise<string> {
  let first = '';
  const leave = h.human.terminals.stream(h.session, 0, (event) => { if (event.kind === 'data' && !first) first = event.chunk.data; });
  leave?.();
  return first;
}

test('Take over opens the session\'s harness by default, through the adapter; Shell opens a shell instead, one at a time', async () => {
  const h = await harness();
  try {
    const harnessOpen = await post(h, `/api/sessions/${h.session}/terminal/open`, { cols: 100, rows: 30 });
    assert.deepEqual(harnessOpen, { status: 200, json: { opened: true, cols: 100, rows: 30, mode: 'harness', name: 'Claude Code' } });
    assert.deepEqual(h.container.terminals[0]?.command, [...HARNESS_COMMAND, h.session], 'the adapter\'s program, in the session\'s container');
    assert.deepEqual(h.order, ['interactive']);
    assert.deepEqual(opened(h).at(-1), { by: 'u1', cols: 100, rows: 30, mode: 'harness' });
    const line = await firstLine(h);
    assert.match(line, /Claude Code, resumed on this session/);
    assert.doesNotMatch(line, /docker exec|on the server/);

    // One terminal at a time: the second open says which one is open, so a reloaded page attaches to it.
    assert.deepEqual(await post(h, `/api/sessions/${h.session}/terminal/open`, { cols: 100, rows: 30, mode: 'shell' }),
      { status: 409, json: { error: 'a terminal is already open for this session: one at a time', mode: 'harness' } });

    // Shell: the harness's terminal closed, then a shell in the same container.
    assert.equal((await post(h, `/api/sessions/${h.session}/terminal/close`)).status, 200);
    assert.equal(h.container.terminals[0]?.ended, 1, 'the harness left before the shell opened');
    const shell = await post(h, `/api/sessions/${h.session}/terminal/open`, { cols: 100, rows: 30, mode: 'shell' });
    assert.deepEqual(shell, { status: 200, json: { opened: true, cols: 100, rows: 30, mode: 'shell' } });
    assert.deepEqual(h.container.terminals[1]?.command, [...SHELL_COMMAND]);
    assert.match(await firstLine(h), /A shell in the session's container/);
    assert.doesNotMatch(await firstLine(h), /docker exec|on the server|claude --resume/);
    assert.deepEqual(h.order, ['interactive'], 'a shell asks nothing of the adapter');
    assert.equal((await post(h, `/api/sessions/${h.session}/terminal/close`)).status, 200);
    assert.equal((await post(h, `/api/sessions/${h.session}/terminal/open`, { cols: 100, rows: 30, mode: 'root' })).status, 400, 'a mode that is not one');
  } finally {
    await h.close();
  }
});

test('a harness the adapter cannot resume answers 501 with its reason, and opens nothing; the Shell still opens', async () => {
  const h = await harness({ interactive: false });
  try {
    const refused = await post(h, `/api/sessions/${h.session}/terminal/open`, { cols: 80, rows: 24 });
    assert.equal(refused.status, 501);
    // The flow's scripted adapter has no interactive resume, as Codex and Cursor until theirs come.
    assert.equal(refused.json.error, 'The claude-code harness cannot be resumed in a terminal yet: open the Shell instead.');
    assert.equal(h.container.terminals.length, 0);
    assert.equal(opened(h).length, 0);
    assert.equal((await post(h, `/api/sessions/${h.session}/terminal/open`, { cols: 80, rows: 24, mode: 'shell' })).status, 200);
  } finally {
    await h.close();
  }
});

test('Give back: the harness leaves first, then the session resumes from its transcript, then it is told to carry on', async () => {
  const h = await harness();
  try {
    await post(h, `/api/sessions/${h.session}/terminal/open`, { cols: 80, rows: 24 });
    h.container.terminals[0]!.onEnd = () => h.order.push('harness left');
    await post(h, `/api/sessions/${h.session}/terminal/input`, { data: 'add a test for the empty week\r' });
    assert.equal((await post(h, `/api/sessions/${h.session}/giveback`)).status, 200);
    assert.deepEqual(h.order, ['interactive', 'harness left', 'resume']);
    const all = h.store.events.after(h.session);
    const closedAt = all.findIndex(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.terminal_closed');
    const toldAt = all.findIndex(({ event }) => event.type === 'TEXT_MESSAGE_CONTENT' && /gave the session back/.test(event.delta));
    assert.ok(closedAt >= 0 && toldAt > closedAt, 'closed, resumed, then told');
    assert.equal(h.engine.takenOver(h.session), undefined);
    // What the human typed to the harness is journaled as any terminal line.
    assert.ok(all.some(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.terminal_input' && (event.value as { line: string }).line === 'add a test for the empty week'));
  } finally {
    await h.close();
  }
});

test('a Give back while the terminal is opening leaves no harness behind (issue 226, item 1)', async () => {
  const h = await harness();
  try {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.container.hold = () => held;
    const opening = post(h, `/api/sessions/${h.session}/terminal/open`, { cols: 80, rows: 24 });
    await until(() => h.order.includes('interactive'), 'the open asked the adapter');
    assert.equal((await post(h, `/api/sessions/${h.session}/giveback`)).status, 200);
    release();
    const answer = await opening;
    assert.equal(answer.status, 409);
    assert.match(String(answer.json.error), /given back/);
    assert.equal(h.container.terminals[0]?.ended, 1, 'the harness that started is ended at once');
    assert.equal(h.human.terminals.openBy(h.session), undefined);
  } finally {
    await h.close();
  }
});
