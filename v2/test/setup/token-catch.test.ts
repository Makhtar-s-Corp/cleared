// The token taken out of the terminal's output (issue #490): wrapped, coloured,
// in pieces, and never passed on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOKEN_MASK, tokenCatch } from '../../src/setup/token-catch.ts';

// Built here, so no line of the repository holds a value shaped like a login.
const TOKEN = ['sk', 'ant', 'oat01', 'AbC_d3'.repeat(14)].join('-');

function run(chunks: readonly string[]): { shown: string; tokens: string[] } {
  const tokens: string[] = [];
  const caught = tokenCatch((token) => tokens.push(token));
  let shown = chunks.map((chunk) => caught.push(chunk)).join('');
  shown += caught.flush();
  return { shown, tokens };
}

test('a token on one line is taken and masked', () => {
  const { shown, tokens } = run([`Your token:\r\n\r\n${TOKEN}\r\n\r\nStore this token securely.\r\n`]);
  assert.deepEqual(tokens, [TOKEN]);
  assert.ok(!shown.includes(TOKEN.slice(0, 12)));
  assert.equal(shown, `Your token:\r\n\r\n${TOKEN_MASK}\r\n\r\nStore this token securely.\r\n`);
});

test('a token wrapped on two lines, each with its indent, is joined', () => {
  const { tokens, shown } = run([`  ${TOKEN.slice(0, 40)}\r\n  ${TOKEN.slice(40)}\r\n\r\nStore this.\r\n`]);
  assert.deepEqual(tokens, [TOKEN]);
  assert.ok(!shown.includes(TOKEN.slice(40)));
});

test('colours and a cut in any place change nothing', () => {
  const text = `\u001b[1m${TOKEN.slice(0, 30)}\u001b[0m\r\n\u001b[1m${TOKEN.slice(30)}\u001b[0m\r\n\r\nStore this.\r\n`;
  for (let cut = 1; cut < text.length; cut += 7) {
    const { tokens, shown } = run([text.slice(0, cut), text.slice(cut)]);
    assert.deepEqual(tokens, [TOKEN], `cut at ${cut}`);
    assert.ok(!shown.includes(TOKEN.slice(30, 50)) && !shown.includes(TOKEN.slice(0, 20)), `cut at ${cut}`);
  }
});

test('one character at a time, nothing of the token ever passes', () => {
  const tokens: string[] = [];
  const caught = tokenCatch((token) => tokens.push(token));
  let shown = '';
  for (const char of `ok\r\n${TOKEN}\r\n\r\nbye\r\n`) shown += caught.push(char);
  shown += caught.flush();
  assert.deepEqual(tokens, [TOKEN]);
  assert.ok(!shown.includes('sk-ant'), shown);
  assert.match(shown, /bye/);
});

test('a line of words after the token is not the token, even with no blank line', () => {
  const { tokens } = run([`${TOKEN}\r\nStore this token securely.\r\n`]);
  assert.deepEqual(tokens, [TOKEN]);
});

test('what is not a token passes untouched, an API key included, and nothing is held at the end', () => {
  const key = ['sk', 'ant', 'api03', 'z'.repeat(30)].join('-');
  const plain = `\u001b[32mhello\u001b[0m sk-\r\nsk-ant\r\n${key}\r\n`;
  const { tokens, shown } = run([plain]);
  assert.deepEqual(tokens, []);
  assert.equal(shown, plain);
});

test('a token printed twice, as a screen repaints it, is masked twice', () => {
  const { tokens, shown } = run([`${TOKEN}\r\n\r\n\u001b[2J${TOKEN}\r\n\r\n`]);
  assert.deepEqual(tokens, [TOKEN, TOKEN]);
  assert.equal(shown.split(TOKEN_MASK).length, 3);
});

// As Claude Code 2.1.306 draws it: spaces as moves to the right, lines ended by \r\r\n, a link around nothing here.
test('the screen of the real command: words drawn with moves, the token wrapped, a blank row after it', () => {
  const words = (text: string) => text.split(' ').join('\u001b[1C');
  const screen = [
    `\u001b[32m\u2713\u001b[1C${words('Long-lived authentication token created successfully!')}\u001b[39m\r\r\n\r\r\n`,
    `${words('Your OAuth token (valid for 1 year):')}\r\r\n\r\r\n`,
    `\u001b[33m${TOKEN.slice(0, 40)}\r\r\n${TOKEN.slice(40, 80)}\r\r\n${TOKEN.slice(80)}\u001b[39m\r\r\n\r\r\n`,
    `\u001b[2m${words('Store this token securely. You won\'t be able to see it again.')}\u001b[22m\r\r\n`,
  ].join('');
  const { tokens, shown } = run([screen]);
  assert.deepEqual(tokens, [TOKEN]);
  for (const piece of [TOKEN.slice(0, 40), TOKEN.slice(40, 80), TOKEN.slice(80)]) assert.ok(!shown.includes(piece));
  assert.match(shown, /Store/);
  const noBlank = run([`${TOKEN}\r\r\n\u001b[2m${words('Store this token')}\u001b[22m\r\r\n`]);
  assert.deepEqual(noBlank.tokens, [TOKEN], 'a line of words is not the token, even drawn with moves');
});
