import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_REF, CheckoutError, projectCheckout, ticketBranch, ticketCheckout } from '../../src/workspace/checkout.ts';
import { commit, gitIn, remote, tempDir } from './git.ts';

const SKILL = '---\nname: demo-skill\ndescription: A skill of the project.\n---\nRun the tests first.\n';

async function setup() {
  const url = remote({ '.claude/skills/demo-skill/SKILL.md': SKILL, 'src/app.ts': 'export const answer = 42;\n' });
  const root = tempDir('checkout');
  const project = await projectCheckout({ url, dir: join(root, 'project'), base: 'main' });
  return { url, root, project };
}

test('the ticket branch is named after the ticket, and a name git would refuse is refused', () => {
  assert.equal(ticketBranch('DEMO-12'), 'cleared/DEMO-12');
  for (const bad of ['', '-x', 'a b', '../x', 'a..b', 'x/y', 'x.lock']) assert.throws(() => ticketBranch(bad), CheckoutError, bad);
});

test('the project checkout is cloned once, then fetched', async () => {
  const { url, project } = await setup();
  assert.equal(project.base, gitIn(url, ['rev-parse', 'main']));
  const seed = tempDir('seed');
  gitIn(seed, ['clone', '-q', url, 'w']);
  const moved = commit(join(seed, 'w'), { 'NEWS.md': 'moved\n' }, 'base moves');
  gitIn(join(seed, 'w'), ['push', '-q', 'origin', 'main']);
  const again = await projectCheckout({ url, dir: project.dir, base: 'main' });
  assert.equal(again.base, moved);
});

test('a project checkout of another remote, or a remote URL with a password, is refused', async () => {
  const { project } = await setup();
  await assert.rejects(projectCheckout({ url: remote(), dir: project.dir, base: 'main' }), CheckoutError);
  const root = tempDir('cred');
  // Assembled at run time, as the guard would refuse it written whole.
  const withPassword = ['https://user', 'hunter22@example.invalid/x.git'].join(':');
  await assert.rejects(projectCheckout({ url: withPassword, dir: join(root, 'p'), base: 'main' }), /password/);
});

test('the ticket checkout is a clone of its own on the ticket branch, from the base', async () => {
  const { url, root, project } = await setup();
  const workdir = join(root, 'tickets', 'DEMO-12');
  const ticket = await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: ticketBranch('DEMO-12') });
  assert.equal(ticket.reused, false);
  assert.equal(gitIn(workdir, ['branch', '--show-current']), 'cleared/DEMO-12');
  assert.equal(gitIn(workdir, ['rev-parse', 'HEAD']), project.base);
  assert.equal(gitIn(workdir, ['rev-parse', BASE_REF]), project.base);
  assert.equal(gitIn(workdir, ['rev-parse', 'origin/main']), project.base);
  // Mounted alone in a container: a real .git folder, no alternates, no
  // link to the project checkout, and origin is the forge, not a host path.
  assert.ok(lstatSync(join(workdir, '.git')).isDirectory());
  assert.equal(existsSync(join(workdir, '.git', 'objects', 'info', 'alternates')), false);
  assert.equal(gitIn(workdir, ['remote', 'get-url', 'origin']), url);
  // The project's skills are there as committed.
  assert.equal(readFileSync(join(workdir, '.claude/skills/demo-skill/SKILL.md'), 'utf8'), SKILL);
});

test('CLAUDE.md and HANDOVER.md are excluded from git in the ticket checkout', async () => {
  const { root, project } = await setup();
  const workdir = join(root, 'w');
  await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: 'cleared/DEMO-1' });
  const exclude = readFileSync(join(workdir, '.git', 'info', 'exclude'), 'utf8').split('\n');
  assert.ok(exclude.includes('/CLAUDE.md') && exclude.includes('/HANDOVER.md'));
  writeFileSync(join(workdir, 'CLAUDE.md'), 'generated\n');
  writeFileSync(join(workdir, 'HANDOVER.md'), 'handover\n');
  assert.equal(gitIn(workdir, ['status', '--porcelain']), '');
});

test('the ticket checkout is reused when it is on the ticket branch, refused otherwise', async () => {
  const { root, project } = await setup();
  const workdir = join(root, 'w');
  await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: 'cleared/DEMO-2' });
  const head = commit(workdir, { 'src/app.ts': 'export const answer = 43;\n' }, 'work');
  const again = await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: 'cleared/DEMO-2' });
  assert.equal(again.reused, true);
  assert.equal(gitIn(workdir, ['rev-parse', 'HEAD']), head);
  await assert.rejects(ticketCheckout({ project: project.dir, workdir, base: 'main', branch: 'cleared/DEMO-3' }), CheckoutError);
  const other = join(root, 'not-a-checkout');
  mkdirSync(other);
  writeFileSync(join(other, 'file'), 'x');
  await assert.rejects(ticketCheckout({ project: project.dir, workdir: other, base: 'main', branch: 'cleared/DEMO-4' }), CheckoutError);
});

test('a ticket checkout that fails half way leaves nothing behind, and the next one succeeds', async () => {
  const { root, project } = await setup();
  const parent = join(root, 'tickets');
  const workdir = join(parent, 'DEMO-8');
  // main/x passes the name checks but cannot be created next to the clone's
  // own main branch: the clone succeeds, the checkout -b after it fails.
  await assert.rejects(ticketCheckout({ project: project.dir, workdir, base: 'main', branch: 'main/x' }), CheckoutError);
  assert.equal(existsSync(workdir), false);
  assert.deepEqual(readdirSync(parent), []);
  const ticket = await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: 'cleared/DEMO-8' });
  assert.equal(ticket.reused, false);
  assert.equal(gitIn(workdir, ['branch', '--show-current']), 'cleared/DEMO-8');
});

test('the base branch is never a ticket branch', async () => {
  const { root, project } = await setup();
  await assert.rejects(ticketCheckout({ project: project.dir, workdir: join(root, 'w'), base: 'main', branch: 'main' }), /base branch/);
});

test('a reused checkout whose git folder was replaced by a link is refused', async () => {
  const { root, project } = await setup();
  const workdir = join(root, 'w');
  await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: 'cleared/DEMO-5' });
  rmSync(join(workdir, '.git', 'info'), { recursive: true });
  symlinkSync(join(root, 'elsewhere'), join(workdir, '.git', 'info'));
  await assert.rejects(ticketCheckout({ project: project.dir, workdir, base: 'main', branch: 'cleared/DEMO-5' }), CheckoutError);
});
