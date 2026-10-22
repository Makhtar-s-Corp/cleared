// The flow's effects for a service of a workspace of several (lane 16):
// each service is cloned into its own checkout and read at its own base
// branch; a ticket's checkout per service is <workdirs>/<ticket>/<service>,
// on the same branch name on every service; what a published head changes
// is read against that service's base. Two temporary repositories, no forge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realEffects } from '../../src/flow/effects.ts';
import type { ServiceConfig } from '../../src/workspace/config.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { CONFIG } from './support.ts';
import { gitIn, remote, tempDir } from '../workspace/git.ts';

const conf = (verdict: string, hosts: string) => `[merge]\nverdict = ${verdict}\n[session]\nhosts = ${hosts}\n[guard]\nterms = none\nallowed = none\n`;

const TICKET: Ticket = { id: 'LOCAL-4', title: 'Held for review', body: 'Hold it.', labels: [], project: 'guestbook', status: 'Todo', createdAt: 'x', updatedAt: 'x' };

function world() {
  const root = tempDir('flow-services');
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: join(root, 'state') };
  delete env.ORCH_LEDGER;
  const service = (name: string, files: Record<string, string>, base = 'main'): ServiceConfig => ({
    name, kind: 'repository', repo: `example-org/${name}`, url: remote(files), base, path: null, dir: join(root, 'services', name, 'checkout'),
    healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null,
  });
  const guestbook = service('guestbook', { '.cleared/agents.conf': conf('no blocking issues', 'registry.npmjs.org'), 'src/page.ts': 'export const page = 1;\n' });
  const filter = service('filter-api', { '.cleared/agents.conf': conf('ship it', 'example.invalid'), 'contract/openapi.yaml': 'openapi: 3.1.0\n', 'package.json': '{"scripts":{"test":"node --test"}}' });
  const config = { ...CONFIG, projectDir: guestbook.dir, repoUrl: guestbook.url, workdirRoot: join(root, 'work') };
  const mono = { ...service('mono', { '.cleared/agents.conf': conf('ok', 'none'), 'filter-api/contract/openapi.yaml': 'openapi: 3.1.0\n' }), kind: 'folder' as const, path: 'filter-api', contract: { format: 'openapi' as const, path: 'contract/openapi.yaml' } };
  return { root, env, guestbook, filter, mono, flow: realEffects(config, { env }) };
}

test('each service is read at its own base branch, from its own checkout', async () => {
  const { flow, guestbook, filter } = world();
  assert.deepEqual(await flow.settings(guestbook), { verdict: 'no blocking issues', safeCommands: [], hosts: ['registry.npmjs.org'], services: [], scripts: [] });
  assert.deepEqual(await flow.settings(filter), { verdict: 'ship it', safeCommands: [], hosts: ['example.invalid'], services: [], scripts: ['test'] });
  assert.match(readFileSync(join(filter.dir, 'contract', 'openapi.yaml'), 'utf8'), /openapi/);
});

