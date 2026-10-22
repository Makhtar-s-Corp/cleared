// The doctor's `lead` section (scripts/doctor-lead.ts): its one check is a
// real generation on this server, run only when the section is named; here
// only its shape is checked, and stop() which it relies on to clean up.
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadChecks } from '../../scripts/doctor-lead.ts';
import { leadSetup } from './support.ts';

test('the lead section has its one real check', () => {
  assert.equal(leadChecks.length, 1);
  assert.match(leadChecks[0]?.name ?? '', /real lead generation/);
});

test('stop() stops the live generation\'s session and starts no other', async () => {
  const t = await leadSetup();
  await t.lead.settled();
  await t.lead.stop();
  await t.lead.tick();
  assert.equal(t.generations.length, 1);
  assert.equal(t.generations[0]?.stopped(), true);
  assert.equal(t.store.sessions.get(t.generations[0]?.id as string)?.status, 'stopped');
  assert.equal(t.lead.state().phase, 'down');
});
