import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { AppConfigError, DEFAULT_APP_PORT, readAppConfig } from '../src/config.ts';
import { PROOF_FILE } from '../../src/modules/users.ts';

const main = new URL('../main.ts', import.meta.url).pathname;
const state = mkdtempSync(join(tmpdir(), 'cleared-v2-app-main-'));
after(() => rmSync(state, { recursive: true, force: true }));

test('the app listens on 127.0.0.1:8792 by default, reads the service on 8791, and uses the live service', () => {
  assert.equal(DEFAULT_APP_PORT, 8792);
  assert.deepEqual(readAppConfig({}), {
    host: '127.0.0.1', port: 8792, source: 'service', serviceUrl: 'http://127.0.0.1:8791', language: 'en', project: '', publicOrigin: undefined,
  });
  const set = readAppConfig({
    CLEARED_V2_APP_PORT: '18792', CLEARED_V2_APP_SOURCE: 'fixtures', CLEARED_V2_PORT: '18791', CLEARED_V2_APP_LANGUAGE: 'fr', CLEARED_REPO: '/srv/checkouts/guestbook',
  });
  assert.deepEqual([set.port, set.source, set.serviceUrl, set.language, set.project], [18792, 'fixtures', 'http://127.0.0.1:18791', 'fr', 'guestbook']);
  assert.equal(readAppConfig({ CLEARED_V2_APP_PROJECT: 'Guestbook', CLEARED_REPO: '/x/other' }).project, 'Guestbook');
});

test('the app refuses the reserved ports, the service\'s own port, an unknown source and an unknown language', () => {
  for (const port of ['80', '443', '8787', '8788', '8790', '8791', '0', '70000', 'x'])
    assert.throws(() => readAppConfig({ CLEARED_V2_APP_PORT: port }), AppConfigError, port);
  assert.throws(() => readAppConfig({ CLEARED_V2_APP_SOURCE: 'files' }), AppConfigError);
  assert.throws(() => readAppConfig({ CLEARED_V2_APP_LANGUAGE: 'de' }), AppConfigError);
  assert.throws(() => readAppConfig({ CLEARED_V2_APP_HOST: '0.0.0.0' }), AppConfigError, 'loopback only');
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test('node app/main.ts serves the sign-in page and makes the proof file beside the ledger', async () => {
  const port = await freePort();
  // The preview listener (lane 20) on a free port too, never 8794 in a test.
  const previewPort = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: state, CLEARED_V2_APP_PORT: String(port), CLEARED_V2_APP_SOURCE: 'fixtures', CLEARED_V2_PREVIEW_PORT: String(previewPort) };
  delete env.CLEARED_V2_PREVIEW_ORIGIN;
  delete env.ORCH_LEDGER;
  const child = spawn(process.execPath, [main], { env });
  try {
    const [line] = await once(child.stdout, 'data');
    assert.match(String(line), new RegExp(`^cleared-v2-app: listening on http://127\\.0\\.0\\.1:${port} \\(fixtures\\)`));
    assert.equal((await fetch(`http://127.0.0.1:${port}/login`)).status, 200);
    assert.equal(statSync(join(state, PROOF_FILE)).mode & 0o777, 0o600);
    // The preview listener answers previews only, on its own loopback port.
    let preview: Response | undefined;
    for (let tries = 0; !preview && tries < 50; tries++) preview = await fetch(`http://127.0.0.1:${previewPort}/`).catch(() => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 20)));
    assert.equal(preview?.status, 404);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
