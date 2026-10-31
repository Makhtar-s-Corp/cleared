// What the receipt's captures need of a service, confirmed while the service runs
// (issue #505): the running engine's workspace says it at once, which is the object
// the effects and the siblings' plans read, so no restart is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { proofTargets } from '../../src/flow/proof-capture.ts';
import { workspaceOf } from '../../src/flow/config.ts';
import { setup } from './support.ts';

const service = { name: 'guestbook', kind: 'repository', repo: 'example-org/guestbook', url: 'https://example.invalid/guestbook.git', base: 'main', path: null, dir: '/srv/guestbook', healthUrl: null, sensitivity: 'normal', consumes: [], run: null, contract: null, brokerSocket: null, brokerState: null };

test('the running flow reads the address and the trial from the moment they are confirmed', async () => {
  const t = await setup({ config: { workspace: { id: 'guestbook', name: 'guestbook', file: null, services: [{ ...service }] } as never } });
  const read = () => workspaceOf(t.engine.config).services[0];
  assert.equal(proofTargets(read() as never, undefined).before, undefined);
  t.engine.applyServiceTargets('guestbook', { healthUrl: 'https://exemple.org/health', run: { dockerfile: 'Dockerfile', port: 8793 } });
  assert.deepEqual(proofTargets(read() as never, undefined).before, { url: 'https://exemple.org/' });
  assert.deepEqual(read()?.run, { dockerfile: 'Dockerfile', port: 8793 });
  t.engine.applyServiceTargets('nope', { healthUrl: 'https://x/', run: null });
  assert.equal(read()?.healthUrl, 'https://exemple.org/health');
});
