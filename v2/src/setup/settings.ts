// The settings file the setup assistant writes (docs/v2/milestone-5-plan.md,
// decision 6): <state>/settings.conf, mode 600, in the format of agents.conf.
// Cleared's settings are environment variables (CLEARED_*), so the file
// holds variables too, in two sections:
//
//   [env]          CLEARED_V2_OWNER_ID = alex
//   [env_files]    GH_TOKEN = /state/forge-github.token
//
// [env] gives a variable its value; [env_files] gives it the content of a
// file, one line, so that a credential lives in a file of its own (mode 600,
// written by writeCredential) and never in this one. The service and the app
// apply it at start (load.ts), under the environment: a variable that is set
// wins, so an install made by hand keeps working.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LedgerPathError, ledgerPath } from '../store/db.ts';
import { parseConf } from '../workspace/config.ts';

export const SETTINGS_FILE = 'settings.conf';

export type Settings = { readonly env: Readonly<Record<string, string>>; readonly files: Readonly<Record<string, string>> };

// The variables the file may set: Cleared's own, and GH_TOKEN, which gh
// reads for the forge. Never PATH, HOME or another program's.
const SETTING = /^(?:CLEARED_[A-Z0-9_]+|GH_TOKEN)$/;

export class SettingsError extends Error {
  override name = 'SettingsError';
}

// The state folder, as the approval service tells it (approval/service.ts,
// stateDirectory), without loading that module before the settings apply.
export const stateFolder = (env: NodeJS.ProcessEnv): string => env.CLEARED_STATE_DIR || env.ORCH_STATE_DIR || dirname(ledgerPath(env));

// The file, in the state folder the service and the app use; none when no
// state folder can be told (the service then stops on its own settings).
export function settingsPath(env: NodeJS.ProcessEnv): string | undefined {
  try {
    return join(stateFolder(env), SETTINGS_FILE);
  } catch (error) {
    if (error instanceof LedgerPathError) return undefined;
    throw error;
  }
}

export function readSettings(path: string): Settings {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return { env: {}, files: {} }; }
  const sections = parseConf(text);
  const kept = (section: Record<string, string> | undefined) => Object.fromEntries(Object.entries(section ?? {}).filter(([name]) => SETTING.test(name)));
  return { env: kept(sections.env), files: kept(sections.env_files) };
}

// Written beside its final name and renamed into place, mode 600: a crash
// leaves the old file whole, and a reader never sees half of the new one.
function writeWhole(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const part = `${path}.part`;
  rmSync(part, { force: true });
  try {
    const fd = openSync(part, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, text); } finally { closeSync(fd); }
    renameSync(part, path);
  } finally {
    rmSync(part, { force: true });
  }
}

const checkLine = (name: string, value: string): void => {
  if (!SETTING.test(name)) throw new SettingsError(`${name} is not a setting the assistant writes`);
  if (/[\r\n\0]/.test(value)) throw new SettingsError(`the value of ${name} must be one line`);
};

// Merges the change into the file: a value sets a line, null removes it.
export function writeSettings(path: string, change: { readonly env?: Readonly<Record<string, string | null>>; readonly files?: Readonly<Record<string, string | null>> }): void {
  const current = readSettings(path);
  const merge = (now: Readonly<Record<string, string>>, more: Readonly<Record<string, string | null>> = {}) => {
    const next: Record<string, string> = { ...now };
    for (const [name, value] of Object.entries(more)) {
      if (value === null) { delete next[name]; continue; }
      checkLine(name, value);
      next[name] = value.trim();
    }
    return next;
  };
  const env = merge(current.env, change.env);
  const files = merge(current.files, change.files);
  const lines = (section: Record<string, string>) => Object.keys(section).sort().map((name) => `${name} = ${section[name]}\n`).join('');
  writeWhole(path, `# Cleared's settings, written by the setup assistant. A variable set in the
# environment wins over a line here. [env] gives a variable its value;
# [env_files] gives it the content of a file, so no credential is in this file.

[env]
${lines(env)}
[env_files]
${lines(files)}`);
}

// A credential's file, one line, mode 600, replaced whole.
export function writeCredential(path: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed === '') throw new SettingsError('the value is empty');
  if (/[\r\n\0]/.test(trimmed)) throw new SettingsError('a credential is one line');
  writeWhole(path, `${trimmed}\n`);
}

// A credential's content, when its file is a regular file of this account
// that no one else can read; undefined otherwise.
export function readCredential(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return undefined; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return undefined;
    const value = readFileSync(fd, 'utf8').trim();
    return value === '' || /[\r\n\0]/.test(value) ? undefined : value;
  } finally {
    closeSync(fd);
  }
}

// Fills the variables the file sets and the environment does not. A name in
// `fromEnvironment` (what the environment set at start) is never replaced;
// by default, any variable already set is kept. A file setting whose file is
// a link, someone else's, readable by others or empty is refused. The answer
// names variables, never a value.
export function applySettings(env: NodeJS.ProcessEnv, path: string | undefined, options: { readonly fromEnvironment?: ReadonlySet<string> } = {}): { applied: string[]; refused: string[] } {
  const applied: string[] = [];
  const refused: string[] = [];
  if (!path) return { applied, refused };
  const settings = readSettings(path);
  const kept = (name: string) => options.fromEnvironment ? options.fromEnvironment.has(name) : env[name] !== undefined && env[name] !== '';
  for (const [name, value] of Object.entries(settings.env)) {
    if (kept(name)) continue;
    env[name] = value;
    applied.push(name);
  }
  for (const [name, file] of Object.entries(settings.files)) {
    if (kept(name)) continue;
    const value = readCredential(file);
    if (value === undefined) { refused.push(name); continue; }
    env[name] = value;
    applied.push(name);
  }
  return { applied, refused };
}
