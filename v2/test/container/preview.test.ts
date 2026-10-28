// The trial environment of a session (milestone 2 plan, decision 20): the
// preview route answers what the session's own `run` sibling answers, under
// the session's unguessable preview key, every answer sandboxed and without
// a cookie; and the runtime issues that key, and the session's siblings and
// skills, when it starts a session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER } from '../../src/api/types.ts';
import { Docker } from '../../src/container/docker.ts';
import { PREVIEW_DEPTH, PREVIEW_POLICY, previewRoutes, type PreviewTarget } from '../../src/container/preview.ts';
import { sessionNames } from '../../src/container/session-runtime.ts';
import { createRuntime } from '../../src/flow/runtime.ts';
import { defaultRegistry, matchRoute, type Route } from '../../src/modules/registry.ts';
import { previewAddress } from '../../src/flow/proof-capture.ts';
import type { SessionAdapter, SessionHandle, StartInput } from '../../src/session/contract.ts';
import { openStore } from '../../src/store/db.ts';
import { projectCheckout } from '../../src/workspace/checkout.ts';
import { FakeDocker } from './fake-docker.ts';
import { remote, tempDir } from '../workspace/git.ts';

const SESSION = '0b7f3c1e-5d0a-4a6e-9f3b-1c2d3e4f5a6b';
const KEY = 'k'.repeat(43);
const PROOF = 'p'.repeat(64);

type Captured = { status?: number; headers: Record<string, string>; body: Buffer };

function call(route: Route, params: Record<string, string>, options: { proof?: string; url?: string } = {}): Promise<Captured> {
  const captured: Captured = { headers: {}, body: Buffer.alloc(0) };
  return new Promise((resolve, reject) => {
    const response = {
      headersSent: false,
      writeHead(status: number, headers: Record<string, string>) { captured.status = status; captured.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])); this.headersSent = true; return this; },
      end(body?: string | Buffer) { captured.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? ''); resolve(captured); },
      destroy() { reject(new Error('destroyed')); },
    };
    const request = { method: 'GET', url: options.url ?? '/', headers: options.proof === undefined ? {} : { [SERVICE_PROOF_HEADER]: options.proof } };
    Promise.resolve(route.handle({ request, response, params, registry: defaultRegistry() } as never)).catch(reject);
  });
}

// A fake docker whose egress container answers the relay with `answer`.
function setup(answer: (url: string) => object = () => ({ status: 200, headers: [['content-type', 'text/html']], body: Buffer.from('<p>hi</p>').toString('base64') })) {
  const fake = new FakeDocker();
  const labels = { 'cleared.dev': 'v2', 'cleared.session': SESSION };
  fake.containers.push({ id: 'e'.repeat(64), name: sessionNames(SESSION).egress, labels, state: 'running' });
  // The guestbook's sibling, second on the list: 172.30.0.3 on the session network.
  fake.containers.push({ id: 'd'.repeat(64), name: sessionNames(SESSION).sibling('guestbook'), labels, state: 'running', args: ['create', '--network', `name=${sessionNames(SESSION).network},alias=guestbook`] });
  const urls: string[] = [];
  fake.execAnswer = (command) => {
    const url = command[3] ?? '';
    urls.push(url);
    return { code: 0, stdout: JSON.stringify(answer(url)) + '\n', stderr: '' };
  };
  const target = (id: string): PreviewTarget | undefined => (id === SESSION ? { session: SESSION, key: KEY, alias: 'guestbook', port: 8793 } : undefined);
  const routes = previewRoutes({ proof: () => PROOF, target, docker: () => new Docker(fake.runner) });
  const at = (depth: number) => routes.find((route) => route.path.split('/').length === 6 + depth) as Route;
  return { fake, urls, routes, at };
}

test('the preview is a GET under the session and its key, at every depth up to the bound', () => {
  const { routes } = setup();
  assert.equal(routes.length, PREVIEW_DEPTH + 2);
  const root = routes.at(-1);
  assert.equal(root?.method, 'GET');
  assert.equal(root?.path, '/api/sessions/:id/preview/:key/');
  for (const [depth, route] of routes.slice(0, -1).entries()) {
    assert.equal(route.method, 'GET');
    assert.equal(route.path, ['/api/sessions/:id/preview/:key', ...Array.from({ length: depth }, (_, i) => `:p${i}`)].join('/'));
  }
});

