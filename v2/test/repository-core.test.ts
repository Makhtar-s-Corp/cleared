// B6.4p and B5.11b (issue #382): the rules that test/no-bash.test.ts and
// test/kept-javascript.test.ts hold for v2/, over the whole repository.
// The core is every tracked file outside examples/ (the projects Cleared is
// tried on) and docs/ (docs/v2/milestone-4-plan.md, decision 1). "Bash" is
// what keep-and-drop.md calls it: a file that starts with a bash shebang.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../', import.meta.url).pathname;
const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((file) => !/^(examples|docs)\//.test(file));
const text = (file: string): string | null => {
  const bytes = readFileSync(join(root, file));
  return bytes.subarray(0, 8000).includes(0) ? null : bytes.toString('utf8');
};

// Built from pieces so that this file does not match itself.
const SHEBANG = '#' + '!';
const BASH_SHEBANG = new RegExp(`${SHEBANG}\\s*(?:/usr/bin/env\\s+(?:-S\\s+)?|/(?:usr/)?(?:local/)?bin/)bash\\b`);
const SHELL_SHEBANG = new RegExp(`^${SHEBANG}\\s*(?:/usr/bin/env\\s+(?:-S\\s+)?|/(?:usr/)?(?:local/)?bin/)(?:ba|da|z|k)?sh\\b`);
const SHELL_PROGRAM = String.raw`(['"\x60])(?:/(?:usr/)?bin/)?(?:ba|da|z|k)?sh\1`;
const SOURCE = /\.(ts|tsx|m?js)$/;

test('the repository tracks no shell script outside examples/', () => {
  assert.deepEqual(tracked.filter((file) => /\.(sh|bash|zsh)$/.test(file)), []);
  assert.deepEqual(tracked.filter((file) => SHELL_SHEBANG.test(text(file) ?? '')), []);
});

test('nothing outside v2/ and examples/, its tests included, writes a bash script or runs bash on the host', () => {
  const bashCall = new RegExp(String.raw`\(\s*(['"\x60])(?:/(?:usr/)?bin/)?bash\1\s*,`);
  const found = tracked.filter((file) => !file.startsWith('v2/')).filter((file) => {
    const content = text(file);
    return content !== null && (BASH_SHEBANG.test(content) || (SOURCE.test(file) && bashCall.test(content)));
  });
  assert.deepEqual(found, []);
});

test('the core outside v2/ starts no shell on the host and writes no shell script', () => {
  const rules: ReadonlyArray<readonly [string, RegExp]> = [
    ['a shell as the program of a call', new RegExp(String.raw`\(\s*${SHELL_PROGRAM}\s*,`)],
    ['a command run through a shell', /\bshell:\s*(?:true|['"`])/],
    ['exec or execSync, which run a shell', /import\s*\{[^}]*\b(?:exec|execSync)\b[^}]*\}\s*from\s*['"]node:child_process['"]/],
    ['a shell script written', new RegExp(`['"\`]${SHEBANG}\\s*(?:/usr/bin/env\\s+|/(?:usr/)?bin/)(?:ba|da|z|k)?sh\\b`)],
  ];
  // The project's own health command ([release] health_command), a command
  // line the project writes in its settings: sh runs it, as v1 always did.
  const allowed = new Map([['lib/release.ts', ['a shell as the program of a call']]]);
  const core = tracked.filter((file) => !file.startsWith('v2/') && !/^test\//.test(file) && (SOURCE.test(file) || file === 'cleared'));
  const found = core.flatMap((file) => {
    const content = readFileSync(join(root, file), 'utf8');
    return rules.filter(([name, rule]) => rule.test(content) && !allowed.get(file)?.includes(name)).map(([name]) => `${file}: ${name}`);
  });
  assert.deepEqual(found, []);
});

test('no JavaScript is kept outside examples/ but what a browser loads by its address', () => {
  assert.deepEqual(tracked.filter((file) => /\.(m?js|cjs|jsx)$/.test(file)), [
    // v1's page scripts, loaded as they are, with no build step.
    'app/public/actions.js',
    'app/public/app.js',
    'app/public/login.js',
    'app/public/notify.js',
    'app/public/sw.js',
    'v2/app/public/sw.js',
    'v2/app/public/theme.js',
  ]);
});
