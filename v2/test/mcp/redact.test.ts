import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TEXT_LIMIT, createRedactor, cutStrings } from '../../src/mcp/redact.ts';
import { testValuesOf } from '../../src/secrets/live.ts';
import { ENV, ENV_NAME, SECRETS } from './support.ts';

const redactor = createRedactor({ env: ENV, paths: ['/srv/state/shop'] });

test('every family of token and key is removed, whatever text holds it', () => {
  const cases: [string, string][] = [
    [SECRETS.anthropic, 'API key'],
    [SECRETS.github, 'GitHub token'],
    [SECRETS.githubFine, 'GitHub token'],
    [SECRETS.slack, 'Slack token'],
    [SECRETS.linear, 'Linear key'],
    [SECRETS.aws, 'AWS key'],
    [SECRETS.jwt, 'JSON web token'],
    [`Authorization: Bearer ${SECRETS.bearer}`, 'bearer token'],
    [SECRETS.privateKey, 'private key'],
    [SECRETS.envValue, 'secret'],
  ];
  for (const [secret, what] of cases) {
    const out = redactor.text(`before ${secret} after`);
    assert.ok(!out.includes(secret), `${what}: ${out}`);
    assert.match(out, new RegExp(`\\[removed: ${what}\\]`), `${what}: ${out}`);
    assert.match(out, /^before /, what);
  }
});

test('the value of an environment assignment is removed and its name kept, at the start of a line or inside one', () => {
  const name = ['GITHUB', 'TOKEN'].join('_');
  for (const line of [`export ${name}=${SECRETS.envToken}`, `run with ${name}=${SECRETS.envToken} npm test`, `${['DB', 'PASSWORD'].join('_')}: '${SECRETS.envToken}'`]) {
    const out = redactor.text(line);
    assert.ok(!out.includes(SECRETS.envToken), out);
  }
  assert.match(redactor.text(`run with ${name}=${SECRETS.envToken} npm test`), new RegExp(`${name}=\\[removed: environment value\\] npm test`));
});

test('the value of a variable of the server\'s own environment whose name says secret is removed wherever it appears', () => {
  assert.equal(ENV[ENV_NAME], SECRETS.envValue);
  assert.equal(redactor.text(`echo ${SECRETS.envValue}|base64`), 'echo [removed: secret]|base64');
});

test('the service\'s folders are removed, ordinary words, ids and dates are kept', () => {
  assert.equal(redactor.text('read /srv/state/shop/ledger.db'), 'read [removed: service path]/ledger.db');
  const plain = 'The basket total rounds to the cent; LOCAL-7 at 2026-10-20T09:00:00.000Z, session 11111111-1111-4111-8111-111111111111';
  assert.equal(redactor.text(plain), plain);
});

test('a deep value is cleaned string by string, an id of the generated shape kept whole, rawEvent dropped', () => {
  const out = redactor.value({
    type: 'TOOL_CALL_RESULT', toolCallId: 'toolu_01BBBBBBBBBB', messageId: 'msg_01CCCCCCCCCC', rawEvent: { leaked: SECRETS.github },
    content: `token ${SECRETS.github}`, list: [SECRETS.aws, 3, true, null], nested: { requestId: SECRETS.slack },
  }) as Record<string, unknown>;
  assert.equal(out.toolCallId, 'toolu_01BBBBBBBBBB');
  assert.equal(out.messageId, 'msg_01CCCCCCCCCC');
  assert.equal(out.rawEvent, undefined);
  assert.equal(out.content, 'token [removed: GitHub token]');
  assert.deepEqual(out.list, ['[removed: AWS key]', 3, true, null]);
  assert.deepEqual(out.nested, { requestId: '[removed: Slack token]' }, 'an id that is not of the generated shape is cleaned as text');
  assert.ok(!JSON.stringify(out).includes(SECRETS.github));
});

test('a long string is cut after it is cleaned, so a secret cut in half is never shown', () => {
  const long = 'a'.repeat(TEXT_LIMIT - 10) + ' ' + SECRETS.github + ' ' + 'b'.repeat(500);
  const out = redactor.text(long);
  assert.ok(!out.includes(SECRETS.github.slice(0, 6)), 'no part of the secret');
  assert.ok(out.includes(' [removed'), 'the marker, cut, where the secret was');
  assert.ok(Array.from(out).length <= TEXT_LIMIT + 40);
  assert.match(out, /\[cut: \d+ characters\]$/);
  assert.equal(redactor.text('short'), 'short');
  const whole = redactor.whole({ delta: long }) as { delta: string };
  assert.equal(whole.delta.length, long.length - SECRETS.github.length + '[removed: GitHub token]'.length, 'whole cleans and does not cut: what a search reads');
  assert.match((cutStrings(whole, 50) as { delta: string }).delta, /^a{50} \[cut: \d+ characters\]$/);
});

test('a token glued to other letters is still a token; a word that only looks like a key\'s start is kept', () => {
  for (const [secret, what] of [[SECRETS.github, 'GitHub token'], [SECRETS.slack, 'Slack token'], [SECRETS.linear, 'Linear key'], [SECRETS.aws, 'AWS key'], [SECRETS.jwt, 'JSON web token']] as const) {
    const out = redactor.text(`prefix${secret}suffix`);
    assert.ok(!out.includes(secret.slice(4, 16)), what);
    assert.match(out, new RegExp(`\\[removed: ${what}\\]`), what);
  }
  const words = 'task-management-system-overview and the risk-assessment-for-the-quarter';
  assert.equal(redactor.text(words), words);
});

test('changes says whether cleaning would change a text: a search term shaped like a secret', () => {
  assert.equal(redactor.changes(SECRETS.github), true);
  assert.equal(redactor.changes(SECRETS.anthropic.slice(0, 30)), true);
  assert.equal(redactor.changes('basket total'), false);
});

// The test secrets (C16): set while the service runs, after the redactor is
// made, and removed from the lanes' answers all the same.
test('a test secret set after the redactor is made is removed from what it answers', () => {
  const made = createRedactor({ env: ENV, paths: [] });
  const value = ['sandbox', 'fake', 'value', 'mcp'].join('-');
  testValuesOf(new DatabaseSync(':memory:'), { CLEARED_V2_STATE_DIR: mkdtempSync(join(tmpdir(), 'cleared-redact-')) }).set('guestbook', 'PAYMENT_SANDBOX_KEY', value, 'u1');
  assert.equal(made.text(`ran with ${value}`), 'ran with [removed: secret]');
});
