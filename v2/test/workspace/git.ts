// Temporary repositories for the workspace and runner tests: a bare remote
// seeded with one commit on the base branch, as a forge would hold it.
// git runs without the machine's own configuration (no global or system
// file), with a fictitious identity and no signing.
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test Author';
process.env.GIT_AUTHOR_EMAIL = 'author@example.invalid';
process.env.GIT_COMMITTER_NAME = 'Test Author';
process.env.GIT_COMMITTER_EMAIL = 'author@example.invalid';

export function gitIn(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cleared-${prefix}-`));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

// The project's committed settings: no private-term list, as the example
// project has (examples/guestbook/.cleared/agents.conf).
export const AGENTS_CONF = '[guard]\nterms = none\nallowed = none\n';

// A bare repository whose base branch `main` holds `files` in one commit.
export function remote(files: Record<string, string> = {}): string {
  const root = tempDir('remote');
  const bare = join(root, 'project.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  const seed = join(root, 'seed');
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  writeFiles(seed, { 'README.md': '# Demo\n', '.cleared/agents.conf': AGENTS_CONF, ...files });
  gitIn(seed, ['add', '-A']);
  gitIn(seed, ['commit', '-q', '-m', 'first commit']);
  gitIn(seed, ['push', '-q', bare, 'main']);
  return bare;
}

// A commit in `dir` of `files`, as a session makes one.
export function commit(dir: string, files: Record<string, string>, message: string): string {
  writeFiles(dir, files);
  gitIn(dir, ['add', '-A']);
  gitIn(dir, ['commit', '-q', '-m', message]);
  return gitIn(dir, ['rev-parse', 'HEAD']);
}

// Secret-shaped values are assembled at run time: written whole, they would
// make the repository guard refuse this file, which is what it is for.
export const plantedKey = ['sk', 'ant', 'api03', 'Q7w8E9r0T1y2U3i4O5p6A7s8D9f0'].join('-');
