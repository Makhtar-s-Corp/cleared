// What a question to the code may name (docs/v2/milestone-2-plan.md,
// decision 28): a service, a file inside it and a line, `service:path:line`,
// and the lines around that line the reader's first turn holds.
import { posix } from 'node:path';

export type AskTarget = { readonly service: string; readonly path: string; readonly line: number };

// What the reader refuses, as its routes answer it: invalid 400, not_found
// 404, conflict 409.
export type ReaderErrorKind = 'invalid' | 'not_found' | 'conflict';

export class ReaderError extends Error {
  override name = 'ReaderError';
  readonly kind: ReaderErrorKind;
  constructor(kind: ReaderErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

// The lines on each side of the named line.
export const EXCERPT_CONTEXT = 10;

const SERVICE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MAX_LINE = 1_000_000;

// A path inside the service: relative, with no step up and no NUL.
export function servicePath(path: string): string | undefined {
  if (path === '' || path.includes('\0') || path.includes('\\') || posix.isAbsolute(path)) return undefined;
  const normal = posix.normalize(path);
  return normal === '.' || normal === '..' || normal.startsWith('../') || normal.endsWith('/') ? undefined : normal;
}

export function parseTarget(text: string): AskTarget {
  const match = /^([^:]+):(.+):([0-9]+)$/.exec(text);
  const service = match?.[1] ?? '';
  const path = servicePath(match?.[2] ?? '');
  const line = Number(match?.[3]);
  if (!match || !SERVICE.test(service) || path === undefined || !Number.isInteger(line) || line < 1 || line > MAX_LINE)
    throw new ReaderError('invalid', 'a target is service:path:line, with a path inside the service and a line from 1');
  return { service, path, line };
}

// The named line and EXCERPT_CONTEXT lines on each side, each with its
// number, the named one marked with `>`.
export function excerpt(text: string, line: number): { readonly from: number; readonly to: number; readonly text: string } {
  const lines = text === '' ? [] : text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  if (line > lines.length) throw new ReaderError('invalid', `line ${line} is past the end of the file, which has ${lines.length} lines`);
  const from = Math.max(1, line - EXCERPT_CONTEXT);
  const to = Math.min(lines.length, line + EXCERPT_CONTEXT);
  const width = Math.max(4, String(to).length);
  const shown = lines.slice(from - 1, to).map((content, i) => `${from + i === line ? '>' : ' '}${String(from + i).padStart(width)}  ${content}`);
  return { from, to, text: shown.join('\n') };
}
