// The workflows run on pushes to the v2 branch as well as on pull requests (docs/v2/decisions-log-milestone-1.md, 2026-10-21).
// Before this change the v2 workflow only ran on pull requests to v2, and checks.yml only on pushes to main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.ts';

// The branches listed under `branches:` inside one trigger (`pull_request`, `push`), or null when it is absent.
function blockBranches(block: string[], trigger: string) {
  const at = block.findIndex((line) => line === `  ${trigger}:`);
  if (at === -1) return null;
  const rest = block.slice(at + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  const own = end === -1 ? rest : rest.slice(0, end);
  const branches = own.find((line) => /^ {4}branches:/.test(line));
  return branches === undefined ? null : branches.replace(/^ {4}branches:\s*\[/, '').replace(/\]\s*$/, '').split(',').map((name) => name.trim());
}

// The `on:` block of a workflow: the lines from `on:` up to the next key at the top level of the file.
function triggers(file: string) {
  const lines = readFileSync(join(ORCH_HOME, '.github', 'workflows', file), 'utf8').split('\n');
  const start = lines.indexOf('on:');
  assert.notEqual(start, -1, `${file} has an on: block`);
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

// The branches listed under `push:` in an `on:` block, or null when there is no push trigger.
function pushBranches(block: string[]) {
  const at = block.findIndex((line) => /^ {2}push:/.test(line));
  if (at === -1) return null;
  const branches = block.slice(at + 1).find((line) => /^ {4}branches:/.test(line));
  assert.notEqual(branches, undefined, 'push lists its branches');
  return branches!.replace(/^ {4}branches:\s*\[/, '').replace(/\]\s*$/, '').split(',').map((name) => name.trim());
}

test('v2 workflow runs on pushes to v2 and on pull requests to v2', () => {
  const block = triggers('v2.yml');
  assert.deepEqual(pushBranches(block), ['v2']);
  assert.deepEqual(blockBranches(block, 'pull_request'), ['v2']);
});

test('checks workflow runs on pushes to main and to v2, and on every pull request', () => {
  const block = triggers('checks.yml');
  assert.deepEqual(pushBranches(block), ['main', 'v2']);
  assert.ok(block.some((line) => /^ {2}pull_request:/.test(line)), 'pull_request trigger kept');
});

test('v2 guard step has a base on every event, and the checkout keeps the history a push base needs', () => {
  const workflow = readFileSync(join(ORCH_HOME, '.github', 'workflows', 'v2.yml'), 'utf8');
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /github\.event\.before != '0{40}'/);
  assert.match(workflow, /\|\| 'HEAD~1'/);
});

// The guard step checks the lines a change brings since a base. On a push there is no base_ref (GitHub sets it on
// pull requests only), so the push base is the commit before the push. An empty base made `origin/` the range.
test('v2 guard step takes its base from the event: the pull request base, or the commit before a push', () => {
  const workflow = readFileSync(join(ORCH_HOME, '.github', 'workflows', 'v2.yml'), 'utf8');
  assert.match(workflow, /github\.event_name == 'pull_request' && format/);
  assert.match(workflow, /github\.event\.before/);
  assert.match(workflow, /format\('origin\/\{0\}', github\.base_ref\)/);
  assert.match(workflow, /npm run guard -- --base "\$GUARD_BASE"/);
});
