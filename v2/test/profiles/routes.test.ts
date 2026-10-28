// The profiles' routes (issue #452): both histories read, an edit a new
// version, a rollback a new version that copies an old one, behind the
// app's proof and a person the service knows; a refusal says its code and
// never the value. The flow module serves them. Fictitious values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import flow from '../../src/modules/flow.ts';
import { defaultRegistry, dispatch, MemoryUsers, type App } from '../../src/modules/registry.ts';
import { profileRoutes } from '../../src/profiles/routes.ts';
import { PROFILES_PATH, type ProfilesView } from '../../src/profiles/types.ts';
import { handle } from '../../src/server.ts';
import type { UserId } from '../../src/session/contract.ts';
import { openStore } from '../../src/store/db.ts';

const PROOF = 'c'.repeat(64);

type Answer = { status: number; json: any; text: string };
type Call = (method: string, path: string, options?: { body?: unknown; user?: string | null; proof?: string | null }) => Promise<Answer>;

async function serve(run: (call: Call) => Promise<void>): Promise<void> {
  const store = openStore(':memory:');
  const users = new MemoryUsers();
  users.users.set('u1', { id: 'u1' as UserId, name: 'alex' });
  users.users.set('u2', { id: 'u2' as UserId, name: 'sam' });
  const routes = profileRoutes({ db: () => store.db, proof: () => PROOF });
  const app: App = { registry: { ...defaultRegistry(), users }, tables: [], routes };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (method, path, { body, user = 'u1', proof = PROOF } = {}) => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (proof !== null) headers[SERVICE_PROOF_HEADER] = proof;
      if (user !== null) headers[SERVICE_USER_HEADER] = user;
      const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, text, json: text ? JSON.parse(text) : undefined };
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
}

test('the flow module serves the profiles\' routes', () => {
  const paths = flow.routes.map((route) => `${route.method} ${route.path}`);
  for (const route of [`GET ${PROFILES_PATH}`, `POST ${PROFILES_PATH}/agent`, `POST ${PROFILES_PATH}/agent/restore`, `POST ${PROFILES_PATH}/environment`, `POST ${PROFILES_PATH}/environment/restore`])
    assert.ok(paths.includes(route), route);
});

test('the histories, an edit and a rollback through the API, each version by its person', async () => {
  await serve(async (call) => {
    const first = (await call('GET', PROFILES_PATH)).json as ProfilesView;
    assert.equal(first.profile.current, 1);
    assert.equal(first.environment.current, 1);
    assert.equal(first.profile.versions[0]?.createdBy, null, 'the service\'s first version names no person');

    const edited = await call('POST', `${PROFILES_PATH}/agent`, { body: { authorModel: 'claude-opus-5-1', harness: 'auto' } });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.json.version, 2);
    assert.equal(edited.json.createdBy, 'alex');
    assert.equal(edited.json.body.harness, 'auto');

    const back = await call('POST', `${PROFILES_PATH}/agent/restore`, { body: { version: 1 }, user: 'u2' });
    assert.equal(back.status, 200, back.text);
    assert.deepEqual([back.json.version, back.json.restoredFrom, back.json.createdBy, back.json.body.harness], [3, 1, 'sam', 'claude-code']);

    const env = await call('POST', `${PROFILES_PATH}/environment`, { body: { memory: '2g' } });
    assert.equal(env.json.version, 2);
    const envBack = await call('POST', `${PROFILES_PATH}/environment/restore`, { body: { version: 1 } });
    assert.deepEqual([envBack.json.version, envBack.json.body.memory], [3, null]);

    const view = (await call('GET', PROFILES_PATH)).json as ProfilesView;
    assert.deepEqual(view.profile.versions.map((v) => v.version), [1, 2, 3]);
    assert.equal(view.profile.current, 3);
    assert.equal(view.profile.versions[1]?.body.authorModel, 'claude-opus-5-1', 'version 2 stays as it was');
    assert.deepEqual(view.environment.versions.map((v) => v.version), [1, 2, 3]);
  });
});

test('a refusal is a code, never the value; a refused write adds no version', async () => {
  await serve(async (call) => {
    const value = ['ghp', 'Q7f2L9m4R1t8V3w6Y0z5B2c7N4h9K1j3P6sD'].join('_');
    const secret = await call('POST', `${PROFILES_PATH}/agent`, { body: { rolePrompts: { author: `Use ${value}.`, reviewer: '' } } });
    assert.deepEqual([secret.status, secret.json], [400, { error: 'sensitive' }]);
    assert.ok(!secret.text.includes(value));
    assert.deepEqual((await call('POST', `${PROFILES_PATH}/agent`, { body: { harness: 'cursor' } })).json, { error: 'harness' });
    assert.deepEqual((await call('POST', `${PROFILES_PATH}/agent/restore`, { body: { version: 'one' } })).json, { error: 'version' });
    assert.deepEqual((await call('POST', `${PROFILES_PATH}/agent/restore`, { body: { version: 7 } })).json, { error: 'version' });
    assert.deepEqual((await call('POST', `${PROFILES_PATH}/agent/restore`, { body: { version: 1 } })).json, { error: 'unchanged' });
    assert.deepEqual((await call('POST', `${PROFILES_PATH}/environment`, { body: { image: 'ubuntu:latest' } })).json, { error: 'image' });
    const view = (await call('GET', PROFILES_PATH)).json as ProfilesView;
    assert.equal(view.profile.versions.length, 1);
    assert.equal(view.environment.versions.length, 1);
  });
});

test('only the app, for a person the service knows', async () => {
  await serve(async (call) => {
    assert.equal((await call('GET', PROFILES_PATH, { proof: null })).status, 401);
    assert.equal((await call('GET', PROFILES_PATH, { proof: 'd'.repeat(64) })).status, 401);
    assert.equal((await call('POST', `${PROFILES_PATH}/agent`, { body: { harness: 'auto' }, user: null })).status, 403);
    assert.equal((await call('POST', `${PROFILES_PATH}/agent`, { body: { harness: 'auto' }, user: 'lead' })).status, 403);
    assert.equal((await call('POST', `${PROFILES_PATH}/agent`, { body: { harness: 'auto' }, user: 'u9' })).status, 403);
    assert.equal(((await call('GET', PROFILES_PATH)).json as ProfilesView).profile.versions.length, 1);
  });
});
