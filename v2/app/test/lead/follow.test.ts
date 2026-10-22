// The lead's stream (GET /api/lead/stream): three named frames, a thread
// message with its seq as the id, a state and a plan with none. A stream
// that drops is reopened after the last message seen, never with its old
// ?after=, and a message already seen is not delivered twice (as the
// session screen does). Then the thread model that merges what comes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadFrame, type LeadMessage, type LeadStreamFrame } from '../../../src/api/types.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { leadFixture, otherPlans } from '../../fixtures/lead.ts';
import { followLead, mergeMessages, mergePlan, type StreamLike } from '../../public/screens/lead.ts';

class FakeStream implements StreamLike {
  readonly listeners = new Map<string, (event: { data: string }) => void>();
  onerror: (() => void) | null = null;
  closed = false;
  readonly url: string;
  constructor(url: string) { this.url = url; }
  addEventListener(name: string, listener: (event: { data: string }) => void): void { this.listeners.set(name, listener); }
  close(): void { this.closed = true; }
  // Delivers a frame as EventSource does: by its event name, its data line.
  deliver(frame: LeadStreamFrame): void {
    const text = leadFrame(frame);
    const name = /^event: (\w+)$/m.exec(text)?.[1] ?? '';
    const data = /^data: (.*)$/m.exec(text)?.[1] ?? '';
    this.listeners.get(name)?.({ data });
  }
}

test('a stream that drops is reopened after the last message, a replay adds nothing twice, and state and plan frames always pass', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const streams: FakeStream[] = [];
  const retries: { run: () => void; ms: number }[] = [];
  const seen: string[] = [];
  const handle = followLead({
    url: (after) => `/api/service/lead/stream?after=${after}`, after: 2,
    open: (url) => { const stream = new FakeStream(url); streams.push(stream); return stream; },
    later: (run, ms) => { retries.push({ run, ms }); },
    onFrame: (frame) => seen.push(frame.kind === 'message' ? `message ${frame.message.seq}` : frame.kind),
  });
  const first = streams[0] as FakeStream;
  assert.equal(first.url, '/api/service/lead/stream?after=2');
  assert.deepEqual([...first.listeners.keys()].sort(), ['message', 'plan', 'state']);
  for (const message of fixture.messages) first.deliver({ kind: 'message', message });
  first.deliver({ kind: 'state', state: fixture.state });
  first.deliver({ kind: 'plan', plan: fixture.plans[0] as never });
  first.onerror?.();
  assert.ok(first.closed, 'the broken stream is closed, not left to retry with its old ?after=');
  assert.equal(retries[0]?.ms, 1500);
  retries.shift()?.run();
  const second = streams[1] as FakeStream;
  assert.equal(second.url, '/api/service/lead/stream?after=5');
  for (const message of fixture.messages) second.deliver({ kind: 'message', message });   // a server that replays everything
  second.deliver({ kind: 'state', state: fixture.state });
  assert.deepEqual(seen, ['message 3', 'message 4', 'message 5', 'state', 'plan', 'state']);
  assert.equal(handle.lastSeq(), 5);
  second.onerror?.();
  assert.equal(retries[0]?.ms, 1500, 'the pause starts again once a frame came');
  third(retries, streams);
  handle.stop();
  const last = streams.at(-1) as FakeStream;
  assert.ok(last.closed);
  last.onerror?.();
  assert.equal(retries.length, 0, 'a stopped stream does not come back');
});

function third(retries: { run: () => void; ms: number }[], streams: FakeStream[]): void {
  retries.shift()?.run();
  (streams.at(-1) as FakeStream).onerror?.();
  assert.equal(retries[0]?.ms, 3000, 'with nothing heard, the pause doubles');
  retries.shift()?.run();
}

test('a frame that is not JSON, or a message without a seq, is dropped', () => {
  const streams: FakeStream[] = [];
  const seen: string[] = [];
  followLead({ url: (after) => `/s?after=${after}`, after: 0, open: (url) => { const s = new FakeStream(url); streams.push(s); return s; }, later: () => {}, onFrame: (f) => seen.push(f.kind) });
  const stream = streams[0] as FakeStream;
  stream.listeners.get('message')?.({ data: '{nope' });
  stream.listeners.get('message')?.({ data: JSON.stringify({ text: 'no seq' }) });
  stream.listeners.get('state')?.({ data: 'nope' });
  assert.deepEqual(seen, []);
});

test('the thread merges by seq, in order, without duplicates; a plan frame replaces that plan or adds it', async () => {
  const fixture = await leadFixture(FIXTURE_NOW);
  const [a, b, c, d, e] = fixture.messages as [LeadMessage, LeadMessage, LeadMessage, LeadMessage, LeadMessage];
  assert.deepEqual(mergeMessages([a, c], [b, c, e, d]).map((m) => m.seq), [1, 2, 3, 4, 5]);
  const handled = { ...c, question: c.question ? { ...c.question, state: 'waiting' as const } : undefined };
  assert.equal(mergeMessages([handled as LeadMessage], [c])[0]?.question?.state, 'handled', 'the newer copy of a seq wins');
  const plan = fixture.plans[0];
  assert.ok(plan);
  const { running } = otherPlans(FIXTURE_NOW);
  const approved = { ...plan, state: 'approved' as const };
  assert.deepEqual(mergePlan([plan, running], approved).map((p) => [p.id, p.state]), [['plan-1', 'approved'], ['plan-2', 'approved']]);
  assert.deepEqual(mergePlan([running], plan).map((p) => p.id), ['plan-2', 'plan-1']);
});
