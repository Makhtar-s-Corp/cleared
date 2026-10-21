// The workflows run on pushes to the v2 branch as well as on pull requests (docs/v2/decisions-log.md, 2026-10-21).
// Before this change the v2 workflow only ran on pull requests to v2, and checks.yml only on pushes to main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORCH_HOME } from '../lib/conf.mjs';

// The `on:` block of a workflow: the lines from `on:` up to the next key at the top level of the file.
function triggers(file) {
  const lines = readFileSync(join(ORCH_HOME, '.github', 'workflows', file), 'utf8').split('\n');
  const start = lines.indexOf('on:');
  assert.notEqual(start, -1, `${file} has an on: block`);
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

// The branches listed under `push:` in an `on:` block, or null when there is no push trigger.
function pushBranches(block) {
  const at = block.findIndex((line) => /^ {2}push:/.test(line));
  if (at === -1) return null;
  const branches = block.slice(at + 1).find((line) => /^ {4}branches:/.test(line));
  assert.notEqual(branches, undefined, 'push lists its branches');
  return branches.replace(/^ {4}branches:\s*\[/, '').replace(/\]\s*$/, '').split(',').map((name) => name.trim());
}

test('v2 workflow runs on pushes to v2 and on pull requests to v2', () => {
  const block = triggers('v2.yml');
  assert.deepEqual(pushBranches(block), ['v2']);
  assert.ok(block.some((line) => /^ {2}pull_request:/.test(line)), 'pull_request trigger kept');
  assert.ok(block.some((line) => /^ {4}branches: \[v2\]/.test(line)), 'pull_request still limited to v2');
});

test('checks workflow runs on pushes to main and to v2, and on every pull request', () => {
  const block = triggers('checks.yml');
  assert.deepEqual(pushBranches(block), ['main', 'v2']);
  assert.ok(block.some((line) => /^ {2}pull_request:/.test(line)), 'pull_request trigger kept');
});
