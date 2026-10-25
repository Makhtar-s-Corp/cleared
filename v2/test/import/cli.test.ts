// The command (docs/v2/milestone-4-plan.md, section 3.2): a dry run by
// default, --apply to write, the service's own settings, French by default,
// English when the app is, and never a decision's text on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../workspace/git.ts';
import { OWNER, at, v1Ledger, v2Checkout } from './v1-fixture.ts';

const CLI = new URL('../../src/cli/import-v1.ts', import.meta.url).pathname;

function setup() {
  const v1 = v1Ledger([
    { id: 'LOCAL-1', labels: ['size:s'], runs: [{ started: at(0), ended: at(70), tokens: 12500 }], measures: [{ at: at(80), total: 75, lane: 'full', pr: 1, todo: at(0), done: at(75), humanWait: null }] },
    { id: 'LOCAL-2', measures: [{ at: at(9), unreadable: true }] },
  ]);
  const root = tempDir('cli');
  const state = join(root, 'state');
  const conf = join(root, 'agents.conf');
  writeFileSync(conf, `[tracker]\nowner_id = ${OWNER}\n[guard]\nterms = none\nallowed = none\n`);
  const checkout = v2Checkout(v1.checkout);
  const env = {
    PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    CLEARED_V2_PROJECT: 'shop', CLEARED_V2_PROJECT_DIR: checkout, CLEARED_V2_REPO: 'example-org/shop', CLEARED_V2_REPO_URL: 'https://example.invalid/shop.git',
    CLEARED_V2_STATE_DIR: state, CLEARED_STATE_DIR: state, CLEARED_CONF: conf,
  };
  const run = (args: string[], over: Record<string, string> = {}) => {
    const result = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { env: { ...env, ...over }, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.stderr };
  };
  return { v1, state, run };
}

test('a dry run in French by default: what it would import, why the rest is left out, nothing written', () => {
  const { v1, state, run } = setup();
  const { code, out } = run(['--from', v1.ledger]);
  assert.equal(code, 0);
  assert.match(out, /Essai à blanc pour l'espace de travail shop/);
  assert.match(out, /LOCAL-1\u00a0: taille s, circuit complet, 1\u00a0h\u00a015 de travail, 12[\u202f\u00a0]500 jetons/);
  assert.match(out, /LOCAL-2 est laissé de côté\u00a0: sa mesure est illisible\./);
  assert.match(out, /docs\/decisions\/0001-queue\.md, approuvée par owner le /);
  assert.ok(!out.includes('Orders are sent through the queue'), 'a decision\'s text is never printed');
  assert.equal(existsSync(join(state, 'ledger.db')), false);
});

test('--apply in English writes, and a second run has nothing new', () => {
  const { v1, state, run } = setup();
  const first = run(['--from', v1.ledger, '--apply'], { CLEARED_V2_APP_LANGUAGE: 'en' });
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /Import for the workspace shop\./);
  assert.match(first.out, /1 ticket joined the estimates' history:/);
  assert.match(first.out, /LOCAL-1: size s, full circuit, 1h\u00a015m of work, 12,500 tokens/);
  assert.match(first.out, /2 decisions are approved in v2, as in v1:/);
  assert.ok(existsSync(join(state, 'ledger.db')));
  const second = run(['--from', v1.ledger, '--apply'], { CLEARED_V2_APP_LANGUAGE: 'en' });
  assert.equal(second.code, 0, second.err);
  assert.match(second.out, /Nothing new to import\./);
  assert.match(second.out, /1 ticket was already imported\./);
});

test('a wrong command line, a missing ledger and v2\'s own ledger end with 64 and say why', () => {
  const { v1, state, run } = setup();
  assert.equal(run([]).code, 64);
  assert.match(run(['--apply']).err, /npm run import-v1 -- --from/);
  assert.equal(run(['--from', v1.ledger, '--force']).code, 64);
  const missing = run(['--from', join(state, 'nothing.db')], { CLEARED_V2_APP_LANGUAGE: 'en' });
  assert.equal(missing.code, 64);
  assert.match(missing.err, /No v1 ledger at .*nothing\.db\./);
  const same = run(['--from', v1.ledger], { CLEARED_STATE_DIR: join(v1.ledger, '..'), CLEARED_V2_APP_LANGUAGE: 'en' });
  assert.equal(same.code, 64);
  assert.match(same.err, /is v2's own ledger, not v1's/);
});

test('without a workspace the command says so', () => {
  const { v1, run } = setup();
  const result = run(['--from', v1.ledger], { CLEARED_V2_PROJECT: '', CLEARED_V2_APP_LANGUAGE: 'en' });
  assert.equal(result.code, 64);
  assert.match(result.err, /No workspace is configured/);
});
