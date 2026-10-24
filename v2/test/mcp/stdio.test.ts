import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SECRETS, SESSIONS, makeLedger } from './support.ts';

const cli = new URL('../../src/cli/ledger-mcp.ts', import.meta.url).pathname;

const env = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
  return out;
};

test('over stdio: one JSON-RPC message per line on stdout and nothing else, until stdin closes', async () => {
  const fixture = makeLedger();
  try {
    const child = spawn(process.execPath, [cli], { env: env({ CLEARED_STATE_DIR: fixture.dir, CLEARED_V2_APP_LANGUAGE: 'en' }), stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const next = async () => JSON.parse(String((await lines.next()).value)) as { id: number; result?: Record<string, unknown>; error?: { code: number } };

    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } });
    assert.equal((await next()).result?.protocolVersion, '2025-06-18');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    child.stdin.write('this is not json\n');
    const bad = await next();
    assert.equal(bad.error?.code, -32700);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_session_timeline', arguments: { session_id: SESSIONS.S1 } } });
    const timeline = await next();
    assert.equal(timeline.id, 2);
    const text = JSON.stringify(timeline);
    assert.match(text, /The basket total now rounds to the cent/);
    for (const secret of Object.values(SECRETS)) assert.ok(!text.includes(secret));
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    assert.equal((await lines.next()).done, true, 'no other line on stdout');
  } finally {
    fixture.close();
  }
});

test('a ledger that cannot be found or does not exist stops the server with a message on stderr, and creates nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-mcp-cli-'));
  try {
    const nowhere = spawnSync(process.execPath, [cli], { env: env({ HOME: dir, XDG_CONFIG_HOME: join(dir, 'config') }), input: '', encoding: 'utf8' });
    assert.equal(nowhere.status, 64);
    assert.equal(nowhere.stdout, '');
    assert.match(nowhere.stderr, /cannot tell where ledger\.db is/);
    const state = join(dir, 'state');
    const missing = spawnSync(process.execPath, [cli], { env: env({ CLEARED_STATE_DIR: state }), input: '', encoding: 'utf8' });
    assert.equal(missing.status, 66);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /no ledger at .*ledger\.db/);
    assert.equal(existsSync(state), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
