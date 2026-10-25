// The reader as the sessions module builds it (decision 28, lane 25): its
// model setting, the recovery at the service's start, the reader built once
// from the flow's configuration and the registry's adapter, and a reader's
// start through the flow runtime's wrapper of the adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFlowConfig, type FlowConfig } from '../../src/flow/config.ts';
import { createRuntime } from '../../src/flow/runtime.ts';
import { defaultRegistry, type Registry } from '../../src/modules/registry.ts';
import { DEFAULT_READER_MODEL, ReaderConfigError, createReaderRuntime, readerModel } from '../../src/reader/runtime.ts';
import type { ReaderEffects } from '../../src/reader/service.ts';
import { ASK_TABLES, AskStore } from '../../src/reader/store.ts';
import { createFakeAdapter } from '../../src/session/adapters/fake.ts';
import type { StartInput } from '../../src/session/contract.ts';
import { DEFAULT_SAFE_COMMANDS } from '../../src/session/policy.ts';
import { applyTables, openStore } from '../../src/store/db.ts';
import { fakeEffects } from '../flow/support.ts';
import { turn } from './support.ts';

const ENV = {
  CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://example.invalid/guestbook.git',
  CLEARED_V2_REPO: 'example-org/cleared-example-guestbook', CLEARED_V2_STATE_DIR: '/state',
};

function effects(released: { id: string; session: string | null }[] = []): ReaderEffects {
  return {
    fileAt: async () => 'x\n',
    prepare: async (input) => ({ dir: `/state/work/asks/${input.id}`, commits: Object.fromEntries(input.services.map((name) => [name, 'c'.repeat(40)])) }),
    linesAt: async () => 1,
    release: async (input) => { released.push(input); },
  };
}

test('the reader\'s model is CLEARED_V2_READER_MODEL, the reviewer\'s by default, and a Claude model id only', () => {
  assert.equal(DEFAULT_READER_MODEL, 'claude-sonnet-5-5');
  assert.equal(readerModel({}), 'claude-sonnet-5-5');
  assert.equal(readerModel({ CLEARED_V2_READER_MODEL: 'claude-haiku-5-5' }), 'claude-haiku-5-5');
  for (const bad of ['gpt-5', 'claude-', 'claude-Haiku', 'claude-x y', '--model=x']) assert.throws(() => readerModel({ CLEARED_V2_READER_MODEL: bad }), ReaderConfigError, bad);
  const store = openStore(':memory:');
  assert.throws(() => createReaderRuntime({ flow: { engine: () => undefined }, env: { CLEARED_V2_READER_MODEL: 'gpt-5' } }).attach({ store }), ReaderConfigError);
});

test('at the service\'s start, the asks the last process left live are stopped and cleaned up; without a project nothing is', () => {
  const store = openStore(':memory:');
  applyTables(store.db, ASK_TABLES);
  const asks = new AskStore(store.db);
  const at = '2026-10-22T10:00:00.000Z';
  asks.create({ id: 'ask-1', project: 'guestbook', question: 'q', service: null, target: null, by: 'u1', at });
  asks.update('ask-1', { state: 'answered', session: '00000000-0000-4000-8000-000000000001', at });
  asks.create({ id: 'ask-2', project: 'other', question: 'q', service: null, target: null, by: 'u1', at });

  const none: { id: string; session: string | null }[] = [];
  createReaderRuntime({ flow: { engine: () => undefined }, env: {}, effects: () => effects(none) }).attach({ store });
  assert.deepEqual(none, []);
  assert.equal(asks.get('ask-1')?.state, 'answered');

  const released: { id: string; session: string | null }[] = [];
  createReaderRuntime({ flow: { engine: () => undefined }, env: ENV, effects: () => effects(released) }).attach({ store });
  assert.equal(asks.get('ask-1')?.state, 'stopped');
  assert.deepEqual(released, [{ id: 'ask-1', session: '00000000-0000-4000-8000-000000000001' }]);
  assert.equal(asks.get('ask-2')?.state, 'starting', 'another workspace\'s ask is not this service\'s');
});

test('the reader is built once, from the flow\'s configuration and the registry\'s adapter, and not without them', async () => {
  const store = openStore(':memory:');
  applyTables(store.db, ASK_TABLES);
  const config = loadFlowConfig(ENV) as FlowConfig;
  let engine: { config: FlowConfig } | undefined;
  const runtime = createReaderRuntime({ flow: { engine: () => engine as never }, env: { ...ENV, CLEARED_V2_READER_MODEL: 'claude-haiku-5-5' }, effects: () => effects() });
  runtime.attach({ store });
  const registry = defaultRegistry();
  assert.equal(runtime.reader(registry), undefined, 'no flow');
  engine = { config };
  assert.equal(runtime.reader(registry), undefined, 'no adapter');
  const inputs: StartInput[] = [];
  const fake = createFakeAdapter({ log: store.events, script: turn('t1', 'In guestbook/src/health.ts:1.', 0.01) });
  const withAdapter: Registry = { ...registry, sessionAdapters: { 'claude-code': { ...fake, start: (input) => { inputs.push(input); return fake.start(input); } } } };
  const reader = runtime.reader(withAdapter);
  assert.ok(reader);
  assert.equal(runtime.reader(withAdapter), reader, 'one reader per process');
  const ask = await reader.ask({ question: 'Where is /health?' }, 'u1');
  for (let i = 0; i < 200 && reader.get(ask.id)?.state !== 'answered'; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(reader.get(ask.id)?.state, 'answered');
  assert.equal(inputs[0]?.model, 'claude-haiku-5-5');
  assert.equal(inputs[0]?.project, 'guestbook');
  assert.equal(reader.get(ask.id)?.turns[0]?.citations[0]?.url, `https://github.com/example-org/cleared-example-guestbook/blob/${'c'.repeat(40)}/src/health.ts#L1`,
    'the link is on the service\'s repository, as the flow\'s configuration names it');
  reader.close();
});

test('a reader started through the flow runtime\'s adapter runs no sibling, and its row is a reader\'s', async () => {
  const store = openStore(':memory:');
  const inputs: StartInput[] = [];
  const runtime = createRuntime({
    env: ENV, effects: () => fakeEffects([]),
    factories: { 'claude-code': ({ log }) => { const fake = createFakeAdapter({ log, script: turn('t1', 'An answer.', 0.01) }); return { ...fake, start: (input) => { inputs.push(input); return fake.start(input); } }; } },
  });
  runtime.attach({ store });
  const adapter = runtime.adapters()['claude-code'];
  assert.ok(adapter);
  const handle = await adapter.start({
    project: 'guestbook', ticket: 'ask-1', role: 'reader', harness: 'claude-code', model: 'claude-haiku-5-5', workdir: '/state/work/asks/ask-1',
    briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
    policy: { role: 'reader', base: 'main', workdir: '/workspace', scripts: [], credentialFile: '/run/cleared/claude.token', safeCommands: DEFAULT_SAFE_COMMANDS, allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [] },
    prompt: 'q', services: [], siblings: [],
  });
  assert.deepEqual(inputs[0]?.siblings, [], 'no sibling is planned for a reader');
  const row = store.sessions.get(handle.id);
  assert.equal(row?.role, 'reader');
  assert.equal(row?.ticket, 'ask-1');
});
