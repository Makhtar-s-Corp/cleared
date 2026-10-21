import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const main = new URL('../src/main.ts', import.meta.url).pathname;

// The service opens the ledger at start: every run here gets a state
// directory of its own, never the machine's.
const state = mkdtempSync(join(tmpdir(), 'cleared-v2-main-'));
after(() => rmSync(state, { recursive: true, force: true }));
function isolated(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, CLEARED_STATE_DIR: state };
  delete out.ORCH_LEDGER;
  return out;
}

// A port the system says is free right now, on this machine only.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

// Starts the service on a free port and resolves once it listens. Another
// process may take the port between the probe and the start: then it tries
// another one.
async function startService(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcessWithoutNullStreams; port: number; line: string }> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [main], { env: isolated({ ...env, CLEARED_V2_PORT: String(port) }) });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const started = await Promise.race([
      once(child.stdout, 'data').then(([chunk]) => String(chunk)),
      once(child, 'exit').then(() => undefined),
    ]);
    if (started !== undefined) return { child, port, line: started };
    if (attempt === 3 || !/is already in use/.test(stderr)) throw new Error(`the service did not start: ${stderr}`);
  }
}

test('node src/main.ts serves /health on 127.0.0.1 at CLEARED_V2_PORT and stops on SIGTERM', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLEARED_V2_HOST;
  const { child, port, line } = await startService(env);
  try {
    assert.match(line, new RegExp(`^cleared-v2: listening on http://127\\.0\\.0\\.1:${port} \\(health: /health\\)$`, 'm'));
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    child.kill('SIGTERM');
  }
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

test('a reserved port stops the service before it listens', () => {
  const run = spawnSync(process.execPath, [main], { env: isolated({ ...process.env, CLEARED_V2_PORT: '8788' }), encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /^cleared-v2: CLEARED_V2_PORT 8788 is reserved/m);
  assert.doesNotMatch(run.stdout, /listening/);
});

test('a port already in use is said as such', async () => {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address() as AddressInfo;
  try {
    const child = spawn(process.execPath, [main], { env: isolated({ ...process.env, CLEARED_V2_HOST: '127.0.0.1', CLEARED_V2_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(`^cleared-v2: 127\\.0\\.0\\.1:${port} is already in use: set CLEARED_V2_PORT to a free port$`, 'm'));
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

test('the service opens the ledger of its state directory and creates its tables there', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLEARED_V2_HOST;
  const { child } = await startService(env);
  child.kill('SIGTERM');
  await once(child, 'exit');
  const path = join(state, 'ledger.db');
  assert.ok(existsSync(path));
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    for (const name of ['session_events', 'sessions', 'policy_rules']) assert.ok(names.includes(name), name);
  } finally {
    db.close();
  }
});

test('a ledger the service cannot place stops it before it listens', () => {
  // No state directory, no project: the ledger has no place. Port 1 cannot
  // be bound by this account, so a regression could never start listening.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: state, XDG_CONFIG_HOME: join(state, 'no-config'), CLEARED_V2_PORT: '1' };
  const run = spawnSync(process.execPath, [main], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /^cleared-v2: .*CLEARED_STATE_DIR/m);
  assert.doesNotMatch(run.stdout, /listening/);
});

test('a ledger that cannot be opened stops the service with exit 64 and says where (review round 1, finding 7)', () => {
  const file = join(state, 'not-a-directory');
  writeFileSync(file, 'x');
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: file, CLEARED_V2_PORT: '1' };
  delete env.ORCH_LEDGER;
  const run = spawnSync(process.execPath, [main], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /^cleared-v2: cannot open the ledger at .*not-a-directory\/ledger\.db: /m);
  assert.doesNotMatch(run.stderr, /\n\s+at /, 'no stack trace');
});
