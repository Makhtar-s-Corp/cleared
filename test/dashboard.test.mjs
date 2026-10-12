import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dirs = [];
const scratch = (prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
test('the dashboard page is refused to any peer outside the allowed ranges, and only the page is served', async () => {
  const { dashboardServer, allowed, TAILSCALE } = await import('../serve/serve-dashboard.mjs');
  for (const peer of ['100.88.1.2', '100.127.255.254', '::ffff:100.64.0.1', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0:ab12::9']) assert.ok(allowed(peer, TAILSCALE), peer);
  // A container of a Docker network, the loopback, a public address, the ranges next to Tailscale's, nonsense.
  for (const peer of ['172.18.0.5', '127.0.0.1', '::1', '10.0.1.7', '192.168.1.4', '8.8.8.8', '100.63.255.255', '100.128.0.1', '::ffff:172.18.0.5', 'fd7a:115c:a1e1::1', '', undefined, 'x']) assert.ok(!allowed(peer, TAILSCALE), String(peer));
  const dir = scratch('orch-serve-');
  writeFileSync(join(dir, 'index.html'), '<p>page</p>');
  writeFileSync(join(dir, 'secret.txt'), 'not served');
  const answer = async (ranges, path = '/') => {
    const server = dashboardServer({ file: join(dir, 'index.html'), ranges });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { signal: AbortSignal.timeout(2000) });
    const body = await response.text();
    server.closeAllConnections();
    server.close();
    return [response.status, body];
  };
  assert.equal((await answer(TAILSCALE))[0], 403, 'the loopback is not the Tailscale network');
  assert.deepEqual(await answer(['127.0.0.0/8']), [200, '<p>page</p>']);
  assert.equal((await answer(['127.0.0.0/8'], '/secret.txt'))[0], 404);
  assert.equal((await answer(['127.0.0.0/8'], '/../secret.txt'))[0], 404);
});

test('the dashboard server answers 400 to a request it cannot read, and goes on serving', async () => {
  const { dashboardServer } = await import('../serve/serve-dashboard.mjs');
  const { connect } = await import('node:net');
  const dir = scratch('orch-serve-');
  writeFileSync(join(dir, 'index.html'), '<p>page</p>');
  const server = dashboardServer({ file: join(dir, 'index.html'), ranges: ['127.0.0.0/8'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const raw = await new Promise((resolve) => {
    let data = '';
    const socket = connect(port, '127.0.0.1', () => socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', () => resolve(data));
  });
  try {
    assert.match(raw, /^HTTP\/1\.1 400 /);
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