// The proof receipt's after page (P210) opens the address previewAddress
// builds, the root with its trailing slash, so the page's relative links stay
// under its key; the real run of 2026-10-28 got the router's 404 there.
test('the receipt\'s after page, the root with its trailing slash, reaches the sibling\'s root', async () => {
  const { routes, urls } = setup();
  const url = new URL(previewAddress({ host: '127.0.0.1', port: 8791 }, { session: SESSION, key: KEY, alias: 'guestbook', port: 8793 }, PROOF).url);
  const match = matchRoute(routes, 'GET', url.pathname);
  assert.ok(match && 'route' in match, `no route for ${url.pathname}`);
  const answer = await call(match.route, match.params, { proof: PROOF, url: url.pathname });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.toString(), '<p>hi</p>');
  assert.deepEqual(urls, ['http://172.30.0.3:8793/']);
  // Without the slash, the same root.
  const bare = matchRoute(routes, 'GET', url.pathname.slice(0, -1));
  assert.ok(bare && 'route' in bare);
  await call(bare.route, bare.params, { proof: PROOF });
  assert.deepEqual(urls, ['http://172.30.0.3:8793/', 'http://172.30.0.3:8793/']);
});

test('without the app\'s proof the preview answers 401 and reaches nothing', async () => {
  const { at, fake } = setup();
  for (const proof of [undefined, 'wrong']) {
    const answer = await call(at(0), { id: SESSION, key: KEY }, proof === undefined ? {} : { proof });
    assert.equal(answer.status, 401);
  }
  assert.deepEqual(fake.calls, []);
});

test('an unknown session and a wrong key get the same 404, and reach nothing', async () => {
  const { at, fake } = setup();
  const unknown = await call(at(0), { id: '9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d', key: KEY }, { proof: PROOF });
  const wrong = await call(at(0), { id: SESSION, key: 'k'.repeat(42) + 'x' }, { proof: PROOF });
  const short = await call(at(0), { id: SESSION, key: 'k' }, { proof: PROOF });
  for (const answer of [unknown, wrong, short]) {
    assert.equal(answer.status, 404);
    assert.equal(answer.body.toString(), unknown.body.toString());
  }
  assert.deepEqual(fake.calls, []);
});

test('the sibling\'s answer comes back sandboxed, with no cookie and none of its own policy, bytes intact', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x01]);
  const { at, fake, urls } = setup(() => ({
    status: 201,
    headers: [['content-type', 'image/png'], ['set-cookie', 'session=stolen'], ['Set-Cookie2', 'x=y'], ['content-security-policy', "default-src *"], ['transfer-encoding', 'chunked'], ['content-encoding', 'gzip'], ['x-app', 'kept']],
    body: png.toString('base64'),
  }));
  const answer = await call(at(2), { id: SESSION, key: KEY, p0: 'static', p1: 'logo.png' }, { proof: PROOF, url: `/api/sessions/${SESSION}/preview/${KEY}/static/logo.png?v=2&x=a%20b` });
  assert.equal(answer.status, 201);
  assert.deepEqual(answer.body, png);
  assert.equal(answer.headers['content-security-policy'], PREVIEW_POLICY);
  assert.equal(PREVIEW_POLICY, 'sandbox allow-scripts allow-forms');
  assert.equal(answer.headers['set-cookie'], undefined);
  assert.equal(answer.headers['set-cookie2'], undefined);
  assert.equal(answer.headers['content-encoding'], undefined, 'the relay decoded the body');
  assert.equal(answer.headers['transfer-encoding'], undefined);
  assert.equal(answer.headers['content-type'], 'image/png');
  assert.equal(answer.headers['content-length'], String(png.length));
  assert.equal(answer.headers['x-app'], 'kept');
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.deepEqual(urls, ['http://172.30.0.3:8793/static/logo.png?v=2&x=a%20b'], 'the sibling\'s address on the session network, never its name');
  // From the session's own egress container, found by a labelled list.
  const exec = fake.calls.find((c) => c.args[0] === 'exec');
  assert.equal(exec?.args[exec.args.indexOf('--') + 1], 'e'.repeat(64));
  assert.deepEqual(exec?.args.slice(exec.args.indexOf('--') + 2, exec.args.indexOf('--') + 4), ['node', '-e']);
});

test('a segment that decodes to a slash or to dots stays one segment of the sibling\'s path', async () => {
  const { at, urls } = setup();
  await call(at(2), { id: SESSION, key: KEY, p0: '..', p1: '../../etc/passwd' }, { proof: PROOF });
  await call(at(1), { id: SESSION, key: KEY, p0: '@evil.example:80' }, { proof: PROOF, url: '/x?next=http://evil.example/' });
  assert.deepEqual(urls, ['http://172.30.0.3:8793/%2E%2E/..%2F..%2Fetc%2Fpasswd', 'http://172.30.0.3:8793/%40evil.example%3A80?next=http://evil.example/']);
});

