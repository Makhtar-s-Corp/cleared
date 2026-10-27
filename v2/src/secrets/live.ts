// The service's one store of test secrets (docs/v2/milestone-5-plan.md,
// decision 12, C16), for the code that reads it without a route: the
// cleaner (session/clean.ts), which removes every value it held from what
// Cleared writes, and the session runtime (container/session-runtime.ts),
// which gives a service's values to its sessions. The secrets module makes
// it on the ledger at start, and the assistant's step reaches the same one:
// one store a ledger, so a value set from either is known at once to both.
import type { DatabaseSync } from 'node:sqlite';
import { keyFileOf, stateDirIn } from './key.ts';
import { TestValues } from './store.ts';

const stores = new WeakMap<DatabaseSync, TestValues>();
let current: TestValues | undefined;

// The store of this ledger, made the first time, its key in the state folder.
export function testValuesOf(db: DatabaseSync, env: NodeJS.ProcessEnv): TestValues {
  let store = stores.get(db);
  if (!store) {
    store = new TestValues(db, keyFileOf(stateDirIn(env)));
    stores.set(db, store);
  }
  current = store;
  return store;
}

// Every value the store held since the service started; none before it is made.
export const knownTestValues = (): readonly string[] => current?.known() ?? [];

// A service's values, by name, as its sessions are given them.
export const testVariablesOf = (service: string): Readonly<Record<string, string>> => current?.variables(service) ?? {};
