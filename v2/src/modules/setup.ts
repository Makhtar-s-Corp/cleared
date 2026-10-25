// The setup module (docs/v2/milestone-5-plan.md, section 5, lane
// v2-j5-assistant): the browser setup assistant's service side.
//   - At start, on a ledger with no user, the setup code (setup/code.ts),
//     printed in the line the one command reads.
//   - GET /api/setup: every step (setup/steps.ts) with its state and its
//     record; POST /api/setup/:step/shown and /skip; and each step's own
//     routes under /api/setup/<its id>.
// Every route wants the app's proof, a known user, and the owner: the one
// the settings name (CLEARED_V2_OWNER_ID, which the app writes when it makes
// the account), else the first account. The settings are applied again
// before each request, so what the app wrote reaches this process.
import type { DatabaseSync } from 'node:sqlite';
import { SERVICE_PROOF_HEADER, SERVICE_USER_HEADER } from '../api/types.ts';
import { Docker } from '../container/docker.ts';
import { SESSION_IMAGE } from '../container/session-runtime.ts';
import { issueSetupCode, noUser, setupCodeLine } from '../setup/code.ts';
import { throwawayContainer } from '../setup/container.ts';
import { answer, guarded, HttpError } from '../setup/http.ts';
import { FROM_ENVIRONMENT, refreshSettings } from '../setup/load.ts';
import { SetupRecords } from '../setup/records.ts';
import { STEPS, type StepDeps } from '../setup/steps.ts';
import { SETUP_TABLES } from '../setup/tables.ts';
import { isStepId, type SetupView, type StepView } from '../setup/types.ts';
import { header } from '../terminal/routes.ts';
import type { SessionContainer } from '../terminal/container.ts';
import { ledgerPath } from '../store/db.ts';
import type { Module, Route, RouteContext, User } from './registry.ts';
import { proofPath, readOrCreateProof, sameProof } from './users.ts';

export type SetupModuleOptions = {
  readonly env: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  readonly container?: SessionContainer;            // default: a throwaway container of the session image
  readonly proof?: () => string;                    // default: the app's proof beside the ledger
  readonly fromEnvironment?: ReadonlySet<string>;   // default: what the environment set when the service started
};

export function setupView(steps: readonly StepView[], owner: string | null): SetupView {
  const total = steps.reduce((sum, step) => ({ personMs: sum.personMs + step.personMs, machineMs: sum.machineMs + step.machineMs }), { personMs: 0, machineMs: 0 });
  return { steps, owner, current: steps.find((step) => step.state === 'todo')?.id ?? null, total };
}

export function createSetupModule(options: SetupModuleOptions): Module {
  const { env } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((line: string) => console.log(line));
  const fromEnvironment = options.fromEnvironment ?? FROM_ENVIRONMENT;
  const refresh = () => { if (!options.fromEnvironment) refreshSettings(env); };
  let proof: string | undefined;
  const proofOf = options.proof ?? (() => (proof ??= readOrCreateProof(proofPath(ledgerPath(env)))));
  let db: DatabaseSync | undefined;
  let records: SetupRecords | undefined;
  const stops: (() => Promise<void>)[] = [];

  async function owner(context: RouteContext): Promise<User> {
    if (!sameProof(header(context.request, SERVICE_PROOF_HEADER), proofOf())) throw new HttpError(401, 'unauthorized');
    const id = header(context.request, SERVICE_USER_HEADER);
    const user = id ? await context.registry.users.get(id) : undefined;
    if (!user) throw new HttpError(403, 'unknown user');
    refresh();
    const named = env.CLEARED_V2_OWNER_ID || (await context.registry.users.list())[0]?.name;
    if (user.name !== named) throw new HttpError(403, 'the setup is the owner\'s');
    return user;
  }

  const ready = () => {
    if (!db || !records) throw new HttpError(503, 'the setup module has no ledger');
    return { db, records };
  };
  const deps: StepDeps = {
    get db() { return ready().db; },
    get records() { return ready().records; },
    env, fromEnvironment, now, owner,
    fetch: options.fetch ?? fetch,
    container: options.container ?? throwawayContainer(new Docker(), env.CLEARED_V2_SETUP_IMAGE || SESSION_IMAGE),
    onStop: (stop) => { stops.push(stop); },
  };

  const viewOf = async (who: User): Promise<SetupView> => {
    const { records: kept } = ready();
    const steps = STEPS.map((step): StepView => {
      const record = kept.get(step.id);
      const state = record?.doneAt || step.done?.(deps) ? 'done' : record?.skippedAt ? 'skipped' : 'todo';
      return {
        id: step.id, state, filled: step.filled, skippable: step.skippable,
        shownAt: record?.shownAt ?? null, doneAt: record?.doneAt ?? null, skippedAt: record?.skippedAt ?? null,
        personMs: record?.personMs ?? 0, machineMs: record?.machineMs ?? 0,
      };
    });
    return setupView(steps, who.name);
  };

  const stepOf = (context: RouteContext) => {
    const id = context.params.step ?? '';
    const step = isStepId(id) ? STEPS.find((s) => s.id === id) : undefined;
    if (!step) throw new HttpError(404, 'no such step');
    return step;
  };

  const routes: Route[] = [
    { method: 'GET', path: '/api/setup', handle: guarded(deps, async (context, user) => answer(context, 200, await viewOf(user))) },
    {
      method: 'POST', path: '/api/setup/:step/shown',
      handle: guarded(deps, async (context, user) => {
        ready().records.shown(stepOf(context).id);
        answer(context, 200, await viewOf(user));
      }),
    },
    {
      method: 'POST', path: '/api/setup/:step/skip',
      handle: guarded(deps, async (context, user) => {
        const step = stepOf(context);
        if (!step.skippable) throw new HttpError(409, 'not_skippable');
        ready().records.skipped(step.id);
        answer(context, 200, await viewOf(user));
      }),
    },
    ...STEPS.flatMap((step) => step.routes?.(deps) ?? []),
  ];

  return {
    tables: [...SETUP_TABLES, ...STEPS.flatMap((step) => step.tables ?? [])],
    routes,
    provide: ({ store }) => {
      db = store.db;
      records = new SetupRecords(store.db, { now });
      return {};
    },
    // The first start: a code, printed, while no account exists. Never throws.
    start: () => {
      try {
        if (db && noUser(db)) {
          const { code, expiresAt } = issueSetupCode(db, now());
          log(setupCodeLine(code, expiresAt));
        }
      } catch (error) {
        console.error(`cleared-v2: the setup code could not be made (${error instanceof Error ? error.message : typeof error})`);
      }
    },
    stop: async () => { await Promise.all(stops.splice(0).map((stop) => stop().catch(() => undefined))); },
  };
}

const setup: Module = createSetupModule({ env: process.env });

export default setup;
