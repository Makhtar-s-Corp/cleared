// What a harness gives up when its session is handed over (matrix B6.3,
// P150): the note of the work so far, read from the session's own journal,
// and the targets the contract allows, claude-code and codex. Cursor stays
// out of every flow (P87) and so does the harness the session already runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdapter, type FakeStep } from '../../src/session/adapters/fake.ts';
import { HandoverRefused, type StartInput } from '../../src/session/contract.ts';
import { HANDOVER_HARNESSES, NOTE_MAX, handoverNote, refuseTarget } from '../../src/session/handover.ts';
import type { SessionEvent } from '../../src/session/events.ts';
import { openStore } from '../../src/store/db.ts';

const input: StartInput = {
  project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', workdir: '/work/LOCAL-1',
  briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
  policy: { role: 'author', base: 'main', workdir: '/workspace', scripts: [], credentialFile: '/run/login', safeCommands: [], allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [] },
  prompt: 'Sort the entries.',
};

const say = (id: string, delta: string): FakeStep[] => [
  { emit: { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' } },
  { emit: { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta } },
  { emit: { type: 'TEXT_MESSAGE_END', messageId: id } },
];
const edit = (id: string, path: string): FakeStep[] => [
  { emit: { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'Edit' } },
  { emit: { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify({ kind: 'edit', path, locations: [] }) } },
  { emit: { type: 'TOOL_CALL_RESULT', messageId: `${id}-r`, toolCallId: id, content: JSON.stringify({ kind: 'edit', ok: true }), role: 'tool' } },
];

async function played(steps: readonly FakeStep[]): Promise<SessionEvent[]> {
  const store = openStore(':memory:');
  try {
    await createFakeAdapter({ log: store.events, script: steps, newId: () => 's' }).start(input);
    return store.events.after('s');
  } finally {
    store.db.close();
  }
}

test('the contract allows claude-code and codex as targets, and Cursor is not one', () => {
  assert.deepEqual([...HANDOVER_HARNESSES], ['claude-code', 'codex']);
  assert.doesNotThrow(() => refuseTarget('claude-code', { harness: 'codex', model: 'm' }));
  assert.doesNotThrow(() => refuseTarget('codex', { harness: 'claude-code', model: 'm' }));
  assert.throws(() => refuseTarget('claude-code', { harness: 'cursor', model: 'm' }), (e) => e instanceof HandoverRefused && /cursor/i.test(e.message));
  assert.throws(() => refuseTarget('codex', { harness: 'cursor', model: 'm' }), HandoverRefused);
  assert.throws(() => refuseTarget('cursor', { harness: 'codex', model: 'm' }), HandoverRefused, 'a Cursor session is not handed over either');
  assert.throws(() => refuseTarget('codex', { harness: 'codex', model: 'm' }), /already/);
  assert.throws(() => refuseTarget('claude-code', { harness: 'codex', model: '' }), /model/);
  assert.throws(() => refuseTarget('claude-code', { harness: 'gemini' as never, model: 'm' }), HandoverRefused);
});

test('the note says what was last said, the files edited, and the plan', async () => {
  const events = await played([
    ...say('a1', 'I read the list.'), ...say('a2', 'The sort is half done.'),
    ...edit('e1', '/workspace/src/entries.ts'), ...edit('e2', 'docs/notes.md'), ...edit('e3', '/workspace/src/entries.ts'), ...edit('e4', '/etc/passwd'),
  ]);
  const note = handoverNote(events);
  assert.match(note, /The sort is half done\./);
  assert.ok(!note.includes('I read the list.'), 'only the last message');
  assert.match(note, /src\/entries\.ts/);
  assert.match(note, /docs\/notes\.md/);
  assert.equal(note.split('src/entries.ts').length, 2, 'a file named once');
  assert.ok(!note.includes('/etc/passwd'), 'a path outside the checkout is not named');
});

test('a failed edit is not named; a session that did nothing says so; the note is capped', async () => {
  const failed = await played([
    { emit: { type: 'TOOL_CALL_START', toolCallId: 'f1', toolCallName: 'Edit' } },
    { emit: { type: 'TOOL_CALL_ARGS', toolCallId: 'f1', delta: JSON.stringify({ kind: 'edit', path: '/workspace/src/broken.ts', locations: [] }) } },
    { emit: { type: 'TOOL_CALL_RESULT', messageId: 'f1-r', toolCallId: 'f1', content: JSON.stringify({ kind: 'edit', ok: false }), role: 'tool' } },
  ]);
  assert.ok(!handoverNote(failed).includes('broken.ts'));
  assert.match(handoverNote(failed), /no file/i);
  assert.match(handoverNote([]), /nothing/i);
  const long = await played(say('a1', 'x'.repeat(NOTE_MAX * 3)));
  assert.ok(handoverNote(long).length <= NOTE_MAX + 400, 'the last message is cut, the frame is not');
});

test('the fake session gives up a note, once told where to; it refuses Cursor and its own harness', async () => {
  const store = openStore(':memory:');
  try {
    const adapter = createFakeAdapter({ log: store.events, script: [...say('a1', 'Half way.'), { awaitMessage: true }], newId: () => 's' });
    const handle = await adapter.start(input);
    const out = await handle.handover({ harness: 'codex', model: 'gpt-6-luna' });
    assert.deepEqual({ session: out.session, from: out.from, to: out.to }, { session: 's', from: 'claude-code', to: { harness: 'codex', model: 'gpt-6-luna' } });
    assert.match(out.note, /Half way\./);
    await assert.rejects(handle.handover({ harness: 'cursor', model: 'm' }), HandoverRefused);
    await assert.rejects(handle.handover({ harness: 'claude-code', model: 'm' }), HandoverRefused);
    await handle.stop();
    await assert.rejects(handle.handover({ harness: 'codex', model: 'm' }), /closed|stopped/);
  } finally {
    store.db.close();
  }
});
