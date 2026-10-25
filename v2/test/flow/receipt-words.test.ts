// The proof receipt's words (lane j3-ui-polish, matrix P222): a receipt with
// no capture claims no cause it cannot know, and the figures' source is
// named as the ticket card names it, the agents, in both languages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReceipt, type ReceiptData } from '../../src/flow/receipt.ts';

const data: ReceiptData = {
  ticket: 'DEMO-7', tests: [], testsDeclared: false, tokens: 1_234_567, costUsd: 0.4, elapsedMs: 42 * 60_000, captures: [],
};

test('no capture: the receipt says none was taken, without guessing why', () => {
  assert.match(renderReceipt(data, 'en'), /^- Captures: none taken$/m);
  assert.match(renderReceipt(data, 'fr'), /^- Captures : aucune$/m);
});

test('the dollars and the missing tokens are the agents\' figures, as on the ticket card', () => {
  assert.match(renderReceipt(data, 'en'), /as the agents reported it \(API-equivalent\)/);
  assert.match(renderReceipt(data, 'fr'), /déclarés par les agents \(équivalent API\)/);
  assert.match(renderReceipt({ ...data, tokens: null, costUsd: null }, 'en'), /Cost: tokens not reported by the agents/);
  assert.match(renderReceipt({ ...data, tokens: null, costUsd: null }, 'fr'), /Coût : jetons non déclarés par les agents/);
  for (const language of ['en', 'fr'] as const) assert.doesNotMatch(renderReceipt({ ...data, tokens: null }, language), /harness|harnais/);
});
