// The proof receipt says in one line, in the project's language, why a
// service has captures or none (issue #368, matrix P226): "No screen
// changed", the screens the change touches, or the human's choice on the
// ticket. A receipt journaled before the rule existed reads as it did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RECEIPT_END, RECEIPT_START, renderReceipt, type ReceiptCapture, type ReceiptData } from '../../src/flow/receipt.ts';

const LINK = 'https://cleared.example.invalid';
const TAKEN = { before: 'before.png', after: 'after.png', video: 'flow.webm', videoMs: 20_400, missing: [] } as const;

const data = (captures: readonly ReceiptCapture[]): ReceiptData => ({
  ticket: 'DEMO-7', tests: [], testsDeclared: false, tokens: 1200, costUsd: null, elapsedMs: 60_000, captures, linkBase: LINK,
});
// The captures' line of the one service.
const line = (captures: readonly ReceiptCapture[], language: 'en' | 'fr') => {
  const lines = renderReceipt(data(captures), language).split('\n').filter((l) => l !== RECEIPT_START && l !== RECEIPT_END && /^- Captures/.test(l));
  assert.equal(lines.length, 1, 'one line a service');
  return lines[0] as string;
};

test('no screen changed: no capture, and the reason, in English and in French', () => {
  const skipped: ReceiptCapture = { service: 'guestbook', missing: [], need: { take: false, reason: 'no_screen', screens: [] } };
  assert.equal(line([skipped], 'en'), '- Captures of guestbook: none. No screen changed');
  assert.equal(line([skipped], 'fr'), '- Captures de guestbook : aucune. Aucun écran modifié');
  assert.doesNotMatch(renderReceipt(data([skipped]), 'en'), /not taken|none taken/);
});

test('the screens a change touches follow the captures\' links', () => {
  const taken: ReceiptCapture = { service: 'guestbook', ...TAKEN, need: { take: true, reason: 'screens', screens: ['inbox', 'session'] } };
  const en = line([taken], 'en');
  assert.ok(en.startsWith(`- Captures of guestbook: [before](${LINK}/api/service/tickets/DEMO-7/proof/guestbook/before.png)`), en);
  assert.ok(en.endsWith('(20s)](https://cleared.example.invalid/api/service/tickets/DEMO-7/proof/guestbook/flow.webm). Screens changed: inbox, session'), en);
  assert.ok(line([taken], 'fr').endsWith('. Écrans modifiés : inbox, session'));
});

test('a long list of screens stays one line: five named, then how many more', () => {
  const screens = ['inbox', 'session', 'lead', 'tower', 'consumption', 'ask', 'app.css'];
  const taken: ReceiptCapture = { service: 'guestbook', ...TAKEN, need: { take: true, reason: 'screens', screens } };
  assert.ok(line([taken], 'en').endsWith('Screens changed: inbox, session, lead, tower, consumption and 2 more'));
  assert.ok(line([taken], 'fr').endsWith('Écrans modifiés : inbox, session, lead, tower, consumption et 2 autres'));
});

test('the human\'s choice on the ticket is the reason, both ways', () => {
  const on: ReceiptCapture = { service: 'guestbook', ...TAKEN, need: { take: true, reason: 'forced_on', screens: [] } };
  const off: ReceiptCapture = { service: 'guestbook', missing: [], need: { take: false, reason: 'forced_off', screens: ['inbox'] } };
  assert.ok(line([on], 'en').endsWith('. Captures turned on from the ticket'));
  assert.ok(line([on], 'fr').endsWith('. Captures activées depuis le ticket'));
  assert.equal(line([off], 'en'), '- Captures of guestbook: none. Captures turned off from the ticket');
  assert.equal(line([off], 'fr'), '- Captures de guestbook : aucune. Captures désactivées depuis le ticket');
});

test('a change that could not be read is captured, and the receipt says why', () => {
  const unread: ReceiptCapture = { service: 'guestbook', ...TAKEN, need: { take: true, reason: 'unread', screens: [] } };
  assert.ok(line([unread], 'en').endsWith('. The change could not be read, so the captures were taken'));
  assert.ok(line([unread], 'fr').endsWith(". Le changement n'a pas pu être lu, les captures ont donc été prises"));
});

test('each service of a ticket of several says its own reason', () => {
  const text = renderReceipt(data([
    { service: 'guestbook', ...TAKEN, need: { take: true, reason: 'screens', screens: ['page.ts'] } },
    { service: 'filter-api', missing: [], need: { take: false, reason: 'no_screen', screens: [] } },
  ]), 'en');
  assert.match(text, /^- Captures of guestbook: .*\. Screens changed: page\.ts$/m);
  assert.match(text, /^- Captures of filter-api: none\. No screen changed$/m);
});

test('a capture journaled before the rule reads as it did', () => {
  assert.equal(line([{ service: 'guestbook', missing: [{ part: 'before', reason: 'no_before' }] }], 'en'),
    '- Captures of guestbook: before: not taken (the service declares no address of what its base runs)');
});
