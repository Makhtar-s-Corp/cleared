// CopilotKit as the page runs it: its headless core with the session's and
// the lead's agents, connected the way useThread connects them, while every
// way a page can send something is watched (fetch, XMLHttpRequest,
// WebSocket, EventSource, sendBeacon). The agents get the app's API and the
// stream from the test, so any request at all is CopilotKit's own: there
// must be none, to CopilotKit's hosts (Copilot Cloud, telemetry, its CDN)
// or anywhere else. The page's Content-Security-Policy (default-src 'self')
// would refuse such a request in a browser anyway; static.test.ts checks it.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'vitest';
import type { LeadMessage, LeadState } from '../../../src/api/types.ts';
import { sseFrame } from '../../../src/api/types.ts';
import { AUTHOR_ID, detailOf, sessionFixture } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { leadFixture } from '../../fixtures/lead.ts';
import { makeCopilot } from '../copilot/provider.tsx';
import type { ThreadAgent } from '../copilot/agent.ts';
import { isLeadThread, LEAD_AGENT, LeadAgent, type LeadThread } from '../screens/lead/agent.ts';
import { isSessionThread, SessionAgent, sessionAgentId } from '../screens/session/agent.ts';
import type { SessionThread, StreamLike } from '../screens/session/model.ts';

const sent: string[] = [];
const saved: Record<string, unknown> = {};
const WATCHED = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator'] as const;

beforeEach(() => {
  sent.length = 0;
  for (const name of WATCHED) saved[name] = (globalThis as Record<string, unknown>)[name];
  const record = (what: string) => (target: unknown) => { sent.push(`${what} ${String(target)}`); };
  Object.assign(globalThis, {
    fetch: async (input: unknown) => { record('fetch')(input instanceof Request ? input.url : input); return new Response('{}'); },
    XMLHttpRequest: class { open(_method: string, url: string) { record('xhr')(url); } send() {} setRequestHeader() {} },
    WebSocket: class { constructor(url: string) { record('websocket')(url); } close() {} },
    EventSource: class { constructor(url: string) { record('eventsource')(url); } close() {} addEventListener() {} },
  });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { ...(saved.navigator as object), sendBeacon: (url: string) => { record('beacon')(url); return true; } } });
});

afterEach(() => {
  for (const name of WATCHED) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: saved[name] });
});

const ticks = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

// A stream that replays frames: the session's stored events, or the lead's.
function replay(frames: readonly { readonly name: string; readonly data: string }[]): { readonly open: (url: string) => StreamLike; readonly urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    open: (url) => {
      urls.push(url);
      const listeners = new Map<string, ((event: { data: string }) => void)[]>();
      const stream: StreamLike = {
        addEventListener: (name, listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
        close: () => {},
        onerror: null,
      };
      queueMicrotask(() => { for (const frame of frames) for (const listener of listeners.get(frame.name) ?? []) listener({ data: frame.data }); });
      return stream;
    },
  };
}

const parse = (frame: string) => ({ name: /^event: (.*)$/m.exec(frame)?.[1] ?? '', data: /^data: (.*)$/m.exec(frame)?.[1] ?? '' });

test('the session\'s timeline reaches CopilotKit as AG-UI snapshots, and CopilotKit sends nothing anywhere', async () => {
  const fixture = sessionFixture(FIXTURE_NOW);
  const detail = detailOf(fixture, AUTHOR_ID);
  assert.ok(detail);
  const events = fixture.store.events.after(AUTHOR_ID).map((event) => parse(sseFrame(event)));
  const stream = replay(events);
  const agent = new SessionAgent({ sessionId: AUTHOR_ID, state: detail.state, open: stream.open, later: () => {} });
  const { copilotkit } = makeCopilot({ [sessionAgentId(AUTHOR_ID)]: agent as unknown as ThreadAgent<object> });
  assert.equal(copilotkit.getAgent(sessionAgentId(AUTHOR_ID)), agent, 'the agent is CopilotKit\'s, registered locally');
  void copilotkit.connectAgent({ agent });
  await ticks();
  assert.ok(isSessionThread(agent.state), 'the agent holds the thread');
  const thread = agent.state as SessionThread;
  assert.equal(thread.lastSeq, events.length);
  assert.ok(thread.rows.some((row) => row.kind === 'tool' && row.request?.state === 'waiting'), 'the permission that waits is in the thread');
  assert.ok(agent.messages.some((message) => message.role === 'user' && typeof message.content === 'string' && message.content.includes('never split')), 'the person\'s answer is an AG-UI message');
  assert.deepEqual(stream.urls, [`/api/service/sessions/${AUTHOR_ID}/events?after=0`], 'the app\'s own stream, from the start');
  await agent.detachActiveRun();
  assert.deepEqual(sent, [], 'no request of CopilotKit\'s own');
});

test('the lead\'s thread reaches CopilotKit, a reply is folded in at once, and CopilotKit sends nothing anywhere', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const calls: string[] = [];
  const api = async <T,>(path: string): Promise<T> => {
    calls.push(path);
    if (path === '/lead') return fixture.state as T;
    if (path === '/lead/messages') return fixture.messages as T;
    if (path === '/plans') return fixture.plans as T;
    throw new Error(path);
  };
  const stream = replay([{ name: 'state', data: JSON.stringify({ ...fixture.state, refreshCount: 7 } satisfies LeadState) }]);
  const agent = new LeadAgent({ api, open: stream.open, later: () => {} });
  const { copilotkit } = makeCopilot({ [LEAD_AGENT]: agent as unknown as ThreadAgent<object> });
  void copilotkit.connectAgent({ agent });
  await ticks();
  assert.ok(isLeadThread(agent.state));
  const thread = agent.state as LeadThread;
  assert.equal(thread.lead.refreshCount, 7, 'the stream\'s state frame is in');
  assert.equal(thread.messages.length, fixture.messages.length);
  assert.deepEqual(calls.sort(), ['/lead', '/lead/messages', '/plans']);
  assert.equal(stream.urls[0], `/api/service/lead/stream?after=${fixture.messages.at(-1)?.seq ?? 0}`);
  const reply: LeadMessage = { seq: 99, at: FIXTURE_NOW.toISOString(), by: 'owner', user: 'u', text: 'Ship it on Friday.', kind: 'message' };
  agent.update((current) => ({ ...current, messages: [...current.messages, reply] }));
  await ticks(2);
  assert.equal((agent.state as LeadThread).messages.at(-1)?.text, 'Ship it on Friday.');
  assert.equal(agent.messages.at(-1)?.role, 'user');
  assert.equal((agent.state as LeadThread).plans.length, fixture.plans.length);
  await agent.detachActiveRun();
  assert.deepEqual(sent, [], 'no request of CopilotKit\'s own');
});

test('the agents are written through the app, never run by CopilotKit', async () => {
  const agent = new LeadAgent({ api: async () => { throw new Error('none'); }, open: replay([]).open, later: () => {} });
  await assert.rejects(agent.runAgent(), /written through the app/);
  assert.deepEqual(sent, []);
});
