// The words of a rule, as the nightly pass compares two (issue #455): the
// same rule written with other case, accents, spaces, punctuation or
// markdown has the same words. Files and lines (`src/run.ts:12`), numbers
// and the small words of English and French are left out, so two
// reviewers who name the same defect in two files say the same thing.

// The share of their words two texts have in common, from which they are one rule.
export const SAME_RULE = 0.6;

const SMALL_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'are', 'was', 'has', 'had', 'have', 'but', 'not', 'its', 'this', 'that', 'with', 'from', 'when', 'then', 'than',
  'into', 'onto', 'which', 'who', 'what', 'where', 'there', 'their', 'they', 'them', 'these', 'those', 'can', 'does', 'did', 'will',
  'les', 'des', 'une', 'est', 'sont', 'dans', 'pour', 'par', 'sur', 'avec', 'pas', 'que', 'qui', 'quand', 'son', 'ses', 'aux', 'mais',
]);

const FILE_LINE = /\S+\.[a-z0-9]{1,6}:\d+(?:-\d+)?/gi;

// The text's words, each once, sorted.
export function words(text: string): string[] {
  const plain = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(FILE_LINE, ' ');
  return [...new Set(plain.split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !/\d/.test(word) && !SMALL_WORDS.has(word)))].sort();
}

export const fingerprint = (text: string): string => words(text).join(' ');

// The words two texts share, over the words either has: 1 for the same words, 0 for none in common.
export function likeness(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const other = new Set(b);
  const shared = a.filter((word) => other.has(word)).length;
  return shared / (a.length + b.length - shared);
}
