// The app's words for the proof scripts, read from its catalogs in both
// languages (lane 38): the app is French by default since lane 35, a proof
// instance may run in English, and a run matches either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { said } from '../../scripts/proof-words.ts';

test('a sentence of the catalogs matches in English and in French, its placeholders as given or as anything', () => {
  const verdict = said('session', 'verdict_ok', { round: 2 });
  assert.ok(verdict.test('Review passed, round 2'));
  assert.ok(verdict.test('Relecture validée, tour 2'));
  assert.ok(!verdict.test('Review passed, round 1'), 'the round given');
  assert.ok(!verdict.test('Relecture\u00a0: des changements demandés, tour 2'));
  const allowed = said('session', 'answer_allow_once');
  assert.ok(allowed.test('Allowed once by owner'));
  assert.ok(allowed.test('Autorisé une fois par owner'));
  assert.ok(said('inbox', 'undo').test('Annuler'));
});

test('several keys make one alternative, and the words are taken as written, not as patterns', () => {
  const verdict = said('session', ['verdict_ok', 'verdict_changes']);
  assert.ok(verdict.test('Review asked for changes, round 1'));
  assert.ok(verdict.test('Relecture\u00a0: des changements demandés, tour 3'));
  assert.ok(!said('session', 'verdict_ok').test('Review passedX round 2'.replace('X', '')), 'the comma is a comma');
  assert.throws(() => said('session', 'no_such_key'), /no_such_key/);
});

test('a space matches a space, a no-break space or a narrow one, either way round (French spacing, lane 37; review of 256)', () => {
  const verdict = said('session', 'verdict_changes', { round: 3 });
  for (const space of [' ', '\u00a0', '\u202f']) assert.ok(verdict.test(`Relecture${space}: des changements demandés, tour 3`), JSON.stringify(space));
  assert.ok(said('session', 'answer_allow_once').test('Allowed\u00a0once by owner'));
});
