// The flow module (lane 7): the ticket's path from Todo to the release
// request lives in flow/engine.ts; this module declares the ticket routes
// that start it (create, list, get, move). The approval route is lane 8's.
// The release trains of a workspace of several services (lane 16) are kept
// in release_trains. The session plan's Go and Change (lane 17) are
// flow/plan-gate.ts's; the Editor tab's files and Take over and Give back
// (lane 20) are flow/files.ts's and flow/takeover.ts's. A ticket's steps,
// in ticket_steps, and the contract item's Approve and Send back (lane 23)
// are flow/steps.ts's.
import { filesRoutes } from '../flow/files.ts';
import { planGateRoutes } from '../flow/plan-gate.ts';
import { runtime } from '../flow/runtime.ts';
import { STEPS_TABLE, stepRoutes } from '../flow/steps.ts';
import { takeoverRoutes } from '../flow/takeover.ts';
import { TRAIN_TABLE } from '../release/store.ts';
import type { Module } from './registry.ts';

const flow: Module = {
  tables: [TRAIN_TABLE, STEPS_TABLE],
  routes: [
    ...runtime.routes((path) => path.startsWith('/api/tickets')),
    ...planGateRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...takeoverRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...filesRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...stepRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
  ],
  provide: () => ({}),
};

export default flow;
