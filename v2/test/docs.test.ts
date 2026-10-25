// The v2 docs say where each feature is (lane `j3-docs-slop`, matrix P221):
// a developer reads v2/README.md first, then docs/adapters.md for the
// harnesses and docs/fast-lane.md for the fast lane. Each feature of
// milestone 3's ten ideas, the fast lane and the skills has its section
// there, naming the file that holds it; and a message that sends the reader
// to v2/README.md for a setting finds that setting there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const v2 = new URL('..', import.meta.url).pathname;
const root = join(v2, '..');
const readme = readFileSync(join(v2, 'README.md'), 'utf8');
const headings = new Set([...readme.matchAll(/^#{2,4} (.+)$/gm)].map(([, title]) => title!.trim()));

// The section, and a file of v2/ it must name, which must exist.
const FEATURES: readonly (readonly [string, string])[] = [
  ['The flow', 'src/flow/config.ts'],
  ['The proof receipt', 'src/flow/receipt.ts'],
  ['The cost of a ticket', 'src/consumption/ticket-cost.ts'],
  ['A ticket from a chat', 'src/flow/chat.ts'],
  ['The harness pick', 'src/flow/harness-pick.ts'],
  ['Ticket templates', 'src/tickets/templates.ts'],
  ['Code questions and their links', 'src/reader/citations.ts'],
  ["The lanes' MCP server", 'src/mcp/lanes.ts'],
  ['On a phone', 'app/web/screens/inbox/inbox.css'],
  ['After a release: the production page', 'src/flow/production.ts'],
  ['The prompt cache', 'scripts/prompt-cache.ts'],
  ['The fast lane', 'src/flow/fast-lane.ts'],
  ['Skills', 'images/session/runner/main.ts'],
];

const section = (title: string): string => {
  const start = readme.search(new RegExp(`^#{2,4} ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
  const rest = readme.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => /^#{2,4} /.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
};

test('v2/README.md has a section for each feature, naming the file that holds it', () => {
  for (const [title, file] of FEATURES) {
    assert.ok(headings.has(title), `no section "${title}" in v2/README.md`);
    assert.ok(existsSync(join(v2, file)), `${file} does not exist`);
    assert.ok(section(title).includes(`\`${file}\``), `"${title}" does not name \`${file}\``);
  }
});

test('a message that says "see X in v2/README.md" finds X there', () => {
  const tracked = execFileSync('git', ['-C', v2, 'ls-files'], { encoding: 'utf8' }).split('\n')
    .filter((file) => /\.(ts|tsx|json)$/.test(file) && !/(^|\/)(test|fixtures)\//.test(file) && file !== 'package-lock.json');
  const named = new Map<string, string>();
  for (const file of tracked) {
    for (const [, name] of readFileSync(join(v2, file), 'utf8').matchAll(/\b([A-Z][A-Z0-9_]{3,}) (?:in|dans) v2\/README\.md/g)) named.set(name!, file);
  }
  assert.ok(named.has('CLEARED_V2_PROJECT'), 'the flow\'s "not configured" message is still read');
  for (const [name, file] of named) assert.ok(readme.includes(`\`${name}\``), `${file} sends the reader to ${name} in v2/README.md, which does not name it`);
});

test('docs/fast-lane.md says what Cleared v2 does with the fast lane', () => {
  const page = readFileSync(join(root, 'docs/fast-lane.md'), 'utf8');
  assert.match(page, /^## In Cleared v2$/m);
  assert.ok(page.includes('`v2/src/flow/fast-lane.ts`'));
});

test('docs/adapters.md points to the harness pick and to the skills a session reads', () => {
  const page = readFileSync(join(root, 'docs/adapters.md'), 'utf8');
  assert.ok(page.includes('CLEARED_V2_PICK_HARNESSES'));
  assert.ok(page.includes("settingSources: ['user']"));
});

test('no em dash in the docs a developer reads first', () => {
  for (const file of ['README.md', 'v2/README.md', 'docs/adapters.md', 'docs/fast-lane.md', 'docs/configuration.md']) {
    assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), /\u2014/, file);
  }
});
