// D11: Node for the whole core, no bash (the owner's decision of 2026-10-21).
// "Bash" is what docs/v2/keep-and-drop.md calls it: a file that starts with
// a bash shebang. v2/ tracks none and writes none, its tests included, and
// its core (the service, the app's server, the scripts, the images) starts
// no shell on the host. What runs inside a session's container is the
// project's image, not the core: the launchers, the terminal's wrapper and
// the doctor's probes keep their `sh -c`, and the human's shell is bash
// (docs/v2/decisions-log-milestone-3.md, 2026-10-25). v1's scripts go in
// milestone 4.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const v2 = new URL('..', import.meta.url).pathname;
const tracked = execFileSync('git', ['-C', v2, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean);
const text = (file: string): string | null => {
  const bytes = readFileSync(join(v2, file));
  return bytes.subarray(0, 8000).includes(0) ? null : bytes.toString('utf8');
};
const SOURCE = /\.(ts|tsx)$/;
const TESTS = /(^|\/)(test|fixtures)\//;
const core = tracked.filter((file) => SOURCE.test(file) && !TESTS.test(file));

// Built from pieces so that this file does not match itself.
const SHEBANG = '#' + '!';
const BASH_SHEBANG = new RegExp(`${SHEBANG}\\s*(?:/usr/bin/env\\s+(?:-S\\s+)?|/(?:usr/)?(?:local/)?bin/)bash\\b`);
const SHELL_SHEBANG = new RegExp(`^${SHEBANG}\\s*(?:/usr/bin/env\\s+(?:-S\\s+)?|/(?:usr/)?(?:local/)?bin/)(?:ba|da|z|k)?sh\\b`);
const SHELL_PROGRAM = String.raw`(['"\x60])(?:/(?:usr/)?bin/)?(?:ba|da|z|k)?sh\1`;

test('v2/ tracks no shell script', () => {
  assert.deepEqual(tracked.filter((file) => /\.(sh|bash|zsh)$/.test(file)), []);
  assert.deepEqual(tracked.filter((file) => SHELL_SHEBANG.test(text(file) ?? '')), []);
});

test('nothing in v2/, its tests included, writes a bash script or runs bash on the host', () => {
  const bashCall = new RegExp(String.raw`\(\s*(['"\x60])(?:/(?:usr/)?bin/)?bash\1\s*,`);
  const found = tracked.filter((file) => file !== 'package-lock.json' && !file.endsWith('no-bash.test.ts')).filter((file) => {
    const content = text(file);
    return content !== null && (BASH_SHEBANG.test(content) || (SOURCE.test(file) && bashCall.test(content)));
  });
  assert.deepEqual(found, []);
});

test('the core starts no shell on the host and writes no shell script', () => {
  const rules: ReadonlyArray<readonly [string, RegExp]> = [
    // A program given as the first argument of a call: spawn('sh', [...]),
    // execFileSync('/bin/sh', [...]), a promisified run('bash', [...]). A
    // command for a container is an array, ['sh', '-c', ...], not a call.
    ['a shell as the program of a call', new RegExp(String.raw`\(\s*${SHELL_PROGRAM}\s*,`)],
    ['a command run through a shell', /\bshell:\s*(?:true|['"`])/],
    ['exec or execSync, which run a shell', /import\s*\{[^}]*\b(?:exec|execSync)\b[^}]*\}\s*from\s*['"]node:child_process['"]/],
    ['a shell given to a child as $SHELL', /\bSHELL:\s*['"`]/],
    ['a shell script written', new RegExp(`['"\`]${SHEBANG}\\s*(?:/usr/bin/env\\s+|/(?:usr/)?bin/)(?:ba|da|z|k)?sh\\b`)],
  ];
  // util-linux's `script` gives the web terminal's docker client the terminal
  // `docker exec --tty` needs. It runs its command with $SHELL -c, always, and
  // Node has no terminal of its own to give instead: sh, not bash, here only.
  const allowed = new Map([['src/container/docker.ts', ['a shell given to a child as $SHELL']]]);
  const found = core.flatMap((file) => {
    const content = readFileSync(join(v2, file), 'utf8');
    return rules.filter(([name, rule]) => rule.test(content) && !allowed.get(file)?.includes(name)).map(([name]) => `${file}: ${name}`);
  });
  assert.deepEqual(found, []);
});
