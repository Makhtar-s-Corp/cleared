// Take over on the real Claude Code adapter, through the service's own path
// (owner decision of 2026-10-22 21:58, lane v2-j2-takeover-real-harness;
// the reviewer by the owner's extension of 22:01): the adapter the runtime
// gives the registry (flow/runtime.ts, wrapped for the workspace), a real
// session container on the guestbook example, the login mounted read only,
// the harness resumed in the web terminal's program (`claude --resume`),
// a line typed to it and answered by the model, the terminal closed as Give
// back closes it, then the runner reloaded from the transcript the human's
// harness left; for the author, the Shell too, with `npm ci` and `npm test`.
//
// It spends a little of the login's quota (Haiku, four short turns per
// role) and starts labelled containers, so it runs only when asked:
//   CLEARED_V2_REAL_HARNESS=1        the opt-in
//   CLEARED_CLAUDE_CREDENTIALS       the login file (else the service's
//                                    claude.token): its path and mode are
//                                    checked here, it is never read, copied
//                                    or printed by the test
// and when docker answers and the session image is there with the label
// cleared.dev=v2. Every docker command goes through the wrapper, which lists
// by the session's label and acts on what the list returned.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, accessSync, cpSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { Docker } from '../../src/container/docker.ts';
import { parseServices } from '../../src/container/services.ts';
import { LOGIN_FILE_MOUNT, removeSessionVolume, sessionNames, SESSION_IMAGE, WORKDIR_MOUNT } from '../../src/container/session-runtime.ts';
import { createRuntime } from '../../src/flow/runtime.ts';
import { claudeCodeRuntime, createClaudeCodeAdapter } from '../../src/session/adapters/claude-code.ts';
import { createCleaner } from '../../src/session/clean.ts';
import { interactiveResume, type Role, type SessionAdapter, type SessionHandle, type StartInput } from '../../src/session/contract.ts';
import { openStore, type Store } from '../../src/store/db.ts';
import { dockerContainer, SHELL_COMMAND, type TerminalProcess } from '../../src/terminal/container.ts';
import { projectCheckout, ticketBranch, ticketCheckout } from '../../src/workspace/checkout.ts';

const MODEL = 'claude-haiku-5-5';
const GUESTBOOK = new URL('../../../examples/guestbook/', import.meta.url).pathname;
const SIZE = { cols: 120, rows: 32 };

// ---- the gate ---------------------------------------------------------------------------

function loginFile(): string {
  return process.env.CLEARED_CLAUDE_CREDENTIALS || claudeCodeRuntime().loginFile;
}

function why(): string | undefined {
  if (process.env.CLEARED_V2_REAL_HARNESS !== '1') return 'set CLEARED_V2_REAL_HARNESS=1 to run it (real containers, the login, a little quota)';
  try {
    const login = statSync(loginFile());
    if (!login.isFile()) return 'the login is not a file';
    accessSync(loginFile(), constants.R_OK);
    if ((login.mode & 0o077) !== 0) return 'the login file is readable by others: fix its mode first';
  } catch {
    return 'no login file (CLEARED_CLAUDE_CREDENTIALS, or claude.token in the state folder)';
  }
  try {
    const images = execFileSync('docker', ['images', '--filter', 'label=cleared.dev=v2', '--filter', `reference=${SESSION_IMAGE}`, '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8', timeout: 10_000 });
    if (!images.split('\n').includes(SESSION_IMAGE)) return `no labelled ${SESSION_IMAGE} image`;
  } catch {
    return 'docker does not answer';
  }
  return undefined;
}

// ---- the guestbook, a workspace of one service -----------------------------------------

type Rig = { readonly root: string; readonly store: Store; readonly adapter: SessionAdapter; readonly docker: Docker; readonly workdir: string; input(role: Role, prompt: string): StartInput };

