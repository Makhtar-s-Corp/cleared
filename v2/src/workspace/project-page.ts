// The project page of a service (issue #274): one short page, kept in the
// service's state folder and never in its repository, that says what a
// session would otherwise rebuild each time: the layout of the service, the
// commands that are useful in it, and its recent decisions. It is made when
// the service is first connected, made again after a merge, and briefed to
// the sessions (workspace/briefing.ts).
//
// It is read from the service's base branch (git ls-tree and git show on
// refs/remotes/origin/<base>), never from the checkout's files, so nothing
// untracked can reach it. A folder service of a monorepo has the page of its
// folder (issue #394): its files, its package.json and README, the commits
// that touched it. A file that can hold a secret is left out by its
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

// What one line can say of a page: the README's first paragraph, else the
// package's name; null for a page that says neither. The lead's line of a
// service that commits no page of its own (issue #394).
export function pageSummary(page: string): string | null {
  const lines = page.split('\n');
  const start = lines.indexOf('## Architecture');
  if (start < 0) return null;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || line.startsWith('Layout of ')) break;
    block.push(line.trim());
  }
  return block.find((line) => !/^(?:Package: |Consumes: |Provides the contract )/.test(line)) ?? block.find((line) => line.startsWith('Package: ')) ?? null;
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

// Every path of the base branch that may be shown, to two levels under
// `folder` (the repository's root by default): a folder of the second level
// is shown as a folder, as git lists it.
function layoutOf(paths: readonly string[], folder = ''): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path.startsWith(folder)) continue;
    const parts = path.slice(folder.length).split('/');
    if (parts[0] === '.git') continue;
    seen.add(folder + (parts.length <= 2 ? parts.join('/') : `${parts[0]}/${parts[1]}/`));
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
  readonly path?: string | null;          // a folder service's folder in the repository
  readonly consumes?: readonly string[];  // the services of the workspace it calls
  readonly contract?: { readonly format: string; readonly path: string } | null;   // the contract it provides
};

// The folder of a folder service, as git names its paths ("guestbook/"), or
// '' for a whole repository.
const folderOf = (source: Pick<PageSource, 'path'>) => (source.path ? `${source.path.replace(/^\.\/|\/+$/g, '')}/` : '');

// What the page is made from: the folder and the repository's settings for
// a folder service, everything otherwise.
const pathsOf = (source: Pick<PageSource, 'path'>) => (folderOf(source) ? ['--', folderOf(source), '.cleared/agents.conf'] : []);

// The tip the page is made at, or null when the checkout does not hold the
// base yet: the base branch's tip, or for a folder service the last commit
// of the base that touched its folder or the repository's settings, so a
// merge in another folder leaves its page as it is.
export async function baseSha(source: Pick<PageSource, 'dir' | 'base' | 'path'>): Promise<string | null> {
  const ref = `refs/remotes/origin/${source.base}`;
  try {
    if (!folderOf(source)) return (await git(source.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
    return (await git(source.dir, ['rev-list', '-1', ref, ...pathsOf(source)])).trim() || null;
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

// The page as the base branch has it now, at `known` when the caller read
// its tip already. Throws when the base is missing.
export async function generateProjectPage(source: PageSource, known?: string): Promise<{ readonly text: string; readonly sha: string }> {
  const sha = known ?? await baseSha(source);
  if (!sha) throw new Error(`the base ${source.base} of ${source.name} is not in its checkout`);
  const ref = `refs/remotes/origin/${source.base}`;
  const folder = folderOf(source);
  const paths = (await git(source.dir, ['ls-tree', '-r', '--name-only', '-z', ref, ...(folder ? ['--', folder] : [])])).split('\0').filter((path) => path && !isDeniedPath(path));

  let packageName = '';
  const commands: string[] = [];
  const pkg = await show(source, `${folder}package.json`);
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

  const readme = await show(source, `${folder}README.md`);
  const subjects = (await git(source.dir, ['log', '--first-parent', `-n${DECISIONS}`, '--no-show-signature', '--format=%cs %s', ref, ...pathsOf(source)])).split('\n').filter(Boolean);
  // Where the service sits in the workspace, as its configuration says.
  const consumes = (source.consumes ?? []).map((name) => `\`${field(source.env, name, 40)}\``);
  const contract = source.contract ? `Provides the contract \`${field(source.env, source.contract.path, 120)}\` (${field(source.env, source.contract.format, 20)}).` : '';

  // The header is left out of the cleaning: the sha is git's, and the
  // cleaner could take its 12 characters for a phone number (issue #360),
  // so the page would never name the base it was made from.
  const header = [
    `# Project page: ${field(source.env, source.name, 80)}`,
    '',
    `Generated by Cleared from ${folder ? `the folder \`${field(source.env, folder.slice(0, -1), 120)}\` of ` : ''}the base branch \`${field(source.env, source.base, 80)}\` at \`${sha.slice(0, 12)}\`${folder ? ', the last commit that changed it' : ''}. It is not part of the project, and it is made again after each merge.`,
    '',
  ];
  const lines = [
    '## Architecture',
    ...(packageName ? [`Package: ${packageName}`] : []),
    ...(readme !== undefined && summaryOf(readme) ? [field(source.env, summaryOf(readme), SUMMARY_LIMIT)] : []),
    ...(consumes.length ? [`Consumes: ${consumes.join(', ')}.`] : []),
    ...(contract ? [contract] : []),
    '',
    folder ? 'Layout of the folder on the base branch:' : 'Layout of the base branch:',
    ...layoutOf(paths, folder),
    '',
    '## Useful commands',
    ...(folder && commands.length ? [`From the folder \`${field(source.env, folder.slice(0, -1), 120)}\`:`] : []),
    ...(commands.length ? commands : ['- None found in package.json.']),
    ...(safe.length ? ['', `Commands a session may run unasked: ${safe.map((c) => `\`${c}\``).join(', ')}.`] : []),
    '',
    '## Recent decisions',
    ...(subjects.length ? subjects.map((s) => `- ${s.slice(0, 11)}${field(source.env, s.slice(11), SUBJECT_LIMIT)}`) : ['- None yet.']),
    '',
  ];
  let text = [...header, clean(lines.join('\n'), source.env)].join('\n');
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

// The page as it is on disk, null only when there is none: a page that
// cannot be read is not written over.
function pageAt(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// The page after a merge: made again when the base branch moved since the
// page was made, left as it is otherwise. A page made again that says what
// the old one said is not written either, so a tip that could not be read
// for a moment rewrites nothing. True when it was written now.
export async function updateProjectPage(source: PageSource): Promise<boolean> {
  const path = projectPagePath(source.env, source.name);
  const sha = await baseSha(source);
  const current = pageAt(path);
  if (sha && current !== null && current.includes(`at \`${sha.slice(0, 12)}\``)) return false;
  const { text } = await generateProjectPage(source, sha ?? undefined);
  if (text === current) return false;
  store(path, text);
  return true;
}
