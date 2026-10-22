// The flow module (lane 7): the ticket's path from Todo to the release
// request lives in flow/engine.ts; this module declares the ticket routes
// that start it (create, list, get, move). The approval route is lane 8's.
// The release trains of a workspace of several services (lane 16) are kept
// in release_trains.
import { runtime } from '../flow/runtime.ts';
import { TRAIN_TABLE } from '../release/store.ts';
import type { Module } from './registry.ts';

const flow: Module = {
  tables: [TRAIN_TABLE],
  routes: runtime.routes((path) => path.startsWith('/api/tickets')),
  provide: () => ({}),
};

export default flow;
