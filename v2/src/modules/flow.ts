// The flow module (lane 7): the ticket's path from Todo to the release
// request lives in flow/engine.ts; this module declares the ticket routes
// that start it (create, list, get, move). The approval route is lane 8's.
// The release trains of a workspace of several services (lane 16) are kept
// in release_trains. The session plan's Go and Change (lane 17) are
// flow/plan-gate.ts's; the Editor tab's files and Take over and Give back
// (lane 20) are flow/files.ts's and flow/takeover.ts's. A ticket's steps,
// in ticket_steps, and the contract item's Approve and Send back (lane 23)
// are flow/steps.ts's; a ticket's variants, in ticket_variants, and the
// variants item's choice (issue #271) are flow/variants.ts's; Resume from
// here (issue #272), in ticket_replays, is flow/replay.ts's; the batches of
// tickets (requirement C6), in batches and batch_items, are flow/batch.ts's,
// whose runner starts with the engine and passes on the flow's events and
// on its own timer. The web terminal of a session taken over and the
// editor's save (lane 31) are terminal/routes.ts's and flow/files.ts's,
// with one human side per process (terminal/human.ts), made with the
// engine and the store this module receives. The idle watchdog (issue #290,
// session/watchdog.ts) starts with the engine, on its own timer.
import { LeverStore } from '../consumption/levers.ts';
import { Docker } from '../container/docker.ts';
import { BATCH_TABLES, BatchRunner, batchRoutes } from '../flow/batch.ts';
import { filesRoutes } from '../flow/files.ts';
import { planGateRoutes } from '../flow/plan-gate.ts';
import { REPLAYS_TABLE, replayRoutes } from '../flow/replay.ts';
import { runtime } from '../flow/runtime.ts';
import { STEPS_TABLE, stepRoutes } from '../flow/steps.ts';
import { takeoverRoutes } from '../flow/takeover.ts';
import { VARIANTS_TABLE, variantRoutes } from '../flow/variants.ts';
import { loadPlanConfig } from '../lead/plans/runner.ts';
import { TRAIN_TABLE } from '../release/store.ts';
import type { Store } from '../store/db.ts';
import { dockerContainer } from '../terminal/container.ts';
import { IdleWatchdog } from '../session/watchdog.ts';
import { HumanSide } from '../terminal/human.ts';
import { terminalRoutes } from '../terminal/routes.ts';
import type { Module, Registry } from './registry.ts';

let store: Store | undefined;
let human: HumanSide | undefined;
let watchdog: IdleWatchdog | undefined;
let batches: BatchRunner | undefined;
// The batches' runner, on the engine and the store; the week stop is the plans' (CLEARED_V2_WEEK_STOP_PERCENT).
function batchesOf(registry: Registry): BatchRunner | undefined {
  if (batches || !store) return batches;
  const engine = runtime.engine(registry);
  if (!engine) return undefined;
  const project = engine.config.project;
  batches = new BatchRunner({
    db: store.db, tickets: engine.registry.ticketStore, flow: engine, project,
    levers: new LeverStore(store.db, project), weekStopPercent: loadPlanConfig(process.env).weekStopPercent,
  });
  batches.listen();
  batches.startTimer();
  return batches;
}
function humanOf(registry: Registry): HumanSide | undefined {
  if (human || !store) return human;
  const engine = runtime.engine(registry);
  if (!engine) return undefined;
  human = new HumanSide({ engine, store, container: dockerContainer(new Docker()) });
  human.startTimer();
  return human;
}

const flow: Module = {
  tables: [TRAIN_TABLE, STEPS_TABLE, VARIANTS_TABLE, REPLAYS_TABLE, ...BATCH_TABLES],
  routes: [
    ...runtime.routes((path) => path.startsWith('/api/tickets')),
    ...planGateRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...takeoverRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof(), human: humanOf }),
    ...filesRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof(), human: humanOf }),
    ...terminalRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof(), human: humanOf }),
    ...stepRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...variantRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...replayRoutes({ engine: (registry) => runtime.engine(registry), proof: () => runtime.proof() }),
    ...batchRoutes({ runner: batchesOf, proof: () => runtime.proof() }),
  ],
  provide: (deps) => {
    store = deps.store;
    return {};
  },
  // The engine is built at start, not at the first request: its restart
  // recovery stops what the last process left, puts its tickets back, and
  // releases the stopped sessions' containers and networks. The watchdog
  // starts with it, once a minute, and so does the batches' runner, whose
  // queue a restart finishes.
  start: (registry) => {
    const engine = runtime.engine(registry);
    if (!engine || !store) return;
    batchesOf(registry);
    if (watchdog) return;
    const docker = new Docker();
    watchdog = new IdleWatchdog({
      store, project: engine.config.project, idleMs: engine.config.idleMs,
      owner: (session) => engine.idleStop(session),
      release: (session) => docker.releaseStopped([session]),
    });
    watchdog.startTimer();
  },
  // Ends the watchdog's and the batches' timers and awaits the passes they run, so that the store
  // does not close under them; a second start builds new ones.
  stop: async () => {
    const ending = watchdog;
    const runner = batches;
    watchdog = undefined;
    batches = undefined;
    await ending?.close();
    await runner?.close();
  },
};

export default flow;
