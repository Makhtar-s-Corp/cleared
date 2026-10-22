// The Editor tab's files (docs/v2/milestone-2-plan.md, decision 30, lane
// 20, and decision 33, lane 31):
//
//   GET /api/sessions/:id/files lists the files the session changed, from
//   its stored edits (the Changes card's counts), relative to its checkout;
//   GET /api/sessions/:id/files/<path> reads one file of the checkout, cut
//   at FILE_LINES lines, through the events' cleaner, with the hash of the
//   whole file's bytes (which a save sends back); with ?version=base, the
//   same file as the ticket's base holds it, for the diff the screen draws;
//   PUT /api/sessions/:id/files/<path> saves one file the editor changed.
//
// The session writes its checkout, so the host reads it without git and
// without following a link: every folder of the path is a plain folder, the
// file is opened with O_NOFOLLOW, and the folder the opened file is really
// in (/proc/self/fd) must still be inside the checkout, which a folder
// swapped for a link between the check and the open would not be. The
// checkout's .git folder is not shown, nor what the session's own Read is
// refused (.env, keys, credential files: session/policy.ts). The base is
// read in the service's own project checkout, which no session writes, by
// the commit the ticket checkout started from (refs/cleared/base).
//
// A save is the owner account's (decision 32), on an author's live or
// taken-over session of a ticket in progress: never while the review runs,
// after the publish, or on an ended session. It is judged as the session's
// own Write of the same path would be: first this file's refusals, then
// evaluate() of session/policy.ts under the author's policy, with the
// file's current text. An `ask` is confirmable for install.package and
// scripts.change only: a second save carrying that rule writes, journaled
// as the user's answer "once" to it; any other `ask` (.git, .claude and
// CLAUDE.md answer `default`) is a refusal. The read of the current text
// and the write both happen in the session's container, never on the host
// (terminal/container.ts): the write program checks the loaded hash, writes
// a temporary file in the file's folder, then checks the real path the
// rename will write (inside the checkout, out of .git and .claude, no
// CLAUDE.md) before it renames. A stale hash answers 409 with the current
// one. Each save is journaled as `cleared.human_edit`, never with the
// content; a live session is told at once through the engine's send, a
// taken-over one at Give back (flow/takeover.ts).
//
// A route matches a fixed number of segments (modules/registry.ts), so the
// file route is one route per depth, up to FILE_DEPTH.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readlinkSync, realpathSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { join, posix, sep } from 'node:path';
import { SERVICE_PROOF_HEADER, type ConfirmableRule, type FileWriteRefusal, type FileWritten, type SessionFile, type SessionFiles } from '../api/types.ts';
import { LOGIN_FILE_MOUNT, WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import { cleanText, secretValues } from '../session/clean.ts';
import { evaluate, type Policy } from '../session/policy.ts';
import { CheckoutError, git, gitPath } from '../workspace/checkout.ts';
import { READ_MAX_BYTES, readCommand, writeCommand } from '../terminal/container.ts';
import type { HumanSide } from '../terminal/human.ts';
import { humanUser, HttpError as RouteError, readBody } from '../terminal/routes.ts';
import { workspaceOf } from './config.ts';
import type { FlowEngine } from './engine.ts';
import { humanEditNotice, userName } from './human-edits.ts';
import { ownerOf } from './takeover.ts';

export const FILE_LINES = 400;
export const FILE_DEPTH = 16;
export const FILE_MAX_BYTES = 16 * 1024 * 1024;   // a larger file is not shown

export type FilesDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly proof: () => string;
  readonly env?: NodeJS.ProcessEnv;                 // for the cleaner's secrets and the service's folders
  readonly human?: (registry: Registry) => HumanSide | undefined;   // the save (lane 31); none: the save answers 503
};

class HttpError extends Error {
  readonly status: number;
  readonly rule: string | undefined;
  constructor(status: number, message: string, rule?: string) {
    super(message);
    this.status = status;
    this.rule = rule;
  }
}

function answer(context: RouteContext, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  context.response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' });
  context.response.end(text);
}

const header = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

