// What the service runs in a session's own container for a human
// (docs/v2/milestone-2-plan.md, decisions 32 and 33, lane 31): the web
// terminal's shell, the editor's read and save, and the checkout's state at
// Take over and at Give back. Nothing here writes or runs git on the host:
// the session writes its checkout, and may have swapped a folder for a link
// or written a git hook, so the host only ever asks the container, where the
// kernel confines every write to what the session's own tools reach.
//
// Each program is a fixed text of this file, run by the image's node through
// the docker wrapper's `exec` (the container from a labelled list, after
// `--`, as the container's user, the session's); what varies (the checkout's
// mount point, the path, a hash) is an argument after the program's `--`,
// and the text a human saves is its input. No word a human typed or sent is
// ever part of a command line.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { Docker, type DockerResult } from '../container/docker.ts';
import { sessionNames, WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { SessionId } from '../session/contract.ts';

// Where the terminal's shell writes its process id, in the container's own /tmp.
export const TERMINAL_PID_FILE = '/tmp/.cleared-terminal.pid';

// The shell of the web terminal: its id written down, so that the close can
// end it and everything it started, since ending the docker client does not
// end a process of `docker exec` (checked on this server with Docker 29.8.1).
export const TERMINAL_SHELL = `echo $$ > ${TERMINAL_PID_FILE}; exec bash -l`;

// Ends the terminal's shell and every process of its session (pkill -s):
// a hang-up first, as a closed terminal sends, then a kill a second later.
export const END_TERMINAL = [
  'sh', '-c',
  `p=$(cat ${TERMINAL_PID_FILE} 2>/dev/null); case "$p" in ''|*[!0-9]*) exit 0;; esac; pkill -HUP -s "$p"; sleep 1; pkill -KILL -s "$p"; rm -f ${TERMINAL_PID_FILE}; exit 0`,
] as const;

// The checks both file programs share: the checkout's real path, the real
// folder the file is in and the file's own real path must stay inside it,
// out of every .git and .claude folder, and never name a CLAUDE.md.
const PLACE = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const out = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0); };
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const guarded = (rel) => { const parts = rel.split(path.sep); return parts.includes('.git') || parts.includes('.claude') || parts[parts.length - 1] === 'CLAUDE.md'; };
const leaves = (rel) => rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
function place(root, rel) {
  const top = fs.realpathSync(root);
  if (rel === '' || path.isAbsolute(rel) || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) return { refused: 'not a path of the checkout' };
  let parent;
  try { parent = fs.realpathSync(path.dirname(path.join(top, rel))); } catch { return { missing: true }; }
  const inParent = path.relative(top, parent);
  if (inParent !== '' && leaves(inParent)) return { refused: 'its folder leaves the checkout through a link' };
  const file = path.join(parent, path.basename(rel));
  let real = file;
  try { real = fs.realpathSync(file); } catch {}
  const inReal = path.relative(top, real);
  if (leaves(inReal)) return { refused: 'it leaves the checkout through a link' };
  if (guarded(path.relative(top, file)) || guarded(inReal)) return { refused: 'it lands in .git, in .claude or on a CLAUDE.md' };
  let stat;
  try { stat = fs.lstatSync(file); } catch { return { missing: true }; }
  if (stat.isSymbolicLink()) return { refused: 'it is a link' };
  if (!stat.isFile()) return { refused: 'not a file' };
  return { parent, file, mode: stat.mode & 0o7777 };
}
`;

// Reads one file of the checkout: its hash, and its text in base64 when it
// is at most READ_MAX_BYTES (the editor shows no larger file).
export const READ_MAX_BYTES = 2 * 1024 * 1024;
export const READ_PROGRAM = `${PLACE}
const [root, rel] = process.argv.slice(1);
const at = place(root, rel);
if (!at.file) out(at);
const bytes = fs.readFileSync(at.file);
out(bytes.length > ${READ_MAX_BYTES} ? { hash: sha(bytes), large: true } : { hash: sha(bytes), text: bytes.toString('base64') });
`;

// Saves one file of the checkout: its text on the input, the hash of the
// version the editor loaded; the file's mode kept. The temporary file is
// written in the file's own folder, then the place is checked again before
// the rename, so a folder swapped for a link meanwhile is refused and the
// temporary file removed.
export const WRITE_PROGRAM = `${PLACE}
const [root, rel, loaded] = process.argv.slice(1);
const text = fs.readFileSync(0);
const at = place(root, rel);
if (!at.file) out(at);
const current = sha(fs.readFileSync(at.file));
if (current !== loaded) out({ stale: current });
const tmp = path.join(at.parent, '.cleared-save-' + crypto.randomBytes(8).toString('hex'));
const fd = fs.openSync(tmp, 'wx', at.mode);
try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
fs.chmodSync(tmp, at.mode);
const again = place(root, rel);
if (!again.file || again.parent !== at.parent) { fs.unlinkSync(tmp); out(again.file ? { refused: 'its folder changed during the save' } : again); }
fs.renameSync(tmp, again.file);
out({ saved: true, hash: sha(text) });
`;

// The checkout at Take over: the commit, and the hash of each file that
// differs from it (changed, deleted: null, or new and not ignored).
export const TAKE_PROGRAM = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const [root] = process.argv.slice(1);
const git = (...args) => execFileSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
const list = (text) => text.split('\0').filter(Boolean);
const hashOf = (rel) => { try { const p = path.join(root, rel); const s = fs.lstatSync(p); return s.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'not-a-file'; } catch { return null; } };
const head = git('rev-parse', 'HEAD').trim();
const files = {};
for (const rel of new Set([...list(git('diff', '--name-only', '-z', 'HEAD')), ...list(git('ls-files', '--others', '--exclude-standard', '-z'))])) files[rel] = hashOf(rel);
process.stdout.write(JSON.stringify({ head, files }));
`;

