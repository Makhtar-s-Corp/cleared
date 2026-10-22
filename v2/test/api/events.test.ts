// The change stream (api/events.ts, lane 34): a ticket's event, an inbox
// write and a session's state change each say one thin event, with no
// payload; the stream needs the app's proof, resumes from Last-Event-ID,
// keeps itself open with a comment, and lets go of the session watchers
// when its last client leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChangeHub, KEEPALIVE_MS } from '../../src/api/events.ts';
import { createApiRoutes } from '../../src/api/routes.ts';
import { SERVICE_PROOF_HEADER, type ChangeEvent } from '../../src/api/types.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { authorScript, quickAuthor, setup, until } from '../flow/support.ts';

const PROOF = 'c'.repeat(64);

const parse = (frame: string): { id: number; event: ChangeEvent } => {
  const id = Number(/^id: (\d+)$/m.exec(frame)?.[1]);
  assert.match(frame, /^event: change$/m);
  return { id, event: JSON.parse(/^data: (.*)$/m.exec(frame)?.[1] ?? 'null') as ChangeEvent };
};

const listen = (hub: ChangeHub, after?: number) => {
  const seen: { id: number; event: ChangeEvent }[] = [];
  const leave = hub.join((frame) => seen.push(parse(frame)), after);
  return { seen, leave };
};

test('a ticket\'s event says the ticket and its session, with nothing but kind, id and time', async () => {
  const t = await setup({ scripts: { author: quickAuthor } });
  const hub = new ChangeHub(t.engine, { settleMs: 5 });
  const { seen, leave } = listen(hub);
  try {
    await t.engine.begin(t.ticket.id, 'u1');
    await until(() => seen.some((s) => s.event.kind === 'ticket' && s.event.id === t.ticket.id), 'the ticket\'s change');
    const session = t.startedSessions[0]!.id;
    await until(() => seen.some((s) => s.event.kind === 'session' && s.event.id === session), 'the session\'s change');
    for (const { event } of seen) {
      assert.deepEqual(Object.keys(event).sort(), ['at', 'id', 'kind']);
      assert.ok(['ticket', 'session', 'inbox'].includes(event.kind), event.kind);
    }
    assert.deepEqual(seen.map((s) => s.id), seen.map((_, i) => i + 1), 'numbered from 1, in order');
  } finally {
    leave();
  }
});

test('an inbox write says "inbox" once, and a burst of writes in one turn once too', async () => {
  const t = await setup();
  const hub = new ChangeHub(t.engine, { settleMs: 5 });
  const { seen, leave } = listen(hub);
  try {
    const base = { ticket: 'LOCAL-1', project: 'guestbook', tool: 'Bash', input: { kind: 'execute' as const, command: 'npm test' }, suggestion: { decision: 'ask' as const, rule: 'default', reason: 'x' } };
    t.inbox.addPermission({ ...base, sessionId: 's1', requestId: 'r1' });
    await until(() => seen.length === 1, 'the inbox\'s change');
    assert.deepEqual({ kind: seen[0]!.event.kind, id: seen[0]!.event.id }, { kind: 'inbox', id: null });
    t.inbox.addPermission({ ...base, sessionId: 's1', requestId: 'r2' });
    t.inbox.handle('permission:s1:r2', 'u1');
    await until(() => seen.length === 2, 'the second change');
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(seen.length, 2, 'two writes of one turn, one event');
    t.inbox.handle('permission:s1:r2', 'u1');            // already handled: nothing written
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(seen.length, 2, 'a write that changes nothing says nothing');
  } finally {
    leave();
  }
});

test('a session\'s state change says the session once its burst settled', async () => {
  const t = await setup({ scripts: { author: authorScript } });
  const hub = new ChangeHub(t.engine, { settleMs: 5 });
  const { seen, leave } = listen(hub);
  try {
    await t.engine.begin(t.ticket.id, 'u1');
    await until(() => t.inbox.list().some((i) => i.kind === 'permission'), 'the permission');
    const session = t.startedSessions[0]!.id;
    await until(() => t.engine.sessionDetail(session)?.phase === 'waiting_human', 'the session waits');
    await until(() => seen.some((s) => s.event.kind === 'session' && s.event.id === session), 'the session\'s change');
    const before = seen.filter((s) => s.event.kind === 'session').length;
    await t.engine.answer(session, t.inbox.list().find((i) => i.kind === 'permission')!.requestId, { kind: 'allow_once' }, 'u1');
    await until(() => seen.filter((s) => s.event.kind === 'session').length > before, 'the change after the answer');
  } finally {
    leave();
  }
});

