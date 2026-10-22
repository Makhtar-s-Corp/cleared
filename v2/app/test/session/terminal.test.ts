// The web terminal's model (decision 32, lane 32), under Node: the
// keystrokes batched at most every 30 ms and 4 KiB per post, sent one post
// at a time and in order; the choice between the web terminal and the
// command; the stream's chunks taken once each, and the closed state's
// reason; the routes it calls, with the anti-forgery header; the page's
// style shims held once per screen, however many terminals mount.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL_INPUT_MAX_BYTES } from '../../../src/api/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator } from '../../web/lib/i18n.ts';
import {
  BATCH_MS, InputBatcher, closedLine, freshChunk, pageNonce, splitBytes, styleShims, terminalApi, terminalChoice,
} from '../../web/components/terminal/model.ts';

const en = translator(loadCatalog('session', 'en'));
const fr = translator(loadCatalog('session', 'fr'));
const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

// A clock the test moves: what the batcher schedules runs when the test says.
function fakeTimers() {
  let next = 1;
  const due = new Map<number, { at: number; run: () => void }>();
  let now = 0;
  return {
    schedule: (run: () => void, ms: number) => { const id = next++; due.set(id, { at: now + ms, run }); return () => { due.delete(id); }; },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...due].sort((a, b) => a[1].at - b[1].at)) if (entry.at <= now) { due.delete(id); entry.run(); }
    },
    pending: () => due.size,
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a piece of input is at most 4 KiB of UTF-8, and no character is cut in two', () => {
  assert.equal(TERMINAL_INPUT_MAX_BYTES, 4096);
  const ascii = 'a'.repeat(10_000);
  const pieces = splitBytes(ascii);
  assert.deepEqual(pieces.map(bytes), [4096, 4096, 1808]);
  assert.equal(pieces.join(''), ascii);
  // Three bytes per character, and four for an emoji (a surrogate pair):
  // a cut at 4096 bytes would fall inside one of them.
  const wide = 'é€😀'.repeat(1000);
  const cut = splitBytes(wide);
  assert.ok(cut.every((piece) => bytes(piece) <= 4096 && bytes(piece) > 0));
  assert.equal(cut.join(''), wide, 'nothing lost, nothing doubled');
  assert.ok(cut.every((piece) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(piece)), 'no surrogate pair split');
  assert.deepEqual(splitBytes(''), []);
});

test('keystrokes are sent at most every 30 ms, one post at a time, in order, none above 4 KiB', async () => {
  assert.equal(BATCH_MS, 30);
  const timers = fakeTimers();
  const posts: string[] = [];
  let inFlight = 0;
  let most = 0;
  const release: (() => void)[] = [];
  const batcher = new InputBatcher({
    schedule: timers.schedule,
    send: (data) => {
      posts.push(data);
      inFlight += 1;
      most = Math.max(most, inFlight);
      return new Promise<void>((resolve) => release.push(() => { inFlight -= 1; resolve(); }));
    },
  });
  batcher.push('l');
  batcher.push('s');
  assert.deepEqual(posts, [], 'nothing before the 30 ms');
  timers.advance(29);
  assert.deepEqual(posts, []);
  timers.advance(1);
  assert.deepEqual(posts, ['ls'], 'the keys of 30 ms in one post');

  // A paste of 10 000 characters while the first post is on its way.
  const burst = `${'x'.repeat(10_000)}\r`;
  batcher.push(burst);
  timers.advance(30);
  await settle();
  assert.equal(posts.length, 1, 'the next post waits for the first answer');
  while (release.length) {
    release.shift()?.();
    await settle();
    timers.advance(30);
    await settle();
  }
  assert.equal(most, 1, 'never two posts at once');
  assert.ok(posts.every((post) => bytes(post) <= 4096), 'no post above 4 KiB');
  assert.equal(posts.join(''), `ls${burst}`, 'in order, nothing lost');
  assert.equal(timers.pending(), 0);
});

test('a refused post stops the batcher and says so; what was typed after it is not sent', async () => {
  const timers = fakeTimers();
  const posts: string[] = [];
  const failures: unknown[] = [];
  const batcher = new InputBatcher({
    schedule: timers.schedule,
    send: async (data) => { posts.push(data); if (data === 'boom') throw new Error('409'); },
    onError: (error) => failures.push(error),
  });
  batcher.push('boom');
  timers.advance(30);
  await settle();
  batcher.push('later');
  timers.advance(30);
  await settle();
  assert.deepEqual(posts, ['boom']);
  assert.equal(failures.length, 1);
  batcher.dispose();
  batcher.push('after dispose');
  timers.advance(30);
  await settle();
  assert.deepEqual(posts, ['boom']);
});

