// The assistant's owner step (docs/v2/milestone-5-plan.md, section 5.2). The
// account itself is made by the app before anyone is signed in, with the
// setup code (app/src/setup.ts, setup/code.ts), which also makes the
// approval key as `npm run setup` does (setup/approval-key.ts). Here, for
// the owner once signed in: their name and the public key, with the setting
// it goes in, [tracker] human_public_key of the project's
// .cleared/agents.conf. Never the private key. Done once a user exists.
import { ApprovalSigner } from '../../approval/signer.ts';
import { approvalKeyPath } from '../approval-key.ts';
import { noUser } from '../code.ts';
import { answer, guarded } from '../http.ts';
import type { SetupStep } from '../step.ts';
import type { OwnerView } from '../types.ts';

export function publicKeyOf(env: NodeJS.ProcessEnv): string | null {
  try { return ApprovalSigner.load(approvalKeyPath(env)).publicKey; } catch { return null; }
}

const owner: SetupStep = {
  id: 'owner',
  filled: true,
  skippable: false,
  done: (deps) => !noUser(deps.db),
  routes: (deps) => [{
    method: 'GET', path: '/api/setup/owner',
    handle: guarded(deps, async (context, user) => {
      answer(context, 200, { name: user.name, publicKey: publicKeyOf(deps.env), setting: 'human_public_key' } satisfies OwnerView);
    }),
  }],
};

export default owner;
