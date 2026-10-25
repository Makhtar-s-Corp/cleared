// The assistant's environment step (docs/v2/milestone-5-plan.md, sections 1
// and 10, step 6, matrix C15): each service of the workspace with what its
// base holds (the devcontainer file, the install command) and its prepared
// image; Build starts the builds and answers at once; the view then shows
// each image ready with its build's time, or failed with its reason. The
// step is done when every service has a ready image, and the builds count
// as the machine's time. The owner's only. Against a fake `docker` and
// temporary repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Docker } from '../../src/container/docker.ts';
import { PreparedImages } from '../../src/container/prepared.ts';
import type { EnvironmentView } from '../../src/container/types.ts';
import { defaultRegistry, dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { HttpError } from '../../src/setup/http.ts';
import { SETUP_STEPS_TABLE, SetupRecords } from '../../src/setup/records.ts';
import type { StepDeps } from '../../src/setup/step.ts';
import ENVIRONMENT, { environmentStep } from '../../src/setup/steps/environment.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { project } from '../container/prepared-fixture.ts';
import { tempDir } from '../workspace/git.ts';

type Call = (method: string, path: string, user?: string) => Promise<{ status: number; json: any }>;

async function serve(env: NodeJS.ProcessEnv, fake: FakeDocker, run: (call: Call, records: SetupRecords) => Promise<void>): Promise<void> {
  const db = new DatabaseSync(':memory:');
  db.exec(SETUP_STEPS_TABLE);
  const records = new SetupRecords(db);
  const deps = {
    db, records, env, fromEnvironment: new Set<string>(), fetch, now: () => new Date(),
    owner: async (context) => {
      if (context.request.headers['x-test-user'] !== 'owner') throw new HttpError(403, 'the setup is the owner\'s');
      return { id: 'u1', name: 'alex' } as never;
    },
    onStop: () => undefined,
    container: undefined as never,
  } satisfies StepDeps;
  const step = environmentStep((stateDir) => new PreparedImages({ docker: new Docker(fake.runner), stateDir }));
  const app: App = { registry: defaultRegistry(), tables: [], routes: step.routes?.(deps) ?? [] };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (method, path, user = 'owner') => {
      const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, ...(method === 'POST' ? { body: '{}' } : {}) });
      return { status: response.status, json: await response.json() };
    }, records);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

function workspace(services: Record<string, ReturnType<typeof project>>): NodeJS.ProcessEnv {
  const state = tempDir('environment');
  const file = join(state, 'workspace.conf');
  writeFileSync(file, ['[workspace]', 'id = demo', ...Object.entries(services).flatMap(([name, made]) => [
    `[service ${name}]`, `repository = example-org/${name}`, `url = ${made.bare}`, `dir = ${made.dir}`,
  ])].join('\n') + '\n');
  return { CLEARED_V2_STATE_DIR: state, CLEARED_V2_WORKSPACE: file };
}

async function settled(call: Call): Promise<EnvironmentView> {
  for (let tries = 0; tries < 200; tries += 1) {
    const view = (await call('GET', '/api/setup/environment')).json as EnvironmentView;
    if (!view.services.some((service) => service.state === 'building')) return view;
    await sleep(10);
  }
  throw new Error('the builds never ended');
}

test('the step is filled, may be skipped, and its file is the registry\'s', () => {
  assert.equal(ENVIRONMENT.id, 'environment');
  assert.equal(ENVIRONMENT.filled, true);
  assert.equal(ENVIRONMENT.skippable, true);
});

test('no workspace yet: the view says so, and a build is refused', async () => {
  const fake = new FakeDocker();
  await serve({ CLEARED_V2_STATE_DIR: tempDir('environment') }, fake, async (call) => {
    assert.deepEqual((await call('GET', '/api/setup/environment')).json, { workspace: false, services: [] });
    const refused = await call('POST', '/api/setup/environment/build');
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, 'no_workspace');
    assert.equal(fake.calls.length, 0, 'Docker is not asked');
  });
});

test('each service with its devcontainer file, its install command and its image; Build answers at once, then each image is ready with its time and the step done', async () => {
  const fake = new FakeDocker();
  const env = workspace({
    api: project({}, null, 'api'),
    web: project({ '.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n', '.cleared/agents.conf': '[merge]\nverdict = ok\n' }, null, 'web'),
  });
  await serve(env, fake, async (call, records) => {
    const first = (await call('GET', '/api/setup/environment')).json as EnvironmentView;
    assert.equal(first.workspace, true);
    assert.deepEqual(first.services.map((s) => [s.name, s.devcontainer, s.install, s.state]), [['api', 'none', 'npm ci', 'none'], ['web', 'image', null, 'none']]);
    assert.equal(fake.calls.length, 0, 'reading the view asks Docker nothing');

    const started = await call('POST', '/api/setup/environment/build');
    assert.equal(started.status, 202);
    const view = await settled(call);
    for (const service of view.services) {
      assert.equal(service.state, 'ready', service.name);
      assert.match(service.image ?? '', new RegExp(`^cleared-v2-prep-${service.name}:[0-9a-f]{16}$`));
      assert.equal(typeof service.buildMs, 'number');
      assert.ok(service.builtAt);
    }
    assert.ok(records.get('environment')?.doneAt, 'every service ready: the step is done');
    assert.equal(records.get('environment')?.machineMs !== undefined, true);

    const again = await call('POST', '/api/setup/environment/build');
    assert.equal(again.status, 202);
    await settled(call);
    assert.equal(fake.calls.filter((c) => c.args[0] === 'build').length, 2, 'nothing changed: nothing built again');
  });
});

test('a failed build says its reason, and the step is not done', async () => {
  const fake = new FakeDocker();
  fake.intercept = (args) => (args[0] === 'build' ? { code: 1, stdout: '', stderr: 'npm error code ERESOLVE' } : undefined);
  await serve(workspace({ api: project({}, null, 'api') }), fake, async (call, records) => {
    await call('POST', '/api/setup/environment/build');
    const view = await settled(call);
    assert.equal(view.services[0]?.state, 'failed');
    assert.match(view.services[0]?.error ?? '', /ERESOLVE/);
    assert.equal(records.get('environment')?.doneAt ?? null, null);
  });
});

test('the step is the owner\'s', async () => {
  await serve(workspace({ api: project({}, null, 'api') }), new FakeDocker(), async (call) => {
    assert.equal((await call('GET', '/api/setup/environment', 'someone')).status, 403);
    assert.equal((await call('POST', '/api/setup/environment/build', 'someone')).status, 403);
  });
});
