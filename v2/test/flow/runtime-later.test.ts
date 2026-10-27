// Issue #420: the assistant's workspace step writes the workspace while the
// service runs (workspace/connect.ts sets CLEARED_V2_WORKSPACE in this
// process), and the newcomer types no command, so no restart. The runtime
// reads the flow's settings again while it has none, builds the engine on
// the first request that finds them, and tells the flow module, which then
// starts what it starts with an engine (the idle watchdog, the batches, the
// chat's replies).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../../src/flow/runtime.ts';
import { defaultRegistry } from '../../src/modules/registry.ts';
import { openStore } from '../../src/store/db.ts';
import { fakeEffects } from './support.ts';

const SETTINGS = {
  CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook',
  CLEARED_V2_REPO_URL: 'https://example.invalid/guestbook.git', CLEARED_V2_REPO: 'example-org/guestbook',
};

test('no workspace at start: no engine; the workspace written later: the engine at the next request, made once, and told', async () => {
  const env: NodeJS.ProcessEnv = { CLEARED_V2_STATE_DIR: '/state' };
  const runtime = createRuntime({ env, effects: () => fakeEffects([]), release: async () => undefined });
  const store = openStore(':memory:');
  runtime.attach({ store });
  const registry = defaultRegistry();
  const told: unknown[] = [];
  runtime.whenEngine((engine) => { told.push(engine); });
  assert.equal(runtime.engine(registry), undefined);
  assert.equal(runtime.engine(registry), undefined, 'asked again, still none');
  assert.equal(told.length, 0);
  Object.assign(env, SETTINGS);
  const engine = runtime.engine(registry);
  try {
    assert.ok(engine, 'built from the settings read again');
    assert.equal(engine.config.project, 'guestbook');
    assert.equal(runtime.engine(registry), engine, 'the same engine after');
    assert.deepEqual(told, [engine], 'told once');
    const late: unknown[] = [];
    runtime.whenEngine((made) => { late.push(made); });
    assert.deepEqual(late, [engine], 'a listener that comes after is told at once');
  } finally {
    await engine?.close();
    store.close();
  }
});

test('a workspace that is named but wrong is said once and leaves no engine, as at start', async () => {
  const env: NodeJS.ProcessEnv = { CLEARED_V2_STATE_DIR: '/state' };
  const runtime = createRuntime({ env, effects: () => fakeEffects([]), release: async () => undefined });
  const store = openStore(':memory:');
  runtime.attach({ store });
  const said: string[] = [];
  const error = console.error;
  console.error = (line: string) => { said.push(line); };
  try {
    Object.assign(env, SETTINGS, { CLEARED_V2_WORKDIRS: 'relative/path' });
    assert.equal(runtime.engine(defaultRegistry()), undefined);
    assert.equal(runtime.engine(defaultRegistry()), undefined);
    assert.equal(said.filter((line) => /CLEARED_V2_WORKDIRS/.test(line)).length, 1, 'said once');
  } finally {
    console.error = error;
    store.close();
  }
});
