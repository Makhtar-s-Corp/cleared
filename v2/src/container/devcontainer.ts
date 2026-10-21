// Which image a session runs, from the project's
// `.devcontainer/devcontainer.json`. Milestone 1 reads two keys only:
// `image`, or `build.dockerfile` (with `build.context`, which the
// specification resolves the same way). Without the file, or without either
// key, the session runs Cleared's base image. Every other key (features,
// mounts, runArgs, lifecycle commands, ports) is reported as ignored and
// never applied: the rest of the devcontainer specification is out of scope.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const DEVCONTAINER_FILE = '.devcontainer/devcontainer.json';

export type ImageChoice =
  | { readonly kind: 'default'; readonly image: string; readonly ignored: readonly string[] }
  | { readonly kind: 'image'; readonly image: string; readonly ignored: readonly string[] }
  | { readonly kind: 'dockerfile'; readonly dockerfile: string; readonly context: string; readonly ignored: readonly string[] };

export class DevcontainerError extends Error {
  override name = 'DevcontainerError';
}

// Keys that are read, or that change nothing about the container.
const READ_KEYS = new Set(['image', 'build', 'name', '$schema']);
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[a-f0-9]{64})?$/;

// JSON with comments and trailing commas, as devcontainer.json allows.
export function parseJsonc(text: string): unknown {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1] ?? '';
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw new SyntaxError('unterminated comment');
      index = end + 2;
      out += ' ';
    } else if (char === ',') {
      // A comma followed only by blanks and comments, then a closing
      // bracket, is a trailing comma: dropped.
      let ahead = index + 1;
      let rest = '';
      while (ahead < text.length) {
        const c = text[ahead] ?? '';
        if (/\s/.test(c)) ahead += 1;
        else if (c === '/' && text[ahead + 1] === '/') { while (ahead < text.length && text[ahead] !== '\n') ahead += 1; }
        else if (c === '/' && text[ahead + 1] === '*') { const end = text.indexOf('*/', ahead + 2); ahead = end < 0 ? text.length : end + 2; }
        else { rest = c; break; }
      }
      if (rest !== '}' && rest !== ']') out += char;
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return JSON.parse(out);
}

// A path from the file, resolved from the devcontainer folder, that must stay
// inside the checkout once symbolic links are followed.
function inside(checkout: string, base: string, path: string, what: string): string {
  if (isAbsolute(path)) throw new DevcontainerError(`${DEVCONTAINER_FILE}: ${what} must be a relative path, got ${JSON.stringify(path)}`);
  const resolved = resolve(base, path);
  if (!existsSync(resolved)) throw new DevcontainerError(`${DEVCONTAINER_FILE}: ${what} ${JSON.stringify(path)} does not exist`);
  const real = realpathSync(resolved);
  const root = realpathSync(checkout);
  const rel = relative(root, real);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new DevcontainerError(`${DEVCONTAINER_FILE}: ${what} ${JSON.stringify(path)} leaves the checkout`);
  return resolved;
}

export function readDevcontainer(checkout: string, defaultImage: string): ImageChoice {
  const file = join(checkout, DEVCONTAINER_FILE);
  if (!existsSync(file)) return { kind: 'default', image: defaultImage, ignored: [] };
  let parsed: unknown;
  try {
    parsed = parseJsonc(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new DevcontainerError(`${DEVCONTAINER_FILE}: not valid JSON with comments (${(error as Error).message})`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new DevcontainerError(`${DEVCONTAINER_FILE}: expected an object`);
  const config = parsed as Record<string, unknown>;
  const ignored = Object.keys(config).filter((key) => !READ_KEYS.has(key)).sort();
  const { image, build } = config;
  if (image !== undefined && build !== undefined) throw new DevcontainerError(`${DEVCONTAINER_FILE}: give either image or build, not both`);
  if (image !== undefined) {
    if (typeof image !== 'string' || !IMAGE.test(image)) throw new DevcontainerError(`${DEVCONTAINER_FILE}: image must be an image reference, got ${JSON.stringify(image)}`);
    return { kind: 'image', image, ignored };
  }
  if (build !== undefined) {
    if (typeof build !== 'object' || build === null) throw new DevcontainerError(`${DEVCONTAINER_FILE}: build must be an object`);
    const { dockerfile, context = '.' } = build as Record<string, unknown>;
    if (typeof dockerfile !== 'string' || !dockerfile) throw new DevcontainerError(`${DEVCONTAINER_FILE}: build.dockerfile is required`);
    if (typeof context !== 'string') throw new DevcontainerError(`${DEVCONTAINER_FILE}: build.context must be a string`);
    const folder = dirname(file);
    return { kind: 'dockerfile', dockerfile: inside(checkout, folder, dockerfile, 'build.dockerfile'), context: inside(checkout, folder, context, 'build.context'), ignored };
  }
  return { kind: 'default', image: defaultImage, ignored };
}
