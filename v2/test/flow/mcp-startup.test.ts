// The lanes' MCP route reads its language and its cleaner when the flow
// module starts, not when it is imported (issue #348): the service's
// environment is the one at start. A file of its own, so that the flow
// module is imported here first, with this file's environment.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MCP_PATH } from '../../src/mcp/http.ts';
import { lanesCatalog } from '../../src/mcp/lanes.ts';
import { assemble, dispatch, emptyModule } from '../../src/modules/registry.ts';
import { handle } from '../../src/server.ts';
import { openStore } from '../../src/store/db.ts';

const state = mkdtempSync(join(tmpdir(), 'cleared-v2-mcp-startup-'));
after(() => rmSync(state, { recursive: true, force: true }));

test('the language set between the import and the start is the one POST /mcp answers in', async () => {
  // No project: the start builds no engine and starts no session.
  for (const key of ['CLEARED_V2_PROJECT', 'CLEARED_V2_WORKSPACE', 'CLEARED_V2_STATE_DIR', 'ORCH_LEDGER']) delete process.env[key];
  process.env.CLEARED_STATE_DIR = state;
  process.env.CLEARED_V2_APP_LANGUAGE = 'fr';
  const { default: flow } = await import('../../src/modules/flow.ts');
  process.env.CLEARED_V2_APP_LANGUAGE = 'en';

  const store = openStore(':memory:');
  const app = assemble({ sessions: emptyModule, users: emptyModule, tickets: emptyModule, flow, approval: emptyModule, inbox: emptyModule, lead: emptyModule, notify: emptyModule, knowledge: emptyModule }, { store });
  app.start?.();
  // Set back after the start: only a read at the start answers in English.
  process.env.CLEARED_V2_APP_LANGUAGE = 'fr';
  const server: Server = createServer((request, response) => dispatch(app, request, response, handle));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${MCP_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-the-token' }, body: '{}',
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: lanesCatalog('en').http_unauthorized });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.stop?.();
    store.close();
  }
});
