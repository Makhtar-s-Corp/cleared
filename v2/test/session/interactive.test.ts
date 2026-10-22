// The adapter interface's interactive resume (owner request of 2026-10-22
// 17:26): a harness gives the program that resumes a session for a human
// at a terminal in its container, or says why it cannot. Claude Code's is
// tested with its adapter (claude-code/adapter.test.ts); every other
// adapter answers unsupported, with a message the terminal shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdapter } from '../../src/session/adapters/fake.ts';
import { interactiveResume, type SessionAdapter } from '../../src/session/contract.ts';
import type { EventLog } from '../../src/session/events.ts';

const log: EventLog = { append: (entry) => ({ ...entry, seq: 1 }), after: () => [] };
const reason = (value: Awaited<ReturnType<typeof interactiveResume>>): string => (value.supported ? '' : value.reason);

test('the fake adapter has no interactive harness, and says so', async () => {
  const fake = createFakeAdapter({ log, script: [] });
  const answer = await interactiveResume(fake, 'session-1');
  assert.equal(answer.supported, false);
  assert.match(reason(answer), /scripted session.*no interactive harness.*Shell/);
});

test('an adapter without the method, Codex or Cursor later, is unsupported with its name; no adapter at all too', async () => {
  const bare: SessionAdapter = {
    harness: 'codex',
    start: () => Promise.reject(new Error('not here')),
    resume: () => Promise.reject(new Error('not here')),
  };
  const codex = await interactiveResume(bare, 'session-1');
  assert.equal(codex.supported, false);
  assert.match(reason(codex), /^The codex harness cannot be resumed in a terminal yet: open the Shell instead\.$/);
  assert.match(reason(await interactiveResume(undefined, 'session-1')), /no harness adapter/);
});

test('an adapter that throws is unsupported, with no detail of the error', async () => {
  const failing: SessionAdapter = {
    harness: 'claude-code',
    start: () => Promise.reject(new Error('not here')),
    resume: () => Promise.reject(new Error('not here')),
    interactive: () => Promise.reject(new Error('/home/someone/secret path')),
  };
  const answer = await interactiveResume(failing, 'session-1');
  assert.equal(answer.supported, false);
  assert.doesNotMatch(reason(answer), /secret path/);
});
