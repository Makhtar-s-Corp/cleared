// The programs the service runs in a session's container for a human
// (src/terminal/container.ts, decisions 32 and 33): run here by this
// machine's node on a temporary checkout, with the links a session could
// have made in it. The save checks the loaded hash, writes a temporary file
// in the file's folder, and refuses, with nothing left behind, a real path
// that leaves the checkout, lands in .git or .claude, or names a CLAUDE.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { END_TERMINAL, giveCommand, readCommand, takeCommand, TERMINAL_SHELL, writeCommand } from '../../src/terminal/container.ts';
import { LocalContainer } from './support.ts';

const SESSION = '0b7f3c1e-5d0a-4a6e-9f3b-1c2d3e4f5a6b';
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', ...args], { encoding: 'utf8' });

function checkout(): { dir: string; outside: string; container: LocalContainer; run: <T>(command: readonly string[], input?: string) => Promise<T>; close(): void } {
  const top = mkdtempSync(join(tmpdir(), 'cleared-container-'));
  const dir = join(top, 'workspace');
  const outside = join(top, 'host');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.claude'));
  mkdirSync(outside);
  writeFileSync(join(outside, 'claude.json'), 'stand-in for the login file\n');
  writeFileSync(join(dir, 'src', 'entries.ts'), 'export const order = "oldest";\n');
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho run\n');
  chmodSync(join(dir, 'run.sh'), 0o755);
  writeFileSync(join(dir, 'CLAUDE.md'), '# Generated\n');
  writeFileSync(join(dir, '.claude', 'settings.json'), '{}\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const container = new LocalContainer(dir);
  return {
    dir, outside, container,
    run: async <T>(command: readonly string[], input?: string) => {
      const result = await container.exec(SESSION, command, input === undefined ? {} : { input });
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout) as T;
    },
    close: () => rmSync(top, { recursive: true, force: true }),
  };
}

const leftovers = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.split('/').at(-1)?.startsWith('.cleared-save-'));

test('the terminal\'s shell writes its id where the close finds it, and the close ends its whole session', () => {
  assert.match(TERMINAL_SHELL, /^echo \$\$ > \/tmp\/\.cleared-terminal\.pid; exec bash -l$/);
  assert.equal(END_TERMINAL[0], 'sh');
  assert.match(END_TERMINAL[2], /pkill -HUP -s "\$p"; sleep 1; pkill -KILL -s "\$p"/);
  assert.match(END_TERMINAL[2], /\*\[!0-9\]\*\) exit 0/, 'a pid file that is not a number ends nothing');
});

test('a save writes the text, keeps the mode, answers the new hash and leaves no temporary file', async () => {
  const c = checkout();
  try {
    const before = readFileSync(join(c.dir, 'run.sh'));
    const text = '#!/bin/sh\necho run fast\n';
    assert.deepEqual(await c.run(writeCommand('run.sh', sha(before)), text), { saved: true, hash: sha(text) });
    assert.equal(readFileSync(join(c.dir, 'run.sh'), 'utf8'), text);
    assert.equal(statSync(join(c.dir, 'run.sh')).mode & 0o777, 0o755);
    assert.deepEqual(leftovers(c.dir), []);
    const call = c.container.calls.at(-1)!;
    assert.deepEqual(call.command.slice(0, 2), ['node', '-e']);
    assert.deepEqual(call.command.slice(3), ['--', '/workspace', 'run.sh', sha(before)], 'the path and the hash are arguments after --');
    assert.equal(call.input, text, 'the text is the input, never an argument');
  } finally {
    c.close();
  }
});

test('a save with a stale hash writes nothing and answers the current one', async () => {
  const c = checkout();
  try {
    const current = readFileSync(join(c.dir, 'src', 'entries.ts'));
    assert.deepEqual(await c.run(writeCommand('src/entries.ts', sha('what the editor loaded')), 'new\n'), { stale: sha(current) });
    assert.deepEqual(readFileSync(join(c.dir, 'src', 'entries.ts')), current);
  } finally {
    c.close();
  }
});

