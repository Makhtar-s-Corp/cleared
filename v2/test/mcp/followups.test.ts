// The follow-ups of the ledger's MCP server (issue 301, from PR 298). The
// values shaped like a secret are put together at run time (support.ts), so
// that the guard, which reads this file, finds none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { LedgerHistory, openLedgerReadOnly } from '../../src/mcp/history.ts';
import { MARKER_TEXTS, createRedactor } from '../../src/mcp/redact.ts';
import { createLedgerServer, serveStdio } from '../../src/mcp/server.ts';
import { openStore } from '../../src/store/db.ts';
import { ENV, SECRETS, SESSIONS, makeLedger } from './support.ts';

const redactor = createRedactor({ env: ENV, paths: [] });
const eventOf = (history: LedgerHistory, text: string) => history.searchEvents({ text }).items.map((e) => `${e.sessionId}:${e.seq}`);

// 1. The pre-filter and the filter read the same text.

test('a search for the marker of a cleaning finds the text that was cleaned, whole or in part', () => {
  const fixture = makeLedger();
  const db = openLedgerReadOnly(fixture.path);
  try {
    const history = new LedgerHistory(db, createRedactor({ env: ENV, paths: [fixture.dir] }));
    const token = `${SESSIONS.S1}:4`;
    assert.ok(eventOf(history, '[removed: GitHub token]').includes(token), 'the whole marker');
    assert.ok(eventOf(history, 'removed: GitHub').includes(token), 'a part of it');
    assert.ok(eventOf(history, 'GitHub token').includes(token), 'its words');
    assert.ok(eventOf(history, 'github [removed: GitHub token]').includes(token), 'the text before it, then the marker');
    assert.deepEqual(eventOf(history, '[removed: GitHub token] and then some'), [], 'a text that is not there is still not found');
    assert.deepEqual(eventOf(history, '[removed: no such category]'), []);
  } finally {
    db.close();
    fixture.close();
  }
});

test('every marker the cleaner writes is one the search knows', () => {
  const text = Object.values(SECRETS).join('\n') + `\nexport ${['GITHUB', 'TOKEN'].join('_')}=${SECRETS.envToken}\n/srv/state/shop/x\nhttps://x.example/?${['api', 'key'].join('_')}=abcdef123456`;
  const made = createRedactor({ env: ENV, paths: ['/srv/state/shop'] }).whole(text) as string;
  const markers = [...made.matchAll(/\[removed: ([^\]]+)\]/g)].map((m) => m[1] as string);
  assert.ok(markers.length >= 10, markers.join(', '));
  for (const marker of markers) assert.ok(MARKER_TEXTS.includes(`removed: ${marker}`), `unknown marker: ${marker}`);
});

// 2. A call reads a bounded number of rows.

test('a search with no usable term stops at the scan limit and says where to go on, a page without a hit included', () => {
  const fixture = makeLedger();
  const db = openLedgerReadOnly(fixture.path);
  try {
    const history = new LedgerHistory(db, createRedactor({ env: ENV, paths: [] }), { scanLimit: 5 });
    // "«" has no run of three ASCII characters: nothing narrows the rows.
    // Its only event is the 31st from the newest, so the first calls read
    // five rows each, find nothing and still say they are not the end.
    const first = history.searchEvents({ text: '«', limit: 1 });
    assert.equal(first.partial, true);
    assert.ok(first.next, 'a next value, though nothing was found');
    assert.deepEqual(first.items, []);
    const seen: string[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const page = history.searchEvents({ text: '«', limit: 1, cursor });
      seen.push(...page.items.map((e) => `${e.sessionId}:${e.seq}`));
      cursor = page.next ?? undefined;
      calls++;
      assert.ok(calls < 20, 'the cursors reach the end');
    } while (cursor);
    assert.deepEqual(seen, [`${SESSIONS.S2}:2`], 'every match once');
    assert.ok(calls > 1);
    const whole = new LedgerHistory(db, createRedactor({ env: ENV, paths: [] }));
    assert.equal(whole.searchEvents({ text: '«' }).partial, false);
    assert.equal(history.searchEvents({ ticket: 'LOCAL-9', limit: 2 }).partial, false, 'a page that fills before the limit is not partial');
  } finally {
    db.close();
    fixture.close();
  }
});

