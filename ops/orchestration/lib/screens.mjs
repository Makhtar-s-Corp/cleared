// The screen tests and captures running on this host, read from the process
// table. A process counts by what it is (its program and one whole argument),
// never by a word found somewhere in a command line: a prompt, an editor or
// a search that only names a screen test is not one. The command that starts
// a screen test counts before it has opened any browser.
//
//   screens.mjs [<proc dir>]      how many such processes are running
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNERS = new Set(['node', 'npm', 'npx']);
const STARTS_ONE = [
  /(^|\/)scripts\/(run-ui-tests|capture-[a-z-]+|ui-shots)\.mjs$/,
  /^(test:ui(:run)?|capture:[a-z]+)$/,
  /(^|\/)(playwright|playwright\/cli\.js|@playwright\/test\/cli\.js)$/,
];
const BROWSERS = new Set(['chrome-headless-shell', 'headless_shell']);

// processes: one list of arguments per process. npm renames its own process
// in one piece (« npm run test:ui »): a single argument is read word by word.
export function screenProcesses(processes) {
  return processes.filter((given) => {
    const argv = given.length === 1 ? given[0].trim().split(/\s+/) : given;
    const program = basename(argv[0] ?? '');
    if (BROWSERS.has(program)) return true;
    return RUNNERS.has(program) && argv.slice(1).some((argument) => STARTS_ONE.some((pattern) => pattern.test(argument)));
  });
}

export function readProcesses(dir = '/proc') {
  const processes = [];
  for (const name of readdirSync(dir)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = readFileSync(join(dir, name, 'cmdline'), 'utf8').split('\0');
      while (argv.length && argv.at(-1) === '') argv.pop();
      if (argv.length) processes.push(argv);
    } catch { /* gone since it was listed, or not a process */ }
  }
  return processes;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(screenProcesses(readProcesses(process.argv[2])).length);
