// The test secrets' routes (docs/v2/milestone-5-plan.md, section 12, C16;
// the shapes in secrets/types.ts). One set of three, under two bases:
//   /api/test-values     the Services screen's panel: the app's proof, then
//                        a person the service knows (not the flow's own
//                        identities), as every route of the app's;
//   /api/setup/secrets   the assistant's step (setup/steps/secrets.ts): the
//                        owner, through the setup module's guard.
// GET answers every service's values by name, the day and the person; POST
// sets or replaces one; POST .../remove removes one. A value is read from a
// request body and written to the store, and is in no answer. A refusal is
// a code the screens say in words (test_values_error_<code>).
import type { Route, RouteContext } from '../modules/registry.ts';
import { sameProof } from '../modules/users.ts';
import { FlowConfigError, loadFlowConfig, workspaceOf } from '../flow/config.ts';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../api/types.ts';
import type { UserId } from '../session/contract.ts';
import { answer, header, HttpError, NOT_HUMAN, readBody } from '../terminal/routes.ts';
import { TestValueError, type StoredValue, type TestValues } from './store.ts';
import { TEST_VALUES_PATH, type TestValue, type TestValueSaved, type TestValuesView } from './types.ts';

const MAX_BODY = 16 * 1024;

// The workspace's services in its order; undefined when none is configured.
export function workspaceServices(env: NodeJS.ProcessEnv): readonly string[] | undefined {
  try {
    const config = loadFlowConfig(env);
    return config ? workspaceOf(config).services.map((service) => service.name) : undefined;
  } catch (error) {
    if (error instanceof FlowConfigError) throw new HttpError(409, 'invalid_workspace');
    throw error;
  }
}

async function named(context: RouteContext, value: StoredValue): Promise<TestValue> {
  const person = await context.registry.users.get(value.setBy);
  return { service: value.service, name: value.name, setAt: value.setAt, setBy: person?.name ?? null, readable: value.readable };
}

export async function testValuesView(context: RouteContext, store: TestValues, env: NodeJS.ProcessEnv): Promise<TestValuesView> {
  const services = workspaceServices(env);
  const values = await Promise.all(store.list().map((value) => named(context, value)));
  const others = [...new Set(values.map((value) => value.service))].filter((service) => !services?.includes(service)).sort();
  return {
    workspace: services !== undefined,
    key: store.state(),
    services: [...(services ?? []).map((name) => ({ name, inWorkspace: true })), ...others.map((name) => ({ name, inWorkspace: false }))]
      .map((service) => ({ ...service, values: values.filter((value) => value.service === service.name) })),
  };
}

// The body's strings, exactly the keys named, or a refusal.
async function fields<K extends string>(context: RouteContext, keys: readonly K[]): Promise<Record<K, string>> {
  const body = await readBody(context.request, MAX_BODY);
  const given = Object.keys(body);
  if (given.length !== keys.length || !keys.every((key) => typeof body[key] === 'string')) throw new HttpError(400, 'body');
  return body as Record<K, string>;
}

export async function setTestValue(context: RouteContext, store: TestValues, env: NodeJS.ProcessEnv, by: UserId): Promise<TestValueSaved> {
  const { service, name, value } = await fields(context, ['service', 'name', 'value'] as const);
  const services = workspaceServices(env);
  if (!services) throw new HttpError(409, 'no_workspace');
  if (!services.includes(service)) throw new HttpError(400, 'service');
  try {
    const saved = store.set(service, name, value, by);
    return { value: await named(context, saved.value), replaced: saved.replaced };
  } catch (error) {
    if (error instanceof TestValueError) throw new HttpError(400, error.code);
    throw error;
  }
}

// A service gone from the workspace keeps its values until a person removes them.
export async function removeTestValue(context: RouteContext, store: TestValues, by: UserId): Promise<void> {
  const { service, name } = await fields(context, ['service', 'name'] as const);
  if (!store.remove(service, name, by)) throw new HttpError(404, 'not_found');
}

export type TestValueRouteDeps = {
  readonly store: () => TestValues | undefined;        // undefined: no ledger yet
  readonly env: NodeJS.ProcessEnv;
  readonly proof: () => string;
};

// The Services screen's routes, behind the app's proof and a person.
export function testValueRoutes(deps: TestValueRouteDeps): Route[] {
  const handled = (run: (context: RouteContext, user: UserId, store: TestValues) => Promise<void>): Route['handle'] => async (context) => {
    try {
      if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), deps.proof())) throw new HttpError(401, 'unauthorized');
      const user = header(context.request, SERVICE_USER_HEADER);
      if (!user || NOT_HUMAN.has(user) || !(await context.registry.users.get(user))) throw new HttpError(403, 'unknown user');
      const store = deps.store();
      if (!store) throw new HttpError(503, 'the secrets module has no ledger');
      await run(context, user, store);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (context.response.headersSent) context.response.end();
      else answer(context, error.status, { error: error.message });
    }
  };
  return [
    { method: 'GET', path: TEST_VALUES_PATH, handle: handled(async (context, _user, store) => answer(context, 200, await testValuesView(context, store, deps.env))) },
    { method: 'POST', path: TEST_VALUES_PATH, handle: handled(async (context, user, store) => answer(context, 200, await setTestValue(context, store, deps.env, user))) },
    {
      method: 'POST', path: `${TEST_VALUES_PATH}/remove`,
      handle: handled(async (context, user, store) => {
        await removeTestValue(context, store, user);
        answer(context, 200, { removed: true });
      }),
    },
  ];
}
