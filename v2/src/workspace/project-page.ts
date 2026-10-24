// The project page of a service (issue #274): one short page, kept in the
// service's state folder and never in its repository, that says what a
// session would otherwise rebuild each time: the layout of the service, the
// commands that are useful in it, and its recent decisions. It is made when
// the service is first connected, made again after a merge, and briefed to
// the sessions (workspace/briefing.ts).
//
// It is read from the service's base branch (git ls-tree and git show on
// refs/remotes/origin/<base>), never from the checkout's files, so nothing
// untracked can reach it. A file that can hold a secret is left out by its
// name, even from the layout; what is read is then cleaned of secret values
// and of token shapes, so a commit subject or a README that quotes one does
// not carry it into every briefing.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { cleanText, secretValues } from '../session/clean.ts';
import { git } from './checkout.ts';
import { BriefingError, serviceNameOk, stateFolder } from './briefing.ts';

// What a briefing can carry for one service's page.
export const PAGE_LIMIT = 8 * 1024;

const LAYOUT_LIMIT = 60;
const DECISIONS = 15;
const SUBJECT_LIMIT = 160;
const SUMMARY_LIMIT = 300;

// <state>/pages/<name>.md. Not in <state>/services/<name>, which only a
// memory level of that service makes.
export function projectPagePath(env: NodeJS.ProcessEnv, service: string): string {
  if (!serviceNameOk(service)) throw new BriefingError(`"${service}" is not a service name`);
  return join(stateFolder(env), 'pages', `${service}.md`);
}

// The page, or null when the service has none (or it cannot be read).
export function readProjectPage(env: NodeJS.ProcessEnv, service: string): string | null {
  try {
    return readFileSync(projectPagePath(env, service), 'utf8');
  } catch {
    return null;
  }
}

// A path that can hold a secret: an environment file, a key or certificate,
// a credentials or secrets file, a package registry's or a netrc login.
const DENIED_PATH = /(?:^|\/)(?:\.env(?:\..*)?|\.envrc|\.npmrc|\.netrc|\.pypirc|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*(?:credential|secret|password|passwd|token)[^/]*)$|\.(?:pem|key|p12|pfx|jks|keystore|asc|gpg|kdbx)$/i;
export const isDeniedPath = (path: string): boolean => DENIED_PATH.test(path);

// The shapes of the tokens the cleaner's guard patterns do not name.
const TOKEN_SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,})/g;

// A name that says a secret, then its value, anywhere in a line: a script
// that sets a token for one command, a subject that says what was set.
const ASSIGNED = /[\w-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|pepper|credential)[\w-]*\s*[=:]\s*[^\s,;]{4,}/gi;

function clean(text: string, env: NodeJS.ProcessEnv): string {
  return cleanText(text, { secrets: secretValues(env) }).replace(TOKEN_SHAPES, '[removed: token]').replace(ASSIGNED, '[removed: secret]');
}

// One field of the page, cleaned on its own: the guard's patterns for an
// assigned secret start at the beginning of a line, which in the page a
// field no longer is.
function field(env: NodeJS.ProcessEnv, text: string, limit: number): string {
  return oneLine(clean(oneLine(text, limit * 4), env), limit);
}