// The checkout at Give back, against the commit of the Take over (so a
// commit the human made in the terminal is seen): each file that differs
// from that commit, or was named on the input (the files that differed at
// Take over), with its hash at that commit, its hash now and its counts
// against that commit (a new file: its lines).
export const GIVE_PROGRAM = String.raw`
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const [root, head] = process.argv.slice(1);
const named = JSON.parse(fs.readFileSync(0, 'utf8') || '[]');
const git = (...args) => execFileSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { maxBuffer: 64 * 1024 * 1024 });
const list = (bytes) => bytes.toString('utf8').split('\0').filter(Boolean);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const now = (rel) => { try { const p = path.join(root, rel); const s = fs.lstatSync(p); return s.isFile() ? sha(fs.readFileSync(p)) : 'not-a-file'; } catch { return null; } };
const then = (rel) => { try { return sha(git('cat-file', 'blob', head + ':' + rel)); } catch { return null; } };
const counts = {};
for (const line of git('diff', '--numstat', '-z', head).toString('utf8').split('\0')) {
  const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
  if (m) counts[m[3]] = [m[1] === '-' ? 0 : Number(m[1]), m[2] === '-' ? 0 : Number(m[2])];
}
const fresh = new Set(list(git('ls-files', '--others', '--exclude-standard', '-z')));
const files = [];
for (const rel of new Set([...list(git('diff', '--name-only', '-z', head)), ...fresh, ...named])) {
  let [added, removed] = counts[rel] || [0, 0];
  if (fresh.has(rel) && !counts[rel]) { try { const t = fs.readFileSync(path.join(root, rel), 'utf8'); added = t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0); } catch {} }
  files.push({ path: rel, before: then(rel), after: now(rel), added, removed });
}
process.stdout.write(JSON.stringify({ files }));
`;

