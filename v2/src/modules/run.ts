// The run module (docs/v2/milestone-5-plan.md, section 8, lane v2-j5-run,
// C18): `cleared run` as an API.
//   - api_tokens: a person's API tokens, made, listed and revoked through
//     the app (run/tokens.ts), the SHA-256 of each value alone kept.
//   - run_launches: the tickets made by POST /api/run, each a batch of one on
//     the flow module's batches' runner (the chat's path, P212), and what
//     the flow said of them since (run/runs.ts).
//   - The routes (run/routes.ts): POST /api/run and GET /api/run/:id behind
//     a token, the token routes behind the app's proof.
// The launcher is built at start, as the chat's is, so a run's session and
// pull request are written even when nobody reads its state.
import { AppConfigError, readAppConfig } from '../../app/src/config.ts';
import { workspaceOf } from '../flow/config.ts';
import { runtime } from '../flow/runtime.ts';
import { runRoutes } from '../run/routes.ts';
import { RUN_TABLES, RunLauncher } from '../run/runs.ts';
import { ACCESS_TABLES, ApiTokens } from '../run/tokens.ts';
import { formatAddress } from '../server.ts';
import type { Store } from '../store/db.ts';
import { batchesOf } from './flow.ts';
import type { Module, Registry } from './registry.ts';

let store: Store | undefined;
let tokens: ApiTokens | undefined;
let launcher: RunLauncher | undefined;

// The app's address, for the links a run answers; a bad setting of the app's is said there, and leaves none here.
function appOrigin(): string | null {
  try {
    const app = readAppConfig(process.env);
    return app.publicOrigin ?? `http://${formatAddress(app.host, app.port)}`;
  } catch (error) {
    if (error instanceof AppConfigError) return null;
    throw error;
  }
}

function launcherOf(registry: Registry): RunLauncher | undefined {
  if (launcher || !store) return launcher;
  const engine = runtime.engine(registry);
  const runner = batchesOf(registry);
  if (!engine || !runner) return undefined;
  launcher = new RunLauncher({
    db: store.db, runner, flow: engine, tickets: engine.registry.ticketStore, project: engine.config.project,
    services: () => workspaceOf(engine.config).services.map((service) => service.name), appOrigin: appOrigin(),
  });
  launcher.listen();
  return launcher;
}

const run: Module = {
  tables: [...ACCESS_TABLES, ...RUN_TABLES],
  routes: runRoutes({ tokens: () => tokens, launcher: launcherOf, proof: () => runtime.proof() }),
  provide: (deps) => {
    store = deps.store;
    tokens = new ApiTokens(deps.store.db);
    return {};
  },
  start: (registry) => { launcherOf(registry); },
  stop: async () => {
    const ending = launcher;
    launcher = undefined;
    await ending?.close();
  },
};

export default run;
