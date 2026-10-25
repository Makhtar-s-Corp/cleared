// The lanes' MCP token made when the service starts (P216, issue #350): the
// real service (src/main.ts) started on a temporary folder, with no project,
// so no engine and no container; it listens on a free port of loopback. The
// token is made at start, before any request: v2-mcp-token beside ledger.db,
// 64 hex characters, mode 600. A token that cannot be read is said in the
// service's log, never its value, and POST /mcp answers 503.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_ACCESS_FILE, MCP_PATH } from '../../src/mcp/http.ts';

const main = new URL('../../src/main.ts', import.meta.url).pathname;
const folders: string[] = [];
after(() => { for (const folder of folders) rmSync(folder, { recursive: true, force: true }); });

// A folder of its own per service: the module keeps the token it read for the process's life.
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleared-v2-mcp-start-'));
  folders.push(dir);
  return dir;
}

// A port the system says is free right now, on this machine only.
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end) throw new Error(`still not ${what} after ${ms / 1000} s`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

type Started = { url: string; child: ChildProcess; log: () => string };

async function start(state: string): Promise<Started> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: state, CLEARED_V2_PORT: String(port), CLEARED_V2_HOST: '127.0.0.1' };
  delete env.ORCH_LEDGER;
  delete env.CLEARED_V2_PROJECT;
  const child = spawn(process.execPath, [main], { env });
  let log = '';
  child.stdout?.on('data', (chunk) => { log += chunk; });
  child.stderr?.on('data', (chunk) => { log += chunk; });
  const url = `http://127.0.0.1:${port}`;
  await until('listening', async () => {
    if (child.exitCode !== null) throw new Error(`the service stopped: ${log}`);
    try { return (await fetch(`${url}/health`)).status === 200; } catch { return false; }
  });
  return { url, child, log: () => log };
}

async function stop(started: Started): Promise<void> {
  if (started.child.exitCode !== null) return;
  started.child.kill('SIGTERM');
  await once(started.child, 'exit');
}

test('the service makes v2-mcp-token beside ledger.db at start, before any request: 64 hex characters, mode 600', async () => {
  const state = folder();
  const path = join(state, MCP_ACCESS_FILE);
  const started = await start(state);
  try {
    await until('made', () => existsSync(path), 5_000);
    assert.match(readFileSync(path, 'utf8'), /^[0-9a-f]{64}\n$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(path).uid, process.getuid?.());
  } finally {
    await stop(started);
  }
});

test('a token the service cannot take is said in its log without its value, kept as it is, and POST /mcp answers 503', async () => {
  const state = folder();
  const path = join(state, MCP_ACCESS_FILE);
  const value = randomBytes(32).toString('hex');
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o644);
  const started = await start(state);
  try {
    await until('said in the log', () => /MCP token/.test(started.log()), 5_000);
    const line = started.log().split('\n').find((text) => /MCP token/.test(text)) ?? '';
    assert.match(line, /^cleared-v2: .*v2-mcp-token.*can be read by others/);
    const answer = await fetch(`${started.url}${MCP_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${value}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-client', version: '0' } } }),
    });
    assert.equal(answer.status, 503);
    assert.doesNotMatch(await answer.text(), new RegExp(value));
    assert.doesNotMatch(started.log(), new RegExp(value), 'the value is in no line of the log');
    assert.equal(readFileSync(path, 'utf8'), `${value}\n`, 'the file is not replaced');
    assert.equal(statSync(path).mode & 0o777, 0o644, 'nor its mode changed');
  } finally {
    await stop(started);
  }
});
