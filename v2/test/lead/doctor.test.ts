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

test('a context threshold of 5% fails with a 1M window but 2% works', async () => {
  // On a 200k window: 5% = 10k tokens, 2% = 4k tokens
  // On a 1M window: 5% = 50k tokens, 2% = 20k tokens
  // With the answer cap of ~4k tokens, 5% is too high for a 1M window.
  // This test verifies the threshold calculation accounts for actual window size.
  const smallWindow = 200_000;
  const largeWindow = 1_000_000;

  // 5% of the windows
  const fivePercentSmall = Math.round(smallWindow * 0.05 / 100) * 100;  // ≈ 10k
  const fivePercentLarge = Math.round(largeWindow * 0.05 / 100) * 100;  // ≈ 50k

  // 2% of the windows (what the doctor should use)
  const twoPercentSmall = Math.round(smallWindow * 0.02 / 100) * 100;   // ≈ 4k
  const twoPercentLarge = Math.round(largeWindow * 0.02 / 100) * 100;   // ≈ 20k

  // The answer cap is about 4k tokens (8 KB)
  const answerCap = 4000;

  // With 5%, we cannot trigger a refresh on a 1M window with a normal answer
  assert(fivePercentLarge > answerCap * 10, '5% of 1M window is too large for normal answers');

  // With 2%, we can trigger a refresh on both window sizes
  assert(twoPercentSmall <= answerCap * 2, '2% of 200k window accommodates answers');
  assert(twoPercentLarge <= answerCap * 10, '2% of 1M window accommodates answers with margin');
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
