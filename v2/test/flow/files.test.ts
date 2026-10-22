// The Editor tab's files (docs/v2/milestone-2-plan.md, decision 30, lane
// 20): GET /api/sessions/:id/files lists what the session changed, and
// GET /api/sessions/:id/files/<path> reads one file of its checkout, read
// only, through the events' cleaner, cut at 400 lines; with ?version=base,
// the same file as the ticket's base holds it, for the diff. The route reads
// the checkout without git and without following a link: the session writes
// that folder.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_PROOF_HEADER, type SessionFile, type SessionFiles } from '../../src/api/types.ts';
import { WORKDIR_MOUNT } from '../../src/container/session-runtime.ts';
import { FILE_LINES, filesRoutes } from '../../src/flow/files.ts';
import { dispatch, type App } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import type { FakeStep } from '../../src/session/adapters/fake.ts';
import { toolArgs, toolResult } from '../../src/session/events.ts';
import { ticketCheckout } from '../../src/workspace/checkout.ts';
import { finished, setup, started, until, type Setup } from './support.ts';

const PROOF = 'c'.repeat(64);
const BASE_TEXT = 'export const order = "oldest";\n';
const NEW_TEXT = 'export const order = "newest";\nexport const limit = 20;\n';

const edit = (id: string, path: string, added: number, removed: number): FakeStep[] => [
  { emit: { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'Edit' } },
  { emit: toolArgs(id, { kind: 'edit', path, added, removed }) },
  { emit: { type: 'TOOL_CALL_END', toolCallId: id } },
  { emit: toolResult(`${id}-result`, id, { kind: 'edit', ok: true }) },
];
const script: readonly FakeStep[] = [
  started,
  ...edit('e1', `${WORKDIR_MOUNT}/src/entries.ts`, 2, 1),
  ...edit('e2', 'test/entries.test.ts', 12, 0),
  ...edit('e3', '/etc/hosts', 1, 0),                      // outside the checkout: not one of its files
  { awaitMessage: true }, finished(0.2),
];

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' });

let root = '';
let login = '';
let t: Setup;
let server: Server;
let base = '';
let session = '';
let workdir = '';

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'cleared-files-'));
  // The service's project checkout, with a base branch the ticket starts from.
  const project = join(root, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  git(root, 'init', '--quiet', '--initial-branch=main', project);
  writeFileSync(join(project, 'src', 'entries.ts'), BASE_TEXT);
  git(project, 'add', '.');
  git(project, 'commit', '--quiet', '-m', 'base');
  git(project, 'remote', 'add', 'origin', 'https://example.invalid/guestbook.git');
  git(project, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  // A file outside every checkout, standing for the session's login.
  login = join(root, 'claude.token');
  writeFileSync(login, 'the login\n');

  t = await setup({
    scripts: { author: script },
    config: { projectDir: project, workdirRoot: join(root, 'work') },
    effects: {
      async prepareWorkdir({ ticket }) {
        const made = await ticketCheckout({ project, workdir: join(root, 'work', ticket.id), base: 'main', branch: `cleared/${ticket.id}` });
        return { workdir: made.workdir, briefing: { projectPage: 'A guestbook.', decisions: [], glossary: [], lessons: [], lastHandover: null } };
      },
    },
  });
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.startedSessions.length > 0, 'the author');
  await t.engine.settled();
  session = t.startedSessions[0]!.id;
  workdir = join(root, 'work', t.ticket.id);

  // What the session wrote in its checkout.
  writeFileSync(join(workdir, 'src', 'entries.ts'), NEW_TEXT);
  mkdirSync(join(workdir, 'test'));
  writeFileSync(join(workdir, 'test', 'entries.test.ts'), 'test("newest first", () => {});\n');
  writeFileSync(join(workdir, 'long.txt'), Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(workdir, 'image.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  writeFileSync(join(workdir, '.env'), 'PORT=8080\n');
  writeFileSync(join(workdir, 'deploy.sh'), ['export ', 'API', '_TOKEN', '=', 'q'.repeat(24), '\n'].join(''));
  symlinkSync(login, join(workdir, 'notes.md'));
  symlinkSync(root, join(workdir, 'linked'));

  const app: App = { registry: t.engine.registry, tables: [], routes: filesRoutes({ engine: () => t.engine, proof: () => PROOF }) };
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

// A GET with the path sent as written: fetch would resolve the dots.
function get(path: string, proof: string | undefined = PROOF): Promise<{ status: number; json: any }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path, method: 'GET', headers: proof ? { [SERVICE_PROOF_HEADER]: proof } : {} }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, json: body ? JSON.parse(body) : undefined }));
    });
    request.on('error', reject);
    request.end();
  });
}

