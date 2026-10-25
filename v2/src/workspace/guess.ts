// What the workspace step guesses from a repository's files
// (docs/v2/milestone-5-plan.md, section 9, decision 15), all proposals the
// person ticks or not, never written alone:
//   - a monorepo's folders: its package.json workspaces (or pnpm's), else
//     two top folders or more with a manifest of their own;
//   - a service's contract: a file under a known name at a known place,
//     read by the fakes' reader before it is proposed (OpenAPI first, then
//     AsyncAPI as events);
//   - a name per service, the repository's or the folder's;
//   - the links: the service map (P245) run on the services with their
//     proposed contracts, each call it finds a proposed consumes line, with
//     the places that suggested it.
// The guess reads a tree: the paths of the base branch and the texts of the
// few files wantedFiles names (connect.ts reads them from git's objects).
import { posix } from 'node:path';
import { buildMap, type MapServiceSpec, type ServiceRead } from '../map/build.ts';
import { contractFacts } from '../map/scan.ts';
import { serviceNameOf } from './config.ts';
import type { ContractLine, ProposedLink } from './types.ts';

export type Tree = { readonly paths: readonly string[]; readonly files: Readonly<Record<string, string>> };

const MANIFESTS = new Set(['package.json', 'deno.json', 'go.mod', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'mix.exs']);
// Top folders that hold parts of a project, not services of their own.
const NOT_SERVICES = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'fixtures', 'node_modules', 'vendor', 'dist', 'build', 'docs', 'doc', 'examples', 'example', 'scripts', 'tools']);

// The known places of a contract, inside the service, in the order they are tried.
const PLACES = ['', 'contract/', 'contracts/', 'api/', 'openapi/', 'spec/', 'docs/'];
const NAMES: readonly (readonly [ContractLine['format'], readonly string[]])[] = [
  ['openapi', ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json']],
  ['events', ['asyncapi.yaml', 'asyncapi.yml', 'asyncapi.json']],
];
const CONTRACT_NAMES = new Set(NAMES.flatMap(([, names]) => names));
const PLACE_FOLDERS = new Set(PLACES.filter(Boolean).map((place) => place.slice(0, -1)));
const ROOT_FILES = ['package.json', 'pnpm-workspace.yaml'];

// The files the guess reads: the root's workspaces, and each file under a
// contract's name, its folder two levels deep at most (a monorepo's
// packages/web/contract/openapi.yaml), its known place not counted.
export function wantedFiles(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    if (ROOT_FILES.includes(path)) return true;
    if (!CONTRACT_NAMES.has(posix.basename(path))) return false;
    const dir = posix.dirname(path);
    const parts = dir === '.' ? [] : dir.split('/');
    const prefix = PLACE_FOLDERS.has(parts.at(-1) ?? '') ? parts.slice(0, -1) : parts;
    return prefix.length <= 2;
  }).sort();
}

const hasManifest = (paths: ReadonlySet<string>, folder: string): boolean => [...MANIFESTS].some((name) => paths.has(`${folder}/${name}`));

// A workspaces entry as a folder or a folder's children (a trailing /*);
// one that leaves the repository, is negated or has another wildcard is not read.
function expand(pattern: string, paths: readonly string[], set: ReadonlySet<string>): string[] {
  const clean = pattern.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || clean.startsWith('/') || clean.startsWith('!') || clean.split('/').some((part) => part === '..' || part === '.')) return [];
  if (clean.endsWith('/*')) {
    const parent = clean.slice(0, -2);
    if (parent.includes('*')) return [];
    const children = new Set(paths.filter((path) => path.startsWith(`${parent}/`)).map((path) => path.slice(parent.length + 1).split('/')).filter((parts) => parts.length > 1).map((parts) => `${parent}/${parts[0]}`));
    return [...children].filter((folder) => hasManifest(set, folder));
  }
  return clean.includes('*') || !hasManifest(set, clean) ? [] : [clean];
}