const program = (text: string, args: readonly string[]): string[] => ['node', '-e', text, '--', ...args];
export const readCommand = (path: string, root = WORKDIR_MOUNT): string[] => program(READ_PROGRAM, [root, path]);
export const writeCommand = (path: string, hash: string, root = WORKDIR_MOUNT): string[] => program(WRITE_PROGRAM, [root, path, hash]);
export const takeCommand = (root = WORKDIR_MOUNT): string[] => program(TAKE_PROGRAM, [root]);
export const giveCommand = (head: string, root = WORKDIR_MOUNT): string[] => program(GIVE_PROGRAM, [root, head]);

// The terminal's process, as the terminal manager (terminals.ts) drives it.
export type TerminalProcess = {
  write(data: string): void;
  resize(cols: number, rows: number): Promise<void>;
  onOutput(listener: (chunk: Buffer) => void): void;
  onExit(listener: () => void): void;
  // Ends the shell in the container and every process it started, then the client.
  end(): Promise<void>;
};

// A session's own container, as the human's routes reach it.
export type SessionContainer = {
  exec(session: SessionId, command: readonly string[], options?: { readonly input?: string; readonly timeoutMs?: number }): Promise<DockerResult>;
  terminal(session: SessionId, size: { readonly cols: number; readonly rows: number }): Promise<TerminalProcess>;
};

// The terminal on the client's side: `script` gave the docker client a
// terminal of its own, whose size the host sets with stty; the kernel then
// signals the client, which resizes the shell's terminal in the container.
function ptsOf(pid: number): string | undefined {
  const pending = [String(pid)];
  for (let seen = 0; pending.length > 0 && seen < 16; seen++) {
    const at = pending.shift() as string;
    try {
      for (const task of readdirSync(`/proc/${at}/task`)) pending.push(...readFileSync(`/proc/${at}/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean));
    } catch { continue; }
    if (at === String(pid)) continue;
    try {
      const tty = readlinkSync(`/proc/${at}/fd/0`);
      if (/^\/dev\/pts\/\d+$/.test(tty)) return tty;
    } catch { /* gone, or not ours */ }
  }
  return undefined;
}

const run = (command: string, args: readonly string[]): Promise<number> => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: 'ignore' });
  child.on('error', () => resolve(1));
  child.on('close', (code) => resolve(code ?? 1));
});

export function scriptTerminal(child: ChildProcessWithoutNullStreams, end: () => Promise<unknown>): TerminalProcess {
  let exited = false;
  const exits: (() => void)[] = [];
  child.on('close', () => { exited = true; for (const listener of exits.splice(0)) listener(); });
  child.stdin.on('error', () => undefined);
  return {
    write: (data) => { if (!exited) child.stdin.write(data); },
    async resize(cols, rows) {
      let tty: string | undefined;
      for (let i = 0; i < 20 && !exited && !(tty = ptsOf(child.pid as number)); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      if (tty) await run('stty', ['-F', tty, 'rows', String(rows), 'cols', String(cols)]);
    },
    onOutput: (listener) => { child.stdout.on('data', listener); child.stderr.on('data', listener); },
    onExit: (listener) => { if (exited) listener(); else exits.push(listener); },
    async end() {
      await end().catch(() => undefined);
      child.stdin.end();
      if (!exited) child.kill('SIGKILL');
      if (!exited) await new Promise<void>((resolve) => { exits.push(resolve); setTimeout(resolve, 3000).unref(); });
    },
  };
}

// The real container: the session's container by its name, through the docker wrapper.
export function dockerContainer(docker: Docker = new Docker()): SessionContainer {
  const name = (session: SessionId) => sessionNames(session).container;
  return {
    exec: (session, command, options = {}) => docker.exec(session, name(session), command, options),
    async terminal(session, size) {
      const inspected = await docker.inspect(session, name(session)) as { Config?: { User?: string } };
      const child = await docker.terminal(session, name(session), { user: inspected.Config?.User ?? '', workdir: WORKDIR_MOUNT, command: ['sh', '-c', TERMINAL_SHELL] });
      const process = scriptTerminal(child, () => docker.exec(session, name(session), END_TERMINAL, { timeoutMs: 15_000 }));
      await process.resize(size.cols, size.rows);
      return process;
    },
  };
}
