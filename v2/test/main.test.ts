import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { once } from 'node:events';

const main = new URL('../src/main.ts', import.meta.url).pathname;

// A port the system says is free right now, on this machine only.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test('node src/main.ts serves /health on 127.0.0.1 at CLEARED_V2_PORT and stops on SIGTERM', async () => {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_V2_PORT: String(port) };
  delete env.CLEARED_V2_HOST;
  const child = spawn(process.execPath, [main], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [line] = await once(child.stdout, 'data');
    assert.equal(String(line).trim(), `cleared-v2: listening on http://127.0.0.1:${port} (health: /health)`);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    assert.deepEqual(await response.json(), { status: 'ok' });
  } finally {
    child.kill('SIGTERM');
  }
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

test('a reserved port stops the service before it listens', () => {
  const run = spawnSync(process.execPath, [main], { env: { ...process.env, CLEARED_V2_PORT: '8788' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /^cleared-v2: CLEARED_V2_PORT 8788 is reserved/);
  assert.equal(run.stdout, '');
});

test('a port already in use is said as such', async () => {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address() as AddressInfo;
  try {
    const child = spawn(process.execPath, [main], { env: { ...process.env, CLEARED_V2_HOST: '127.0.0.1', CLEARED_V2_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.equal(stderr.trim(), `cleared-v2: 127.0.0.1:${port} is already in use: set CLEARED_V2_PORT to a free port`);
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});
