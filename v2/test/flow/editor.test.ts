// Open in an editor (docs/v2/complement-devin.md item 19, requirements
// matrix C19, P120 to P125): GET /api/sessions/:id/editor gives the links
// that open the session's checkout in VS Code or Cursor, built from the
// checkout the service itself started (never from a path the browser sends)
// and only when it is a real folder strictly inside the service's work
// folder. Nothing is run on the server.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../../src/api/types.ts';
import { checkoutFolder, editorLinks, editorRoutes, parseEditorHost } from '../../src/flow/editor.ts';
import { loadFlowConfig, FlowConfigError } from '../../src/flow/config.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { quickAuthor, setup, until, type Setup } from './support.ts';

const PROOF = 'e'.repeat(64);
const HOST = 'dev.example.invalid';

let root = '';
let real = '';
let t: Setup;
let server: Server;
let base = '';
let session = '';
let workdir = '';
let host: string | undefined;

// A work folder whose name would break a link built by pasting: a space, a hash, a question mark, a percent sign and an apostrophe.
const FOLDER = 'cleared editor #1 ?50% o\'k';

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'cleared-editor-'));
  real = realpathSync(root);
  const work = join(root, FOLDER);
  mkdirSync(work);
  t = await setup({
    scripts: { author: quickAuthor },
    config: { workdirRoot: work },
    effects: {
      async prepareWorkdir({ ticket }) {
        const dir = join(work, ticket.id);
        mkdirSync(join(dir, '.git'), { recursive: true });
        return { workdir: dir, briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null } };
      },
    },
  });
  t.users.users.set('lead', { id: 'lead', name: 'Lead' });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.startedSessions.length > 0, 'the author');
  await t.engine.settled();
  session = t.startedSessions[0]!.id;
  workdir = join(work, t.ticket.id);
  // The host is read when the route answers, so each test can set it.
  const app: App = { registry: t.engine.registry, tables: [], routes: editorRoutes({ engine: () => t.engine, proof: () => PROOF, host: () => host }) };
  server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await t.engine.close();
  rmSync(root, { recursive: true, force: true });
});

async function get(path: string, headers: Record<string, string> = { [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'u1' }): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}${path}`, { headers });
  const body = await response.text();
  return { status: response.status, json: body ? JSON.parse(body) : undefined };
}

const encoded = (path: string) => path.split('/').map((part) => encodeURIComponent(part).replace(/'/g, '%27')).join('/');

test('the route asks for the proof and a person the service knows, and an unknown session is 404', async () => {
  const path = `/api/sessions/${session}/editor`;
  assert.equal((await get(path, { [SERVICE_USER_HEADER]: 'u1' })).status, 401, 'without the proof');
  assert.equal((await get(path, { [SERVICE_PROOF_HEADER]: PROOF })).status, 403, 'without a user');
  assert.equal((await get(path, { [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'nobody' })).status, 403, 'an unknown user');
  assert.equal((await get(path, { [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'lead' })).status, 403, 'the lead is not a person');
  assert.equal((await get(path, { [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'cleared' })).status, 403, 'the flow is not a person');
  assert.equal((await get('/api/sessions/nobody/editor')).status, 404);
});

test('with no host configured the links open the checkout on this machine, each path segment encoded', async () => {
  host = undefined;
  const answer = await get(`/api/sessions/${session}/editor`);
  assert.equal(answer.status, 200);
  const path = join(real, FOLDER, t.ticket.id);
  assert.deepEqual(answer.json, {
    mode: 'local',
    links: [
      { editor: 'vscode', url: `vscode://file${encoded(path)}` },
      { editor: 'cursor', url: `cursor://file${encoded(path)}` },
    ],
  });
  assert.match(String(answer.json.links[0]?.url), /\/cleared%20editor%20%231%20%3F50%25%20o%27k\//, 'a space, a hash, a question mark, a percent sign and an apostrophe cannot change the link');
});

test('with an SSH host configured the links are the remote ones, and the same checkout', async () => {
  host = HOST;
  const answer = await get(`/api/sessions/${session}/editor`);
  assert.equal(answer.status, 200);
  const path = encoded(join(real, FOLDER, t.ticket.id));
  assert.deepEqual(answer.json, {
    mode: 'ssh',
    links: [
      { editor: 'vscode', url: `vscode://vscode-remote/ssh-remote+${HOST}${path}` },
      { editor: 'cursor', url: `cursor://vscode-remote/ssh-remote+${HOST}${path}` },
    ],
  });
  host = undefined;
});

test('the route takes no path from the request: a query or a header naming another folder changes nothing', async () => {
  const plain = await get(`/api/sessions/${session}/editor`);
  const asked = await get(`/api/sessions/${session}/editor?path=/etc&workdir=/`, { [SERVICE_PROOF_HEADER]: PROOF, [SERVICE_USER_HEADER]: 'u1', 'x-workdir': '/etc' });
  assert.deepEqual(asked, plain);
});

