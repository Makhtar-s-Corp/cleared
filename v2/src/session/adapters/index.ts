// The harness adapters the service can start sessions with: 'claude-code'
// (claude-code.ts, with the default runtime of the service's state folder).
// The fake adapter (fake.ts) is never registered: tests and fixtures create
// it themselves.
import type { Harness, SessionAdapter, StartInput } from '../contract.ts';
import type { Cleaner } from '../clean.ts';
import type { EventLog } from '../events.ts';
import type { Policy } from '../policy.ts';
import { createClaudeCodeAdapter } from './claude-code.ts';

// What an adapter needs from the service.
export type AdapterDeps = {
  readonly log: EventLog;
  readonly cleaner: () => Cleaner;                // one per session, with the service's secrets and paths
  // The policy for each evaluation (milestone 2, decision 11): the learned
  // rules and the ticket's files as they are now. The policy the session
  // started with when absent.
  readonly policy?: (input: StartInput) => Policy;
};

export type AdapterFactory = (deps: AdapterDeps) => SessionAdapter;

export const adapterFactories: Readonly<Partial<Record<Harness, AdapterFactory>>> = {
  'claude-code': (deps) => createClaudeCodeAdapter({ log: deps.log, cleaner: deps.cleaner, ...(deps.policy ? { policy: deps.policy } : {}) }),
};
