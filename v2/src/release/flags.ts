// What the release card says of a change besides its pull requests
// (docs/v2/milestone-2-plan.md, decision 23): the author's groups by intent,
// and the flags the diff raises. The publish step calls flags() once per
// ticket, with the diff of every pull request it published and the report
// the author left as its last `cleared.changes` journal event, and puts the
// result on the release item. Lane 16 placed the call; lane 18 fills it.
//
//   The groups are the report's, each with the files the diff changes, in
//   the report's order; a file named twice stays in its first group; the
//   changed files no group names go to "Other changes". Without a report
//   there is no group. With a report and no diff to read, the report's
//   groups are kept as the author gave them.
//
//   The flags, each a chip with its files: schema (a file in a migration
//   folder, or a .sql file), dependency (a line of a dependencies block of
//   package.json, or a lock file), config (.github/, .cleared/ and the
//   guarded paths given), secret_shape (an added line the guard would flag:
//   named by its kind, never by its text), contract (a contract file given
//   by the compatibility check), large (more than 400 lines added over the
//   whole change). A chip is never a block: when a hunk of package.json
//   does not show which block it is in, its lines are flagged.
//
// The diff is read hunk by hunk, by the counts of each hunk's header, so an
// added line that reads like a header ("+++ b/x") is a line. A train's
// diffs come one repository after the other: a path two repositories share
// is named once.
import type { ChangesReport, ReleaseFlag, ReleaseFlagKind, ReleaseGroup } from '../api/types.ts';
import { GUARD_PATTERNS } from '../session/clean.ts';
import type { SessionEvent } from '../session/events.ts';

// The journal event `report_changes` writes (decision 22's tool, lane 17).
export const CHANGES_EVENT = 'cleared.changes';

export const OTHER_CHANGES = 'Other changes';
export const LARGE_LINES = 400;

// Always configuration, whatever a service's [merge] guarded_paths say.
const CONFIG_PATHS: readonly string[] = ['.github/', '.cleared/'];

export type FlagsInput = {
  readonly diff: string;                         // unified diffs, one after the other, as git diff prints them
  readonly report?: ChangesReport;               // absent: the author reported nothing
  readonly contracts?: readonly string[];        // the services' contract files, as paths of their repositories
  readonly guarded?: readonly string[];          // the services' [merge] guarded_paths, prefixes as merge.mjs reads them
};

export type FlagsResult = { readonly groups: readonly ReleaseGroup[]; readonly flags: readonly ReleaseFlag[] };

// One file of the diff: its path and what its hunks add and remove.
type FileChange = { path: string; added: string[]; removed: number; dependency: boolean };

const DEPENDENCY_KEYS: ReadonlySet<string> = new Set([
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies', 'overrides', 'resolutions',
]);
// Top-level fields of package.json that are not dependencies: a line of one,
// in a hunk that shows no block, is not flagged.
const PACKAGE_FIELDS: ReadonlySet<string> = new Set([
  'name', 'version', 'description', 'keywords', 'homepage', 'bugs', 'license', 'author', 'contributors', 'funding', 'files', 'main',
  'module', 'browser', 'bin', 'man', 'directories', 'repository', 'config', 'private', 'type', 'types', 'typings', 'exports', 'imports',
  'workspaces', 'packageManager', 'publishConfig', 'sideEffects',
]);
const LOCK_FILES: ReadonlySet<string> = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);

const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);

// A path as git prints it: unquoted, without its a/ or b/ side.
function pathOf(raw: string): string | null {
  let text = raw.trim();
  if (text === '/dev/null') return null;
  if (text.startsWith('"') && text.endsWith('"')) {
    try { text = JSON.parse(text) as string; } catch { text = text.slice(1, -1); }
  }
  return text.replace(/^[ab]\//, '');
}

// `diff --git a/x b/y`: the b side, read from the end, since a path may hold " b/".
function gitHeaderPath(line: string): string | null {
  const rest = line.slice('diff --git '.length);
  const quoted = /"b\/((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (quoted) return pathOf(`"b/${quoted[1]}"`);
  const at = rest.lastIndexOf(' b/');
  return at < 0 ? null : rest.slice(at + 3);
}

// Where a package.json hunk is: the blocks it opened, innermost last.
// Unknown at the hunk's start: a hunk need not show its block's opening.
class PackageBlocks {
  #stack: ('dependency' | 'other')[] = [];

  #current(): 'dependency' | 'other' | 'unknown' {
    return this.#stack.at(-1) ?? 'unknown';
  }

  // Whether a changed line of this text is a dependency's; then the line moves the blocks.
  read(text: string, changed: boolean): boolean {
    const opens = /^\s*"([^"]+)"\s*:\s*[{[]\s*$/.exec(text);
    const pair = /^\s*"([^"]+)"\s*:/.exec(text);
    const current = this.#current();
    let flagged = false;
    if (changed) {
      if (opens) flagged = DEPENDENCY_KEYS.has(opens[1] as string) || current === 'dependency';
      else if (current === 'dependency') flagged = true;
      else if (current === 'unknown') flagged = !(pair && PACKAGE_FIELDS.has(pair[1] as string)) && /\S/.test(text) && !/^\s*[}\]],?\s*$/.test(text);
    }
    if (opens) this.#stack.push(current === 'dependency' || DEPENDENCY_KEYS.has(opens[1] as string) ? 'dependency' : 'other');
    else if (/^\s*[{[]\s*$/.test(text)) this.#stack.push(current === 'dependency' ? 'dependency' : 'other');
    else if (/^\s*[}\]],?\s*$/.test(text)) this.#stack.pop();
    return flagged;
  }
}

