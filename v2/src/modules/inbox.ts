// The inbox module (lane 7): the items that wait for a person (a permission,
// a question, a release) and their state, in flow_inbox of ledger.db, and
// the route that lists them.
import { INBOX_TABLE } from '../inbox/store.ts';
import { runtime } from '../flow/runtime.ts';
import type { Module } from './registry.ts';

const inbox: Module = {
  tables: [INBOX_TABLE],
  routes: runtime.routes((path) => path === '/api/inbox'),
  provide: () => ({}),
};

export default inbox;
