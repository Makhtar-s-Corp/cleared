// The paths the capture rule reads (issue #368, matrix P226): what the
// author's branch commits against the service's base, read as a step's
// branch is (fetched into the service's own checkout, never by git in the
// session's checkout); a folder service's are the paths in its folder. Two
// temporary repositories, no forge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realEffects } from '../../src/flow/effects.ts';
import type { ServiceConfig } from '../../src/workspace/config.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { CONFIG } from './support.ts';
import { gitIn, remote, tempDir } from '../workspace/git.ts';

const conf = '[merge]\nverdict = ok\n[session]\nhosts = none\n[guard]\nterms = none\nallowed = none\n';
const TICKET: Ticket = { id: 'LOCAL-8', title: 'Newest first', body: '', labels: [], project: 'guestbook', status: 'Todo', createdAt: 'x', updatedAt: 'x' };

function world() {
  const root = tempDir('flow-capture-paths');
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: join(root, 'state') };
  delete env.ORCH_LEDGER;
  const service = (name: string, files: Record<string, string>): ServiceConfig => ({
    name, kind: 'repository', repo: `example-org/${name}`, url: remote(files), base: 'main', path: null, dir: join(root, 'services', name, 'checkout'),
    healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null,
  });
  const guestbook = service('guestbook', { '.cleared/agents.conf': conf, 'src/page.ts': 'export const page = 1;\n', 'src/server.ts': 'export {};\n' });
  const mono = { ...service('mono', { '.cleared/agents.conf': conf, 'web/src/page.ts': 'export {};\n', 'api/src/server.ts': 'export {};\n' }), kind: 'folder' as const, path: 'api' };
  const config = { ...CONFIG, projectDir: guestbook.dir, repoUrl: guestbook.url, workdirRoot: join(root, 'work') };
  return { guestbook, mono, flow: realEffects(config, { env }) };
}

test('the committed paths of the author\'s branch, against the base; what is not committed is not read', async () => {
  const { flow, guestbook } = world();
  const { workdir } = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', service: guestbook });
  const read = flow.changedPaths as NonNullable<typeof flow.changedPaths>;
  assert.deepEqual(await read({ ticket: TICKET.id, service: guestbook, workdir }), []);
  writeFileSync(join(workdir, 'src', 'server.ts'), 'export const port = 0;\n');
  mkdirSync(join(workdir, 'test'));
  writeFileSync(join(workdir, 'test', 'server.test.ts'), 'export {};\n');
  gitIn(workdir, ['add', 'src/server.ts', 'test/server.test.ts']);
  gitIn(workdir, ['commit', '-q', '-m', 'The port from the settings']);
  writeFileSync(join(workdir, 'src', 'page.ts'), 'not committed\n');
  assert.deepEqual([...await read({ ticket: TICKET.id, service: guestbook, workdir })].sort(), ['src/server.ts', 'test/server.test.ts']);
});

test('a folder service reads the paths in its folder only, as paths of the repository', async () => {
  const { flow, mono } = world();
  const { workdir } = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', service: mono });
  writeFileSync(join(workdir, 'web', 'src', 'page.ts'), 'export const page = 2;\n');
  writeFileSync(join(workdir, 'api', 'src', 'server.ts'), 'export const port = 0;\n');
  gitIn(workdir, ['commit', '-q', '-am', 'Both folders change']);
  assert.deepEqual(await (flow.changedPaths as NonNullable<typeof flow.changedPaths>)({ ticket: TICKET.id, service: mono, workdir }), ['api/src/server.ts']);
});