async function rig(t: TestContext, ticket: string): Promise<Rig> {
  const root = mkdtempSync(join(tmpdir(), 'cleared-real-harness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // The forge: the guestbook example as it is in this repository, without its node_modules.
  const seed = join(root, 'seed');
  cpSync(GUESTBOOK, seed, { recursive: true, filter: (path) => !relative(GUESTBOOK, path).split('/').includes('node_modules') });
  const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'user.name=Cleared test', '-c', 'user.email=test@cleared.invalid', ...args], { cwd, stdio: 'ignore' });
  git(root, ['init', '-q', '--bare', '-b', 'main', 'guestbook.git']);
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'the guestbook example']);
  git(seed, ['push', '-q', join(root, 'guestbook.git'), 'main']);
  const project = await projectCheckout({ url: join(root, 'guestbook.git'), dir: join(root, 'services', 'guestbook'), base: 'main' });
  writeFileSync(join(root, 'workspace.conf'), `[workspace]\nid = guestbook\nname = Guestbook\n\n[service guestbook]\nrepository = example-org/cleared-example-guestbook\nurl = ${join(root, 'guestbook.git')}\ndir = ${project.dir}\n`);
  const workdir = join(root, 'work', ticket, 'guestbook');
  await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: ticketBranch(ticket) });

  const env = { CLEARED_V2_WORKSPACE: join(root, 'workspace.conf'), CLEARED_V2_STATE_DIR: join(root, 'state'), CLEARED_V2_WORKDIRS: join(root, 'work') };
  const docker = new Docker();
  const runtime = { ...claudeCodeRuntime(env), loginFile: loginFile(), maxBudgetUsd: 0.5, stopTimeoutMs: 20_000 };
  const store = openStore(join(root, 'ledger.db'));
  const flow = createRuntime({
    env, effects: () => ({}) as never,
    factories: { 'claude-code': (deps) => createClaudeCodeAdapter({ ...deps, docker, runtime }) },
  });
  flow.attach({ store });
  const adapter = flow.adapters()['claude-code'] as SessionAdapter;
  const services = parseServices('postgres:16 POSTGRES_HOST_AUTH_METHOD=trust');
  return {
    root, store, adapter, docker, workdir,
    input: (role, prompt) => ({
      project: 'guestbook', ticket, role, harness: 'claude-code', model: MODEL, workdir, prompt, services,
      briefing: { projectPage: '', decisions: [], glossary: [], lessons: [], lastHandover: null },
      policy: {
        role, base: 'main', workdir: WORKDIR_MOUNT, scripts: ['test'], credentialFile: LOGIN_FILE_MOUNT,
        safeCommands: ['npm ci', 'npm test'], allowedHosts: ['registry.npmjs.org'], forbiddenHosts: [], ticketFiles: [], learned: [],
      },
    }),
  };
}

// ---- what the session and the terminal said ----------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, probe: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

// The turns ended so far, and the assistant's words of the turns after `from`.
const ended = (store: Store, id: string) => store.events.after(id).filter(({ event }) => event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR');
function said(store: Store, id: string, fromSeq: number): string {
  const rows = store.events.after(id, fromSeq);
  const assistant = new Set(rows.flatMap(({ event }) => (event.type === 'TEXT_MESSAGE_START' && event.role === 'assistant' ? [event.messageId] : [])));
  return rows.map(({ event }) => (event.type === 'TEXT_MESSAGE_CONTENT' && assistant.has(event.messageId) ? event.delta : '')).join('');
}

async function turnEnds(store: Store, id: string, count: number): Promise<void> {
  await until(`turn ${count} of ${id.slice(0, 8)} to end`, () => ended(store, id).length >= count || undefined, 240_000);
  const last = ended(store, id).at(-1)?.event;
  assert.equal(last?.type, 'RUN_FINISHED', `turn ${count} finished, not ${JSON.stringify(last).slice(0, 200)}`);
}

// The terminal's output with the escape sequences taken out, for matching.
function screen(term: TerminalProcess): { text(): string } {
  let raw = '';
  term.onOutput((chunk) => { raw += chunk.toString('utf8'); });
  // eslint-disable-next-line no-control-regex
  return { text: () => raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)/g, ' ').replace(/\x1b./g, ' ') };
}

async function inContainer(rig: Rig, id: string, script: string, ...args: string[]): Promise<{ code: number; stdout: string }> {
  const result = await rig.docker.exec(id, sessionNames(id).container, ['sh', '-c', script, 'sh', ...args]);
  return { code: result.code, stdout: result.stdout.trim() };
}

// The transcript Claude Code resumes from: the session's id in the project
// folder of the checkout's mount point, in the session's config volume. Its
// length only; nothing of it is read.
const TRANSCRIPT = 'f="$CLAUDE_CONFIG_DIR/projects/$(printf %s "$PWD" | sed "s#[^A-Za-z0-9]#-#g")/$1.jsonl"; test -f "$f" && wc -l < "$f"';
// The human's harness: a `claude --resume` process, by its command line.
const RESUMED = 'for p in /proc/[0-9]*; do tr "\\0" " " < $p/cmdline 2>/dev/null | grep -q -- "--resume $1" && echo $p; done; true';

async function cleanUp(rig: Rig, handle: SessionHandle | undefined, id: string | undefined): Promise<void> {
  if (handle) await handle.stop().catch(() => undefined);
  if (!id) return;
  assert.deepEqual(await rig.docker.containers(id), [], 'nothing with the session\'s label is left');
  await removeSessionVolume(rig.docker, id);
}

// ---- the legs -------------------------------------------------------------------------------