// One line of prose: control characters out, one line, cut.
function oneLine(text: string, limit: number): string {
  const line = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

// What the base branch says of the service: its README's first paragraph.
function summaryOf(readme: string): string {
  for (const paragraph of readme.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const text = paragraph.split('\n').filter((line) => !/^\s*(?:#|!\[|\[!\[|<|[-*]{3,}\s*$)/.test(line)).join(' ').trim();
    if (text) return oneLine(text, SUMMARY_LIMIT);
  }
  return '';
}

// Every path of the base branch that may be shown, to two levels: a folder
// of the second level is shown as a folder, as git lists it.
function layoutOf(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const parts = path.split('/');
    if (parts[0] === '.git') continue;
    seen.add(parts.length === 1 ? path : parts.length === 2 ? path : `${parts[0]}/${parts[1]}/`);
  }
  const all = [...seen].sort((a, b) => a.localeCompare(b));
  const shown = all.slice(0, LAYOUT_LIMIT).map((entry) => `- \`${entry}\``);
  if (all.length > LAYOUT_LIMIT) shown.push(`- … and ${all.length - LAYOUT_LIMIT} more`);
  return shown;
}

function listOf(text: string | undefined): string[] {
  return (text ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

export type PageSource = {
  readonly dir: string;                   // the service's checkout, whose base branch is read
  readonly base: string;                  // the service's base branch
  readonly name: string;                  // the service's name
  readonly env: NodeJS.ProcessEnv;
};

// The base branch's tip, or null when the checkout does not hold it yet.
export async function baseSha(source: Pick<PageSource, 'dir' | 'base'>): Promise<string | null> {
  try {
    return (await git(source.dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${source.base}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

async function show(source: PageSource, path: string): Promise<string | undefined> {
  if (isDeniedPath(path)) return undefined;
  try {
    return await git(source.dir, ['show', `refs/remotes/origin/${source.base}:${path}`]);
  } catch {
    return undefined;
  }
}

// The page as the base branch has it now. Throws when the base is missing.
export async function generateProjectPage(source: PageSource): Promise<{ readonly text: string; readonly sha: string }> {
  const sha = await baseSha(source);
  if (!sha) throw new Error(`the base ${source.base} of ${source.name} is not in its checkout`);
  const ref = `refs/remotes/origin/${source.base}`;
  const paths = (await git(source.dir, ['ls-tree', '-r', '--name-only', '-z', ref])).split('\0').filter((path) => path && !isDeniedPath(path));

  let packageName = '';
  const commands: string[] = [];
  const pkg = await show(source, 'package.json');
  if (pkg !== undefined) {
    try {
      const parsed = JSON.parse(pkg) as { name?: unknown; scripts?: Record<string, unknown> };
      if (typeof parsed.name === 'string') packageName = oneLine(parsed.name, 80);
      for (const [script, body] of Object.entries(parsed.scripts ?? {}))
        if (typeof body === 'string') commands.push(`- \`npm run ${oneLine(script, 40)}\`: \`${field(source.env, body, 100)}\``);
    } catch { /* a package.json that does not parse says nothing */ }
  }
  const conf = await show(source, '.cleared/agents.conf');
  const safe = conf === undefined ? [] : listOf(/^\s*safe_commands\s*=\s*(.*)$/m.exec(conf)?.[1]).map((c) => field(source.env, c, 80));

  const readme = await show(source, 'README.md');
  const subjects = (await git(source.dir, ['log', '--first-parent', `-n${DECISIONS}`, '--no-show-signature', '--format=%cs %s', ref])).split('\n').filter(Boolean);

  const lines = [
    `# Project page: ${source.name}`,
    '',
    `Generated by Cleared from the base branch \`${source.base}\` at \`${sha.slice(0, 12)}\`. It is not part of the project, and it is made again after each merge.`,
    '',
    '## Architecture',
    ...(packageName ? [`Package: ${packageName}`] : []),
    ...(readme !== undefined && summaryOf(readme) ? [field(source.env, summaryOf(readme), SUMMARY_LIMIT)] : []),
    '',
    'Layout of the base branch:',
    ...layoutOf(paths),
    '',
    '## Useful commands',
    ...(commands.length ? commands : ['- None found in package.json.']),
    ...(safe.length ? ['', `Commands a session may run unasked: ${safe.map((c) => `\`${c}\``).join(', ')}.`] : []),
    '',
    '## Recent decisions',
    ...(subjects.length ? subjects.map((s) => `- ${s.slice(0, 11)}${field(source.env, s.slice(11), SUBJECT_LIMIT)}`) : ['- None yet.']),
    '',
  ];
  let text = clean(lines.join('\n'), source.env);
  if (Buffer.byteLength(text) > PAGE_LIMIT) text = `${Buffer.from(text).subarray(0, PAGE_LIMIT - 40).toString('utf8').replace(/\n[^\n]*$/, '')}\n\n(cut to fit)\n`;
  return { text, sha };
}

// Written beside itself then renamed over the old page, in a folder made
// private.
function store(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const aside = join(dirname(path), `.project-page.${randomUUID()}`);
  try {
    writeFileSync(aside, text, { flag: 'wx', mode: 0o600 });
    renameSync(aside, path);
  } finally {
    rmSync(aside, { force: true });
  }
}

// The page at a service's first connection: made once, never made again by a
// fetch. True when it was made now.
export async function ensureProjectPage(source: PageSource): Promise<boolean> {
  const path = projectPagePath(source.env, source.name);
  if (existsSync(path)) return false;
  store(path, (await generateProjectPage(source)).text);
  return true;
}

// The page after a merge: made again when the base branch moved since the
// page was made, left as it is otherwise. True when it was written now.
export async function updateProjectPage(source: PageSource): Promise<boolean> {
  const path = projectPagePath(source.env, source.name);
  const sha = await baseSha(source);
  const current = readProjectPage(source.env, source.name);
  if (sha && current !== null && current.includes(`at \`${sha.slice(0, 12)}\``)) return false;
  store(path, (await generateProjectPage(source)).text);
  return true;
}
