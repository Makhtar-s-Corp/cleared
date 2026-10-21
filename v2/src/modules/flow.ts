// The flow module (lane 7): the ticket's path from Todo to the release
// request lives in flow/engine.ts; this module declares the ticket routes
// that start it (create, list, get, move). The approval route is lane 8's.
import { runtime } from '../flow/runtime.ts';
import type { Module } from './registry.ts';

const flow: Module = {
  tables: [],
  routes: runtime.routes((path) => path.startsWith('/api/tickets')),
  provide: () => ({}),
};

export default flow;
