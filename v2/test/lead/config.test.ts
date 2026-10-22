import test from 'node:test';
import assert from 'node:assert/strict';
import { LeadConfigError, loadLeadConfig } from '../../src/lead/config.ts';

const project = { CLEARED_V2_PROJECT: 'guestbook' };

test('the lead is on when the project is set, with the defaults of the plan', () => {
  assert.deepEqual(loadLeadConfig(project), { enabled: true, model: 'claude-opus-5-5', contextPercent: 50, handoverPercent: 40, batchMs: 60_000 });
  assert.equal(loadLeadConfig({}).enabled, false);
  assert.equal(loadLeadConfig({ ...project, CLEARED_V2_LEAD_ENABLED: 'off' }).enabled, false);
  assert.equal(loadLeadConfig({ ...project, CLEARED_V2_LEAD_ENABLED: '0' }).enabled, false);
  assert.equal(loadLeadConfig({ ...project, CLEARED_V2_LEAD_ENABLED: 'on' }).enabled, true);
});

test('each setting is read, and a wrong one is an error, not a silent default', () => {
  const config = loadLeadConfig({
    ...project, CLEARED_V2_LEAD_MODEL: 'claude-haiku-5-5', CLEARED_V2_LEAD_CONTEXT_PERCENT: '5', CLEARED_V2_LEAD_HANDOVER_PERCENT: '4', CLEARED_V2_LEAD_BATCH_SECONDS: '10',
  });
  assert.deepEqual(config, { enabled: true, model: 'claude-haiku-5-5', contextPercent: 5, handoverPercent: 4, batchMs: 10_000 });
  for (const env of [
    { CLEARED_V2_LEAD_CONTEXT_PERCENT: '0' }, { CLEARED_V2_LEAD_CONTEXT_PERCENT: '101' }, { CLEARED_V2_LEAD_HANDOVER_PERCENT: 'x' },
    { CLEARED_V2_LEAD_HANDOVER_PERCENT: '50' }, { CLEARED_V2_LEAD_BATCH_SECONDS: '-1' }, { CLEARED_V2_LEAD_BATCH_SECONDS: '1.5' },
    { CLEARED_V2_LEAD_ENABLED: 'maybe' }, { CLEARED_V2_LEAD_MODEL: 'opus' },
  ]) assert.throws(() => loadLeadConfig({ ...project, ...env }), LeadConfigError, JSON.stringify(env));
});
