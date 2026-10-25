#!/usr/bin/env node
// The one `cleared` command (docs/v2/milestone-5-plan.md, decision 8):
// `cleared <command> [arguments]` runs src/cli/<command>.ts with the
// arguments, and ends with its exit code; a lane adds a command by adding
// that file, and never edits this one. In the image it is on the PATH
// (images/cleared/Dockerfile); from a clone it is node v2/src/cli/cleared.ts.
// No command, or help, lists the commands; an unknown one also, on stderr,
// with exit 64. Words: messages/cleared.<language>.json, in
// CLEARED_V2_APP_LANGUAGE (French by default, as the app).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadCatalog, type Language } from '../../app/src/catalog.ts';
import { translator, type Translate } from '../../app/web/lib/i18n.ts';

export const CLI_DIR = new URL('.', import.meta.url).pathname;
export const CLI_MESSAGES_DIR = join(CLI_DIR, 'messages');

// A command's name: lower-case words joined by dashes, never this file's.
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const languageOf = (env: NodeJS.ProcessEnv): Language => (env.CLEARED_V2_APP_LANGUAGE?.trim() === 'en' ? 'en' : 'fr');

// The translator of a catalog of messages/, over the shell's units of time.
export function cliTranslator(catalog: string, language: Language): Translate {
  const read = (lang: Language) => JSON.parse(readFileSync(join(CLI_MESSAGES_DIR, `${catalog}.${lang}.json`), 'utf8')) as Record<string, string>;
  return translator({ ...loadCatalog('shell', language), ...read('en'), ...(language === 'en' ? {} : read(language)) });
}

export function commands(dir: string = CLI_DIR): string[] {
  return readdirSync(dir).filter((file) => file.endsWith('.ts')).map((file) => file.slice(0, -3)).filter((name) => name !== 'cleared' && NAME.test(name)).sort();
}

// The file a command runs, or none: a name of the folder's own files only,
// so no argument reaches a path above it.
export function commandFile(name: string, dir: string = CLI_DIR): string | undefined {
  if (name === 'cleared' || !NAME.test(name)) return undefined;
  const file = join(dir, `${name}.ts`);
  try { return statSync(file).isFile() ? file : undefined; } catch { return undefined; }
}

if (import.meta.main) {
  const t = cliTranslator('cleared', languageOf(process.env));
  // CLEARED_V2_CLI_DIR is for the tests, which add a command of their own.
  const dir = process.env.CLEARED_V2_CLI_DIR || CLI_DIR;
  const [name = 'help', ...args] = process.argv.slice(2);
  const usage = `${t('usage')}\n${t('usage_commands', { list: commands(dir).join(', ') })}\n`;
  const file = name === 'help' ? undefined : commandFile(name, dir);
  if (name === 'help') process.stdout.write(usage);
  else if (file === undefined) {
    process.stderr.write(`${t('unknown_command', { name })}\n${usage}`);
    process.exitCode = 64;
  } else {
    const run = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' });
    process.exitCode = run.status ?? 1;
  }
}