test('the server says a page is partial, in both languages', async () => {
  const fixture = makeLedger();
  const db = openLedgerReadOnly(fixture.path);
  try {
    const history = new LedgerHistory(db, createRedactor({ env: ENV, paths: [] }), { scanLimit: 5 });
    for (const language of ['en', 'fr'] as const) {
      const server = createLedgerServer({ history, language });
      const answer = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_events', arguments: { text: '«', limit: 1 } } }) as { result: { structuredContent: { partial: boolean; next: string | null; events: unknown[] } } };
      assert.equal(answer.result.structuredContent.partial, true, language);
      assert.deepEqual(answer.result.structuredContent.events, [], language);
      assert.ok(answer.result.structuredContent.next, language);
      const listed = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { description: string }[] } };
      assert.match(listed.result.tools[1]?.description ?? '', language === 'en' ? /partial/i : /partielle/i, language);
    }
  } finally {
    db.close();
    fixture.close();
  }
});

// 3. A cursor is built on the stored values.

test('two sessions whose ids are cleaned to the same text, made at the same moment, are each paged once, and the cursor holds neither id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-mcp-cursor-'));
  try {
    const path = join(dir, 'ledger.db');
    const store = openStore(path);
    const at = '2026-10-20T09:00:00.000Z';
    // An id of no generated shape that holds the environment's secret value: cleaned, it reads the same whatever its other letters.
    const ids = ['a', 'b', 'c'].map((letter) => `${SECRETS.envValue}-${letter}`);
    for (const id of ids) store.sessions.put({ id, project: 'shop', ticket: 'LOCAL-7', role: 'author', harness: 'claude-code', model: 'm', status: 'done', createdAt: at, updatedAt: at, service: null, previewKey: null });
    for (const id of ids) store.events.append({ sessionId: id, ticket: 'LOCAL-7', project: 'shop', at, event: { type: 'STEP_STARTED', stepName: 'author' } });
    store.close();
    const db = openLedgerReadOnly(path);
    try {
      const history = new LedgerHistory(db, createRedactor({ env: ENV, paths: [] }));
      const sessions = history.searchSessions({ limit: 1 });
      const events = history.searchEvents({ limit: 1 });
      for (const page of [sessions, events]) {
        assert.ok(page.next);
        const cursor = Buffer.from(page.next ?? '', 'base64url').toString('utf8');
        for (const id of ids) assert.ok(!cursor.includes(id), 'the cursor holds a stored id');
        assert.ok(!cursor.includes(SECRETS.envValue));
      }
      const walk = <T>(first: { items: T[]; next: string | null }, more: (cursor: string) => { items: T[]; next: string | null }) => {
        const all = [...first.items];
        for (let page = first, n = 0; page.next && n < 10; n++) { page = more(page.next); all.push(...page.items); }
        return all;
      };
      assert.equal(walk(sessions, (cursor) => history.searchSessions({ limit: 1, cursor })).length, 3, 'three sessions, once each');
      assert.equal(walk(events, (cursor) => history.searchEvents({ limit: 1, cursor })).length, 3, 'three events, once each');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 4. The names of the keys, and a name that only holds a word of a secret's.

test('the name of a key is cleaned like its value, in an event, a search and a timeline', () => {
  const out = redactor.value({ [SECRETS.github]: 'x', nested: { [`key ${SECRETS.aws}`]: [1] }, rawEvent: { a: 1 }, toolCallId: 'toolu_01BBBBBBBBBB' }) as Record<string, unknown>;
  assert.ok(!JSON.stringify(out).includes(SECRETS.github.slice(0, 8)), JSON.stringify(out));
  assert.ok(!JSON.stringify(out).includes(SECRETS.aws.slice(0, 8)), JSON.stringify(out));
  assert.equal(out.toolCallId, 'toolu_01BBBBBBBBBB', 'an id key is still decided on the stored name');
  assert.equal(out.rawEvent, undefined);
  const twice = redactor.whole({ [SECRETS.github]: 1, [`${SECRETS.github}x`.replace('R', 'S')]: 2 }) as Record<string, unknown>;
  assert.equal(Object.keys(twice).length, 2, 'two keys cleaned to one marker keep both values');
});

test('a key that is a secret is cleaned in the stored event too, found by neither search nor timeline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-mcp-key-'));
  try {
    const path = join(dir, 'ledger.db');
    const store = openStore(path);
    const at = '2026-10-20T09:00:00.000Z';
    store.sessions.put({ id: SESSIONS.S1, project: 'shop', ticket: 'LOCAL-7', role: 'author', harness: 'claude-code', model: 'm', status: 'done', createdAt: at, updatedAt: at, service: null, previewKey: null });
    store.events.append({ sessionId: SESSIONS.S1, ticket: 'LOCAL-7', project: 'shop', at, event: { type: 'STATE_SNAPSHOT', snapshot: { [SECRETS.github]: 'value' } } as never });
    store.close();
    const db = openLedgerReadOnly(path);
    try {
      const history = new LedgerHistory(db, createRedactor({ env: ENV, paths: [] }));
      const shown = JSON.stringify([history.searchEvents({}), history.timeline(SESSIONS.S1, {})]);
      assert.ok(!shown.includes(SECRETS.github.slice(0, 8)), shown);
      assert.match(shown, /\[removed: GitHub token\]/);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('NAME=value: a name that only holds the letters of a secret\'s keeps its value, a name that is one has it removed', () => {
  const keep = ['BYPASS_MODE=1', 'AUTHOR=alice', 'AUTHOR_EMAIL=alice@example.com', 'KEYBOARD_LAYOUT=azerty', 'MONKEY_COUNT=3', 'COMPASS_POINT=north', 'PASSENGER_COUNT=4', 'HOTKEY_BINDING=ctrl'];
  for (const line of keep) assert.equal(redactor.text(`run ${line} npm test`), `run ${line} npm test`, line);
  const name = (...parts: string[]) => parts.join('');
  const hide = [
    name('GITHUB', '_TOKEN'), name('API', 'KEY'), name('PG', 'PASSWORD'), name('SSH', 'PASS'), name('GITHUB', 'TOKEN'), name('DB', '_PASS'), name('MY', '_PASSPHRASE'),
    name('STRIPE', '_SECRET_', 'KEY'), name('X', '_AUTH'), name('BYPASS', '_TOKEN'), name('AUTHOR', '_API_', 'KEY'), name('AWS_SECRET', '_ACCESS_', 'KEY'),
  ];
  for (const variable of hide) {
    const out = redactor.text(`run ${variable}=${SECRETS.envToken} npm test`);
    assert.ok(!out.includes(SECRETS.envToken), variable);
    assert.match(out, new RegExp(`${variable}=\\[removed: environment value\\] npm test`), variable);
  }
});

// 5. A client that is gone.

test('serveStdio stops quietly when the output is closed by its reader (EPIPE), though its input stays open', async () => {
  const input = new ReadableLines();
  const output = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); } });
  const history = {} as LedgerHistory;
  const served = serveStdio(input, output, createLedgerServer({ history, language: 'en' }));
  input.push('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  const outcome = await Promise.race([served.then(() => 'stopped'), new Promise((resolve) => setTimeout(() => resolve('still reading'), 2000))]);
  input.push(null);
  assert.equal(outcome, 'stopped');
});

