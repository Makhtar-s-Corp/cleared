import test from 'node:test';
import assert from 'node:assert/strict';
import { LeadConfigError, loadLeadConfig } from '../../src/lead/config.ts';

const project = { CLEARED_V2_PROJECT: 'guestbook' };

// The lead runs once the flow runs (lead/engine.ts): the setting is read at
// start, and the assistant writes a workspace file later, never
// CLEARED_V2_PROJECT (issue #420). So only CLEARED_V2_LEAD_ENABLED turns it off.
test('the lead is on unless turned off, with the defaults of the plan', () => {
  assert.deepEqual(loadLeadConfig(project), { enabled: true, model: 'claude-opus-5-5', contextPercent: 50, handoverPercent: 40, batchMs: 60_000 });
  assert.equal(loadLeadConfig({ CLEARED_V2_WORKSPACE: '/state/workspace.conf' }).enabled, true, 'a workspace file, no project');
  assert.equal(loadLeadConfig({}).enabled, true, 'no workspace yet: on, and the lead waits for the flow');
  assert.equal(loadLeadConfig({ CLEARED_V2_LEAD_ENABLED: 'off' }).enabled, false);
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
