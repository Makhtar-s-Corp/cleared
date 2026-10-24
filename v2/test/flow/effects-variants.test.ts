// The flow's effects for a ticket's variants (issue #271, P75): each
// variant is its own clone, <workdirs>/<ticket>.variant-<round>-<position>,
// on the ticket branch's one name, and what it changes is read out of its
// checkout into a ref of its own, so two variants never read each other's
// change. A temporary repository, no forge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realEffects } from '../../src/flow/effects.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { CONFIG } from './support.ts';
import { gitIn, remote, tempDir } from '../workspace/git.ts';

const TICKET: Ticket = { id: 'LOCAL-4', title: 'Newest first', body: 'Sort it.', labels: [], project: 'guestbook', status: 'Todo', createdAt: 'x', updatedAt: 'x' };
const CONF = '[merge]\nverdict = no blocking issues\n[session]\nhosts = registry.npmjs.org\n[guard]\nterms = none\nallowed = none\n';

function world() {
  const root = tempDir('flow-variants');
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: join(root, 'state') };
  delete env.ORCH_LEDGER;
  const url = remote({ '.cleared/agents.conf': CONF, 'src/entries.ts': 'export const order = "oldest";\n' });
  const config = { ...CONFIG, projectDir: join(root, 'project'), repoUrl: url, workdirRoot: join(root, 'work') };
  return { root, flow: realEffects(config, { env }) };
}

function commit(workdir: string, file: string, text: string): void {
  writeFileSync(join(workdir, file), text);
  gitIn(workdir, ['add', file]);
  gitIn(workdir, ['commit', '-q', '-m', `Change ${file}`]);
}

test('each variant is its own clone on the ticket branch, and its change is read from its own checkout, committed work only', async () => {
  const { flow, root } = world();
  const one = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', variant: { round: 1, position: 1 } });
  const two = await flow.prepareWorkdir({ ticket: TICKET, role: 'author', variant: { round: 1, position: 2 } });
  assert.equal(one.workdir, join(root, 'work', 'LOCAL-4.variant-1-1'));
  assert.equal(two.workdir, join(root, 'work', 'LOCAL-4.variant-1-2'));
  for (const workdir of [one.workdir, two.workdir]) assert.equal(gitIn(workdir, ['rev-parse', '--abbrev-ref', 'HEAD']), 'cleared/LOCAL-4');

  commit(one.workdir, 'src/entries.ts', 'export const order = "newest";\n');
  commit(two.workdir, 'src/sort.ts', 'export const sort = (a: number[]) => [...a].reverse();\n');
  writeFileSync(join(two.workdir, 'notes.txt'), 'not committed\n');

  const read = flow.variantChanges as NonNullable<typeof flow.variantChanges>;
  const first = await read({ ticket: TICKET.id, workdir: one.workdir, variant: { round: 1, position: 1 } });
  const second = await read({ ticket: TICKET.id, workdir: two.workdir, variant: { round: 1, position: 2 } });
  assert.deepEqual(first.files, ['src/entries.ts']);
  assert.match(first.diff, /^-export const order = "oldest";$/m);
  assert.match(first.diff, /^\+export const order = "newest";$/m);
  assert.deepEqual(second.files, ['src/sort.ts'], 'its own change, not the other variant\'s, and nothing uncommitted');
  // Read again after the first changed more: still each its own.
  commit(one.workdir, 'src/more.ts', 'export {};\n');
  assert.deepEqual((await read({ ticket: TICKET.id, workdir: two.workdir, variant: { round: 1, position: 2 } })).files, ['src/sort.ts']);
  assert.deepEqual([...(await read({ ticket: TICKET.id, workdir: one.workdir, variant: { round: 1, position: 1 } })).files].sort(), ['src/entries.ts', 'src/more.ts']);

  // The chosen variant's reviewer works in its checkout, as it was left.
  assert.equal((await flow.prepareWorkdir({ ticket: TICKET, role: 'reviewer', variant: { round: 1, position: 2 } })).workdir, two.workdir);
  // The ticket's own checkout is another clone.
  assert.equal((await flow.prepareWorkdir({ ticket: TICKET, role: 'author' })).workdir, join(root, 'work', 'LOCAL-4'));
});