// Take over with the harness, a line typed to it, Give back, the reload.
async function harnessLeg(rig: Rig, handle: SessionHandle, id: string): Promise<void> {
  const before = await inContainer(rig, id, TRANSCRIPT, id);
  assert.equal(before.code, 0, 'the runner\'s transcript is where `claude --resume` looks for it (the checkout\'s project folder)');
  const resume = await interactiveResume(rig.adapter, id);
  assert.equal(resume.supported, true, `the harness is resumed in the terminal: ${JSON.stringify(resume)}`);
  if (!resume.supported) return;
  assert.equal(resume.name, 'Claude Code');
  assert.ok(resume.command.includes(id) && resume.command.some((word) => word.includes('claude --resume')), 'claude --resume on the session\'s own id');
  assert.ok(!resume.command.some((word) => word.includes(rig.root)), 'no host path in the command');

  const term = await dockerContainer(rig.docker).terminal(id, SIZE, resume.command);
  const out = screen(term);
  let open = true;
  try {
    // The resumed conversation: the session's first turn is on the screen.
    await until('the resumed conversation on the screen', () => /PLUM/.test(out.text()) || undefined, 90_000);
    assert.doesNotMatch(out.text(), /no login in the session's container/);
    assert.notEqual((await inContainer(rig, id, RESUMED, id)).stdout, '', 'a claude --resume process runs in the container');
    // A line typed to the harness, answered by the model on the real login.
    await sleep(2_000);
    term.write('What is 17 plus 25? Reply with the number only.');
    await sleep(500);
    term.write('\r');
    await until('the harness\'s answer', () => /\b42\b/.test(out.text()) || undefined, 120_000);
    await sleep(3_000);
    // Give back closes the terminal: the harness leaves and keeps its transcript.
    const closing = Date.now();
    await term.end();
    open = false;
    const closeMs = Date.now() - closing;
    assert.ok(closeMs < 8_000, `the terminal closed in ${closeMs} ms`);
    assert.equal((await inContainer(rig, id, RESUMED, id)).stdout, '', 'no claude --resume is left');
    const after = await inContainer(rig, id, TRANSCRIPT, id);
    assert.ok(Number(after.stdout) > Number(before.stdout), `the human's turn is in the transcript (${before.stdout} then ${after.stdout} lines)`);
    console.log(`# ${id.slice(0, 8)}: the terminal closed in ${closeMs} ms; the transcript went from ${before.stdout} to ${after.stdout} lines`);
  } finally {
    if (open) await term.end();
  }

  // Give back: the runner takes the session back from that transcript.
  const turns = ended(rig.store, id).length;
  const again = await rig.adapter.resume(id);
  assert.equal(again, handle, 'the same handle: the runner reloaded in its container');
  const from = rig.store.events.after(id).at(-1)?.seq ?? 0;
  await handle.send({ text: 'Which number did you give in your previous answer, the one the person at the terminal asked for? Reply with the number only.', by: 'cleared' });
  await turnEnds(rig.store, id, turns + 1);
  assert.match(said(rig.store, id, from), /\b42\b/, 'the reloaded runner read what the human did with the harness');
}

async function start(rig: Rig, role: Role): Promise<{ handle: SessionHandle; id: string }> {
  const handle = await rig.adapter.start(rig.input(role, 'Remember the word PLUM. Do not use any tool. Reply with the single word: ready.'));
  await turnEnds(rig.store, handle.id, 1);
  return { handle, id: handle.id };
}

// ---- the tests --------------------------------------------------------------------------------

const reason = why();

test('the author\'s session: Take over resumes Claude Code in the terminal, Give back reloads the runner; the Shell runs npm ci and npm test', { skip: reason, timeout: 20 * 60_000 }, async (t) => {
  const r = await rig(t, 'REAL-1');
  let handle: SessionHandle | undefined;
  let id: string | undefined;
  try {
    ({ handle, id } = await start(r, 'author'));
    await harnessLeg(r, handle, id);

    // The Shell: the container's environment, no login in it, the guestbook's tests.
    const term = await dockerContainer(r.docker).terminal(id, SIZE, SHELL_COMMAND);
    const out = screen(term);
    try {
      term.write('echo "database:${DATABASE_URL:+set} login:${CLAUDE_CODE_OAUTH_TOKEN:+yes}:end"\r');
      await until('the shell\'s answer', () => /database:set login::end/.test(out.text()) || undefined, 30_000);
      term.write('npm ci --no-audit --no-fund && npm test\r');
      await until('the tests\' summary', () => /ℹ fail \d+/.test(out.text()) || undefined, 8 * 60_000);
      assert.doesNotMatch(out.text(), /Cannot find package 'pg'/);
      assert.doesNotMatch(out.text(), /DATABASE_URL is not set/);
      assert.match(out.text(), /ℹ fail 0\b/, 'the guestbook\'s tests pass in the session\'s container');
    } finally {
      await term.end();
    }
  } finally {
    await cleanUp(r, handle, id);
  }
});

test('the reviewer\'s session: Take over resumes Claude Code in the terminal, Give back reloads the runner', { skip: reason, timeout: 15 * 60_000 }, async (t) => {
  const r = await rig(t, 'REAL-2');
  let handle: SessionHandle | undefined;
  let id: string | undefined;
  try {
    ({ handle, id } = await start(r, 'reviewer'));
    await harnessLeg(r, handle, id);
  } finally {
    await cleanUp(r, handle, id);
  }
});
