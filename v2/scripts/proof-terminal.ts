// The lines step 11 of the multi-service proof types in the Shell of a
// session taken over (proof-j2-multi.ts), each typed once the one before has
// answered (lane v2-j2-takeover-real-harness). The real run of 2026-10-22
// typed `npm test` 1.5 s after `git status`: the tests' output scrolled "On
// branch" out of the 21-row terminal before the step looked for it, and the
// step failed. That run's `npm test` also failed at the import of pg: a
// fresh ticket checkout has no node_modules (the guestbook's devcontainer
// declares no install command, and the author had not run `npm ci` yet), so
// `npm ci` comes first. DATABASE_URL was set.
//
// A line has answered when the shell's prompt is back on the terminal's last
// row, and, for `git status`, when "On branch" is on the screen. Only `git
// status` must answer; `npm ci` and `npm test` are recorded: a red install
// or test is the author's work in progress, not the proof's.

export type ShellLine = {
  readonly line: string;
  readonly expect?: RegExp;       // on the screen once the line has answered
  readonly timeoutMs: number;
  readonly required: boolean;     // the step fails when it does not answer in time
};

export const SHELL_LINES: readonly ShellLine[] = [
  { line: 'git status', expect: /On branch /, timeoutMs: 30_000, required: true },
  { line: 'npm ci', timeoutMs: 5 * 60_000, required: false },
  { line: 'npm test', timeoutMs: 5 * 60_000, required: false },
];

// The terminal's rows, as the screen shows them, end with the shell's
// prompt: bash's `user@host:/workspace$ `, or the rehearsal's stand-in's.
// While a command runs, the last row is the typed line or its output.
export function atPrompt(rows: string): boolean {
  const last = rows.split('\n').map((row) => row.trimEnd()).filter((row) => row !== '').at(-1) ?? '';
  return /\$$/.test(last);
}

// The rehearsal's stand-in shell names itself in what it answers
// (proof-rehearsal-multi.ts shellAnswer).
const STAND_IN = /the rehearsal's stand-in shell/;

// What a line said, from the rows on the screen once it answered.
export function lineOutcome(line: string, rows: string): string {
  if (STAND_IN.test(rows) && rows.includes(`${line}: the rehearsal's stand-in shell`)) return 'not run by the rehearsal\'s stand-in shell';
  if (line === 'npm ci') {
    if (/added \d+ packages?|up to date/.test(rows)) return 'installed';
    return /npm error/.test(rows) ? 'failed' : 'answered';
  }
  if (line === 'npm test') {
    const pass = /ℹ pass (\d+)/.exec(rows)?.[1];
    const fail = /ℹ fail (\d+)/.exec(rows)?.[1];
    if (pass !== undefined && fail !== undefined) return `pass ${pass}, fail ${fail}`;
    return /✖/.test(rows) ? 'some tests failed (the summary scrolled out of the rows)' : 'no summary on the screen';
  }
  return 'answered';
}
