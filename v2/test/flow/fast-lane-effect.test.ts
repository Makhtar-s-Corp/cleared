// The fast lane's real reading (matrix B2.2): v1's rules (lib/fast-lane.mjs,
// docs/fast-lane.md) on what merging the ticket's branch would land on the
// base, read out of the service's own checkout, with the [fast_lane]
// settings of the service's base branch, never the branch's own. Real git in
// temporary repositories; nothing reaches a forge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { realEffects } from '../../src/flow/effects.ts';
import type { Ticket } from '../../src/tickets/contract.ts';
import { CONFIG } from './support.ts';
import { commit, gitIn, remote, tempDir } from '../workspace/git.ts';

const FAST = '[fast_lane]\nenabled = yes\nlabels = Quick\nsafe_paths = docs/, README.md\nmax_lines = 20\n';
const conf = (fast = FAST) => `[merge]\nverdict = no blocking issues\n[guard]\nterms = none\nallowed = none\n${fast}`;
const TICKET: Ticket = { id: 'LOCAL-1', title: 'A troubleshooting section', body: 'Say what to do.', labels: ['Quick'], project: 'guestbook', status: 'Todo', createdAt: 'x', updatedAt: 'x' };

async function world(fast?: string) {
  const root = tempDir('fast-lane');
  const env: NodeJS.ProcessEnv = { ...process.env, CLEARED_STATE_DIR: join(root, 'state') };
  delete env.ORCH_LEDGER;
  const config = { ...CONFIG, projectDir: join(root, 'project'), repoUrl: remote({ '.cleared/agents.conf': conf(fast), 'docs/guide.md': '# Guide\n' }), workdirRoot: join(root, 'work') };
  const flow = realEffects(config, { env });
  const { workdir } = await flow.prepareWorkdir({ ticket: TICKET, role: 'author' });
  const judge = flow.fastLane as NonNullable<typeof flow.fastLane>;
  return { config, flow, workdir, judge };
}

test('a prose change in the safe paths is fast, read from the session\'s branch', async () => {
  const { workdir, judge } = await world();
  const head = commit(workdir, { 'docs/troubleshooting.md': '# Troubleshooting\n\nWhen the database does not answer, start it again.\n' }, 'A troubleshooting page');
  const verdict = await judge({ ticket: TICKET.id, workdir });
  assert.deepEqual({ state: verdict.state, reasons: verdict.reasons, keep: verdict.keep, files: verdict.files, lines: verdict.lines }, { state: 'fast', reasons: [], keep: true, files: 1, lines: 3 });
  assert.equal(verdict.head, head, 'judged at the branch\'s own commit');
});

test('code outside the safe paths, and markup in a page, take the full circuit with their reasons', async () => {
  const { workdir, judge } = await world();
  commit(workdir, { 'src/entries.ts': 'export const newest = true;\n', 'docs/guide.md': '# Guide\n\n<script>alert(1)</script>\n' }, 'Code and markup');
  const verdict = await judge({ ticket: TICKET.id, workdir });
  assert.equal(verdict.state, 'full');
  assert.equal(verdict.keep, true, 'a rule the diff breaks is kept: the ticket goes back for good');
  assert.deepEqual([...verdict.reasons].sort(), ['content', 'file_type', 'outside_safe']);
  assert.match(verdict.first ?? '', /outside_safe: src\/entries\.ts/);
});

test('more lines than max_lines is too many', async () => {
  const { workdir, judge } = await world();
  commit(workdir, { 'docs/long.md': Array.from({ length: 25 }, (_, i) => `Line ${i + 1}.`).join('\n') + '\n' }, 'A long page');
  const verdict = await judge({ ticket: TICKET.id, workdir });
  assert.deepEqual(verdict.reasons, ['too_many_lines']);
});

test('the settings are the base\'s: a branch that widens its own safe paths is protected, not fast', async () => {
  const { workdir, judge } = await world();
  commit(workdir, { '.cleared/agents.conf': conf(FAST.replace('safe_paths = docs/, README.md', 'safe_paths = docs/, README.md, src/')), 'src/entries.ts': 'export const newest = true;\n' }, 'Widen');
  const verdict = await judge({ ticket: TICKET.id, workdir });
  assert.equal(verdict.state, 'full');
  assert.ok(verdict.reasons.includes('protected'));
  assert.ok(verdict.reasons.includes('outside_safe'), 'src/ is not safe at the base');
});

test('a published head is read in the service\'s checkout, as the publish left it', async () => {
  const { config, workdir, judge } = await world();
  const head = commit(workdir, { 'README.md': '# Demo\n\nRun npm test.\n' }, 'Say how to test');
  gitIn(config.projectDir, ['fetch', '-q', join(workdir, '.git'), `cleared/${TICKET.id}`]);
  const verdict = await judge({ ticket: TICKET.id, head });
  assert.deepEqual({ state: verdict.state, head: verdict.head }, { state: 'fast', head });
});

test('a service with the fast lane off, or settings it cannot read, is the full circuit for this reading only', async () => {
  const off = await world('');
  commit(off.workdir, { 'docs/troubleshooting.md': '# Troubleshooting\n' }, 'A page');
  assert.deepEqual(await off.judge({ ticket: TICKET.id, workdir: off.workdir }), { state: 'full', reasons: ['disabled'], keep: false });
  const typo = await world(`${FAST}never_path = docs/legal/\n`);
  commit(typo.workdir, { 'docs/troubleshooting.md': '# Troubleshooting\n' }, 'A page');
  const verdict = await typo.judge({ ticket: TICKET.id, workdir: typo.workdir });
  assert.deepEqual({ state: verdict.state, reasons: verdict.reasons, keep: verdict.keep }, { state: 'full', reasons: ['settings'], keep: false });
  assert.match(verdict.problem ?? '', /unknown key "never_path"/);
});

test('a branch that conflicts with the base is not judged: the full circuit, not kept', async () => {
  const { config, workdir, judge } = await world();
  commit(workdir, { 'docs/guide.md': '# Guide\n\nOn the branch.\n' }, 'Branch side');
  // The base moves under the branch, on the same line.
  const seed = join(tempDir('fast-lane-seed'), 'seed');
  gitIn(tempDir('fast-lane-clone'), ['clone', '-q', config.repoUrl, seed]);
  commit(seed, { 'docs/guide.md': '# Guide\n\nOn the base.\n' }, 'Base side');
  gitIn(seed, ['push', '-q', 'origin', 'main']);
  const verdict = await judge({ ticket: TICKET.id, workdir });
  assert.deepEqual({ state: verdict.state, reasons: verdict.reasons, keep: verdict.keep }, { state: 'full', reasons: ['unreadable'], keep: false });
});