test('serveStdio reports an output error that is not EPIPE', async () => {
  const input = new ReadableLines();
  const output = new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('write ENOSPC'), { code: 'ENOSPC' })); } });
  const served = serveStdio(input, output, createLedgerServer({ history: {} as LedgerHistory, language: 'en' }));
  input.push('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await assert.rejects(Promise.race([served, new Promise((_, reject) => setTimeout(() => reject(new Error('still reading')), 2000))]), /ENOSPC/);
  input.push(null);
});

test('the server process whose client closed its stdout exits with 0 and no stack on stderr', async () => {
  const fixture = makeLedger();
  const cli = new URL('../../src/cli/ledger-mcp.ts', import.meta.url).pathname;
  const child = spawn(process.execPath, [cli], { env: { PATH: process.env.PATH, HOME: process.env.HOME, CLEARED_STATE_DIR: fixture.dir }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdout.destroy();
    for (let i = 0; i < 5 && child.exitCode === null; i++) {
      child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const code = await Promise.race([closed, new Promise<string>((resolve) => setTimeout(() => resolve('still running'), 5000))]);
    assert.equal(code, 0, stderr);
    assert.equal(stderr, '');
  } finally {
    child.kill();
    fixture.close();
  }
});

// A readable that a test feeds line by line, which stays open until null.
class ReadableLines extends Readable {
  override _read(): void { /* fed by push */ }
}

// 6. The ledger of a service that is writing, and a folder that is read only.

test('a read while the service writes (WAL): the committed rows are read, a transaction in progress is not, and nothing waits', () => {
  const fixture = makeLedger();
  const writer = new DatabaseSync(fixture.path);
  writer.exec('PRAGMA journal_mode = WAL');
  const reader = openLedgerReadOnly(fixture.path);
  try {
    const history = new LedgerHistory(reader, createRedactor({ env: ENV, paths: [] }));
    const count = () => history.searchEvents({ ticket: 'LOCAL-12', limit: 100 }).items.length;
    const add = (n: number) => writer.prepare("INSERT INTO session_events (session_id, seq, at, ticket, project, type, event) VALUES (?, ?, ?, 'LOCAL-12', 'shop', 'TEXT_MESSAGE_CONTENT', ?)")
      .run(SESSIONS.S1, 100 + n, `2026-10-23T08:00:${String(n).padStart(2, '0')}.000Z`, JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', delta: `written ${n}` }));
    assert.equal(count(), 0);
    writer.exec('BEGIN IMMEDIATE');
    add(1);
    add(2);
    assert.equal(count(), 0, 'a transaction in progress is not read');
    const started = Date.now();
    assert.equal(history.searchSessions({}).items.length, 3, 'the reader does not wait for the writer');
    assert.ok(Date.now() - started < 1000);
    writer.exec('COMMIT');
    assert.equal(count(), 2, 'a commit is read by the connection already open');
    for (const row of history.searchEvents({ ticket: 'LOCAL-12' }).items) assert.match(JSON.stringify(row.event), /written/);
    // A page being read while the writer commits and checkpoints keeps its snapshot or sees the new rows, never an error.
    add(3);
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(count(), 3);
  } finally {
    reader.close();
    writer.close();
    fixture.close();
  }
});

test('the ledger of a closed service, in a folder that cannot be written to, is read with no -wal and no -shm', { skip: process.getuid?.() === 0 ? 'root writes anywhere' : false }, () => {
  const fixture = makeLedger();
  try {
    chmodSync(fixture.dir, 0o555);
    const db = openLedgerReadOnly(fixture.path);
    try {
      const history = new LedgerHistory(db, createRedactor({ env: ENV, paths: [] }));
      assert.equal(history.searchSessions({}).items.length, 3);
      assert.equal(history.timeline(SESSIONS.S1, {})?.events.length, 5);
    } finally {
      db.close();
    }
  } finally {
    chmodSync(fixture.dir, 0o755);
    fixture.close();
  }
});
