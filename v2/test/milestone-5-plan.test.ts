// Milestone 5's plan and the matrix (issue #404): C5 is done with its proof,
// and docs/v2/milestone-5-plan.md splits every milestone 5 line of the matrix
// into lanes, at most three a wave, each lane with its own section. What a
// lane later delivers changes a line's status, never these checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../..', import.meta.url).pathname;
const v2 = join(root, 'v2');
const matrix = readFileSync(join(root, 'docs/v2/requirements-matrix.md'), 'utf8');
const planFile = join(root, 'docs/v2/milestone-5-plan.md');

type Row = { readonly id: string; readonly milestone: string; readonly deliveredBy: string; readonly provenBy: string; readonly status: string };

const rows: readonly Row[] = matrix.split('\n')
  .filter((line) => /^\| [A-Z][0-9.]*[a-z]?[0-9]* \|/.test(line))
  .map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    return { id: cells[0]!, milestone: cells[2]!, deliveredBy: cells[3]!, provenBy: cells[4]!, status: cells[5]! };
  });

const row = (id: string): Row => {
  const found = rows.find((candidate) => candidate.id === id);
  assert.ok(found, `no line ${id} in the matrix`);
  return found;
};

test('C5, the project page kept up to date, is done by pull request 395, with its tests named and present', () => {
  const c5 = row('C5');
  assert.match(c5.status, /^done\b/);
  assert.match(c5.deliveredBy, /\b395\b/);
  const files = [...c5.provenBy.matchAll(/`(test\/[^`]+\.test\.ts)`/g)].map(([, file]) => file!);
  assert.ok(files.length > 0, 'C5 names no test file');
  for (const file of files) assert.ok(existsSync(join(v2, file)), `${file} does not exist`);
});

test('the milestone 5 plan exists', () => {
  assert.ok(existsSync(planFile), 'docs/v2/milestone-5-plan.md does not exist');
});

const plan = existsSync(planFile) ? readFileSync(planFile, 'utf8') : '';

test('every milestone 5 line of the matrix is named in the plan', () => {
  const lines = rows.filter((candidate) => /^5\b/.test(candidate.milestone)).map((candidate) => candidate.id);
  for (const id of ['D14', 'B6.5', 'B6.5p', 'C4', 'C15', 'C16', 'C18', 'M10']) assert.ok(lines.includes(id), `${id} is not a milestone 5 line`);
  for (const id of lines) assert.match(plan, new RegExp(`\\b${id.replace('.', '\\.')}\\b`), `${id} is not in the plan`);
});

test('each lane of the waves has its section, and no wave runs more than three lanes', () => {
  const section = plan.split(/^(?=## )/m).find((part) => /^## \d+\. Waves$/m.test(part)) ?? '';
  const waves = section.split('\n').filter((line) => /^\| \d+ \|/.test(line));
  assert.ok(waves.length > 0, 'the plan has no waves table');
  const sections = new Set([...plan.matchAll(/^## \d+\. .*\(`(v2-j5-[a-z0-9-]+)`/gm)].map(([, lane]) => lane!));
  for (const wave of waves) {
    const lanes = [...wave.split('|')[2]!.matchAll(/`(v2-j5-[a-z0-9-]+)`/g)].map(([, lane]) => lane!);
    assert.ok(lanes.length >= 1 && lanes.length <= 3, `${wave.trim()}: ${lanes.length} lanes`);
    for (const lane of lanes) assert.ok(sections.has(lane), `${lane} has no section of its own`);
  }
});

test('each lane says its files, its tests and proof, and what needs a real account or a fresh machine', () => {
  const lanes = plan.split(/^(?=## \d+\. .*\(`v2-j5-)/m).slice(1);
  assert.ok(lanes.length > 0, 'the plan has no lane section');
  for (const lane of lanes) {
    const name = /`(v2-j5-[a-z0-9-]+)`/.exec(lane)![1];
    for (const heading of ['What exists at the end, and how it is proven', 'Files this lane owns', 'Real accounts and machines', 'Out of scope']) {
      assert.match(lane, new RegExp(`^### \\d+\\.\\d+ ${heading}$`, 'm'), `${name} has no "${heading}"`);
    }
  }
});

test('the plan has no em dash', () => {
  assert.doesNotMatch(plan, /—/);
});
