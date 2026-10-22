// The recipes as each service's base branch holds them (decision 29): read
// from git's objects at refs/remotes/origin/<base> of the service's own
// checkout, never from its working tree; plain files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRecipeSource } from '../../src/recipes/source.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const recipe = (name: string, body = 'Do it.\n\n- [ ] done\n') => `---\nname: ${name}\nkind: ticket\n---\n${body}`;

// A repository pushed to a bare origin, then cloned: the clone is the service's checkout.
function repository(root: string, name: string, files: Record<string, string>, links: Record<string, string> = {}): string {
  const work = join(root, `${name}-work`);
  const origin = join(root, `${name}.git`);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(root, 'init', '-q', '-b', 'main', work);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(work, path, '..'), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(join(work, path, '..'), { recursive: true });
    symlinkSync(target, join(work, path));
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'seed');
  git(work, 'remote', 'add', 'origin', origin);
  git(work, 'push', '-q', 'origin', 'main');
  const checkout = join(root, name);
  git(root, 'clone', '-q', origin, checkout);
  return checkout;
}

test('the recipes are read at the base branch; a change of the working tree or an unpushed commit is not seen', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'recipes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = repository(root, 'guestbook', {
    '.cleared/recipes/bump.md': recipe('bump'),
    '.cleared/recipes/tidy.md': recipe('tidy'),
    '.cleared/recipes/notes.txt': 'not a recipe',
    'README.md': '# Guestbook\n',
  });
  writeFileSync(join(dir, '.cleared/recipes/bump.md'), recipe('bump', 'Changed in the working tree.\n\n- [ ] x\n'));
  writeFileSync(join(dir, '.cleared/recipes/local.md'), recipe('local'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'local only');
  const source = gitRecipeSource({ services: [{ name: 'guestbook', base: 'main', dir, path: null }] });
  const { recipes, problems } = await source.list();
  assert.deepEqual(recipes.map((r) => `${r.service}:${r.name}`), ['guestbook:bump', 'guestbook:tidy']);
  assert.equal(recipes[0]?.body, 'Do it.\n\n- [ ] done\n');
  assert.deepEqual(problems, []);
});

test('a committed link, a file that is not a recipe and a name used by an earlier service are left out, each with its problem', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'recipes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const guestbook = repository(root, 'guestbook', { '.cleared/recipes/bump.md': recipe('bump'), '.cleared/recipes/broken.md': 'no front matter' },
    { '.cleared/recipes/secret.md': '/etc/passwd' });
  const filter = repository(root, 'filter-api', { '.cleared/recipes/bump.md': recipe('bump'), '.cleared/recipes/words.md': recipe('words') });
  const source = gitRecipeSource({ services: [{ name: 'guestbook', base: 'main', dir: guestbook, path: null }, { name: 'filter-api', base: 'main', dir: filter, path: null }] });
  const { recipes, problems } = await source.list();
  assert.deepEqual(recipes.map((r) => `${r.service}:${r.name}`), ['guestbook:bump', 'filter-api:words']);
  assert.deepEqual(problems.map((p) => `${p.service}:${p.file}`).sort(), ['filter-api:.cleared/recipes/bump.md', 'guestbook:.cleared/recipes/broken.md', 'guestbook:.cleared/recipes/secret.md']);
  assert.match(problems.find((p) => p.file.endsWith('secret.md'))?.message ?? '', /plain file/);
  assert.match(problems.find((p) => p.service === 'filter-api')?.message ?? '', /guestbook/);
});

test('a folder service reads the recipes of its folder; a service never fetched has none, and says so', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'recipes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mono = repository(root, 'mono', { 'web/.cleared/recipes/web-only.md': recipe('web-only'), '.cleared/recipes/root.md': recipe('root') });
  const source = gitRecipeSource({ services: [{ name: 'web', base: 'main', dir: mono, path: 'web' }, { name: 'api', base: 'main', dir: join(root, 'absent'), path: null }] });
  const { recipes, problems } = await source.list();
  assert.deepEqual(recipes.map((r) => `${r.service}:${r.name}`), ['web:web-only']);
  assert.deepEqual(problems.map((p) => p.service), ['api']);
  assert.match(problems[0]?.message ?? '', /main/);
});

test('a recipe file larger than 64 KiB is refused', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'recipes-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = repository(root, 'guestbook', { '.cleared/recipes/big.md': recipe('big', `${'x'.repeat(70 * 1024)}\n\n- [ ] done\n`) });
  const { recipes, problems } = await gitRecipeSource({ services: [{ name: 'guestbook', base: 'main', dir, path: null }] }).list();
  assert.deepEqual(recipes, []);
  assert.match(problems[0]?.message ?? '', /65536 bytes/);
});
