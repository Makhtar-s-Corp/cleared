// The secrets module (docs/v2/milestone-5-plan.md, section 12, decision 12,
// C16): a service's test secrets, encrypted at rest.
//   - test_secrets and test_secret_changes (secrets/store.ts): each value
//     sealed under <state>/secrets.key, each change with its name, who and
//     when, never its value.
//   - The store is made on the ledger at start (secrets/live.ts): the
//     cleaner removes every value it held from what Cleared writes, and the
//     session runtime gives a service's values to its sessions.
//   - The Services screen's routes (secrets/routes.ts), behind the app's
//     proof and a person; the assistant's step has its own, for the owner
//     (setup/steps/secrets.ts), on the same store.
import { testValuesOf } from '../secrets/live.ts';
import { testValueRoutes } from '../secrets/routes.ts';
import { TEST_VALUE_TABLES, type TestValues } from '../secrets/store.ts';
import { ledgerPath } from '../store/db.ts';
import type { Module } from './registry.ts';
import { proofPath, readOrCreateProof } from './users.ts';

export type SecretsModuleOptions = {
  readonly env?: NodeJS.ProcessEnv;                 // default: the process's
  readonly proof?: () => string;                    // default: the app's proof beside the ledger
};

export function createSecretsModule(options: SecretsModuleOptions = {}): Module {
  const env = options.env ?? process.env;
  let proof: string | undefined;
  const proofOf = options.proof ?? (() => (proof ??= readOrCreateProof(proofPath(ledgerPath(env)))));
  let store: TestValues | undefined;
  return {
    tables: TEST_VALUE_TABLES,
    routes: testValueRoutes({ store: () => store, env, proof: proofOf }),
    provide: (deps) => {
      store = testValuesOf(deps.store.db, env);
      return {};
    },
  };
}

export default createSecretsModule();
