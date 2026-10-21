// The harness adapters the service can start sessions with: 'claude-code'
// (claude-code.ts, with the default runtime of the service's state folder).
// The fake adapter (fake.ts) is never registered: tests and fixtures create
// it themselves.
import type { Harness, SessionAdapter } from '../contract.ts';
import type { Cleaner } from '../clean.ts';
import type { EventLog } from '../events.ts';
import { createClaudeCodeAdapter } from './claude-code.ts';

// What an adapter needs from the service.
export type AdapterDeps = {
  readonly log: EventLog;
  readonly cleaner: () => Cleaner;                // one per session, with the service's secrets and paths
};

export type AdapterFactory = (deps: AdapterDeps) => SessionAdapter;

export const adapterFactories: Readonly<Partial<Record<Harness, AdapterFactory>>> = {
  'claude-code': (deps) => createClaudeCodeAdapter(deps),
};
