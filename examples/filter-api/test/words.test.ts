import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findWords, loadWords, parseWords, WORDS_PATH } from '../src/words.ts';

test('the list is one word per line; blank lines and # comments are left out; case is folded', () => {
  const list = parseWords('# a comment\nSpam\n\n  scam  \nspam\n');
  assert.deepEqual([...list], ['spam', 'scam']);
});

test('a line that is not one word of letters or digits is refused, with its line number', () => {
  assert.throws(() => parseWords('spam\ntwo words\n'), /line 2/);
  assert.throws(() => parseWords('spam\nwh@t\n'), /line 2/);
});

test('findWords gives the listed words found, each once, in the order of the text', () => {
  const list = parseWords('spam\nscam\ncasino\n');
  assert.deepEqual(findWords(list, 'A SCAM, some spam, more spam and a scam.'), ['scam', 'spam']);
  assert.deepEqual(findWords(list, 'Lovely guestbook, thank you!'), []);
  assert.deepEqual(findWords(list, ''), []);
});

test('only whole words match: a listed word inside another word is not found', () => {
  const list = parseWords('spam\n');
  assert.deepEqual(findWords(list, 'spammer antispam spam-free'), ['spam']);
  assert.deepEqual(findWords(list, 'spammer antispam'), []);
});

test('words in other scripts and with accents are words too', () => {
  const list = parseWords('arnaque\nescroquerie\n');
  assert.deepEqual(findWords(list, "C'est une ARNAQUE, une escroquerie."), ['arnaque', 'escroquerie']);
  assert.deepEqual(findWords(parseWords('été\n'), 'Un bel été.'), ['été']);
});

test('words.txt, the list the app serves, loads and is not empty', async () => {
  const list = await loadWords();
  assert.ok(list.size > 0);
  assert.deepEqual([...list], [...parseWords(readFileSync(WORDS_PATH, 'utf8'))]);
  assert.ok(list.has('spam'), 'the proof and the README use "spam" as the listed word');
});
