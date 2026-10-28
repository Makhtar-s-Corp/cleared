// The decisions log, split by milestone (lane `v2-j6-decisions-log-split`,
// issue #478). docs/v2/decisions-log.md is now a short index; the entries
// are in docs/v2/decisions-log-milestone-<N>.md, in order. Read in order,
// the files start with the old page byte for byte (its SHA-256 below, taken
// at `origin/v2` before the split), so no entry was edited, moved or
// reordered; later entries only add bytes at the end of the last file.
// Every relative link and anchor of the index and the files resolves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const docs = join(root, 'docs/v2');
const indexFile = join(docs, 'decisions-log.md');
const index = readFileSync(indexFile, 'utf8');

// The old page at `origin/v2` 9e32fb8 (pull request 470), before the split.
const FROZEN_BYTES = 1496147;
const FROZEN_SHA256 = '05f06dbbea0b7e53bd3d0dc06e2e544421283a5cf9735c39ff3de1a57ebf4e57';

const FILE = /^decisions-log-milestone-(\d+)\.md$/;
const listed = [...new Set([...index.matchAll(/\]\((decisions-log-milestone-\d+\.md)\)/g)].map(([, file]) => file!))];
const milestone = (file: string): number => Number(FILE.exec(file)![1]);
const files = [...listed].sort((a, b) => milestone(a) - milestone(b));

test('the index lists one file per milestone, from 1 with no gap, and every such file on disk', () => {
  assert.ok(files.length > 0, 'the index lists no milestone file');
  assert.deepEqual(files.map(milestone), files.map((_, at) => at + 1));
  const onDisk = readdirSync(docs).filter((file) => FILE.test(file)).sort((a, b) => milestone(a) - milestone(b));
  assert.deepEqual(onDisk, files);
});

test('the index holds no entry and sends new entries to the last milestone file', () => {
  assert.doesNotMatch(index, /^## \d{4}-\d{2}-\d{2}:/m, 'an entry was written in the index; it goes in the current milestone file');
  const first = /\*\*New entries go at the end of \[[^\]]+\]\(([^)]+)\)/.exec(index);
  assert.ok(first, 'the index does not say where new entries go');
  assert.equal(first[1], files.at(-1));
});

test('the files, read in order, start with the old page byte for byte', () => {
  const whole = Buffer.concat(files.map((file) => readFileSync(join(docs, file))));
  assert.ok(whole.length >= FROZEN_BYTES, `${whole.length} bytes, fewer than the old page's ${FROZEN_BYTES}`);
  assert.equal(createHash('sha256').update(whole.subarray(0, FROZEN_BYTES)).digest('hex'), FROZEN_SHA256);
});

test('each file after the first starts at an entry heading', () => {
  for (const file of files.slice(1)) assert.match(readFileSync(join(docs, file), 'utf8'), /^## \d{4}-\d{2}-\d{2}: /, file);
});

// GitHub's anchor for a heading: lower case, punctuation dropped (a code
// span's backticks, not its text), each space a hyphen, and -1, -2 after a
// repeated one.
const anchors = (markdown: string): Set<string> => {
  const seen = new Map<string, number>();
  const found = new Set<string>();
  for (const [, title] of withoutFences(markdown).matchAll(/^#{1,6} (.+?)#*$/gm)) {
    const slug = title!.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0;
    found.add(count === 0 ? slug : `${slug}-${count}`);
    seen.set(slug, count + 1);
  }
  return found;
};

// Fenced blocks and code spans are text, not links or headings.
const withoutFences = (markdown: string): string => markdown.replace(/^```[\s\S]*?^```/gm, '');
const withoutCode = (markdown: string): string => withoutFences(markdown).replace(/`[^`\n]*`/g, '');

const links = (markdown: string): string[] =>
  [...withoutCode(markdown).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(([, target]) => target!)
    .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target));

test('every relative link and anchor of the index and the milestone files resolves', () => {
  const broken: string[] = [];
  let checked = 0;
  for (const from of [indexFile, ...files.map((file) => join(docs, file))]) {
    const text = readFileSync(from, 'utf8');
    for (const target of links(text)) {
      checked++;
      const [path, anchor] = target.split('#', 2) as [string, string | undefined];
      const file = path === '' ? from : join(dirname(from), decodeURIComponent(path));
      if (!existsSync(file)) { broken.push(`${from.slice(root.length)}: ${target}`); continue; }
      if (anchor !== undefined && !(statSync(file).isFile() && anchors(readFileSync(file, 'utf8')).has(decodeURIComponent(anchor))))
        broken.push(`${from.slice(root.length)}: ${target} (no such heading)`);
    }
  }
  assert.ok(checked > 100, `only ${checked} links read`);
  assert.deepEqual(broken, []);
});