// A path the session named, relative to its checkout; undefined outside it.
export function checkoutPath(path: string): string | undefined {
  const rel = posix.isAbsolute(path) ? posix.relative(WORKDIR_MOUNT, path) : posix.normalize(path);
  return rel === '' || rel === '.' || rel.startsWith('..') || posix.isAbsolute(rel) ? undefined : rel;
}

// The changed files: the stored edits' counts, one line per file of the checkout.
export function changedFiles(files: readonly { readonly path: string; readonly added: number; readonly removed: number }[]): SessionFiles['files'] {
  const out = new Map<string, { path: string; added: number; removed: number }>();
  for (const file of files) {
    const path = checkoutPath(file.path);
    if (path === undefined) continue;
    const seen = out.get(path) ?? { path, added: 0, removed: 0 };
    seen.added += file.added;
    seen.removed += file.removed;
    out.set(path, seen);
  }
  return [...out.values()];
}

// What the session's Read of the path is refused for, as the policy says it.
const READER: Policy = {
  role: 'author', base: '', workdir: WORKDIR_MOUNT, scripts: [], credentialFile: LOGIN_FILE_MOUNT,
  safeCommands: [], allowedHosts: [], forbiddenHosts: [], ticketFiles: [], learned: [],
};

function refusal(parts: readonly string[]): HttpError | undefined {
  if (parts.includes('.git')) return new HttpError(403, 'the checkout\'s git folder is not shown', 'git');
  const verdict = evaluate({ tool: 'Read', input: { file_path: posix.join(WORKDIR_MOUNT, ...parts) } }, READER);
  return verdict.decision === 'deny' ? new HttpError(403, verdict.message, verdict.rule) : undefined;
}

// The path's segments as the route decoded them: each one a name, never a
// step up, never a separator.
function segments(params: Readonly<Record<string, string | undefined>>, depth: number): string[] {
  const parts = Array.from({ length: depth }, (_, i) => params[`p${i}`] ?? '');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /[/\\\0]/.test(part))) throw new HttpError(400, 'not a path of the checkout');
  return parts;
}

// The file's bytes, read without following a link and never outside the checkout.
function readCheckoutFile(workdir: string, parts: readonly string[]): Buffer {
  let root: string;
  try { root = realpathSync(workdir); } catch { throw new HttpError(409, 'the session\'s checkout is gone'); }
  let dir = workdir;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) throw new HttpError(404, 'no such file in the checkout');
    if (stat.isSymbolicLink()) throw new HttpError(403, 'a link is not followed', 'link');
    if (!stat.isDirectory()) throw new HttpError(404, 'no such file in the checkout');
  }
  let fd: number;
  try {
    fd = openSync(join(dir, parts.at(-1) as string), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new HttpError(403, 'a link is not followed', 'link');
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, 'no such file in the checkout');
    throw new HttpError(403, 'the file cannot be read');
  }
  try {
    const real = readlinkSync(`/proc/self/fd/${fd}`);
    if (!real.startsWith(`${root}${sep}`) || real.slice(root.length + 1).split(sep).includes('.git')) throw new HttpError(403, 'a link is not followed', 'link');
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HttpError(400, 'not a file');
    if (stat.size > FILE_MAX_BYTES) throw new HttpError(413, 'the file is too large to show');
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      size += read;
      if (size > FILE_MAX_BYTES) throw new HttpError(413, 'the file is too large to show');
      chunks.push(chunk.subarray(0, read));
    }
    return Buffer.concat(chunks);
  } finally {
    closeSync(fd);
  }
}

// The file as the screen shows it: UTF-8 text with no NUL, its first
// FILE_LINES lines, cleaned; the hash and the line count are the whole file's.
function shown(path: string, bytes: Buffer, clean: (text: string) => string): SessionFile {
  if (bytes.includes(0)) throw new HttpError(415, 'not a text file');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new HttpError(415, 'not a text file'); }
  const lines = text.split('\n');
  const count = text === '' ? 0 : text.endsWith('\n') ? lines.length - 1 : lines.length;
  const cut = count > FILE_LINES;
  const kept = cut ? `${lines.slice(0, FILE_LINES).join('\n')}\n` : text;
  return { path, text: clean(kept), lines: count, cut, hash: createHash('sha256').update(bytes).digest('hex') };
}

