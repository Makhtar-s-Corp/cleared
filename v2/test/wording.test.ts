// The words of every v2 catalog, the servers' as the app's (lane
// `j3-docs-slop`, matrix P221): app/test/shell/tokens.test.ts keeps the
// app's catalogs free of emoji, exclamation marks and em dashes; the chat's,
// the proof receipt's and the two MCP servers' are read here too. No filler,
// no dash used as a pause, and a duration is said through the app's
// formatter (app/web/lib/time.ts), never as milliseconds or a placeholder
// named in seconds (the formatter's own `{n} s` and the grace's countdown
// under a minute are its words, not a raw count).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const v2 = new URL('..', import.meta.url).pathname;

function catalogs(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === 'test') return [];
    if (statSync(path).isDirectory()) return catalogs(path);
    return /(^|\/)messages\/[^/]+\.(en|fr)\.json$/.test(path) ? [path] : [];
  });
}

const FILES = [...catalogs(join(v2, 'app')), ...catalogs(join(v2, 'src'))];

const RULES: readonly (readonly [RegExp, string])[] = [
  [/\p{Extended_Pictographic}/u, 'an emoji'],
  [/!/, 'an exclamation mark'],
  [/\u2014/, 'an em dash'],
  [/\S [\u2013-] /, 'a dash used as a pause'],
  [/\b(?:simply|seamless(?:ly)?|effortless(?:ly)?|easily|feel free|please note|note that|don't worry|oops|awesome)\b/i, 'a filler word'],
  [/\b(?:simplement|facilement|n'hésitez pas|n’hésitez pas|veuillez noter|pas de panique|oups|génial)\b/i, 'a filler word'],
  [/\}\s?(?:ms|millisecond|milliseconde)/, 'a count of milliseconds'],
  [/\{[a-z_]*(?:_?ms|seconds)\}/i, 'a placeholder in milliseconds or seconds'],
];

test('the servers\' catalogs are read with the app\'s', () => {
  const names = FILES.map((file) => relative(v2, file));
  for (const name of ['src/flow/messages/chat.fr.json', 'src/flow/messages/receipt.en.json', 'src/mcp/messages/lanes.fr.json', 'src/mcp/messages/ledger.en.json', 'app/messages/tower.en.json']) {
    assert.ok(names.includes(name), name);
  }
});

test('no emoji, exclamation mark, dash used as a pause, filler or raw duration in any v2 catalog', () => {
  for (const file of FILES) {
    const catalog = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [key, text] of Object.entries(catalog)) {
      if (typeof text !== 'string') continue;
      for (const [rule, what] of RULES) assert.doesNotMatch(text, rule, `${relative(v2, file)} ${key}: ${what}`);
    }
  }
});
