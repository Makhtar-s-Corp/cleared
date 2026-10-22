// The adapters the sessions module gives the registry are the runtime's
// (flow/runtime.ts), each one wrapped to start its sessions in the
// workspace. The real multi-service proof of 2026-10-22 (step 11, LOCAL-14)
// found Take over saying "The claude-code harness cannot be resumed in a
// terminal yet": the wrapper kept start and resume and dropped the
// adapter's interactive resume (owner decision of 2026-10-22 21:58, lane
// v2-j2-takeover-real-harness). These tests go through runtime.adapters(),
// the path the service takes, not through an adapter put in a registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../../src/flow/runtime.ts';
import { interactiveResume, type InteractiveResume, type SessionAdapter, type SessionHandle } from '../../src/session/contract.ts';
import { openStore } from '../../src/store/db.ts';

const SESSION = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';

function runtimeOf(adapter: SessionAdapter): SessionAdapter {
  const runtime = createRuntime({ env: {}, effects: () => ({}) as never, factories: { 'claude-code': () => adapter } });
  runtime.attach({ store: openStore(':memory:') });
  return runtime.adapters()['claude-code'] as SessionAdapter;
}

test('the runtime\'s adapter keeps the harness\'s interactive resume, and asks it with the session', async () => {
  const asked: string[] = [];
  const answer: InteractiveResume = { supported: true, name: 'Claude Code', command: ['sh', '-c', 'exec claude --resume "$1"', 'claude-code', SESSION] };
  const wrapped = runtimeOf({
    harness: 'claude-code',
    async start() { return { id: SESSION } as SessionHandle; },
    async resume(id) { return { id } as SessionHandle; },
    async interactive(id) { asked.push(id); return answer; },
  });
  assert.equal(typeof wrapped.interactive, 'function', 'the wrapper has the interactive resume');
  assert.deepEqual(await interactiveResume(wrapped, SESSION), answer);
  assert.deepEqual(asked, [SESSION]);
});

test('an adapter without an interactive resume stays without one through the runtime, and the Shell is offered', async () => {
  const wrapped = runtimeOf({
    harness: 'claude-code',
    async start() { return { id: SESSION } as SessionHandle; },
    async resume(id) { return { id } as SessionHandle; },
  });
  assert.equal(wrapped.interactive, undefined);
  const said = await interactiveResume(wrapped, SESSION);
  assert.equal(said.supported, false);
  assert.match((said as { reason: string }).reason, /open the Shell instead/);
});

test('every method of the harness\'s adapter is a method of the runtime\'s', () => {
  const inner: SessionAdapter = {
    harness: 'claude-code',
    async start() { return { id: SESSION } as SessionHandle; },
    async resume(id) { return { id } as SessionHandle; },
    async interactive() { return { supported: false, reason: 'no' }; },
  };
  const wrapped = runtimeOf(inner);
  const methods = (adapter: SessionAdapter) => Object.keys(adapter).filter((key) => typeof (adapter as unknown as Record<string, unknown>)[key] === 'function').sort();
  assert.deepEqual(methods(wrapped), methods(inner));
  assert.equal(wrapped.harness, inner.harness);
});