test('a sibling that does not answer, or a stopped session, is a 502 with no detail of the host', async () => {
  const failing = setup(() => ({ error: 'TypeError' }));
  const answer = await call(failing.at(0), { id: SESSION, key: KEY }, { proof: PROOF });
  assert.equal(answer.status, 502);
  assert.equal(answer.headers['content-security-policy'], PREVIEW_POLICY);
  const stopped = setup();
  stopped.fake.containers.length = 0;
  const gone = await call(stopped.at(0), { id: SESSION, key: KEY }, { proof: PROOF });
  assert.equal(gone.status, 502);
  assert.doesNotMatch(gone.body.toString(), /cleared-v2-|docker/);
  // A sibling that exited is not asked by its name: nothing is relayed.
  const exited = setup();
  (exited.fake.containers[1] as { state?: string }).state = 'exited';
  assert.equal((await call(exited.at(0), { id: SESSION, key: KEY }, { proof: PROOF })).status, 502);
  assert.deepEqual(exited.urls, []);
});

// ---------------------------------------------------------- the runtime

const WORKSPACE = (dirs: { guestbook: string; filter: string }) => `[workspace]
id = guestbook
name = Guestbook and filter API

[service guestbook]
repository = example-org/cleared-example-guestbook
url = https://github.com/example-org/cleared-example-guestbook.git
dir = ${dirs.guestbook}
consumes = filter-api
run = Dockerfile 8793

[service filter-api]
repository = example-org/cleared-example-filter-api
url = https://github.com/example-org/cleared-example-filter-api.git
dir = ${dirs.filter}
run = Dockerfile 8795
contract = openapi:contract/openapi.yaml
`;

const CONTRACT = readFileSync(new URL('./fixtures/filter-api.openapi.yaml', import.meta.url), 'utf8');
const SKILL = '---\nname: cleared-guestbook\ndescription: The guestbook.\n---\n';

async function runtimeSetup() {
  const root = tempDir('runtime');
  const guestbook = await projectCheckout({ url: remote({ Dockerfile: 'FROM node:24-slim\n', 'package.json': '{}\n', '.claude/skills/cleared-guestbook/SKILL.md': SKILL }), dir: join(root, 'services', 'guestbook'), base: 'main' });
  const filter = await projectCheckout({ url: remote({ Dockerfile: 'FROM node:24-slim\n', 'contract/openapi.yaml': CONTRACT }), dir: join(root, 'services', 'filter-api'), base: 'main' });
  writeFileSync(join(root, 'workspace.conf'), WORKSPACE({ guestbook: guestbook.dir, filter: filter.dir }));
  const env = { CLEARED_V2_WORKSPACE: join(root, 'workspace.conf'), CLEARED_V2_STATE_DIR: join(root, 'state'), CLEARED_V2_WORKDIRS: join(root, 'work') };
  const starts: StartInput[] = [];
  let next = 0;
  const ids = [SESSION, '9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d', '00000000-0000-4000-8000-000000000003'];
  const adapter: SessionAdapter = {
    harness: 'claude-code',
    async start(input) { starts.push(input); return { id: ids[next++] } as SessionHandle; },
    async resume(id) { return { id } as SessionHandle; },
  };
  const store = openStore(':memory:');
  const runtime = createRuntime({ env, effects: () => ({}) as never, factories: { 'claude-code': () => adapter } });
  runtime.attach({ store });
  const workdir = join(root, 'work', 'LOCAL-1', 'guestbook');
  mkdirSync(workdir, { recursive: true });
  const input = (overrides: Partial<StartInput> = {}): StartInput => ({
    project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', workdir, prompt: '',
    briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
    policy: { role: 'author', base: 'main', workdir: '/workspace', scripts: [], credentialFile: '/run/cleared/claude.token', safeCommands: [], allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [] },
    ...overrides,
  });
  return { root, guestbook, filter, store, runtime, starts, input, adapter: runtime.adapters()['claude-code'] as SessionAdapter };
}

