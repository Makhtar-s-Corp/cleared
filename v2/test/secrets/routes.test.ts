// The test secrets' routes (docs/v2/milestone-5-plan.md, section 12, C16):
// the Services screen's, for any signed-in person behind the app's proof,
// and the assistant's step's, for the owner; names, dates and who, never a
// value in an answer; a service of the workspace only; the module hands its
// store to the cleaner and to the session runtime. Fake values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { createSecretsModule } from '../../src/modules/secrets.ts';
import { defaultRegistry, dispatch, MemoryUsers, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { knownTestValues, testVariablesOf } from '../../src/secrets/live.ts';
import { TEST_VALUES_PATH, type TestValuesView } from '../../src/secrets/types.ts';
import { HttpError } from '../../src/setup/http.ts';
import { SETUP_STEPS_TABLE, SetupRecords } from '../../src/setup/records.ts';
import type { StepDeps } from '../../src/setup/step.ts';
import SECRETS from '../../src/setup/steps/secrets.ts';
import { secretValues } from '../../src/session/clean.ts';
import type { UserId } from '../../src/session/contract.ts';
import { tempDir } from '../workspace/git.ts';

const PROOF = 'b'.repeat(64);
const fake = (n: number | string = 1): string => ['sandbox', 'fake', 'value', String(n)].join('-');

// A workspace of two services; the repositories are never read by these routes.
function workspace(): NodeJS.ProcessEnv {
  const state = tempDir('secrets-routes');
  const file = join(state, 'workspace.conf');
  writeFileSync(file, ['[workspace]', 'id = demo',
    '[service api]', 'repository = example-org/api', `url = ${join(state, 'api.git')}`, `dir = ${join(state, 'api')}`,
    '[service web]', 'repository = example-org/web', `url = ${join(state, 'web.git')}`, `dir = ${join(state, 'web')}`,
  ].join('\n') + '\n');
  return { CLEARED_V2_STATE_DIR: state, CLEARED_V2_WORKSPACE: file };
}

type Answer = { status: number; json: any; text: string };
type Call = (method: string, path: string, options?: { body?: unknown; user?: string | null; proof?: string | null }) => Promise<Answer>;

async function serve(env: NodeJS.ProcessEnv, run: (call: Call, answers: Answer[]) => Promise<void>): Promise<void> {
  const db = new DatabaseSync(':memory:');
  const users = new MemoryUsers();
  users.users.set('u1', { id: 'u1' as UserId, name: 'alex' });
  users.users.set('u2', { id: 'u2' as UserId, name: 'sam' });
  const module = createSecretsModule({ env, proof: () => PROOF });
  for (const table of module.tables) db.exec(table);
  const registry = { ...defaultRegistry(), ...module.provide({ store: { db } as never }), users };
  const app: App = { registry, tables: module.tables, routes: module.routes };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const answers: Answer[] = [];
  try {
    await run(async (method, path, { body, user = 'u1', proof = PROOF } = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (proof !== null) headers[SERVICE_PROOF_HEADER] = proof;
      if (user !== null) headers[SERVICE_USER_HEADER] = user;
      const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      const answer = { status: response.status, text, json: text ? JSON.parse(text) : undefined };
      answers.push(answer);
      return answer;
    }, answers);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

test('the Services screen\'s routes: set, list by name, date and person, replace and remove, never a value in an answer', async () => {
  await serve(workspace(), async (call, answers) => {
    const empty = (await call('GET', TEST_VALUES_PATH)).json as TestValuesView;
    assert.deepEqual(empty, { workspace: true, key: 'none', services: [{ name: 'api', inWorkspace: true, values: [] }, { name: 'web', inWorkspace: true, values: [] }] });

    const saved = await call('POST', TEST_VALUES_PATH, { body: { service: 'api', name: 'PAYMENT_SANDBOX_KEY', value: fake(1) } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.replaced, false);
    assert.equal(saved.json.value.name, 'PAYMENT_SANDBOX_KEY');
    assert.equal(saved.json.value.setBy, 'alex', 'the person by name');
    const replaced = await call('POST', TEST_VALUES_PATH, { body: { service: 'api', name: 'PAYMENT_SANDBOX_KEY', value: fake(2) }, user: 'u2' });
    assert.equal(replaced.json.replaced, true);

    const view = (await call('GET', TEST_VALUES_PATH)).json as TestValuesView;
    assert.equal(view.key, 'ready');
    const api = view.services.find((service) => service.name === 'api');
    assert.deepEqual(api?.values.map((value) => [value.name, value.setBy, value.readable]), [['PAYMENT_SANDBOX_KEY', 'sam', true]]);
    assert.match(api?.values[0]?.setAt ?? '', /^\d{4}-\d{2}-\d{2}T/);

    assert.deepEqual(testVariablesOf('api'), { PAYMENT_SANDBOX_KEY: fake(2) }, 'the session runtime reads the module\'s store');
    for (const value of [fake(1), fake(2)]) assert.ok(knownTestValues().includes(value) && secretValues({}).includes(value), 'the cleaner removes it');

    assert.equal((await call('POST', `${TEST_VALUES_PATH}/remove`, { body: { service: 'api', name: 'PAYMENT_SANDBOX_KEY' } })).status, 200);
    const again = await call('POST', `${TEST_VALUES_PATH}/remove`, { body: { service: 'api', name: 'PAYMENT_SANDBOX_KEY' } });
    assert.deepEqual([again.status, again.json], [404, { error: 'not_found' }]);
    assert.deepEqual(testVariablesOf('api'), {});

    for (const answer of answers) for (const value of [fake(1), fake(2)]) assert.ok(!answer.text.includes(value), 'no answer carries a value');
  });
});

test('a refusal is a code the screens say in words: a service outside the workspace, a bad name, a short value, a bad body', async () => {
  await serve(workspace(), async (call, answers) => {
    const refused = async (body: unknown) => {
      const answer = await call('POST', TEST_VALUES_PATH, { body });
      return [answer.status, answer.json?.error];
    };
    assert.deepEqual(await refused({ service: 'mail', name: 'PAYMENT_SANDBOX_KEY', value: fake() }), [400, 'service']);
    assert.deepEqual(await refused({ service: 'api', name: 'payment', value: fake() }), [400, 'name']);
    assert.deepEqual(await refused({ service: 'api', name: 'HOME', value: fake() }), [400, 'reserved']);
    assert.deepEqual(await refused({ service: 'api', name: 'PAYMENT_SANDBOX_KEY', value: 'short' }), [400, 'short']);
    assert.deepEqual(await refused({ service: 'api', name: 'PAYMENT_SANDBOX_KEY', value: 42 }), [400, 'body']);
    assert.deepEqual(await refused({ service: 'api', name: 'PAYMENT_SANDBOX_KEY', value: fake(), extra: true }), [400, 'body']);
    assert.ok(answers.every((answer) => !answer.text.includes(fake())));
  });
});

test('the app\'s proof first, then a person the service knows; the flow\'s own identities are not people', async () => {
  await serve(workspace(), async (call) => {
    assert.equal((await call('GET', TEST_VALUES_PATH, { proof: null })).status, 401);
    assert.equal((await call('GET', TEST_VALUES_PATH, { proof: 'c'.repeat(64) })).status, 401);
    assert.equal((await call('GET', TEST_VALUES_PATH, { user: null })).status, 403);
    assert.equal((await call('GET', TEST_VALUES_PATH, { user: 'u9' })).status, 403);
    assert.equal((await call('POST', TEST_VALUES_PATH, { user: 'cleared', body: { service: 'api', name: 'PAYMENT_SANDBOX_KEY', value: fake() } })).status, 403);
  });
});

test('no workspace: the view says so, and a write is refused', async () => {
  const state = tempDir('secrets-none');
  await serve({ CLEARED_V2_STATE_DIR: state }, async (call) => {
    assert.deepEqual((await call('GET', TEST_VALUES_PATH)).json, { workspace: false, key: 'none', services: [] });
    const answer = await call('POST', TEST_VALUES_PATH, { body: { service: 'api', name: 'PAYMENT_SANDBOX_KEY', value: fake() } });
    assert.deepEqual([answer.status, answer.json], [409, { error: 'no_workspace' }]);
  });
});

test('a value of a service no longer in the workspace is listed apart, so it can be removed', async () => {
  const env = workspace();
  await serve(env, async (call) => {
    await call('POST', TEST_VALUES_PATH, { body: { service: 'web', name: 'MAIL_TEST_PASSWORD', value: fake() } });
    writeFileSync(env.CLEARED_V2_WORKSPACE as string, ['[workspace]', 'id = demo', '[service api]', 'repository = example-org/api', `url = /nowhere/api.git`, `dir = /nowhere/api`].join('\n') + '\n');
    const view = (await call('GET', TEST_VALUES_PATH)).json as TestValuesView;
    assert.deepEqual(view.services.map((service) => [service.name, service.inWorkspace, service.values.length]), [['api', true, 0], ['web', false, 1]]);
    assert.equal((await call('POST', `${TEST_VALUES_PATH}/remove`, { body: { service: 'web', name: 'MAIL_TEST_PASSWORD' } })).status, 200);
    assert.deepEqual((await call('POST', TEST_VALUES_PATH, { body: { service: 'web', name: 'MAIL_TEST_PASSWORD', value: fake() } })).json, { error: 'service' });
  });
});

// ------------------------------------------------------------------ the step

async function step(env: NodeJS.ProcessEnv, run: (call: Call, records: SetupRecords) => Promise<void>): Promise<void> {
  const db = new DatabaseSync(':memory:');
  db.exec(SETUP_STEPS_TABLE);
  for (const table of SECRETS.tables ?? []) db.exec(table);
  const records = new SetupRecords(db);
  const deps = {
    db, records, env, fromEnvironment: new Set<string>(), fetch, now: () => new Date(),
    owner: async (context) => {
      if (context.request.headers[SERVICE_USER_HEADER] !== 'u1') throw new HttpError(403, 'the setup is the owner\'s');
      return { id: 'u1' as UserId, name: 'alex' };
    },
    onStop: () => undefined,
    container: undefined as never,
  } satisfies StepDeps;
  const users = new MemoryUsers();
  users.users.set('u1', { id: 'u1' as UserId, name: 'alex' });
  const app: App = { registry: { ...defaultRegistry(), users }, tables: [], routes: SECRETS.routes?.(deps) ?? [] };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (method, path, { body, user = 'u1' } = {}) => {
      const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(user === null ? {} : { [SERVICE_USER_HEADER]: user }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, text, json: text ? JSON.parse(text) : undefined };
    }, records);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

test('the assistant\'s step is filled and may be skipped; the owner adds values, and Done needs one', async () => {
  assert.equal(SECRETS.id, 'secrets');
  assert.equal(SECRETS.filled, true);
  assert.equal(SECRETS.skippable, true);
  await step(workspace(), async (call, records) => {
    assert.equal((await call('GET', '/api/setup/secrets', { user: 'u2' })).status, 403, 'the owner\'s only');
    assert.deepEqual((await call('POST', '/api/setup/secrets/done')).json, { error: 'empty' }, 'nothing to finish: skip instead');
    const saved = await call('POST', '/api/setup/secrets', { body: { service: 'api', name: 'PAYMENT_SANDBOX_KEY', value: fake() } });
    assert.equal(saved.status, 200);
    assert.ok(!saved.text.includes(fake()));
    const view = (await call('GET', '/api/setup/secrets')).json as TestValuesView;
    assert.deepEqual(view.services.find((service) => service.name === 'api')?.values.map((value) => [value.name, value.setBy]), [['PAYMENT_SANDBOX_KEY', 'alex']]);
    assert.ok(!JSON.stringify(view).includes(fake()));
    assert.equal(records.get('secrets')?.doneAt ?? null, null, 'a value saved does not end the step');
    assert.deepEqual((await call('POST', '/api/setup/secrets/done')).json, { done: true });
    assert.notEqual(records.get('secrets')?.doneAt ?? null, null);
    assert.equal((await call('POST', '/api/setup/secrets/remove', { body: { service: 'api', name: 'PAYMENT_SANDBOX_KEY' } })).status, 200);
  });
});
