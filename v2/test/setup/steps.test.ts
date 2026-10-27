// The assistant's steps (docs/v2/milestone-5-plan.md, decision 9 and section
// 5, lane v2-j5-assistant): one file per step for the service, one screen
// and one catalog pair per step, a stub for each step a later lane fills;
// the setup module's routes, its start, and who may use them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { STEPS } from '../../src/setup/steps.ts';
import { STEP_IDS } from '../../src/setup/types.ts';
import { SETUP_CODE_LINE } from '../../src/setup/code.ts';
import { PASSWORD, startSetup } from './support.ts';

const root = new URL('../../', import.meta.url).pathname;
const pascal = (id: string) => id.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');

test('the steps of the proof\'s section 1, in order, each with its file, its screen and its two catalogs', () => {
  assert.deepEqual([...STEP_IDS], ['owner', 'forge', 'model', 'workspace', 'environment', 'secrets', 'checks', 'first-ticket']);
  assert.deepEqual(STEPS.map((step) => step.id), [...STEP_IDS]);
  for (const id of STEP_IDS) {
    assert.ok(existsSync(`${root}src/setup/steps/${id}.ts`), `src/setup/steps/${id}.ts`);
    assert.ok(existsSync(`${root}app/web/screens/setup/steps/${pascal(id)}.tsx`), `${pascal(id)}.tsx`);
    for (const language of ['en', 'fr']) assert.ok(existsSync(`${root}app/messages/setup-${id}.${language}.json`), `setup-${id}.${language}.json`);
  }
});

test('this lane fills the owner, the forge and the model; the others are stubs a person may skip', () => {
  const byId = new Map(STEPS.map((step) => [step.id, step]));
  for (const id of ['owner', 'forge', 'model'] as const) assert.equal(byId.get(id)?.filled, true, id);
  for (const id of ['owner', 'forge', 'model'] as const) assert.equal(byId.get(id)?.skippable, false, `${id} cannot be skipped: nothing runs without it`);
  for (const step of STEPS.filter((s) => !s.filled)) assert.equal(step.skippable, true, `${step.id}: a stub can be skipped`);
});

test('a step declares its own routes, under /api/setup/<its id>', async () => {
  const service = await startSetup();
  try {
    for (const step of STEPS) {
      for (const route of step.routes?.({} as never) ?? []) assert.ok(route.path.startsWith(`/api/setup/${step.id}`), `${step.id}: ${route.path}`);
    }
  } finally { await service.close(); }
});

test('on a ledger with no user, the start prints the setup code in the line the one command reads', async () => {
  const service = await startSetup();
  try {
    service.start();
    const line = service.lines.find((l) => SETUP_CODE_LINE.test(l));
    assert.ok(line, service.lines.join('\n'));
    const rows = service.store.db.prepare('SELECT COUNT(*) AS n FROM v2_setup_code').get() as { n: number };
    assert.equal(rows.n, 1);
  } finally { await service.close(); }
});

test('with a user, the start prints no code and makes none', async () => {
  const service = await startSetup();
  try {
    await service.directory.add('alex', PASSWORD);
    service.start();
    assert.deepEqual(service.lines.filter((l) => SETUP_CODE_LINE.test(l)), []);
    assert.equal((service.store.db.prepare('SELECT COUNT(*) AS n FROM v2_setup_code').get() as { n: number }).n, 0);
  } finally { await service.close(); }
});

test('the routes want the app\'s proof, a known user, and the owner', async () => {
  const service = await startSetup();
  try {
    const alex = await service.directory.add('alex', PASSWORD);
    const sam = await service.directory.add('sam', PASSWORD);
    assert.equal((await service.call('/api/setup', { user: alex.id, proof: null })).status, 401);
    assert.equal((await service.call('/api/setup', { user: alex.id, proof: 'b'.repeat(64) })).status, 401);
    assert.equal((await service.call('/api/setup', { user: 'nobody' })).status, 403);
    assert.equal((await service.call('/api/setup', { user: sam.id })).status, 403, 'the first account is the owner; another person waits for them');
    assert.equal((await service.call('/api/setup', { user: alex.id })).status, 200);
  } finally { await service.close(); }
});

test('the owner named in the settings is the owner, not the first account', async () => {
  const service = await startSetup({ env: { CLEARED_V2_OWNER_ID: 'sam' } });
  try {
    const alex = await service.directory.add('alex', PASSWORD);
    const sam = await service.directory.add('sam', PASSWORD);
    assert.equal((await service.call('/api/setup', { user: alex.id })).status, 403);
    assert.equal((await service.call('/api/setup', { user: sam.id })).status, 200);
  } finally { await service.close(); }
});

test('the view: every step in order with its state and times, the owner done, the current step the first one left', async () => {
  const service = await startSetup();
  try {
    const alex = await service.directory.add('alex', PASSWORD);
    const view = (await service.call('/api/setup', { user: alex.id })).json;
    assert.deepEqual(view.steps.map((s: { id: string }) => s.id), [...STEP_IDS]);
    assert.equal(view.owner, 'alex');
    assert.equal(view.steps[0].state, 'done', 'the owner exists: the first step is done');
    assert.equal(view.current, 'forge');
    for (const step of view.steps) for (const key of ['state', 'filled', 'skippable', 'shownAt', 'doneAt', 'skippedAt', 'personMs', 'machineMs']) assert.ok(key in step, `${step.id} ${key}`);
    assert.deepEqual(Object.keys(view.total).sort(), ['machineMs', 'personMs']);
  } finally { await service.close(); }
});

test('shown and skip are recorded; a step that cannot be skipped says so; an unknown step is not found', async () => {
  const service = await startSetup();
  try {
    const alex = await service.directory.add('alex', PASSWORD);
    assert.equal((await service.call('/api/setup/workspace/shown', { method: 'POST', user: alex.id })).status, 200);
    const skipped = await service.call('/api/setup/workspace/skip', { method: 'POST', user: alex.id });
    assert.equal(skipped.status, 200);
    const workspace = skipped.json.steps.find((s: { id: string }) => s.id === 'workspace');
    assert.equal(workspace.state, 'skipped');
    assert.ok(workspace.shownAt);
    const refused = await service.call('/api/setup/forge/skip', { method: 'POST', user: alex.id });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error, 'not_skippable');
    assert.equal((await service.call('/api/setup/nothing/shown', { method: 'POST', user: alex.id })).status, 404);
  } finally { await service.close(); }
});
