// The code a reader's answer cites (P215, issue #331): the
// `service/path:line` and `service/path:from-to` mentions its briefing asks
// for, each checked against the commit the reader read, and a GitHub link
// to that commit and those lines.
//
//   The link is the service's: built from the service's repository as the
//   workspace names it, the commit its folder was exported at
//   (workspace/checkout.ts exportBase) and the file's lines counted from
//   git's objects at that commit (workdir.ts linesAt). An address the
//   reader writes is never taken. A mention whose file or lines that commit
//   does not hold keeps no link and says why, so an invented citation shows.
//
//   A bare `path:line`, without its service, is read when the ask read one
//   service only, and kept only when that commit holds it: anything else
//   written that way (a host and its port) may be no citation at all.
import { WORKDIR_MOUNT } from '../container/session-runtime.ts';
import type { AskCitation } from '../api/types.ts';
import { ReaderError, servicePath } from './target.ts';

// The most citations one answer keeps.
export const MAX_CITATIONS = 40;
const MAX_LINE = 1_000_000;

export type Mention = {
  readonly text: string;
  readonly service: string;
  readonly path: string;
  readonly from: number;
  readonly to: number;
  readonly bare: boolean;
};

export type CiteSource = {
  readonly name: string;
  readonly repo: string;                 // owner/name on GitHub
  readonly path: string | null;          // the folder of a monorepo service
};

export type CiteDeps = {
  readonly services: readonly CiteSource[];
  // The services the ask read, every one when absent: a bare path is theirs when they are one.
  readonly read?: readonly string[];
  // The commit each service's folder was exported at, for the session that answered.
  readonly commits: Readonly<Record<string, string>>;
  // The lines of a plain text file of a service at a commit; a ReaderError when it holds none.
  linesAt(service: string, commit: string, path: string): Promise<number>;
};

const PATH = '[A-Za-z0-9_@+.-]+(?:/[A-Za-z0-9_@+.-]+)*';
const LINES = ':([0-9]{1,7})(?:[-–]([0-9]{1,7}))?(?![0-9])';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

export function mentionsIn(answer: string, services: readonly string[], read: readonly string[] = services): Mention[] {
  const found: (Mention & { readonly at: number; readonly end: number })[] = [];
  const add = (match: RegExpExecArray, service: string, raw: string, bare: boolean) => {
    const path = servicePath(raw);
    const from = Number(match[match.length - 2]);
    const to = match[match.length - 1] === undefined ? from : Number(match[match.length - 1]);
    if (path === undefined || from < 1 || from > MAX_LINE || to > MAX_LINE) return;
    found.push({ text: match[0], service, path, from, to, bare, at: match.index, end: match.index + match[0].length });
  };
  if (services.length > 0) {
    const named = new RegExp(`(?<![A-Za-z0-9_./-])(?:${escape(WORKDIR_MOUNT)}/)?(${services.map(escape).join('|')})/(${PATH})${LINES}`, 'g');
    for (const match of answer.matchAll(named)) add(match, match[1] as string, match[2] as string, false);
  }
  if (read.length === 1) {
    const bare = new RegExp(`(?<![A-Za-z0-9_./:@+-])(${PATH})${LINES}`, 'g');
    for (const match of answer.matchAll(bare)) {
      const at = match.index;
      if (!/[A-Za-z]/.test(match[1] as string) || found.some((m) => at < m.end && m.at < at + match[0].length)) continue;
      add(match, read[0] as string, match[1] as string, true);
    }
  }
  const seen = new Set<string>();
  return found.sort((a, b) => a.at - b.at)
    .filter((m) => !seen.has(m.text) && seen.add(m.text))
    .slice(0, MAX_CITATIONS)
    .map(({ at: _at, end: _end, ...mention }) => mention);
}

const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// https://github.com/<repo>/blob/<commit>/<path>#L<from>[-L<to>], or
// undefined when one of them is not what it should be.
export function githubLink(input: { readonly repo: string; readonly commit: string; readonly path: string; readonly from: number; readonly to: number }): string | undefined {
  const name = input.repo.split('/')[1];
  if (!REPO.test(input.repo) || name === '.' || name === '..' || !COMMIT.test(input.commit)) return undefined;
  const path = servicePath(input.path);
  if (path === undefined || !Number.isInteger(input.from) || !Number.isInteger(input.to) || input.from < 1 || input.to < input.from) return undefined;
  const lines = input.to > input.from ? `#L${input.from}-L${input.to}` : `#L${input.from}`;
  return `https://github.com/${input.repo}/blob/${input.commit}/${path.split('/').map(encodeURIComponent).join('/')}${lines}`;
}

export async function citationsOf(answer: string, deps: CiteDeps): Promise<AskCitation[]> {
  const counts = new Map<string, Promise<number | 'no_file' | 'unchecked'>>();
  const count = (service: string, commit: string, path: string) => {
    const key = `${service}\n${commit}\n${path}`;
    let lines = counts.get(key);
    if (!lines) {
      lines = deps.linesAt(service, commit, path).catch((error: unknown) => {
        if (error instanceof ReaderError) return 'no_file' as const;
        console.error(`cleared-v2: a citation of ${service} could not be checked (${errorName(error)})`);
        return 'unchecked' as const;
      });
      counts.set(key, lines);
    }
    return lines;
  };
  const cited: AskCitation[] = [];
  for (const mention of mentionsIn(answer, deps.services.map((service) => service.name), deps.read)) {
    const { bare, ...where } = mention;
    // A service the ask did not read is no code the reader read.
    const commit = !deps.read || deps.read.includes(mention.service) ? deps.commits[mention.service] ?? null : null;
    const source = deps.services.find((service) => service.name === mention.service) as CiteSource;
    let problem: AskCitation['problem'] = null;
    let url: string | undefined;
    const lines = commit === null ? 'no_file' : await count(mention.service, commit, mention.path);
    if (typeof lines !== 'number') problem = lines;
    else if (mention.to < mention.from || mention.to > lines) problem = 'no_line';
    else {
      url = githubLink({ repo: source.repo, commit: commit as string, path: source.path === null ? mention.path : `${source.path}/${mention.path}`, from: mention.from, to: mention.to });
      if (url === undefined) problem = 'no_repository';
    }
    if (bare && problem !== null) continue;
    cited.push({ ...where, commit, url: url ?? null, problem });
  }
  return cited;
}