// The commit the ticket checkout started from, read without git.
function baseCommit(workdir: string): string | undefined {
  try {
    const loose = gitPath(workdir, ['refs', 'cleared', 'base'], 'file');
    const sha = readFileSync(loose, 'utf8').trim();
    if (/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) return sha;
  } catch { /* packed, or missing */ }
  try {
    const packed = readFileSync(gitPath(workdir, ['packed-refs'], 'file'), 'utf8');
    return /^([0-9a-f]{40}(?:[0-9a-f]{24})?) refs\/cleared\/base$/m.exec(packed)?.[1];
  } catch {
    return undefined;
  }
}

// The counts of a save: the lines removed and added, the common head and
// tail left out, the rest compared line by line (or counted whole when it
// is too long to compare).
export function lineCounts(before: string, after: string): { added: number; removed: number } {
  const split = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const a = split(before);
  const b = split(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  if (x.length * y.length > 4_000_000) return { added: y.length, removed: x.length };
  let row = new Array<number>(y.length + 1).fill(0);
  for (const line of x) {
    const next = new Array<number>(y.length + 1).fill(0);
    for (let j = 0; j < y.length; j++) next[j + 1] = line === y[j] ? (row[j] as number) + 1 : Math.max(row[j + 1] as number, next[j] as number);
    row = next;
  }
  const same = row[y.length] as number;
  return { added: y.length - same, removed: x.length - same };
}

const CONFIRMABLE: ReadonlySet<string> = new Set<ConfirmableRule>(['install.package', 'scripts.change']);
const LIVE_PHASES: ReadonlySet<string> = new Set(['starting', 'working', 'waiting_human']);
const SAVE_MAX_BODY = 2 * READ_MAX_BYTES;

// A save that is refused, with the rule and its reason (FileWriteRefusal).
class Refusal extends Error {
  readonly status: number;
  readonly body: FileWriteRefusal;
  constructor(status: number, body: Omit<FileWriteRefusal, 'error'>) {
    super(body.reason);
    this.status = status;
    this.body = { error: body.reason, ...body };
  }
}

// What the session's container answers for the file (terminal/container.ts).
type Read = { readonly hash?: string; readonly text?: string; readonly large?: boolean; readonly missing?: boolean; readonly refused?: string };
type Written = { readonly saved?: true; readonly hash?: string; readonly stale?: string; readonly missing?: boolean; readonly refused?: string };

async function inContainer<T>(human: HumanSide, session: string, command: readonly string[], input?: string): Promise<T> {
  const result = await human.container.exec(session, command, input === undefined ? {} : { input });
  if (result.code !== 0) throw new HttpError(503, 'the session\'s container did not answer: is it still running?');
  try { return JSON.parse(result.stdout) as T; } catch { throw new HttpError(503, 'the session\'s container gave no answer the service reads'); }
}

export function filesRoutes(deps: FilesDeps): Route[] {
  const env = deps.env ?? process.env;
  const read = (run: (engine: FlowEngine, context: RouteContext) => Promise<void> | void): Route['handle'] => async (context) => {
    try {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const engine = deps.engine(context.registry);
      if (!engine) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
      await run(engine, context);
    } catch (error) {
      if (error instanceof HttpError) answer(context, error.status, { error: error.message, ...(error.rule ? { rule: error.rule } : {}) });
      else throw error;
    }
  };
  const detailOf = (engine: FlowEngine, context: RouteContext) => {
    const detail = engine.sessionDetail(context.params.id as string);
    if (!detail) throw new HttpError(404, 'no such session');
    return detail;
  };
  // The events' cleaner, with the service's secrets and folders (flow/runtime.ts).
  const cleaner = (engine: FlowEngine) => (text: string) => cleanText(text, {
    secrets: secretValues(env),
    servicePaths: [...new Set([env.CLEARED_V2_STATE_DIR, env.HOME ?? homedir(), engine.config.projectDir, engine.config.workdirRoot].filter((p): p is string => !!p && p !== '/'))],
  });

  const file = (depth: number): Route['handle'] => read((engine, context) => {
    const detail = detailOf(engine, context);
    const parts = segments(context.params, depth);
    const version = new URL(context.request.url ?? '/', 'http://service').searchParams.get('version');
    if (version !== null && version !== 'base') throw new HttpError(400, 'version is base, or nothing for the checkout');
    const denied = refusal(parts);
    if (denied) throw denied;
    const workdir = engine.sessionWorkdir(detail.id);
    if (workdir === undefined) throw new HttpError(409, 'the service does not know this session\'s checkout any more: it restarted since the session ran');
    const path = parts.join('/');
    if (version === null) return answer(context, 200, shown(path, readCheckoutFile(workdir, parts), cleaner(engine)));
    const commit = baseCommit(workdir);
    if (commit === undefined) throw new HttpError(404, 'the ticket\'s base is not known');
    const services = workspaceOf(engine.config).services;
    const project = (services.find((service) => service.name === detail.service) ?? services[0])?.dir ?? engine.config.projectDir;
    return git(project, ['cat-file', 'blob', `${commit}:${path}`]).then(
      (text) => answer(context, 200, shown(path, Buffer.from(text, 'utf8'), cleaner(engine))),
      (error: unknown) => { throw error instanceof CheckoutError ? new HttpError(404, 'the base has no such file') : error; },
    );
  });

  // PUT /api/sessions/:id/files/<path>: the editor's save (decision 33).
  const save = (depth: number): Route['handle'] => async (context) => {
    try {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const engine = deps.engine(context.registry);
      const human = deps.human?.(context.registry);
      if (!engine || !human) throw new HttpError(503, 'the flow is not configured: see CLEARED_V2_PROJECT in v2/README.md');
      const user = await humanUser(context, deps.proof());
      if (user !== await ownerOf(context.registry)) throw new HttpError(403, 'saving a file of a session is the owner account\'s alone in this version (the first account of this service): ask the owner');
      const detail = detailOf(engine, context);
      const taken = engine.takenOver(detail.id);
      if (taken && taken.by !== user) throw new HttpError(403, 'the session is taken over by another account');
      if (detail.role !== 'author') throw new HttpError(409, 'only an author\'s checkout is edited: a reviewer reads it');
      if (!LIVE_PHASES.has(detail.phase) || engine.sessionWorkdir(detail.id) === undefined) throw new HttpError(409, 'the session has ended: its checkout is not edited any more');
      const tickets = context.registry.ticketStore;
      const ticket = await tickets.get(detail.ticket);
      if (ticket?.status !== tickets.states.progress) throw new HttpError(409, 'the ticket is not in progress: its review runs, or its change is published');
      if (engine.sessions().some((s) => s.ticket === detail.ticket && (s.role === 'reviewer' && LIVE_PHASES.has(s.phase) || s.phase === 'reviewing')))
        throw new HttpError(409, 'the review runs: the checkout is not edited meanwhile');
      const parts = segments(context.params, depth);
      const denied = refusal(parts);
      if (denied) throw new Refusal(denied.status, { rule: denied.rule ?? null, reason: denied.message, confirmable: false });
      const body = await readBody(context.request, SAVE_MAX_BODY).catch((error: unknown) => { throw error instanceof RouteError ? new HttpError(error.status, error.message) : error; });
      const { text, hash, confirm } = body;
      if (typeof text !== 'string' || text.includes('\0')) throw new HttpError(400, 'text is the file\'s new text, with no NUL');
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new HttpError(400, 'hash is the SHA-256 of the version the editor loaded');
      if (confirm !== undefined && (typeof confirm !== 'string' || !CONFIRMABLE.has(confirm)))
        throw new Refusal(403, { rule: typeof confirm === 'string' ? confirm : null, reason: 'only install.package and scripts.change are confirmed in the editor', confirmable: false });
      if (Buffer.byteLength(text) > READ_MAX_BYTES) throw new HttpError(413, 'the text is too large to save from the editor');
      const path = parts.join('/');
      const containerPath = posix.join(WORKDIR_MOUNT, path);

      // The current file, read in the session's container.
      const current = await inContainer<Read>(human, detail.id, readCommand(path));
      if (current.refused) throw new Refusal(403, { rule: 'link', reason: `the file is not saved: ${current.refused}`, confirmable: false });
      if (current.missing || current.hash === undefined) throw new HttpError(404, 'no such file in the checkout');
      if (current.large || current.text === undefined) throw new Refusal(403, { rule: 'editor.cut', reason: `the file is too large for the editor: it is read only there`, confirmable: false });
      const bytes = Buffer.from(current.text, 'base64');
      let before: string;
      try { before = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new HttpError(415, 'not a text file'); }
      if (bytes.includes(0)) throw new HttpError(415, 'not a text file');
      const lines = before === '' ? 0 : before.split('\n').length - (before.endsWith('\n') ? 1 : 0);
      if (lines > FILE_LINES) throw new Refusal(403, { rule: 'editor.cut', reason: `the viewer cuts this file at ${FILE_LINES} lines: it is read only in the editor`, confirmable: false });
      if (current.hash !== hash) throw new Refusal(409, { rule: null, reason: 'the file changed since the editor loaded it: reload it', hash: current.hash, confirmable: false });

      // The verdict the session's own Write of the same path would get.
      const verdict = evaluate({ tool: 'Write', input: { file_path: containerPath, content: text } }, human.policy(detail.project ?? engine.config.project), {
        readFile: (file) => (file === containerPath ? before : undefined),
      });
      if (verdict.decision === 'deny') throw new Refusal(403, { rule: verdict.rule, reason: verdict.message, confirmable: false });
      const confirmed = verdict.decision === 'ask' && confirm === verdict.rule && CONFIRMABLE.has(verdict.rule);
      if (verdict.decision === 'ask' && !confirmed)
        throw new Refusal(403, { rule: verdict.rule, reason: verdict.reason, confirmable: CONFIRMABLE.has(verdict.rule) });

      // The write, in the session's container.
      const written = await inContainer<Written>(human, detail.id, writeCommand(path, hash), text);
      if (written.stale !== undefined) throw new Refusal(409, { rule: null, reason: 'the file changed since the editor loaded it: reload it', hash: written.stale, confirmable: false });
      if (written.refused) throw new Refusal(403, { rule: 'link', reason: `the file is not saved: ${written.refused}`, confirmable: false });
      if (written.missing || !written.saved || written.hash === undefined) throw new HttpError(404, 'no such file in the checkout');

      if (confirmed) {
        human.journal(detail.id, { type: 'CUSTOM', name: 'cleared.permission_answered', value: { requestId: `editor-${written.hash.slice(0, 12)}`, decision: 'allow_once', by: user, rule: verdict.rule } });
      }
      const counts = lineCounts(before, text);
      const edit = { path: human.clean(path), by: user, added: counts.added, removed: counts.removed, before: current.hash, after: written.hash, via: 'editor' as const };
      human.edited(detail.id, edit, taken !== undefined);
      if (!taken) {
        const notice = humanEditNotice(await userName(context.registry.users, user), [edit]);
        await engine.send(detail.id, notice, 'cleared').catch((error: unknown) =>
          console.error(`cleared-v2: session ${detail.id} could not be told of a save (${error instanceof Error ? error.name : typeof error})`));
      }
      answer(context, 200, { saved: true, hash: written.hash } satisfies FileWritten);
    } catch (error) {
      if (error instanceof Refusal) answer(context, error.status, error.body);
      else if (error instanceof HttpError) answer(context, error.status, { error: error.message, ...(error.rule ? { rule: error.rule } : {}) });
      else if (error instanceof RouteError) answer(context, error.status, { error: error.message });
      else throw error;
    }
  };

  return [
    {
      method: 'GET', path: '/api/sessions/:id/files',
      handle: read((engine, context) => {
        const detail = detailOf(engine, context);
        answer(context, 200, { files: changedFiles(detail.state.files) } satisfies SessionFiles);
      }),
    },
    ...Array.from({ length: FILE_DEPTH }, (_, i) => ({
      method: 'GET' as const,
      path: ['/api/sessions/:id/files', ...Array.from({ length: i + 1 }, (_, j) => `:p${j}`)].join('/'),
      handle: file(i + 1),
    })),
    ...Array.from({ length: FILE_DEPTH }, (_, i) => ({
      method: 'PUT' as const,
      path: ['/api/sessions/:id/files', ...Array.from({ length: i + 1 }, (_, j) => `:p${j}`)].join('/'),
      handle: save(i + 1),
    })),
  ];
}
