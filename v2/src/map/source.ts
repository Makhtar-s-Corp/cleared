// A service's files as the map reads them (docs/v2/milestone-4-plan.md,
// section 12.3): from git's objects at refs/remotes/origin/<base> of the
// service's own checkout, which no session writes, as the recipes and the
// reader read theirs; never the working tree or an unpushed commit. A
// folder of a monorepo is read alone, its paths inside it. Only plain
// files: a committed link, a submodule, a binary file are not read. The
// code files (scan.ts isCodeFile) within MAP_CAPS; past the count or the
// bytes, the read keeps the first files in path order and says `capped`.
// Besides them: the service's .cleared/agents.conf (its folder's, else the
// repository's), its package.json and its contract file.
//
// readFolder applies the same rules to a folder of the disk, without its
// links: the app's fixtures and the examples' tests read examples/ with it.
import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { CheckoutError, git } from '../workspace/checkout.ts';
import type { ServiceRead } from './build.ts';
import { isCodeFile, type MapFile } from './scan.ts';

export const MAP_CAPS = { files: 2000, bytes: 16 * 1024 * 1024, fileBytes: 256 * 1024 } as const;
export type MapCaps = { readonly files: number; readonly bytes: number; readonly fileBytes: number };

export type MapService = {
  readonly name: string;
  readonly base: string;
  readonly dir: string;                            // the service's own checkout, as the flow fetches it
  readonly path: string | null;                    // the folder of a monorepo service
  readonly contract: { readonly path: string } | null;
};

const CONF = '.cleared/agents.conf';
const PACKAGE = 'package.json';
// <mode> SP <type> SP <object> SP+ <size> TAB <path>
const ENTRY = /^(\d+) (\w+) ([0-9a-f]+) +(\d+|-)\t(.*)$/s;

const notFetched = (name: string): ServiceRead => ({ name, commit: null, files: [], conf: null, packageJson: null, contract: null, problems: ['not_fetched'] });
const isText = (text: string) => !text.includes('\0') && !text.includes('�');

// The commit of the service's base branch in its checkout, or null when it is not fetched.
export async function baseCommit(service: Pick<MapService, 'base' | 'dir'>): Promise<string | null> {
  try {
    const commit = (await git(service.dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${service.base}^{commit}`])).trim();
    return /^[0-9a-f]{40,64}$/.test(commit) ? commit : null;
  } catch (error) {
    if (error instanceof CheckoutError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

// The blobs' texts by object id, through one `git cat-file --batch`.
function catFiles(dir: string, objects: readonly string[]): Promise<Map<string, string>> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    delete env.GIT_CONFIG_PARAMETERS;
    const child = spawn('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'cat-file', '--batch'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new CheckoutError(`git cat-file --batch failed (exit ${code})`)); return; }
      const out = Buffer.concat(chunks);
      const texts = new Map<string, string>();
      let at = 0;
      while (at < out.length) {
        const end = out.indexOf(0x0a, at);
        if (end < 0) break;
        const [id, type, size] = out.subarray(at, end).toString('utf8').split(' ');
        if (type === 'missing' || size === undefined) { at = end + 1; continue; }
        const length = Number(size);
        texts.set(id as string, out.subarray(end + 1, end + 1 + length).toString('utf8'));
        at = end + 1 + length + 1;
      }
      resolve(texts);
    });
    child.stdin.end(objects.map((id) => `${id}\n`).join(''));
  });
}

type Entry = { readonly path: string; readonly object: string; readonly size: number };

// Which entries the read keeps: the code files in path order within the
// caps, and the three named files.
function pick(entries: readonly Entry[], service: Pick<MapService, 'path' | 'contract'>, caps: MapCaps) {
  const inside = (full: string): string | undefined => {
    if (service.path === null) return full;
    return full.startsWith(`${service.path}/`) ? full.slice(service.path.length + 1) : undefined;
  };
  const code: Entry[] = [];
  const named: Record<'conf' | 'rootConf' | 'packageJson' | 'contract', Entry | undefined> = { conf: undefined, rootConf: undefined, packageJson: undefined, contract: undefined };
  for (const entry of entries) {
    if (entry.size > caps.fileBytes) continue;
    if (service.path !== null && entry.path === CONF) named.rootConf = entry;
    const path = inside(entry.path);
    if (path === undefined) continue;
    if (path === CONF) named.conf = entry;
    else if (path === PACKAGE) named.packageJson = entry;
    else if (service.contract && path === service.contract.path) named.contract = entry;
    if (isCodeFile(path)) code.push({ ...entry, path });
  }
  code.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const kept: Entry[] = [];
  let bytes = 0;
  let capped = false;
  for (const entry of code) {
    if (kept.length >= caps.files || bytes + entry.size > caps.bytes) { capped = true; break; }
    kept.push(entry);
    bytes += entry.size;
  }
  return { kept, capped, conf: named.conf ?? named.rootConf, packageJson: named.packageJson, contract: named.contract };
}

export async function readService(service: MapService, caps: MapCaps = MAP_CAPS): Promise<ServiceRead> {
  const commit = await baseCommit(service);
  if (commit === null) return notFetched(service.name);
  const listing = await git(service.dir, ['ls-tree', '-r', '-z', '--long', commit, '--', service.path ?? '.']);
  const entries: Entry[] = [];
  for (const line of listing.split('\0')) {
    const match = ENTRY.exec(line);
    // A plain file: no link (120000), no submodule (160000), no folder.
    if (!match || match[2] !== 'blob' || (match[1] !== '100644' && match[1] !== '100755')) continue;
    entries.push({ path: match[5] as string, object: match[3] as string, size: Number(match[4]) });
  }
  const chosen = pick(entries, service, caps);
  const wanted = [...chosen.kept, chosen.conf, chosen.packageJson, chosen.contract].filter((entry): entry is Entry => entry !== undefined);
  const texts = await catFiles(service.dir, [...new Set(wanted.map((entry) => entry.object))]);
  const text = (entry: Entry | undefined): string | null => {
    const value = entry ? texts.get(entry.object) : undefined;
    return value !== undefined && isText(value) ? value : null;
  };
  const files: MapFile[] = chosen.kept.flatMap((entry) => {
    const value = text(entry);
    return value === null ? [] : [{ path: entry.path, text: value }];
  });
  return {
    name: service.name, commit, files, conf: text(chosen.conf), packageJson: text(chosen.packageJson), contract: text(chosen.contract),
    problems: chosen.capped ? ['capped'] : [],
  };
}

// A folder of the disk, read by the same rules; links are not followed.
export function readFolder(root: string, service: { readonly name: string; readonly contract: { readonly path: string; readonly format?: string } | null }, caps: MapCaps = MAP_CAPS): ServiceRead {
  const entries: Entry[] = [];
  const walk = (relative: string): void => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = relative ? posix.join(relative, name) : name;
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) { if (name !== 'node_modules' && name !== '.git') walk(path); }
      else if (stat.isFile()) entries.push({ path, object: path, size: stat.size });
    }
  };
  walk('');
  const chosen = pick(entries, { path: null, contract: service.contract }, caps);
  const text = (entry: Entry | undefined): string | null => {
    if (!entry) return null;
    const value = readFileSync(join(root, entry.object), 'utf8');
    return isText(value) ? value : null;
  };
  return {
    name: service.name, commit: null,
    files: chosen.kept.flatMap((entry) => { const value = text(entry); return value === null ? [] : [{ path: entry.path, text: value }]; }),
    conf: text(chosen.conf), packageJson: text(chosen.packageJson), contract: text(chosen.contract), problems: chosen.capped ? ['capped'] : [],
  };
}
