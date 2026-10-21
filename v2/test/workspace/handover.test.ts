import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HandoverError, captureHandover } from '../../src/workspace/handover.ts';
import { projectCheckout, ticketCheckout } from '../../src/workspace/checkout.ts';
import { remote, tempDir } from './git.ts';

const SESSION = '5f0c2b9a-8e1d-4c3b-a2f1-0e9d8c7b6a54';
const VALID = ['## Done', 'The query.', '## Tried and failed, and why', 'Nothing.', '## Left to do', 'The page.',
  '## Where the artifacts are (screenshots, logs, branches)', 'The branch.', '## Open questions', 'None.', ''].join('\n');

async function setup() {
  const root = tempDir('handover');
  const project = await projectCheckout({ url: remote(), dir: join(root, 'project'), base: 'main' });
  const workdir = join(root, 'w');
  await ticketCheckout({ project: project.dir, workdir, base: 'main', branch: 'cleared/DEMO-9' });
  const env = { CLEARED_STATE_DIR: join(root, 'state') };
  const input = { project: project.dir, workdir, role: 'author' as const, model: 'claude-opus-5-5', ticket: 'DEMO-9', sessionId: SESSION, env };
  const ledger = () => new DatabaseSync(join(root, 'state', 'ledger.db'), { readOnly: true });
  return { root, workdir, input, ledger };
}

test('a valid HANDOVER.md goes into memory for the ticket, then leaves the checkout', async () => {
  const { workdir, input, ledger } = await setup();
  writeFileSync(join(workdir, 'HANDOVER.md'), VALID);
  const id = await captureHandover(input);
  assert.equal(typeof id, 'string');
  assert.equal(existsSync(join(workdir, 'HANDOVER.md')), false);
  const db = ledger();
  const row = db.prepare('SELECT type, scope, content, source_who, source_where, status FROM memory_entries WHERE id = ?').get(id as string);
  db.close();
  assert.deepEqual({ ...row }, { type: 'handover', scope: 'ticket:DEMO-9', content: VALID, source_who: 'agent:author/claude-opus-5-5', source_where: `session:${SESSION}`, status: 'proposed' });
});

test('a missing HANDOVER.md is recorded as missing, so the next briefing says so', async () => {
  const { input, ledger } = await setup();
  assert.equal(await captureHandover(input), null);
  const db = ledger();
  const event = db.prepare("SELECT ticket, run_id FROM events WHERE kind = 'handover_missing'").get();
  db.close();
  assert.deepEqual({ ...event }, { ticket: 'DEMO-9', run_id: SESSION });
});

test('a HANDOVER.md without the five headings is kept aside, recorded as missing, and removed', async () => {
  const { root, workdir, input } = await setup();
  writeFileSync(join(workdir, 'HANDOVER.md'), '## Done\nSomething.\n');
  assert.equal(await captureHandover(input), null);
  assert.equal(existsSync(join(workdir, 'HANDOVER.md')), false);
  assert.equal(readdirSync(join(root, 'state', 'runs', SESSION)).filter((name) => name.startsWith('invalid-handover-')).length, 1);
});

test('a HANDOVER.md that is a link is never read', async () => {
  const { root, workdir, input } = await setup();
  const target = join(root, 'outside.md');
  writeFileSync(target, VALID);
  symlinkSync(target, join(workdir, 'HANDOVER.md'));
  assert.equal(await captureHandover(input), null);
  assert.equal(existsSync(target), true);
});

test('a session id that is not a UUID is refused before anything is read', async () => {
  const { input } = await setup();
  await assert.rejects(captureHandover({ ...input, sessionId: '../../etc' }), HandoverError);
});