test('a session on a service of the workspace starts with its siblings from the base branches and the project\'s skills', async () => {
  const t = await runtimeSetup();
  await t.adapter.start(t.input());
  const [started] = t.starts;
  assert.equal(started?.service, 'guestbook', 'the first service of the workspace, until the flow names one');
  const state = join(t.root, 'state');
  assert.deepEqual(started?.siblings, [
    { name: 'guestbook', port: 8793, real: { base: join(state, 'siblings', 'guestbook', t.guestbook.base), dockerfile: 'Dockerfile', tag: `cleared-v2-base-guestbook:${t.guestbook.base.slice(0, 12)}`, checkout: t.input().workdir } },
    {
      name: 'filter-api', port: 8795, contract: join(state, 'siblings', 'filter-api', t.filter.base, 'contract/openapi.yaml'),
      real: { base: join(state, 'siblings', 'filter-api', t.filter.base), dockerfile: 'Dockerfile', tag: `cleared-v2-base-filter-api:${t.filter.base.slice(0, 12)}` },
    },
  ]);
  assert.equal(readFileSync(started?.siblings?.[1]?.contract ?? '', 'utf8'), CONTRACT);
  assert.equal(started?.skills, join(state, 'skills', 'guestbook', t.guestbook.base));
  assert.equal(readFileSync(join(started?.skills ?? '', 'cleared-guestbook/SKILL.md'), 'utf8'), SKILL);
});

test('the ticket checkout of another service the ticket touches becomes that sibling\'s ticket layer', async () => {
  const t = await runtimeSetup();
  mkdirSync(join(t.root, 'work', 'LOCAL-1', 'filter-api'));
  await t.adapter.start(t.input());
  assert.equal(t.starts[0]?.siblings?.[1]?.real?.checkout, join(t.root, 'work', 'LOCAL-1', 'filter-api'));
});

test('the runtime issues the session\'s preview key and stores its service; the preview reaches its own run sibling', async () => {
  const t = await runtimeSetup();
  const handle = await t.adapter.start(t.input());
  const row = t.store.sessions.get(handle.id);
  assert.equal(row?.service, 'guestbook');
  assert.match(row?.previewKey ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(t.runtime.previewTarget(handle.id), { session: handle.id, key: row?.previewKey, alias: 'guestbook', port: 8793 });
  // The engine's own put, after the start, keeps both.
  t.store.sessions.put({ id: handle.id, project: 'guestbook', ticket: 'LOCAL-1', role: 'author', harness: 'claude-code', model: 'claude-opus-5-5', status: 'working', createdAt: 'x', updatedAt: 'y' });
  assert.equal(t.store.sessions.get(handle.id)?.previewKey, row?.previewKey);
  // Each session its own key.
  const other = await t.adapter.start(t.input({ role: 'reviewer' }));
  assert.notEqual(t.store.sessions.get(other.id)?.previewKey, row?.previewKey);
});

test('a session on another service has that service\'s preview; the lead\'s sessions are left as they are; an unknown service is refused', async () => {
  const t = await runtimeSetup();
  mkdirSync(join(t.root, 'work', 'LOCAL-1', 'filter-api'));
  const filter = await t.adapter.start(t.input({ service: 'filter-api', workdir: join(t.root, 'work', 'LOCAL-1', 'filter-api') }));
  assert.equal(t.store.sessions.get(filter.id)?.service, 'filter-api');
  assert.ok(t.store.sessions.get(filter.id)?.previewKey, 'filter-api runs: its own sibling is its preview');
  const lead = await t.adapter.start(t.input({ role: 'lead' }));
  assert.equal(t.starts.at(-1)?.siblings, undefined);
  assert.equal(t.starts.at(-1)?.skills, undefined);
  assert.equal(t.store.sessions.get(lead.id), undefined, 'the lead engine writes its own rows');
  assert.equal(t.runtime.previewTarget(lead.id), undefined);
  assert.equal(t.runtime.previewTarget('unknown'), undefined);
  await assert.rejects(t.adapter.start(t.input({ service: 'billing' })), /billing is not a service of the workspace/);
});

test('siblings the flow gives are used as they are, and none is planned for them', async () => {
  const t = await runtimeSetup();
  await t.adapter.start(t.input({ siblings: [], skills: '/given/skills' }));
  assert.deepEqual(t.starts[0]?.siblings, []);
  assert.equal(t.starts[0]?.skills, '/given/skills');
  assert.equal(t.store.sessions.get(SESSION)?.previewKey, null, 'no own sibling: no preview');
});

test('a redirect to the sibling keeps its path; one that leaves it is dropped', async () => {
  for (const [location, kept] of [['/entries?page=2', '/entries?page=2'], ['http://guestbook:8793/a', '/a'], ['http://172.30.0.3:8793/b?c=1', '/b?c=1'], ['http://guestbook:9999/a', undefined], ['https://evil.example/', undefined], ['//evil.example/x', undefined]] as const) {
    const { at } = setup(() => ({ status: 302, headers: [['location', location]], body: '' }));
    const answer = await call(at(0), { id: SESSION, key: KEY }, { proof: PROOF });
    assert.equal(answer.status, 302);
    assert.equal(answer.headers.location, kept, location);
  }
});
