// What the session and its reviewer are told of a human's changes
// (docs/v2/milestone-2-plan.md, decision 33, lane 31): humanEdits() reads
// the session's `cleared.human_edit` events, merged per path; a session
// taken over is told at Give back, in one notice, of the editor's saves and
// of the files the terminal changed (found in its container against the
// checkout at Take over); and the reviewer's prompt, through lane 23's call
// in the engine's review start, names them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { filesRoutes } from '../../src/flow/files.ts';
import { humanEditNotice, humanEdits } from '../../src/flow/human-edits.ts';
import { takeoverRoutes } from '../../src/flow/takeover.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { SessionEvent } from '../../src/session/events.ts';
import { HumanSide } from '../../src/terminal/human.ts';
import { LocalContainer } from '../terminal/support.ts';
import { authorScript, finished, setup, started, text as said_, until } from './support.ts';

const PROOF = 'd'.repeat(64);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const edit = (seq: number, at: string, value: Record<string, unknown>): SessionEvent => ({
  seq, at, sessionId: 's1', ticket: 't1', project: 'guestbook',
  event: { type: 'CUSTOM', name: 'cleared.human_edit', value: { by: 'u1', before: null, after: null, via: 'editor', added: 0, removed: 0, path: 'a', ...value } as never },
});

test('humanEdits merges the edits per path: the counts added up, the first hash before, the last after, the last who and how', () => {
  assert.deepEqual(humanEdits({ events: [] }), []);
  const events = [
    edit(1, '2026-10-22T10:00:00.000Z', { path: 'src/entries.ts', added: 2, removed: 1, before: 'h0', after: 'h1' }),
    { seq: 2, at: '2026-10-22T10:01:00.000Z', sessionId: 's1', ticket: 't1', project: 'guestbook', event: { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'not an edit' } } satisfies SessionEvent,
    edit(3, '2026-10-22T10:02:00.000Z', { path: 'NOTES.txt', added: 2, after: 'n1', via: 'terminal' }),
    edit(4, '2026-10-22T10:03:00.000Z', { path: 'src/entries.ts', added: 1, removed: 3, before: 'h1', after: 'h2', via: 'terminal' }),
  ];
  assert.deepEqual(humanEdits({ events }), [
    { path: 'src/entries.ts', by: 'u1', at: '2026-10-22T10:03:00.000Z', added: 3, removed: 4, before: 'h0', after: 'h2', via: 'terminal' },
    { path: 'NOTES.txt', by: 'u1', at: '2026-10-22T10:02:00.000Z', added: 2, removed: 0, before: null, after: 'n1', via: 'terminal' },
  ]);
  assert.equal(humanEditNotice('Demo', [{ path: 'a.ts', added: 1, removed: 0 }, { path: 'b.ts', added: 0, removed: 2 }]),
    'Demo changed these files: a.ts (+1, -0), b.ts (+0, -2). Read them again before editing them.');
});

test('a session taken over is told at Give back, in one notice, of the editor\'s save and of a file the terminal created; the reviewer\'s prompt names both', async () => {
  // The resumed session reads the engine's words at Give back, then this
  // lane's notice, before its turn ends: the real runner queues a message
  // sent while a turn starts (images/session/runner/main.ts).
  const t = await setup({ scripts: { author: authorScript, reopen: [{ awaitMessage: true }, { awaitMessage: true }, started, ...said_('a2', 'Read them.'), finished(0.2)] } });
  const root = mkdtempSync(join(tmpdir(), 'cleared-human-'));
  const server: Server = createServer();
  try {
    writeFileSync(join(root, 'entries.ts'), 'export const order = "oldest";\n');
    execFileSync('git', ['-C', root, 'init', '-q']);
    execFileSync('git', ['-C', root, '-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-qm', 'base']);
    const container = new LocalContainer(root);
    const human = new HumanSide({ engine: t.engine, store: t.store, container, now: () => new Date(t.clock.now), env: {} });
    const deps = { engine: () => t.engine, proof: () => PROOF, human: () => human };
    const app: App = { registry: t.engine.registry, tables: [], routes: [...filesRoutes(deps), ...takeoverRoutes(deps)] };
    server.on('request', (request, response) => dispatch(app, request, response, handle));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'u1', 'content-type': 'application/json' };

    await t.engine.start(t.ticket.id, 'u1');
    await until(() => t.inbox.waitingFor(t.startedSessions[0]?.id ?? '') > 0, 'the permission');
    await t.engine.settled();
    const id = t.startedSessions[0]!.id;
    assert.equal((await fetch(`${base}/api/sessions/${id}/takeover`, { method: 'POST', headers })).status, 200);
    await t.engine.settled();
    const said = () => t.store.events.after(id).flatMap(({ event }) => event.type === 'TEXT_MESSAGE_CONTENT' ? [event.delta] : []);
    const before = said().length;

    // The editor's save while taken over: journaled, not told yet.
    const text = 'export const order = "newest";\n';
    const saved = await fetch(`${base}/api/sessions/${id}/files/entries.ts`, { method: 'PUT', headers, body: JSON.stringify({ text, hash: sha(readFileSync(join(root, 'entries.ts'))) }) });
    assert.equal(saved.status, 200);
    assert.equal(said().length, before, 'nothing said to a session taken over');
    // A file the terminal created.
    writeFileSync(join(root, 'NOTES.txt'), 'one\ntwo\nthree\n');

    assert.equal((await fetch(`${base}/api/sessions/${id}/giveback`, { method: 'POST', headers })).status, 200);
    const notices = said().slice(before).filter((line) => line.includes('changed these files'));
    assert.deepEqual(notices, ['Demo changed these files: entries.ts (+1, -1), NOTES.txt (+3, -0). Read them again before editing them.'], 'one notice, with both files');
    const edits = t.store.events.after(id).flatMap(({ event }) => event.type === 'CUSTOM' && event.name === 'cleared.human_edit' ? [event.value] : []);
    assert.deepEqual(edits.map((e) => [e.path, e.via]), [['entries.ts', 'editor'], ['NOTES.txt', 'terminal']], 'the editor\'s save is not journaled again as the terminal\'s');
    assert.deepEqual(edits[1], { path: 'NOTES.txt', by: 'u1', added: 3, removed: 0, before: null, after: sha('one\ntwo\nthree\n'), via: 'terminal' });
    assert.deepEqual(humanEdits({ events: t.store.events.after(id) }).map((e) => e.path), ['entries.ts', 'NOTES.txt']);

    // The author ends its turn, and the review starts with the files named.
    await until(() => t.startedSessions.some((s) => s.input.role === 'reviewer'), 'the review');
    await t.engine.settled();
    const prompt = t.startedSessions.find((s) => s.input.role === 'reviewer')!.input.prompt;
    assert.match(prompt, /A person changed these files/);
    assert.match(prompt, /`entries\.ts`, by u1 in the editor \(\+1 -1\)/);
    assert.match(prompt, /`NOTES\.txt`, by u1 in the terminal \(\+3 -0\)/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await t.engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});