test('a ticket gets a checkout per service under <workdirs>/<ticket>/<service>, on the same branch on each', async () => {
  const { flow, guestbook, filter, root } = world();
  const one = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', service: guestbook });
  const two = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', service: filter });
  assert.equal(one.workdir, join(root, 'work', 'LOCAL-4', 'guestbook'));
  assert.equal(two.workdir, join(root, 'work', 'LOCAL-4', 'filter-api'));
  for (const workdir of [one.workdir, two.workdir]) assert.equal(gitIn(workdir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'cleared/LOCAL-4');
  assert.match(readFileSync(join(two.workdir, 'contract', 'openapi.yaml'), 'utf8'), /openapi/, 'the filter API\'s own files');
  // The reviewer works in the same checkout.
  assert.equal((await flow.prepareWorkdir({ ticket: TICKET, role: 'reviewer', service: filter })).workdir, two.workdir);
});

test('without a service, the ticket\'s checkout is <workdirs>/<ticket>, as in milestone 1', async () => {
  const { flow, root } = world();
  assert.equal((await flow.prepareWorkdir({ ticket: TICKET, role: 'author' })).workdir, join(root, 'work', 'LOCAL-4'));
});

test('what a head changes is read in its service\'s checkout, against that service\'s base: the files and the diff', async () => {
  const { flow, filter } = world();
  const { workdir } = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', service: filter });
  writeFileSync(join(workdir, 'contract', 'openapi.yaml'), 'openapi: 3.1.0\ninfo: {}\n');
  writeFileSync(join(workdir, 'words.txt'), 'held\n');
  gitIn(workdir, ['add', 'contract/openapi.yaml', 'words.txt']);
  gitIn(workdir, ['commit', '-q', '-m', 'Hold flagged entries']);
  const head = gitIn(workdir, ['rev-parse', 'HEAD']);
  // publish fetches the branch out of the ticket checkout into the service's checkout first.
  gitIn(filter.dir, ['fetch', '-q', workdir, `cleared/LOCAL-4:refs/cleared/publish/LOCAL-4`]);
  const changed = await (flow.changes as NonNullable<typeof flow.changes>)({ ticket: TICKET.id, head, service: filter });
  assert.deepEqual([...changed.files].sort(), ['contract/openapi.yaml', 'words.txt']);
  assert.match(changed.diff, /^diff --git a\/contract\/openapi\.yaml b\/contract\/openapi\.yaml/m);
  assert.match(changed.diff, /\+info: \{\}/);
  await assert.rejects((flow.changes as NonNullable<typeof flow.changes>)({ ticket: TICKET.id, head: '--output=x', service: filter }), /not a commit/);
});

// Lane 23: what a step's branch changes, fetched out of its checkout as publish does.
test('a step\'s branch is read against its service\'s base: its files, the contract\'s diff and blob, and the contract as committed in the snapshot', async () => {
  const { flow, filter, root } = world();
  const service = { ...filter, contract: { format: 'openapi' as const, path: 'contract/openapi.yaml' } };
  const { workdir } = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', service });
  const read = flow.stepChanges as NonNullable<typeof flow.stepChanges>;
  const before = await read({ ticket: TICKET.id, service, workdir });
  assert.deepEqual(before.files, []);
  assert.equal(before.contract?.diff, '');
  assert.match(before.contract?.blob ?? '', /^[0-9a-f]{40}$/);
  writeFileSync(join(workdir, 'contract', 'openapi.yaml'), 'openapi: 3.1.0\ninfo: {}\n');
  gitIn(workdir, ['commit', '-q', '-am', 'The contract gains its info']);
  writeFileSync(join(workdir, 'contract', 'openapi.yaml'), 'not committed\n');
  const snapshot = join(root, 'work', 'LOCAL-4', '.validated', 'step-1-1');
  const after = await read({ ticket: TICKET.id, service, workdir, snapshot });
  assert.deepEqual(after.files, ['contract/openapi.yaml']);
  assert.match(after.contract?.diff ?? '', /\+info: \{\}/);
  assert.notEqual(after.contract?.blob, before.contract?.blob);
  assert.equal(after.contract?.snapshot, join(snapshot, 'openapi.yaml'));
  assert.equal(readFileSync(join(snapshot, 'openapi.yaml'), 'utf8'), 'openapi: 3.1.0\ninfo: {}\n', 'what is committed, not the working file');
  assert.equal((await read({ ticket: TICKET.id, service: filter, workdir })).contract, null, 'a service without a contract');
  writeFileSync(join(workdir, '.git', 'objects', 'info', 'alternates'), '/elsewhere/objects\n');
  await assert.rejects(read({ ticket: TICKET.id, service, workdir }), /alternates/);
});

test('a folder service\'s contract is read inside its folder, as a path of the repository', async () => {
  const { flow, mono } = world();
  const { workdir } = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', service: mono });
  writeFileSync(join(workdir, 'filter-api', 'contract', 'openapi.yaml'), 'openapi: 3.1.0\ninfo: {}\n');
  gitIn(workdir, ['commit', '-q', '-am', 'The contract gains its info']);
  const read = await (flow.stepChanges as NonNullable<typeof flow.stepChanges>)({ ticket: TICKET.id, service: mono, workdir });
  assert.deepEqual(read.files, ['filter-api/contract/openapi.yaml']);
  assert.equal(read.contract?.path, 'filter-api/contract/openapi.yaml', 'so the contract-only check compares like with like');
  assert.match(read.contract?.diff ?? '', /\+info: \{\}/);
});

// The reviewer of a ticket of several services sees every service's change
// (owner decision of 2026-10-22 20:33): each one read as a step's branch is.
test('a service\'s ticket branch is read for the reviewer out of <workdirs>/<ticket>/<service>: its files and its whole diff, committed only', async () => {
  const { flow, filter, guestbook } = world();
  const read = flow.branchChanges as NonNullable<typeof flow.branchChanges>;
  assert.deepEqual(await read({ ticket: TICKET.id, service: guestbook }), { files: [], diff: '' }, 'a service the ticket has no checkout of has no change');
  const { workdir } = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', service: filter });
  assert.deepEqual(await read({ ticket: TICKET.id, service: filter }), { files: [], diff: '' });
  writeFileSync(join(workdir, 'contract', 'openapi.yaml'), 'openapi: 3.1.0\ninfo: {}\n');
  writeFileSync(join(workdir, 'words.txt'), 'held\n');
  gitIn(workdir, ['add', 'contract/openapi.yaml', 'words.txt']);
  gitIn(workdir, ['commit', '-q', '-m', 'Hold flagged entries']);
  writeFileSync(join(workdir, 'words.txt'), 'not committed\n');
  const changed = await read({ ticket: TICKET.id, service: filter });
  assert.deepEqual([...changed.files].sort(), ['contract/openapi.yaml', 'words.txt']);
  assert.match(changed.diff, /^diff --git a\/contract\/openapi\.yaml b\/contract\/openapi\.yaml/m);
  assert.match(changed.diff, /\+info: \{\}/);
  assert.match(changed.diff, /\+held/);
  assert.doesNotMatch(changed.diff, /not committed/);
  // A checkout whose git would read another repository is refused, as for a step.
  writeFileSync(join(workdir, '.git', 'commondir'), '../elsewhere\n');
  await assert.rejects(read({ ticket: TICKET.id, service: filter }), /commondir/);
});