const file = (path: string) => `/api/sessions/${session}/files/${path}`;

test('the list names the files the session changed, relative to its checkout, with their counts', async () => {
  assert.equal((await get(`/api/sessions/${session}/files`, '')).status, 401, 'without the proof');
  assert.equal((await get('/api/sessions/nobody/files')).status, 404);
  const listed = await get(`/api/sessions/${session}/files`);
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.json as SessionFiles).files, [
    { path: 'src/entries.ts', added: 2, removed: 1 },
    { path: 'test/entries.test.ts', added: 12, removed: 0 },
  ]);
});

test('a file of the checkout is read whole, with the hash of its bytes; ?version=base reads the ticket\'s base', async () => {
  const read = await get(file('src/entries.ts'));
  assert.equal(read.status, 200);
  assert.deepEqual(read.json as SessionFile, {
    path: 'src/entries.ts', text: NEW_TEXT, lines: 2, cut: false, hash: createHash('sha256').update(NEW_TEXT).digest('hex'),
  });
  const baseVersion = await get(`${file('src/entries.ts')}?version=base`);
  assert.equal(baseVersion.status, 200);
  assert.equal((baseVersion.json as SessionFile).text, BASE_TEXT);
  assert.equal((baseVersion.json as SessionFile).hash, createHash('sha256').update(BASE_TEXT).digest('hex'));
  assert.equal((await get(`${file('test/entries.test.ts')}?version=base`)).status, 404, 'a file the base does not have');
  assert.equal((await get(`${file('src/entries.ts')}?version=other`)).status, 400);
  assert.equal((await get(file('src/missing.ts'))).status, 404);
  assert.equal((await get(file('src'))).status, 400, 'a folder is not a file');
});

test('a file is cut at 400 lines, and says so', async () => {
  const read = await get(file('long.txt'));
  assert.equal(read.status, 200);
  const cut = read.json as SessionFile;
  assert.equal(FILE_LINES, 400);
  assert.equal(cut.cut, true);
  assert.equal(cut.lines, 1000);
  assert.equal(cut.text.split('\n').filter(Boolean).length, 400);
  assert.ok(cut.text.startsWith('line 1\n') && cut.text.trimEnd().endsWith('line 400'));
});

test('the route refuses what the session may not read and what is not text, and cleans what it reads', async () => {
  const env = await get(file('.env'));
  assert.equal(env.status, 403);
  assert.match(env.json.error, /secret/);
  assert.equal((await get(file('.git/config'))).status, 403, 'the checkout\'s git folder');
  assert.equal((await get(file('image.bin'))).status, 415, 'a binary file');
  const cleaned = await get(file('deploy.sh'));
  assert.equal(cleaned.status, 200);
  assert.ok(!cleaned.json.text.includes('q'.repeat(24)), 'the secret is masked');
  assert.match(cleaned.json.text, /\[removed: /);
});

test('the route follows no link and never leaves the checkout', async () => {
  const link = await get(file('notes.md'));
  assert.equal(link.status, 403, 'a link to the login file');
  assert.ok(!JSON.stringify(link.json).includes('the login'));
  const through = await get(file('linked/claude.token'));
  assert.equal(through.status, 403, 'a path through a linked folder');
  assert.ok(!JSON.stringify(through.json).includes('the login'));
  for (const path of ['%2E%2E/claude.token', '..%2Fclaude.token', 'src/%2E%2E/%2E%2E/claude.token', '%2Fetc%2Fhosts', 'src/.']) {
    const answer = await get(file(path));
    assert.ok(answer.status === 400 || answer.status === 404, `${path}: ${answer.status}`);
    assert.ok(!JSON.stringify(answer.json).includes('the login'), path);
  }
});
