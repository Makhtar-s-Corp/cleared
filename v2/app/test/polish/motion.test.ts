// The detector's findings on the rendered screens (Impeccable's audit, lane
// 38): a status dot does not pulse (an animation of box-shadow, off the
// motion rule of 2.2.6), the waiting plan has a ring and no glow, and
// paragraphs wrap without leaving one word on their last line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SHEET = readFileSync(new URL('../../web/styles/app.css', import.meta.url), 'utf8').replace(/\/\*[^]*?\*\//g, '');

test('every keyframe moves only opacity and transform; nothing pulses', () => {
  for (const [, name, body] of SHEET.matchAll(/@keyframes ([a-z-]+) \{([^]*?\})\s*\}/g)) {
    for (const [, property] of body!.matchAll(/([a-z-]+)\s*:/g)) assert.match(property!, /^(opacity|transform)$/, `@keyframes ${name}: ${property}`);
  }
  assert.doesNotMatch(SHEET, /animation:\s*pulse/);
});

test('what waits has a ring, not a glow, in both themes', () => {
  for (const [, value] of SHEET.matchAll(/--e-awaiting:\s*([^;]+);/g)) assert.equal(value!.trim(), '0 0 0 1.5px var(--awaiting)');
});

test('paragraphs and list items wrap pretty', () => {
  assert.match(SHEET, /p, li, dd \{ text-wrap: pretty; \}/);
});