test('the web terminal for the session I took over, on the loopback address; else the command, and why', () => {
  const at = '2026-10-22T09:30:00.000Z';
  assert.deepEqual(terminalChoice({ offered: true, takeover: { kind: 'mine', at } }), { kind: 'web' });
  assert.deepEqual(terminalChoice({ offered: false, takeover: { kind: 'mine', at } }), { kind: 'command', why: 'here_only' });
  assert.deepEqual(terminalChoice({ offered: undefined, takeover: { kind: 'mine', at } }), { kind: 'command', why: 'here_only' }, 'an app that does not say: no terminal');
  assert.deepEqual(terminalChoice({ offered: true, takeover: { kind: 'other', at } }), { kind: 'command', why: 'other' }, 'another account\'s take over: its command, no terminal');
  assert.deepEqual(terminalChoice({ offered: true, takeover: { kind: 'free', can: true } }), { kind: 'none' });
  assert.deepEqual(terminalChoice({ offered: true, takeover: { kind: 'free', can: false } }), { kind: 'none' });
});

test('each chunk of the stream is written once, in order, after a reconnection too', () => {
  let last = 0;
  const written: string[] = [];
  for (const chunk of [{ seq: 1, data: 'a' }, { seq: 2, data: 'b' }, { seq: 2, data: 'b' }, { seq: 1, data: 'a' }, { seq: 3, data: 'c' }]) {
    if (!freshChunk(last, chunk)) continue;
    last = chunk.seq;
    written.push(chunk.data);
  }
  assert.deepEqual(written, ['a', 'b', 'c']);
});

test('the closed state says why, in both languages', () => {
  for (const reason of ['give_back', 'idle', 'closed', 'exit', 'lost', 'refused'] as const) {
    for (const t of [en, fr]) {
      const line = closedLine(reason, t);
      assert.ok(line && !line.includes('{'), `${reason}: ${line}`);
    }
  }
  assert.match(closedLine('idle', en), /15 minutes/);
});

test('the routes: open with the size, the input as typed, the resize; each post with the anti-forgery token; an open terminal is attached', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const answers: Record<string, { status: number; body: unknown }> = {
    open: { status: 200, body: { opened: true, cols: 100, rows: 30, resume: 'claude --resume s-1' } },
  };
  const fetcher = async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const name = String(url).split('/').at(-1) ?? '';
    const answer = answers[name] ?? { status: 200, body: { accepted: true } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  };
  const api = terminalApi('s 1', 'token-1', fetcher);
  assert.deepEqual(await api.open({ cols: 100, rows: 30 }), { kind: 'opened', cols: 100, rows: 30, resume: 'claude --resume s-1' });
  await api.input('ls\r');
  await api.resize({ cols: 120, rows: 40 });
  assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
    ['POST', '/api/service/sessions/s%201/terminal/open'],
    ['POST', '/api/service/sessions/s%201/terminal/input'],
    ['POST', '/api/service/sessions/s%201/terminal/resize'],
  ]);
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get('x-csrf-token'), 'token-1');
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(call.init.credentials, 'same-origin');
  }
  assert.deepEqual(calls.map((c) => JSON.parse(String(c.init.body))), [{ cols: 100, rows: 30 }, { data: 'ls\r' }, { cols: 120, rows: 40 }]);
  assert.equal(api.streamUrl, '/api/service/sessions/s%201/terminal/stream');

  // A terminal already open (a reload of the page): the stream is attached.
  answers.open = { status: 409, body: { error: 'a terminal is already open for this session' } };
  assert.deepEqual(await api.open({ cols: 80, rows: 24 }), { kind: 'attach' });
  answers.open = { status: 403, body: { error: 'the web terminal opens on this machine\'s browser only, at the app\'s loopback address' } };
  assert.deepEqual(await api.open({ cols: 80, rows: 24 }), { kind: 'refused', reason: 'the web terminal opens on this machine\'s browser only, at the app\'s loopback address' });
  answers.input = { status: 409, body: { error: 'no terminal is open' } };
  await assert.rejects(api.input('x'));
});

test('the page\'s nonce is read from its meta element\'s nonce property, which the browser keeps when it hides the attribute', () => {
  const doc = { querySelector: (selector: string) => (selector === 'meta[property="csp-nonce"]' ? { nonce: 'abc123', getAttribute: () => '' } : null) };
  assert.equal(pageNonce(doc), 'abc123');
  assert.equal(pageNonce({ querySelector: () => null }), '');
});

test('the style shims are installed once per screen and removed with the last terminal, in any order', () => {
  const log: string[] = [];
  const shims = styleShims({
    nonce: (value) => { log.push(`nonce on ${value}`); return () => log.push('nonce off'); },
    cssom: () => { log.push('cssom on'); return () => log.push('cssom off'); },
  });
  const first = shims.hold('n-1');
  const second = shims.hold('n-1');
  assert.deepEqual(log, ['nonce on n-1', 'cssom on'], 'a second terminal (or React\'s second mount) installs nothing more');
  first();
  assert.deepEqual(log, ['nonce on n-1', 'cssom on'], 'the first one gone, the second still has them');
  first();
  assert.deepEqual(log, ['nonce on n-1', 'cssom on'], 'a release given twice counts once');
  second();
  assert.deepEqual(log, ['nonce on n-1', 'cssom on', 'nonce off', 'cssom off']);
  assert.throws(() => shims.hold(''), /nonce/, 'no nonce, no shim: the page was written without one');
});
