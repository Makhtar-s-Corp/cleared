import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
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

// Starts the service on a free port and resolves once it listens. Another
// process may take the port between the probe and the start: then it tries
// another one.
async function startService(env: NodeJS.ProcessEnv): Promise<{ child: ChildProcessWithoutNullStreams; port: number; line: string }> {
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const child = spawn(process.execPath, [main], { env: { ...env, CLEARED_V2_PORT: String(port) } });
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
  const run = spawnSync(process.execPath, [main], { env: { ...process.env, CLEARED_V2_PORT: '8788' }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /^cleared-v2: CLEARED_V2_PORT 8788 is reserved/m);
  assert.doesNotMatch(run.stdout, /listening/);
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
    assert.match(stderr, new RegExp(`^cleared-v2: 127\\.0\\.0\\.1:${port} is already in use: set CLEARED_V2_PORT to a free port$`, 'm'));
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});