test('checkoutFolder: only a real folder strictly inside the work folder, with a .git, is a worktree of Cleared', () => {
  const work = join(root, 'pure');
  mkdirSync(join(work, 'T-1', '.git'), { recursive: true });
  mkdirSync(join(work, 'T-2'), { recursive: true });            // no .git: not a checkout
  mkdirSync(join(root, 'outside', '.git'), { recursive: true });
  mkdirSync(join(`${work}-evil`, '.git'), { recursive: true });
  writeFileSync(join(work, 'T-3'), 'a file\n');
  symlinkSync(join(root, 'outside'), join(work, 'T-4'));         // a link out of the work folder
  symlinkSync(join(work, 'T-1'), join(work, 'T-5'));             // a link inside it: the real folder is named
  const refused = (workdir: string, status: number) => assert.throws(() => checkoutFolder(workdir, work), (error: unknown) => (error as { status?: number }).status === status, workdir);
  assert.equal(checkoutFolder(join(work, 'T-1'), work), join(realpathSync(work), 'T-1'));
  assert.equal(checkoutFolder(join(work, 'T-5'), work), join(realpathSync(work), 'T-1'));
  refused(work, 403);                                            // the work folder itself
  refused(join(root, 'outside'), 403);                           // outside it
  refused(join(work, 'T-4'), 403);                               // a link that leaves it
  refused(join(work, 'T-1', '..', '..', 'outside'), 403);        // a step up
  refused(`${work}-evil`, 403);                                  // a sibling that shares the prefix
  refused('relative/T-1', 403);
  refused(join(work, 'T-2'), 403);
  refused(join(work, 'T-3'), 403);
  refused(join(work, 'T-9'), 409);                               // gone
  refused(`${join(work, 'T-1')}\n`, 403);                        // control characters
});

test('editorLinks: the folder is encoded, and a host that could change the link is refused', () => {
  assert.deepEqual(editorLinks("/work/T 1/a#b?c%d'e"), {
    mode: 'local',
    links: [{ editor: 'vscode', url: 'vscode://file/work/T%201/a%23b%3Fc%25d%27e' }, { editor: 'cursor', url: 'cursor://file/work/T%201/a%23b%3Fc%25d%27e' }],
  });
  assert.equal(editorLinks('/work/T-1', 'me@dev.example.invalid').links[0]?.url, 'vscode://vscode-remote/ssh-remote+me@dev.example.invalid/work/T-1');
  for (const bad of ['evil/x', 'x#y', 'x?y', 'a b', '-oProxyCommand=x', 'x@', '@x', 'x:22', 'x\ny', 'a@b@c', '%41']) {
    assert.throws(() => parseEditorHost(bad), /CLEARED_V2_EDITOR_SSH_HOST/, JSON.stringify(bad));
  }
  assert.equal(parseEditorHost(undefined), undefined);
  assert.equal(parseEditorHost('  '), undefined, 'blank is unset');
  assert.equal(parseEditorHost('dev.example.invalid'), 'dev.example.invalid');
  assert.equal(parseEditorHost('me@dev-1.example.invalid'), 'me@dev-1.example.invalid');
});

test('CLEARED_V2_EDITOR_SSH_HOST is read with the flow\'s configuration, and a bad one stops the start', () => {
  const env = { CLEARED_V2_PROJECT: 'guestbook', CLEARED_V2_PROJECT_DIR: '/srv/guestbook', CLEARED_V2_REPO_URL: 'https://github.com/example-org/cleared-example-guestbook.git', CLEARED_V2_REPO: 'example-org/cleared-example-guestbook', CLEARED_V2_STATE_DIR: '/state' };
  assert.equal(loadFlowConfig({ ...env })?.editorHost, undefined);
  assert.equal(loadFlowConfig({ ...env, CLEARED_V2_EDITOR_SSH_HOST: HOST })?.editorHost, HOST);
  assert.throws(() => loadFlowConfig({ ...env, CLEARED_V2_EDITOR_SSH_HOST: 'x#y' }), (error: unknown) => error instanceof FlowConfigError && /CLEARED_V2_EDITOR_SSH_HOST/.test(error.message));
});

test('a checkout outside the work folder, or gone, gives no link (403, 409), and the answer never carries a path of its own', async () => {
  // The service's work folder is moved: the session's checkout is now outside it.
  const config = t.engine.config as { workdirRoot: string };
  const kept = config.workdirRoot;
  config.workdirRoot = join(root, 'elsewhere');
  mkdirSync(config.workdirRoot);
  const outside = await get(`/api/sessions/${session}/editor`);
  assert.equal(outside.status, 403);
  assert.ok(!JSON.stringify(outside.json).includes(root), 'the refusal names no path');
  config.workdirRoot = kept;
  rmSync(workdir, { recursive: true, force: true });
  const gone = await get(`/api/sessions/${session}/editor`);
  assert.equal(gone.status, 409);
  assert.ok(!JSON.stringify(gone.json).includes(root), 'the refusal names no path');
});
