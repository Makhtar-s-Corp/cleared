// The setup assistant's addresses (docs/v2/milestone-5-plan.md, section 5.4,
// lane v2-j5-assistant): /setup and /setup/<step>, a page of its own beside
// the shell's screens, which the shell's router never takes over.
import test from 'node:test';
import assert from 'node:assert/strict';
import { placeOf, setupPlaceOf, setupPath } from '../../web/lib/routes.ts';

test('/setup is the assistant at its current step, /setup/<step> one step; anything else under it is no page', () => {
  assert.deepEqual(setupPlaceOf('/setup'), { step: null });
  assert.deepEqual(setupPlaceOf('/setup/forge'), { step: 'forge' });
  assert.deepEqual(setupPlaceOf('/setup/first-ticket'), { step: 'first-ticket' });
  assert.equal(setupPlaceOf('/setup/nothing'), undefined);
  assert.equal(setupPlaceOf('/setup/forge/more'), undefined);
  assert.equal(setupPlaceOf('/'), undefined);
  assert.equal(setupPath('model'), '/setup/model');
  assert.equal(placeOf('/setup'), undefined, 'not a screen of the shell: its router leaves it to the browser');
  assert.equal(placeOf('/setup/forge'), undefined);
});