test('Last-Event-ID replays what was said after it; the last client to leave lets the sessions go', async () => {
  const t = await setup({ scripts: { author: authorScript } });
  const hub = new ChangeHub(t.engine, { settleMs: 5 });
  const first = listen(hub);
  await t.engine.begin(t.ticket.id, 'u1');
  await until(() => first.seen.length >= 3, 'three changes');
  const session = t.startedSessions[0]!.id;
  const second = listen(hub, 1);
  assert.deepEqual(second.seen.map((s) => s.id), first.seen.slice(1).map((s) => s.id));
  assert.ok(t.engine.watchers(session) >= 1, 'the live session is watched');
  first.leave();
  assert.equal(hub.listening, 1);
  second.leave();
  assert.equal(hub.listening, 0);
  await until(() => t.engine.watchers(session) === 0, 'the watcher released');
});

test('GET /api/events: the app\'s proof first, then a stream that opens with a comment and carries the changes', async () => {
  assert.equal(KEEPALIVE_MS, 20_000, 'a comment every 20 seconds');
  const t = await setup();
  const app: App = { registry: t.engine.registry, tables: [], routes: createApiRoutes({ engine: () => t.engine, proof: () => PROOF }) };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const controller = new AbortController();
  try {
    assert.equal((await fetch(`${base}/api/events`)).status, 401, 'no proof, no stream');
    const response = await fetch(`${base}/api/events`, { headers: { [SERVICE_PROOF_HEADER]: PROOF }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const read = async (until_: (text: string) => boolean) => {
      while (!until_(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    };
    await read((s) => s.includes(': stream open'));
    t.inbox.addPermission({ ticket: 'LOCAL-1', project: 'guestbook', sessionId: 's1', requestId: 'r1', tool: 'Bash', input: { kind: 'execute', command: 'ls' }, suggestion: { decision: 'ask', rule: 'default', reason: 'x' } });
    await read((s) => s.includes('event: change'));
    const frame = text.slice(text.indexOf('id: '));
    assert.equal(parse(frame).event.kind, 'inbox');
    assert.doesNotMatch(frame, /permission|LOCAL-1|ls/, 'no payload');
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// A stand-in engine whose one session's journal the test writes, with no
// event on the flow's bus: only the watcher can tell.
function quietEngine(role: string) {
  let status = 'Reading the diff';
  const wakes = new Set<() => void>();
  const detail = () => ({ id: 's-lead', role, phase: 'working', status, lastSeq: Math.random(), updatedAt: new Date().toISOString() });
  const engine = {
    subscribe: () => () => {},
    inbox: { onChange: () => () => {} },
    sessions: () => [detail()],
    sessionDetail: () => detail(),
    watch: () => {
      let wake = () => {};
      const entry = () => wake();
      wakes.add(entry);
      return {
        wait: (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); wake = () => { clearTimeout(timer); resolve(); }; }),
        close: () => { wake(); wakes.delete(entry); },
      };
    },
  };
  return { engine, write: (next: string) => { status = next; for (const wake of wakes) wake(); }, wakes };
}

test('a session\'s journal alone says the session when its summary changed, and a lead session says "lead" too', async () => {
  const quiet = quietEngine('lead');
  const hub = new ChangeHub(quiet.engine as never, { settleMs: 5 });
  const { seen, leave } = listen(hub);
  try {
    await until(() => quiet.wakes.size === 1, 'the session watched');
    quiet.write('Reading the diff');                       // the same summary: a new seq, nothing said
    await new Promise((done) => setTimeout(done, 30));
    assert.equal(seen.length, 0);
    quiet.write('Running the tests');
    await until(() => seen.length === 2, 'the session\'s and the lead\'s change');
    assert.deepEqual(seen.map((s) => [s.event.kind, s.event.id]).sort(), [['lead', null], ['session', 's-lead']]);
  } finally {
    leave();
  }
  assert.equal(quiet.wakes.size, 0, 'released with the last client');
});
