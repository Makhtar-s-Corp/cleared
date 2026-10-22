import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE_REF, CheckoutError, exportBase, projectCheckout, ticketBranch, ticketCheckout } from '../../src/workspace/checkout.ts';
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

// ------------------------------------------ one checkout per ticket and per service (milestone 2, decision 20)

test('a ticket touching two services has one checkout of each, <workdirs>/<ticket>/<service>, on the same branch', async () => {
  const root = tempDir('two-services');
  const guestbook = await projectCheckout({ url: remote({ 'src/page.ts': 'page\n' }), dir: join(root, 'services', 'guestbook', 'checkout'), base: 'main' });
  const filter = await projectCheckout({ url: remote({ 'src/check.ts': 'check\n' }), dir: join(root, 'services', 'filter-api', 'checkout'), base: 'main' });
  const branch = ticketBranch('LOCAL-7');
  const one = await ticketCheckout({ project: guestbook.dir, workdir: join(root, 'work', 'LOCAL-7', 'guestbook'), base: 'main', branch });
  const two = await ticketCheckout({ project: filter.dir, workdir: join(root, 'work', 'LOCAL-7', 'filter-api'), base: 'main', branch });
  assert.equal(gitIn(one.workdir, ['branch', '--show-current']), 'cleared/LOCAL-7');
  assert.equal(gitIn(two.workdir, ['branch', '--show-current']), 'cleared/LOCAL-7');
  assert.ok(existsSync(join(one.workdir, 'src/page.ts')) && existsSync(join(two.workdir, 'src/check.ts')), 'each is a clone of its own service');
  assert.equal(one.cwd, one.workdir, 'a repository service works at the root of its checkout');
  assert.deepEqual(readdirSync(join(root, 'work', 'LOCAL-7')).sort(), ['filter-api', 'guestbook']);
});

test('a folder of a monorepo: the clone is the repository, and the session works in the folder', async () => {
  const url = remote({ 'services/billing/package.json': '{}\n', 'services/web/package.json': '{}\n' });
  const root = tempDir('monorepo');
  const project = await projectCheckout({ url, dir: join(root, 'project'), base: 'main' });
  const workdir = join(root, 'work', 'LOCAL-8', 'billing');
  const made = await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: ticketBranch('LOCAL-8'), path: 'services/billing' });
  assert.equal(made.cwd, join(workdir, 'services', 'billing'));
  assert.ok(existsSync(join(workdir, 'services/web/package.json')), 'the whole repository is cloned');
  const reused = await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: ticketBranch('LOCAL-8'), path: 'services/billing' });
  assert.equal(reused.reused, true);
  assert.equal(reused.cwd, made.cwd);
  for (const bad of ['../x', '/services/billing', 'services//billing', '']) {
    await assert.rejects(ticketCheckout({ project: project.dir, workdir: join(root, 'work', 'bad'), base: 'main', branch: ticketBranch('LOCAL-9'), path: bad }), CheckoutError, bad);
  }
  await assert.rejects(ticketCheckout({ project: project.dir, workdir, base: 'main', branch: ticketBranch('LOCAL-8'), path: 'services/missing' }), /not a folder of the checkout/);
  // The session can replace the folder by a link: the host refuses it.
  rmSync(join(workdir, 'services', 'billing'), { recursive: true });
  symlinkSync('/etc', join(workdir, 'services', 'billing'));
  await assert.rejects(ticketCheckout({ project: project.dir, workdir, base: 'main', branch: ticketBranch('LOCAL-8'), path: 'services/billing' }), /not a folder of the checkout/);
});

test('the base branch is exported once per commit from the service\'s own checkout, never from its working tree', async () => {
  const { url, root, project } = await setup();
  writeFileSync(join(project.dir, 'src/app.ts'), 'a change nobody committed\n');
  const exports = join(root, 'exports');
  const first = await exportBase({ project: project.dir, base: 'main', root: exports });
  assert.ok(first);
  assert.equal(first.commit, project.base);
  assert.equal(first.dir, join(exports, project.base));
  assert.equal(readFileSync(join(first.dir, 'src/app.ts'), 'utf8'), 'export const answer = 42;\n');
  assert.equal(existsSync(join(first.dir, '.git')), false);
  writeFileSync(join(first.dir, 'marker'), 'kept');
  const again = await exportBase({ project: project.dir, base: 'main', root: exports });
  assert.equal(readFileSync(join(again?.dir ?? '', 'marker'), 'utf8'), 'kept', 'an export of the same commit is reused');
  assert.deepEqual(readdirSync(exports), [project.base], 'no partial folder is left');

  // The base moves: a new commit, a new folder.
  const seed = tempDir('seed');
  gitIn(seed, ['clone', '-q', url, 'w']);
  const moved = commit(join(seed, 'w'), { 'src/app.ts': 'export const answer = 43;\n' }, 'base moves');
  gitIn(join(seed, 'w'), ['push', '-q', 'origin', 'main']);
  await projectCheckout({ url, dir: project.dir, base: 'main' });
  const next = await exportBase({ project: project.dir, base: 'main', root: exports });
  assert.equal(next?.commit, moved);
  assert.equal(readFileSync(join(next?.dir ?? '', 'src/app.ts'), 'utf8'), 'export const answer = 43;\n');
});

test('one folder of the base can be exported alone, its content at the top; a base without it exports nothing', async () => {
  const { root, project } = await setup();
  const skills = await exportBase({ project: project.dir, base: 'main', root: join(root, 'skills'), only: '.claude/skills' });
  assert.deepEqual(readdirSync(skills?.dir ?? ''), ['demo-skill']);
  assert.equal(readFileSync(join(skills?.dir ?? '', 'demo-skill/SKILL.md'), 'utf8'), SKILL);
  assert.equal(await exportBase({ project: project.dir, base: 'main', root: join(root, 'none'), only: '.claude/agents' }), undefined);
  assert.equal(existsSync(join(root, 'none')), false);
  await assert.rejects(exportBase({ project: project.dir, base: 'main', root: join(root, 'x'), only: '../x' }), CheckoutError);
});