function workspacePatterns(tree: Tree): string[] {
  const root = tree.files['package.json'];
  if (root !== undefined) {
    try {
      const value = (JSON.parse(root) as { workspaces?: unknown }).workspaces;
      const list = Array.isArray(value) ? value : (value as { packages?: unknown } | undefined)?.packages;
      if (Array.isArray(list)) return list.filter((entry): entry is string => typeof entry === 'string');
    } catch { /* not JSON: no workspaces */ }
  }
  const pnpm = tree.files['pnpm-workspace.yaml'];
  if (pnpm === undefined) return [];
  // The packages list, one "- entry" a line, its quotes taken off.
  const lines = pnpm.split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages\s*:/.test(line));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const item = /^\s+-\s*(.+?)\s*$/.exec(line);
    if (!item) { if (/^\S/.test(line)) break; continue; }
    out.push((item[1] as string).replace(/^(['"])(.*)\1$/, '$2'));
  }
  return out;
}

// The folders of a monorepo that could be services, or null for a repository that is one service.
export function folderServices(tree: Tree): { readonly folders: string[]; readonly from: 'workspaces' | 'manifests' } | null {
  const set = new Set(tree.paths);
  const declared = [...new Set(workspacePatterns(tree).flatMap((pattern) => expand(pattern, tree.paths, set)))].sort();
  if (declared.length > 0) return { folders: declared, from: 'workspaces' };
  const top = [...new Set(tree.paths.map((path) => path.split('/')).filter((parts) => parts.length > 1).map((parts) => parts[0] as string))]
    .filter((folder) => !folder.startsWith('.') && !NOT_SERVICES.has(folder) && hasManifest(set, folder)).sort();
  return top.length >= 2 ? { folders: top, from: 'manifests' } : null;
}

// The contract of the service at `folder` (null: the repository's root), its path inside the service.
export function contractOf(tree: Tree, folder: string | null): ContractLine | null {
  for (const [format, names] of NAMES) {
    for (const place of PLACES) {
      for (const name of names) {
        const path = `${place}${name}`;
        const text = tree.files[folder ? `${folder}/${path}` : path];
        if (text === undefined) continue;
        try {
          contractFacts(format, path, text);
          return { format, path };
        } catch { /* not a contract the reader knows: the next name */ }
      }
    }
  }
  return null;
}

// A name per service, as a service name allows: the folder's or the
// repository's; one already taken becomes <repository>-<folder> or
// <owner>-<repository>, then gets a number.
export function serviceNames(entries: readonly { readonly repo: string; readonly path: string | null }[]): string[] {
  const taken = new Set<string>();
  return entries.map(({ repo, path }) => {
    const [owner = '', name = ''] = repo.split('/');
    const last = path ? (path.split('/').at(-1) as string) : name;
    const first = serviceNameOf(last);
    let chosen = [first, serviceNameOf(path ? `${name}-${last}` : `${owner}-${name}`)].find((candidate) => !taken.has(candidate));
    for (let n = 2; chosen === undefined; n++) {
      const candidate = `${first.slice(0, 39 - String(n).length).replace(/-+$/, '')}-${n}`;
      if (!taken.has(candidate)) chosen = candidate;
    }
    taken.add(chosen);
    return chosen;
  });
}

// The calls the map finds between the services, given their proposed
// contracts and no declared consumes: each a proposed consumes line.
export function proposeLinks(services: readonly MapServiceSpec[], reads: readonly ServiceRead[]): ProposedLink[] {
  const map = buildMap({ workspace: 'proposal', services: services.map((service) => ({ ...service, consumes: [] })), reads, at: new Date(0).toISOString() });
  return map.links.filter((link) => link.kind === 'call' && link.found)
    .map((link) => ({ id: `${link.from}>${link.to}`, from: link.from, to: link.to, items: link.items, places: link.places }));
}
