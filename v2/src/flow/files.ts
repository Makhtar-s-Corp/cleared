// The Editor tab's files (docs/v2/milestone-2-plan.md, decision 30, lane
// 20), read only in this lane (lane 31 adds the save, decision 33):
//
//   GET /api/sessions/:id/files lists the files the session changed, from
//   its stored edits (the Changes card's counts), relative to its checkout;
//   GET /api/sessions/:id/files/<path> reads one file of the checkout, cut
//   at FILE_LINES lines, through the events' cleaner, with the hash of the
//   whole file's bytes (which a save sends back); with ?version=base, the
//   same file as the ticket's base holds it, for the diff the screen draws.
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
// A route matches a fixed number of segments (modules/registry.ts), so the
// file route is one route per depth, up to FILE_DEPTH.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readlinkSync, realpathSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { homedir } from 'node:os';
import { join, posix, sep } from 'node:path';
import { SERVICE_PROOF_HEADER, type SessionFile, type SessionFiles } from '../api/types.ts';
import { LOGIN_FILE_MOUNT, WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { Registry, Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import { cleanText, secretValues } from '../session/clean.ts';
import { evaluate, type Policy } from '../session/policy.ts';
import { CheckoutError, git, gitPath } from '../workspace/checkout.ts';
import { workspaceOf } from './config.ts';
import type { FlowEngine } from './engine.ts';

export const FILE_LINES = 400;
export const FILE_DEPTH = 16;
export const FILE_MAX_BYTES = 16 * 1024 * 1024;   // a larger file is not shown

export type FilesDeps = {
  readonly engine: (registry: Registry) => FlowEngine | undefined;
  readonly proof: () => string;
  readonly env?: NodeJS.ProcessEnv;                 // for the cleaner's secrets and the service's folders
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
  ];
}