test('the save checks the real path it writes: links the session made to .git, CLAUDE.md, .claude or outside are refused, with nothing left', async () => {
  const c = checkout();
  try {
    symlinkSync('.git/hooks', join(c.dir, 'scripts'));
    writeFileSync(join(c.dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n');
    symlinkSync('CLAUDE.md', join(c.dir, 'notes.md'));
    symlinkSync('.claude', join(c.dir, 'config'));
    symlinkSync(c.outside, join(c.dir, 'linked'));
    symlinkSync(join(c.outside, 'claude.json'), join(c.dir, 'login.json'));
    const hooks = readdirSync(join(c.dir, '.git', 'hooks')).sort();
    const cases: [string, string][] = [
      ['scripts/pre-commit', '#!/bin/sh\n'],
      ['notes.md', '# Generated\n'],
      ['config/settings.json', '{}\n'],
      ['linked/claude.json', 'stand-in for the login file\n'],
      ['login.json', 'stand-in for the login file\n'],
      ['.git/config', readFileSync(join(c.dir, '.git', 'config'), 'utf8')],
      ['CLAUDE.md', '# Generated\n'],
      ['src/CLAUDE.md', ''],
    ];
    for (const [path, loaded] of cases) {
      const answer = await c.run<{ refused?: string; missing?: boolean }>(writeCommand(path, sha(loaded)), 'echo pwned\n');
      assert.ok(answer.refused || answer.missing, `${path}: ${JSON.stringify(answer)}`);
    }
    assert.deepEqual(readdirSync(join(c.dir, '.git', 'hooks')).sort(), hooks, 'nothing new under .git/hooks');
    assert.equal(readFileSync(join(c.dir, '.git', 'hooks', 'pre-commit'), 'utf8'), '#!/bin/sh\n');
    assert.equal(readFileSync(join(c.dir, 'CLAUDE.md'), 'utf8'), '# Generated\n');
    assert.equal(readFileSync(join(c.dir, '.claude', 'settings.json'), 'utf8'), '{}\n');
    assert.equal(readFileSync(join(c.outside, 'claude.json'), 'utf8'), 'stand-in for the login file\n');
    assert.deepEqual(readdirSync(c.outside), ['claude.json'], 'nothing written outside the checkout');
    assert.deepEqual(leftovers(c.dir), []);
  } finally {
    c.close();
  }
});

test('the read answers the hash and the text of a file, and refuses the same links', async () => {
  const c = checkout();
  try {
    const text = readFileSync(join(c.dir, 'src', 'entries.ts'));
    assert.deepEqual(await c.run(readCommand('src/entries.ts')), { hash: sha(text), text: text.toString('base64') });
    symlinkSync(join(c.outside, 'claude.json'), join(c.dir, 'login.json'));
    assert.ok((await c.run<{ refused?: string }>(readCommand('login.json'))).refused);
    assert.deepEqual(await c.run(readCommand('src/none.ts')), { missing: true });
  } finally {
    c.close();
  }
});

test('the checkout at Take over and at Give back: a change, a new file, a commit made meanwhile and a change undone are all found', async () => {
  const c = checkout();
  try {
    // What the session had left uncommitted when it was taken over.
    writeFileSync(join(c.dir, 'src', 'entries.ts'), 'export const order = "newest";\n');
    const taken = await c.run<{ head: string; files: Record<string, string | null> }>(takeCommand());
    assert.equal(taken.head, git(c.dir, 'rev-parse', 'HEAD').trim());
    assert.deepEqual(taken.files, { 'src/entries.ts': sha('export const order = "newest";\n') });

    // The human, in the terminal: undoes the session's change, edits and
    // commits run.sh, and creates a file.
    git(c.dir, 'checkout', '--', 'src/entries.ts');
    writeFileSync(join(c.dir, 'run.sh'), '#!/bin/sh\necho run\necho twice\n');
    git(c.dir, 'commit', '-qam', 'by hand');
    writeFileSync(join(c.dir, 'NOTES.txt'), 'one\ntwo\n');

    const given = await c.run<{ files: { path: string; before: string | null; after: string | null; added: number; removed: number }[] }>(giveCommand(taken.head), JSON.stringify(Object.keys(taken.files)));
    const byPath = Object.fromEntries(given.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ['NOTES.txt', 'run.sh', 'src/entries.ts']);
    assert.deepEqual(byPath['run.sh'], { path: 'run.sh', before: sha('#!/bin/sh\necho run\n'), after: sha('#!/bin/sh\necho run\necho twice\n'), added: 1, removed: 0 });
    assert.deepEqual(byPath['NOTES.txt'], { path: 'NOTES.txt', before: null, after: sha('one\ntwo\n'), added: 2, removed: 0 });
    assert.equal(byPath['src/entries.ts']?.after, sha('export const order = "oldest";\n'), 'the undone change is seen');
    assert.ok(!existsSync(join(c.dir, '.cleared-save')));
  } finally {
    c.close();
  }
});
