// The command (docs/v2/milestone-4-plan.md, section 7.2): npm run status,
// the service's own settings, French by default, English when the app is,
// --json for one schema 1 object, exit 0 without a problem (a notice never
// counts), 1 with one, 2 when the status cannot be collected; the ledger
// is only read. The service is a fake /health on loopback, port 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tempDir } from '../workspace/git.ts';
import { beatRow, ledger, session } from './support.ts';

const CLI = new URL('../../src/cli/status.ts', import.meta.url).pathname;

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function fakeService(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    response.writeHead(request.url === '/health' ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// A port nothing listens on: one the system gave, then freed.
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function setup(port: number) {
  const root = tempDir('status-cli');
  const state = join(root, 'state');
  const store = ledger(join(state, 'ledger.db'));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '', HOME: root,
    CLEARED_V2_PROJECT: 'shop', CLEARED_V2_PROJECT_DIR: root, CLEARED_V2_REPO: 'example-org/shop', CLEARED_V2_REPO_URL: 'https://example.invalid/shop.git',
    CLEARED_V2_STATE_DIR: state, CLEARED_STATE_DIR: state, CLEARED_V2_HOST: '127.0.0.1', CLEARED_V2_PORT: String(port),
  };
  const run = (args: string[], over: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { env: { ...env, ...over } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  return { root, state, store, run };
}

test('a healthy service, in French by default: exit 0', async () => {
  const service = await fakeService();
  const { store, run } = setup(service.port);
  try {
    beatRow(store.db, { at: ago(1.5) });
    const { code, out, err } = await run([]);
    assert.equal(code, 0, err);
    assert.match(out, /^Cleared · shop$/m);
    assert.match(out, /^Service +répond sur 127\.0\.0\.1:\d+$/m);
    assert.match(out, /^Dernier battement +il y a 1 min$/m);
    assert.match(out, /^Problèmes +aucun$/m);
  } finally {
    store.close();
    await service.close();
  }
});

test('in English, a stalled session and a late beat: exit 1, each in a sentence', async () => {
  const service = await fakeService();
  const { store, run } = setup(service.port);
  try {
    beatRow(store.db, { at: ago(10.5) });
    session(store.db, { id: 's7', ticket: 'LOCAL-7', updatedAt: ago(185.5) });
    const { code, out } = await run([], { CLEARED_V2_APP_LANGUAGE: 'en' });
    assert.equal(code, 1);
    assert.match(out, /^Problems +The last beat is 10 min old: the service has stopped, or it is stuck\.$/m);
    assert.match(out, /Session s7 \(author\) of LOCAL-7 has not moved for 3h 5m\./);
  } finally {
    store.close();
    await service.close();
  }
});

test('the service silent on its address: exit 1', async () => {
  const { store, run } = setup(await freePort());
  try {
    beatRow(store.db, { at: ago(0.5) });
    const { code, out } = await run([], { CLEARED_V2_APP_LANGUAGE: 'en' });
    assert.equal(code, 1);
    assert.match(out, /^Service +does not answer at 127\.0\.0\.1:\d+$/m);
  } finally {
    store.close();
  }
});

test('a notice alone: exit 0', async () => {
  const service = await fakeService();
  const { store, run } = setup(service.port);
  try {
    beatRow(store.db, { at: ago(0.5), monitor: 'off' });
    const { code, out } = await run([], { CLEARED_V2_APP_LANGUAGE: 'en' });
    assert.equal(code, 0);
    assert.match(out, /^Notices +No monitor is set/m);
  } finally {
    store.close();
    await service.close();
  }
});

test('--json: one schema 1 object, and the same exit code', async () => {
  const service = await fakeService();
  const { store, run } = setup(service.port);
  try {
    beatRow(store.db, { at: ago(0.5) });
    session(store.db, { id: 's7', ticket: 'LOCAL-7', updatedAt: ago(185) });
    const { code, out } = await run(['--json']);
    assert.equal(code, 1);
    const json = JSON.parse(out) as { schema: number; project: string; ok: boolean; problems: { code: string; message: string }[] };
    assert.equal(json.schema, 1);
    assert.equal(json.project, 'shop');
    assert.equal(json.ok, false);
    assert.deepEqual(json.problems.map((p) => p.code), ['session_stalled']);
    assert.match(json.problems[0]?.message ?? '', /^La session s7 \(auteur\) de LOCAL-7 n'a pas bougé depuis 3 h 05\.$/);
  } finally {
    store.close();
    await service.close();
  }
});

test('the ledger is only read', async () => {
  const service = await fakeService();
  const { state, store, run } = setup(service.port);
  try {
    beatRow(store.db, { at: ago(0.5) });
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = readFileSync(join(state, 'ledger.db'));
    const rows = JSON.stringify(store.db.prepare('SELECT * FROM v2_heartbeat_state ORDER BY key').all());
    assert.equal((await run([])).code, 0);
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.deepEqual(readFileSync(join(state, 'ledger.db')), before);
    assert.equal(JSON.stringify(store.db.prepare('SELECT * FROM v2_heartbeat_state ORDER BY key').all()), rows);
    assert.equal((store.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 0);
  } finally {
    store.close();
    await service.close();
  }
});

test('no ledger, a bad setting or an unknown argument: exit 2, said in a line', async () => {
  const root = tempDir('status-none');
  const env = { PATH: process.env.PATH ?? '', HOME: root, CLEARED_STATE_DIR: join(root, 'state'), CLEARED_V2_PORT: String(await freePort()) };
  const run = (args: string[], over: Record<string, string> = {}) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', CLI, ...args], { env: { ...env, ...over } });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code, out, err }));
  });
  const missing = await run([]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /^cleared-v2: Aucun registre à .+ledger\.db : le service n'a pas tourné avec ce dossier d'état\.\n$/);
  const json = await run(['--json'], { CLEARED_V2_APP_LANGUAGE: 'en' });
  assert.equal(json.code, 2);
  const parsed = JSON.parse(json.out) as { schema: number; ok: boolean; problems: { code: string; level: string; message: string }[] };
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.problems.map((p) => [p.code, p.level]), [['status_error', 'problem']]);
  assert.match(parsed.problems[0]?.message ?? '', /^No ledger at .+ledger\.db: the service has not run with this state folder\.$/);
  const bad = await run([], { CLEARED_V2_HEARTBEAT_SECONDS: '5', CLEARED_V2_APP_LANGUAGE: 'en' });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /CLEARED_V2_HEARTBEAT_SECONDS/);
  const usage = await run(['--reap'], { CLEARED_V2_APP_LANGUAGE: 'en' });
  assert.equal(usage.code, 2);
  assert.match(usage.err, /^cleared-v2: Usage: npm run status \[-- --json\]\n$/);
});
