// The guard's strict pass leaves v2/package-lock.json out (scripts/guard.ts:
// the "assigned secret" rule reads a dependency's version range as a
// secret), and only its tree pass reads the lock file. Issue 185, item 3:
// that exclusion is held by a test. The guard runs as CI runs it, with
// --base, in a repository of its own made in a temporary folder, with the
// repository's guard copied in and no private-term list (CLEARED_REPO
// unset): a secret pattern, not a private term, is what is planted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const v2 = new URL('../..', import.meta.url).pathname;
const repository = join(v2, '..');
// A secret-shaped line, made here so that this file holds none: a key named
// token given a quoted value of eight characters or more.
const SECRET_LINE = `    "${['to', 'ken'].join('')}": "${'s3cr3t-'.repeat(2)}value",`;
const LOCK = (extra: string) => `{\n  "name": "cleared-v2",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n${extra}      "name": "cleared-v2"\n    }\n  }\n}\n`;

function repo(t: test.TestContext): { readonly root: string; readonly commit: (files: Record<string, string>, message: string) => void } {
  const root = mkdtempSync(join(tmpdir(), 'cleared-v2-guard-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgSign=false', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(root, 'lib', 'guard'), { recursive: true });
  for (const name of ['codex-guard.ts', 'private-terms.ts']) copyFileSync(join(repository, 'lib', 'guard', name), join(root, 'lib', 'guard', name));
  const commit = (files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  commit({ 'v2/package.json': '{ "name": "cleared-v2", "private": true }\n', 'v2/package-lock.json': LOCK('') }, 'base');
  git('tag', 'base');
  return { root, commit };
}

function guard(root: string): { readonly status: number | null; readonly out: string } {
  const env = { ...process.env };
  delete env.CLEARED_REPO;
  delete env.ORCH_GUARD_REF;
  const result = spawnSync(process.execPath, [join(v2, 'scripts', 'guard.ts'), '--base', 'base'], { cwd: join(root, 'v2'), env, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test('a secret-shaped line planted in package-lock.json fails the tree pass, though the strict pass leaves the lock file out', (t) => {
  const { root, commit } = repo(t);
  commit({ 'v2/package-lock.json': LOCK(`${SECRET_LINE}\n`) }, 'a planted line');
  const { status, out } = guard(root);
  assert.equal(status, 1, out);
  assert.match(out, /guard: 2 v2 files: refused/, out);
  assert.match(out, /guard: the lines changed since base: nothing refused/, `the strict pass does not read the lock file\n${out}`);
  assert.doesNotMatch(out, /s3cr3t/, 'the value is never printed');
});

test('the same line in another file fails the strict pass too, and a clean change passes both', (t) => {
  const { root, commit } = repo(t);
  commit({ 'v2/notes.md': `${SECRET_LINE}\n` }, 'a planted line elsewhere');
  const planted = guard(root);
  assert.equal(planted.status, 1, planted.out);
  assert.match(planted.out, /guard: the lines changed since base: refused/, planted.out);

  const clean = repo(t);
  clean.commit({ 'v2/package-lock.json': LOCK('      "version": "0.0.1",\n') }, 'a clean change');
  const passed = guard(clean.root);
  assert.equal(passed.status, 0, passed.out);
  assert.match(passed.out, /guard: 2 v2 files: nothing refused/, passed.out);
});
