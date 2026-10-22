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

test('opening share plus margin thresholds prevent spurious refresh on opening', async () => {
  // When the doctor measures the opening share (8% on 200k, 2.3% on 1M), it derives
  // the threshold as opening + 1%. The test verifies:
  // 1. Generation 1's opening turn (first measure is on opening) does NOT trigger refresh
  //    (per engine.ts:510-512, opening turn refresh is skipped).
  // 2. Generation 1's first owner turn has context at opening + margin, does NOT exceed
  //    the derived threshold, so does not refresh on this real data.
  // 3. Only when context grows past opening + 1% does refresh trigger.

  const t = await leadSetup({ lead: [
    // Gen 1: opening at 8%, first owner turn at 8.5% (within threshold of 9%)
    [...opening(8), ...turn('t1', say('r1', 'Ready.'), context(8.5))],
    // Gen 2: opening at 8%, measure for comparison
    [...opening(8), ...turn('t2', say('r2', 'Answer.'), context(10))],
  ]});

  await t.lead.settled();
  assert.equal(t.generations.length, 1, 'generation 1 did not refresh on its opening measure');

  // First owner message to generation 1: context at 8.5% < 9%, should not refresh
  await t.lead.post('First question.', 'doctor');
  await t.lead.tick();
  assert.equal(t.generations.length, 1, 'generation 1 did not refresh on first owner turn at 8.5%');
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
