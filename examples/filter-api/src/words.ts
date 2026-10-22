// The word list and the check: words.txt holds one word per line, and a
// text is not ok when it holds one of them as a whole word, whatever its case.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export type WordList = ReadonlySet<string>;

export const WORDS_PATH = fileURLToPath(new URL('../words.txt', import.meta.url));

// A word is a run of letters and digits, in any script.
const WORD = /^[\p{L}\p{N}]+$/u;
const SEPARATORS = /[^\p{L}\p{N}]+/u;

const fold = (text: string): string => text.normalize('NFC').toLowerCase();

// Blank lines and lines starting with # are left out; any other line must be
// one word, so a typo in the list fails the start instead of matching nothing.
export function parseWords(text: string): Set<string> {
  const list = new Set<string>();
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    if (!WORD.test(line)) throw new Error(`words.txt, line ${index + 1}: not one word of letters or digits: "${line}"`);
    list.add(fold(line));
  });
  return list;
}

export async function loadWords(path: string = WORDS_PATH): Promise<WordList> {
  return parseWords(await readFile(path, 'utf8'));
}

// The listed words the text holds, each once, in the order they first appear.
export function findWords(list: WordList, text: string): string[] {
  const found = new Set<string>();
  for (const word of fold(text).split(SEPARATORS)) if (list.has(word)) found.add(word);
  return [...found];
}
