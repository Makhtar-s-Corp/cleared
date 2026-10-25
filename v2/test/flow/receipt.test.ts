// The proof receipt at the top of a pull request Cleared opens (issue #326,
// matrix P210): the captures before and after with the video of the flow,
// the tests the reviewers ran with their result, and the cost in tokens and
// time, in dollars only when every session of the ticket reported a figure.
// It is built from structured fields only, in the project's language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RECEIPT_END, RECEIPT_START, RECEIPT_MESSAGES_DIR, proofLink, renderReceipt, withReceipt, type ReceiptData } from '../../src/flow/receipt.ts';

const LINK = 'https://cleared.example.invalid';

const full: ReceiptData = {
  ticket: 'DEMO-7',
  tests: [
    { round: 1, command: 'npm test', outcome: 'failed' },
    { round: 2, command: 'npm test', outcome: 'passed' },
  ],
  testsDeclared: true,
  tokens: 1_234_567,
  costUsd: 0.4,
  elapsedMs: 42 * 60_000 + 10_000,
  captures: [{ service: 'guestbook', before: 'before.png', after: 'after.png', video: 'flow.webm', videoMs: 20_400, missing: [] }],
  linkBase: LINK,
};

// The block's lines, without its markers.
const lines = (text: string) => text.split('\n').filter((line) => line !== RECEIPT_START && line !== RECEIPT_END);

test('the receipt in English: the captures linked, each test with its round and result, the tokens, the time and the dollars', () => {
  const text = renderReceipt(full, 'en');
  assert.ok(text.startsWith(`${RECEIPT_START}\n`), text);
  assert.ok(text.endsWith(`\n${RECEIPT_END}`), text);
  const body = lines(text).join('\n');
  assert.match(body, /^### Proof receipt$/m);
  const base = `${LINK}/api/service/tickets/DEMO-7/proof/guestbook`;
  assert.ok(body.includes(`[before](${base}/before.png)`), body);
  assert.ok(body.includes(`[after](${base}/after.png)`), body);
  assert.ok(body.includes(`[video of the flow (20s)](${base}/flow.webm)`), body);
  assert.match(body, /Round 1: `npm test` failed/);
  assert.match(body, /Round 2: `npm test` passed/);
  assert.match(body, /1,234,567 tokens/);
  assert.match(body, /\$0\.40 as the harness reported it \(API-equivalent\)/);
  assert.match(body, /42 min from the first session to this pull request/);
  assert.doesNotMatch(body, /€|EUR/);
});

test('the receipt in French: the same facts in the project\'s language, numbers and durations said the French way', () => {
  const body = lines(renderReceipt(full, 'fr')).join('\n');
  assert.match(body, /^### Reçu de preuve$/m);
  assert.ok(body.includes('[avant]('), body);
  assert.ok(body.includes('[après]('), body);
  assert.ok(body.includes('[vidéo du parcours (20 s)]('), body);
  assert.match(body, /Tour 1 : `npm test` a échoué/);
  assert.match(body, /Tour 2 : `npm test` a réussi/);
  assert.match(body, /1 234 567 jetons|1 234 567 jetons/);
  assert.match(body, /0,40 \$US/);
  assert.match(body, /42 min de la première session à cette pull request/);
});

test('no dollar amount without a real figure for every session; the tokens and the time stay', () => {
  for (const language of ['en', 'fr'] as const) {
    const body = renderReceipt({ ...full, costUsd: null }, language);
    assert.doesNotMatch(body, /\$|USD|€|EUR/, body);
    assert.match(body, language === 'en' ? /1,234,567 tokens/ : /jetons/);
  }
  // No token count either: said as not reported, never as zero.
  assert.match(renderReceipt({ ...full, costUsd: null, tokens: null }, 'en'), /Cost: tokens not reported by the harness/);
  assert.doesNotMatch(renderReceipt({ ...full, costUsd: null, tokens: null }, 'en'), /\b0 tokens/);
});

test('a capture not taken says why, by its code; with no link address the files are said to be kept by Cleared', () => {
  const missing = renderReceipt({
    ...full,
    captures: [
      { service: 'guestbook', after: 'after.png', video: 'flow.webm', videoMs: 19_000, missing: [{ part: 'before', reason: 'no_before' }] },
      { service: 'filter-api', missing: [{ part: 'after', reason: 'no_after' }, { part: 'video', reason: 'no_after' }, { part: 'before', reason: 'failed' }] },
    ],
  }, 'en');
  assert.match(missing, /guestbook.*before: not taken \(the service declares no address of what its base runs\)/);
  assert.match(missing, /filter-api.*after: not taken \(no trial environment was running\)/);
  assert.match(missing, /filter-api.*before: not taken \(the capture failed\)/);
  const none = renderReceipt({ ...full, captures: [] }, 'en');
  assert.match(none, /Captures: none taken/);
  const unlinked = renderReceipt({ ...full, linkBase: undefined }, 'en');
  assert.doesNotMatch(unlinked, /\]\(/);
  assert.match(unlinked, /before, after, video of the flow \(20s\): kept by Cleared, no link address is set/);
});

test('no declared test command, or one declared and never run: said, not left blank', () => {
  assert.match(renderReceipt({ ...full, tests: [], testsDeclared: false }, 'en'), /Tests: the service declares no test command/);
  assert.match(renderReceipt({ ...full, tests: [{ round: 1, command: 'npm test', outcome: 'not_run' }] }, 'en'), /Round 1: `npm test` was not run/);
  assert.match(renderReceipt({ ...full, tests: [{ round: 1, command: 'npm test', outcome: 'unclear' }] }, 'fr'), /Tour 1 : `npm test` a tourné dans un tube ou une liste/);
});

test('the block holds only what its fields say: a command with a backtick cannot break out, a link base with a path or credentials is not used', () => {
  const body = renderReceipt({ ...full, tests: [{ round: 1, command: 'npm `test`', outcome: 'passed' }] }, 'en');
  assert.match(body, /`npm 'test'` passed/);
  assert.equal(proofLink(`https://${['user', 'pass'].join(':')}@cleared.example.invalid`, 'DEMO-7', 'guestbook', 'before.png'), undefined);
  assert.equal(proofLink('file:///home/someone', 'DEMO-7', 'guestbook', 'before.png'), undefined);
  assert.equal(proofLink('https://cleared.example.invalid/some/path/', 'DEMO-7', 'guestbook', 'before.png'), 'https://cleared.example.invalid/api/service/tickets/DEMO-7/proof/guestbook/before.png');
});

test('the block goes first in a body, and replaces the one already there', () => {
  const block = renderReceipt(full, 'en');
  assert.equal(withReceipt('The report.', block), `${block}\n\nThe report.`);
  const again = renderReceipt({ ...full, tokens: 5 }, 'en');
  const replaced = withReceipt(withReceipt('The report.', block), again);
  assert.equal(replaced, `${again}\n\nThe report.`);
  assert.equal(replaced.split(RECEIPT_START).length, 2);
});

test('the receipt\'s catalogs: French has every English key, and no French sentence is the English one', () => {
  const read = (language: string) => JSON.parse(readFileSync(`${RECEIPT_MESSAGES_DIR}receipt.${language}.json`, 'utf8')) as Record<string, string>;
  const en = read('en');
  const fr = read('fr');
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) assert.notEqual(fr[key], en[key], key);
});