export function parseDiff(diff: string): FileChange[] {
  const files: FileChange[] = [];
  let file: FileChange | undefined;
  let old = 0;                                           // the lines the hunk still has on each side
  let now = 0;
  let blocks: PackageBlocks | undefined;
  for (const line of diff.split('\n')) {
    if (file && (old > 0 || now > 0)) {
      const mark = line === '' ? ' ' : line[0];          // an empty context line some tools write without its space
      const text = line.slice(1);
      if (mark === '\\') continue;                       // "\ No newline at end of file"
      if (mark === '+' || mark === '-' || mark === ' ') {
        if (mark !== '+') old--;
        if (mark !== '-') now--;
        if (mark === '+') file.added.push(text);
        if (mark === '-') file.removed++;
        if (blocks?.read(text, mark !== ' ')) file.dependency = true;
        continue;
      }
      old = 0;                                           // a cut diff: what follows is a header
      now = 0;
    }
    if (line.startsWith('diff --git ')) {
      const path = gitHeaderPath(line);
      file = path ? { path, added: [], removed: 0, dependency: false } : undefined;
      if (file) files.push(file);
      blocks = undefined;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const path = pathOf(line.slice(4));
      if (path) file.path = path;
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      old = hunk[1] === undefined ? 1 : Number(hunk[1]);
      now = hunk[2] === undefined ? 1 : Number(hunk[2]);
      blocks = base(file.path) === 'package.json' ? new PackageBlocks() : undefined;
    }
  }
  return files;
}

const under = (path: string, prefixes: readonly string[]) => prefixes.some((prefix) => prefix !== '' && path.startsWith(prefix));
const sorted = (paths: Iterable<string>) => [...new Set(paths)].sort();
const lines = (n: number) => (n === 1 ? '1 line' : `${n} lines`);

function groupsOf(report: ChangesReport | undefined, changed: readonly string[]): ReleaseGroup[] {
  if (!report) return [];
  const seen = new Set<string>();
  const known = new Set(changed);
  const out: ReleaseGroup[] = [];
  for (const group of report.groups) {
    const intent = group.intent.trim();
    const files = group.files.filter((path) => (changed.length === 0 || known.has(path)) && !seen.has(path) && seen.add(path));
    if (intent && files.length > 0) out.push({ intent, files });
  }
  const rest = changed.filter((path) => !seen.has(path));
  if (rest.length > 0) out.push({ intent: OTHER_CHANGES, files: rest });
  return out;
}

export function flags(input: FlagsInput): FlagsResult {
  const files = parseDiff(input.diff);
  const changed = sorted(files.map((f) => f.path));
  const found = new Map<ReleaseFlagKind, { files: string[]; detail: string }>();
  const raise = (kind: ReleaseFlagKind, path: string, detail: string) => {
    const known = found.get(kind) ?? { files: [], detail };
    known.files.push(path);
    found.set(kind, known);
  };
  const guarded = [...CONFIG_PATHS, ...(input.guarded ?? [])];
  const contracts = new Set(input.contracts ?? []);
  const secrets = new Set<string>();
  let added = 0;
  for (const file of files) {
    const { path } = file;
    added += file.added.length;
    if (/(?:^|\/)(?:migrations?|migrate)\//i.test(path) || /\.sql$/i.test(path)) raise('schema', path, 'Changes the database: a migration or SQL file.');
    if (LOCK_FILES.has(base(path)) || file.dependency) raise('dependency', path, 'Changes the dependencies: package.json\'s dependencies or a lock file.');
    if (under(path, guarded)) raise('config', path, 'Changes the configuration: the CI, Cleared\'s settings or a guarded path.');
    const kinds = new Set(file.added.flatMap((text) => GUARD_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind)));
    if (kinds.size > 0) {
      for (const kind of kinds) secrets.add(kind);
      raise('secret_shape', path, '');
    }
    if (contracts.has(path)) raise('contract', path, 'Changes a contract another service may consume.');
  }
  const secret = found.get('secret_shape');
  if (secret) secret.detail = `Adds a line shaped like a secret (${[...secrets].sort().join(', ')}): the guard refuses to publish it.`;
  if (added > LARGE_LINES) for (const file of files) if (file.added.length > 0) raise('large', file.path, `A large change: ${lines(added)} added, more than ${LARGE_LINES}.`);
  const order: readonly ReleaseFlagKind[] = ['schema', 'dependency', 'config', 'secret_shape', 'contract', 'large'];
  return {
    groups: groupsOf(input.report, changed),
    flags: order.flatMap((kind) => {
      const flag = found.get(kind);
      return flag ? [{ kind, files: sorted(flag.files), detail: flag.detail }] : [];
    }),
  };
}

// The report of the session's last `cleared.changes` event, by that name.
// One whose value is not a list of groups of an intent and its files reads
// as no report: the tool that writes it validates it (lane 17).
export function changesReport(events: readonly SessionEvent[]): ChangesReport | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event as { readonly type: string; readonly name?: string; readonly value?: unknown } | undefined;
    if (event?.type !== 'CUSTOM' || event.name !== CHANGES_EVENT) continue;
    const groups = (event.value as { groups?: unknown } | null | undefined)?.groups;
    if (!Array.isArray(groups)) return undefined;
    const out: { intent: string; files: string[] }[] = [];
    for (const group of groups as { intent?: unknown; files?: unknown }[]) {
      if (typeof group?.intent !== 'string' || !Array.isArray(group.files) || !group.files.every((file) => typeof file === 'string')) return undefined;
      out.push({ intent: group.intent, files: [...group.files as string[]] });
    }
    return { groups: out };
  }
  return undefined;
}
