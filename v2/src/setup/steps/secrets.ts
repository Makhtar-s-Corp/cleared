// The assistant's secrets step (docs/v2/milestone-5-plan.md, sections 1 and
// 12, step 7, C16): the test secrets the project's tests need, for each
// service of the workspace, on the secrets module's store (secrets/live.ts),
// so a value set here is the one the Services screen lists, the sessions
// are given and the cleaner removes. Names, dates and who, never a value.
// Done once a value is saved; a person with none skips the step.
//
//   GET  /api/setup/secrets          -> TestValuesView
//   POST /api/setup/secrets          { service, name, value } -> TestValueSaved
//   POST /api/setup/secrets/remove   { service, name } -> { removed: true }
//   POST /api/setup/secrets/done     -> { done: true }; 409 { error: 'empty' } with no value
//   GET  /api/setup/secrets/expected -> ExpectedSecrets: the names the repositories show their tests read
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../../flow/config.ts';
import { expectedSecrets } from '../../secrets/expected.ts';
import { testValuesOf } from '../../secrets/live.ts';
import { removeTestValue, setTestValue, testValuesView } from '../../secrets/routes.ts';
import { TEST_VALUE_TABLES } from '../../secrets/store.ts';
import { answer, guarded, HttpError } from '../http.ts';
import type { SetupStep } from '../step.ts';

const secrets: SetupStep = {
  id: 'secrets',
  filled: true,
  skippable: true,
  tables: TEST_VALUE_TABLES,
  routes: (deps) => {
    const store = () => testValuesOf(deps.db, deps.env);
    return [
      {
        method: 'GET', path: '/api/setup/secrets',
        handle: guarded(deps, async (context) => answer(context, 200, await testValuesView(context, store(), deps.env))),
      },
      {
        method: 'POST', path: '/api/setup/secrets',
        handle: guarded(deps, async (context, user) => answer(context, 200, await setTestValue(context, store(), deps.env, user.id))),
      },
      {
        method: 'GET', path: '/api/setup/secrets/expected',
        handle: guarded(deps, async (context) => {
          let services: readonly { readonly name: string; readonly dir: string; readonly base: string }[] = [];
          try {
            const config = loadFlowConfig(deps.env);
            services = config ? workspaceOf(config).services : [];
          } catch (error) {
            if (!(error instanceof FlowConfigError)) throw error;
          }
          answer(context, 200, { services: await Promise.all(services.map(async (service) => ({ service: service.name, names: await expectedSecrets(service) }))) });
        }),
      },
      {
        method: 'POST', path: '/api/setup/secrets/remove',
        handle: guarded(deps, async (context, user) => {
          await removeTestValue(context, store(), user.id);
          answer(context, 200, { removed: true });
        }),
      },
      {
        method: 'POST', path: '/api/setup/secrets/done',
        handle: guarded(deps, async (context) => {
          if (!store().list().some((value) => value.readable)) throw new HttpError(409, 'empty');
          deps.records.done('secrets');
          answer(context, 200, { done: true });
        }),
      },
    ];
  },
};

export default secrets;
