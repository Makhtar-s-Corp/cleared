// The assistant's environment step (docs/v2/milestone-5-plan.md, sections 1
// and 10, step 6, matrix C15): each service of the workspace with what its
// base holds (the devcontainer file, the install command) and its prepared
// image; Build starts the builds and answers at once; the view then shows
// each image ready with its build's time, or failed with its reason. The
// step is done when every service has a ready image, and the builds count
// as the machine's time. Once an image is ready, the service's declared
// check runs in it; a service with no .devcontainer, whose image did not
// build or whose check failed is proposed a setup session (C4), a ticket of
// the environment template started from here. The owner's only. Against a
// fake `docker`, a fake flow and temporary repositories.
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
import { ENVIRONMENT_LABEL } from '../../src/flow/env-setup.ts';
import { MemoryTicketStore } from '../../src/tickets/contract.ts';
import { defaultRegistry, dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { HttpError } from '../../src/setup/http.ts';
import { SETUP_STEPS_TABLE, SetupRecords } from '../../src/setup/records.ts';
import type { StepDeps } from '../../src/setup/step.ts';
import ENVIRONMENT, { environmentStep, type SetupFlow } from '../../src/setup/steps/environment.ts';
import { FakeDocker } from '../container/fake-docker.ts';
import { project } from '../container/prepared-fixture.ts';
import { tempDir } from '../workspace/git.ts';

type Call = (method: string, path: string, user?: string, body?: unknown) => Promise<{ status: number; json: any }>;

// The running flow as the step sees it: its tickets in memory, the starts recorded.
function fakeFlow(services: readonly string[]) {
  const begun: string[] = [];
  const flow: SetupFlow = { project: 'demo', services, tickets: new MemoryTicketStore(), begin: (ticket, by) => { begun.push(`${ticket}:${by}`); } };
  return { flow, begun };
}

async function serve(env: NodeJS.ProcessEnv, fake: FakeDocker, run: (call: Call, records: SetupRecords) => Promise<void>, flow?: SetupFlow): Promise<void> {
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
  const step = environmentStep((stateDir) => new PreparedImages({ docker: new Docker(fake.runner), stateDir }), () => flow);
  const app: App = { registry: defaultRegistry(), tables: [], routes: step.routes?.(deps) ?? [] };
  const server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await run(async (method, path, user = 'owner', body = {}) => {
      const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
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
    assert.deepEqual((await call('GET', '/api/setup/environment')).json, { workspace: false, services: [], sessions: 'no_flow' });
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
    assert.deepEqual(first.services.map((s) => s.foreignImage), [null, null], 'Cleared\'s session image under any tag is not another image');

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

const SESSION = { service: 'api', title: 'Prepare the environment of api', body: '## The service\napi' };

test('once an image is ready its declared check runs in it, on the base\'s tree with no network; a service with no .devcontainer is proposed a setup session', async () => {
  const fake = new FakeDocker();
  const ran: string[][] = [];
  fake.execAnswer = (command) => { ran.push([...command]); return { code: 0, stdout: '# pass 4\n', stderr: '' }; };
  const env = workspace({
    api: project({}, null, 'api'),
    web: project({ '.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n', '.cleared/agents.conf': '[merge]\nverdict = ok\n[session]\ntest_command = npm run check\n' }, null, 'web'),
  });
  await serve(env, fake, async (call) => {
    const first = (await call('GET', '/api/setup/environment')).json as EnvironmentView;
    assert.deepEqual(first.services.map((s) => [s.name, s.checkCommand, s.check, s.proposal]), [['api', 'npm test', null, 'no_devcontainer'], ['web', 'npm run check', null, null]]);
    await call('POST', '/api/setup/environment/build');
    const view = await settled(call);
    assert.deepEqual(ran, [['npm', 'test'], ['npm', 'run', 'check']]);
    const creates = fake.calls.filter((c) => c.args[0] === 'create').map((c) => c.args);
    assert.equal(creates.length, 2);
    for (const args of creates) {
      assert.ok(args.includes('name=none'), 'no network');
      assert.match(args.find((a) => a.startsWith('type=bind,')) ?? '', /,target=\/workspace$/);
      assert.match(args.at(args.indexOf('--') + 1) ?? '', /^cleared-v2-prep-(api|web):[0-9a-f]{16}$/, 'in the prepared image itself');
    }
    assert.deepEqual(view.services.map((s) => [s.check?.passed, s.check?.tail, s.proposal]), [[true, '# pass 4', 'no_devcontainer'], [true, '# pass 4', null]]);
    assert.equal(fake.containers.length, 0, 'the checks\' containers are removed');
    assert.equal(fake.images.length, 2, 'the prepared images are kept');

    await call('POST', '/api/setup/environment/build');
    await settled(call);
    assert.equal(ran.length, 2, 'a check that passed on this image does not run again');
  }, fakeFlow(['api', 'web']).flow);
});

test('a check that fails in its image proposes a setup session and runs again at the next Build; a failed build proposes one too', async () => {
  const fake = new FakeDocker();
  let code = 1;
  const env = workspace({ api: project({ '.devcontainer/devcontainer.json': '{ "image": "cleared-v2-session:latest" }\n' }, null, 'api') });
  const secret = ['made', 'at', 'run', 'time', String(process.pid)].join('-');
  env.CLEARED_V2_EXAMPLE_TOKEN = secret;
  fake.execAnswer = () => ({ code, stdout: `not ok 1 - sqlite3: command not found\nconnecting with ${secret} from ${env.CLEARED_V2_STATE_DIR}/x\n`, stderr: '' });
  await serve(env, fake, async (call) => {
    await call('POST', '/api/setup/environment/build');
    let view = await settled(call);
    assert.equal(view.services[0]?.state, 'ready');
    assert.equal(view.services[0]?.check?.passed, false);
    assert.match(view.services[0]?.check?.tail ?? '', /sqlite3: command not found/);
    assert.doesNotMatch(JSON.stringify(view), new RegExp(`${secret}|${env.CLEARED_V2_STATE_DIR}`), 'cleaned before it is kept and shown');
    assert.equal(view.services[0]?.proposal, 'check_failed');
    code = 0;
    await call('POST', '/api/setup/environment/build');
    view = await settled(call);
    assert.equal(view.services[0]?.check?.passed, true, 'checked again');
    assert.equal(view.services[0]?.proposal, null);
  }, fakeFlow(['api']).flow);

  const broken = new FakeDocker();
  broken.intercept = (args) => (args[0] === 'build' ? { code: 1, stdout: '', stderr: 'E: Unable to locate package sqlite3' } : undefined);
  await serve(workspace({ api: project({}, null, 'api') }), broken, async (call) => {
    await call('POST', '/api/setup/environment/build');
    const view = await settled(call);
    assert.equal(view.services[0]?.proposal, 'build_failed');
    assert.equal(view.services[0]?.check, null);
    assert.ok(!broken.calls.some((c) => c.args[0] === 'exec'), 'no check without an image');
  }, fakeFlow(['api']).flow);
});

test('a setup session starts from the step: a ticket of the environment template on that service, started as its owner; the open one is answered after', async () => {
  const { flow, begun } = fakeFlow(['api', 'web']);
  await serve(workspace({ api: project({}, null, 'api'), web: project({}, null, 'web') }), new FakeDocker(), async (call) => {
    assert.equal((await call('GET', '/api/setup/environment')).json.sessions, 'ready');
    const made = await call('POST', '/api/setup/environment/session', 'owner', SESSION);
    assert.equal(made.status, 200);
    assert.deepEqual(made.json, { ticket: 'LOCAL-1', created: true });
    const ticket = await flow.tickets.get('LOCAL-1');
    assert.equal(ticket?.title, SESSION.title);
    assert.equal(ticket?.body, SESSION.body);
    assert.deepEqual(ticket?.labels, [ENVIRONMENT_LABEL]);
    assert.deepEqual(ticket?.services?.map((s) => s.name), ['api'], 'on that service of the workspace');
    assert.deepEqual(begun, ['LOCAL-1:u1']);

    const again = await call('POST', '/api/setup/environment/session', 'owner', SESSION);
    assert.deepEqual(again.json, { ticket: 'LOCAL-1', created: false }, 'one open session per service');
    assert.deepEqual(begun, ['LOCAL-1:u1']);
    const view = (await call('GET', '/api/setup/environment')).json as EnvironmentView;
    assert.deepEqual(view.services.map((s) => [s.name, s.setupTicket]), [['api', 'LOCAL-1'], ['web', null]]);

    await flow.tickets.move('LOCAL-1', flow.tickets.states.done, { kind: 'human', id: 'u1' });
    assert.deepEqual(((await call('GET', '/api/setup/environment')).json as EnvironmentView).services.map((s) => s.setupTicket), [null, null], 'a done one is not open');
  }, flow);
});

test('a setup session is refused without the flow, for a service the flow does not know yet, for another service, a bad body, or another person', async () => {
  const env = workspace({ api: project({}, null, 'api'), web: project({}, null, 'web') });
  await serve(env, new FakeDocker(), async (call) => {
    const refused = await call('POST', '/api/setup/environment/session', 'owner', SESSION);
    assert.deepEqual([refused.status, refused.json.error], [409, 'no_flow']);
  });
  const { flow, begun } = fakeFlow(['api']);
  await serve(env, new FakeDocker(), async (call) => {
    assert.equal((await call('GET', '/api/setup/environment')).json.sessions, 'restart', 'web was connected after the flow read its workspace');
    const later = await call('POST', '/api/setup/environment/session', 'owner', { ...SESSION, service: 'web' });
    assert.deepEqual([later.status, later.json.error], [409, 'restart']);
    const unknown = await call('POST', '/api/setup/environment/session', 'owner', { ...SESSION, service: 'billing' });
    assert.deepEqual([unknown.status, unknown.json.error], [400, 'unknown_service']);
    for (const body of [{}, { ...SESSION, title: '  ' }, { ...SESSION, title: 'x'.repeat(201) }, { ...SESSION, body: 7 }]) {
      const bad = await call('POST', '/api/setup/environment/session', 'owner', body);
      assert.deepEqual([bad.status, bad.json.error], [400, 'invalid'], JSON.stringify(body));
    }
    assert.equal((await call('POST', '/api/setup/environment/session', 'someone', SESSION)).status, 403);
    assert.deepEqual(begun, []);
    assert.deepEqual(await flow.tickets.list(), []);
  }, flow);
});
