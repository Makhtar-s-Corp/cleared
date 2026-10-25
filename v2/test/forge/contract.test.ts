// The forge contract (milestone 5 plan, decision 10, section 6): the
// in-memory fake and the GitHub adapter over a fake gh pass the same cases
// from the same world. No call reaches GitHub.
import { GitHubForge } from '../../src/forge/github.ts';
import { forgeContractCases } from './contract-cases.ts';
import { FakeForge } from './fake.ts';
import { fakeGh } from './fake-gh.ts';

forgeContractCases('the fake forge', (world) => {
  const forge = new FakeForge(structuredClone(world));
  return { forge, world: () => forge.world };
});

forgeContractCases('the GitHub adapter', (world) => {
  const gh = fakeGh(world);
  return { forge: new GitHubForge({ dir: gh.root, env: gh.env }), world: gh.world };
});
