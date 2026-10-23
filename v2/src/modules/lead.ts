// The lead module (docs/v2/milestone-2-plan.md, decision 14): the project
// lead's tables (lead_*, plans and plan_items), its routes (section 7.1)
// and its engine (lead/engine.ts), built over the flow's engine on the
// first request to a lead or plan route, as the flow's is: a module's
// provide has no registry. The plans (lead/plans/, lane 7) are built with
// the lead, register their two tools, their lines of the compact state and
// their section of the handover through the lead's extensions, and tick
// every 30 seconds from then on. The recipes and the schedules (decision
// 29, lane 26) are built with the plans and run through them: their tables
// and routes are this module's, the scheduler ticks every minute, and the
// runner starts a schedule's tickets with the schedule's budget on their
// Origin (schedules/budget.ts).
import { homedir } from 'node:os';
import { workspaceOf } from '../flow/config.ts';
import { runtime as flowRuntime } from '../flow/runtime.ts';
import { LeadConfigError } from '../lead/config.ts';
import { createLeadRuntime } from '../lead/engine.ts';
import { createPlanRoutes } from '../lead/plans/routes.ts';
import { PlanRunner, loadPlanConfig, type PlanConfig } from '../lead/plans/runner.ts';
import { PLAN_TABLES } from '../lead/plans/store.ts';
import { planExtensions } from '../lead/plans/tools.ts';
import { createLeadRoutes } from '../lead/routes.ts';
import { LEAD_TABLES } from '../lead/store.ts';
import { recipeRoutes } from '../recipes/routes.ts';
import { Recipes } from '../recipes/service.ts';
import { gitRecipeSource } from '../recipes/source.ts';
import { budgetedFlow } from '../schedules/budget.ts';
import { scheduleRoutes } from '../schedules/routes.ts';
import { Scheduler } from '../schedules/scheduler.ts';
import { SCHEDULE_TABLES } from '../schedules/store.ts';
import { cleanText, secretValues } from '../session/clean.ts';
import type { Store } from '../store/db.ts';
import { projectCheckout } from '../workspace/checkout.ts';
import { forgeEnvironments } from '../workspace/publish.ts';
import type { Module, Registry } from './registry.ts';

let store: Store | undefined;
let planConfig: PlanConfig | undefined;
let plans: PlanRunner | undefined;
let recipes: Recipes | undefined;
let schedules: Scheduler | undefined;

export const leadRuntime = createLeadRuntime({ flow: flowRuntime, extensions: planExtensions(() => plans) });

// The plans, with the lead: undefined while the service runs no lead.
export function plansOf(registry: Registry): PlanRunner | undefined {
  if (plans) return plans;
  const lead = leadRuntime.lead(registry);
  const flow = flowRuntime.engine(registry);
  if (!lead || !flow || !store || !planConfig) return undefined;
  const env = process.env;
  const fc = flow.config;
  const servicePaths = [...new Set([env.CLEARED_V2_STATE_DIR, env.HOME ?? homedir(), fc.projectDir, fc.workdirRoot].filter((p): p is string => !!p && p !== '/'))];
  const clean = (text: string) => cleanText(text, { secrets: secretValues(env), servicePaths });
  const services = workspaceOf(fc).services;
  plans = new PlanRunner({
    store, inbox: flow.inbox, tickets: registry.ticketStore, flow: budgetedFlow(flow, (plan) => schedules?.budgetOf(plan)), lead, project: fc.project,
    services: services.map((service) => service.name), config: planConfig, clean,
  });
  plans.listen();
  plans.startTimer();
  recipes = new Recipes({
    source: gitRecipeSource({
      services: services.map((service) => ({ name: service.name, base: service.base, dir: service.dir, path: service.path })),
      // The fetch the flow makes before an author's first turn (flow/effects.ts).
      refresh: async (name) => {
        const service = services.find((candidate) => candidate.name === name);
        if (service) await projectCheckout({ url: service.url, dir: service.dir, base: service.base, env: (await forgeEnvironments(service.dir, env)).git });
      },
    }),
    plans, lead, inbox: flow.inbox, workspace: services, clean,
  });
  schedules = new Scheduler({ db: store.db, project: fc.project, recipes, plans, lead, weekStopPercent: planConfig.weekStopPercent });
  schedules.startTimer();
  return plans;
}

// The recipes and the scheduler, built with the plans.
export function recipesOf(registry: Registry): Recipes | undefined {
  plansOf(registry);
  return recipes;
}

export function schedulesOf(registry: Registry): Scheduler | undefined {
  plansOf(registry);
  return schedules;
}

const lead: Module = {
  tables: [...LEAD_TABLES, ...PLAN_TABLES, ...SCHEDULE_TABLES],
  routes: [
    // A lead route builds the plans too, so a service the tower polls runs its plans.
    ...createLeadRoutes({
      lead: (registry) => {
        plansOf(registry);
        return leadRuntime.lead(registry);
      },
      proof: () => flowRuntime.proof(),
    }),
    ...createPlanRoutes({ plans: plansOf, proof: () => flowRuntime.proof() }),
    ...recipeRoutes({ recipes: recipesOf, proof: () => flowRuntime.proof() }),
    ...scheduleRoutes({ schedules: schedulesOf, proof: () => flowRuntime.proof() }),
  ],
  provide: (deps) => {
    try {
      leadRuntime.attach(deps);
      planConfig = loadPlanConfig(process.env);
      store = deps.store;
    } catch (error) {
      // A lead setting that is set but wrong stops the service, as a bad port does.
      if (!(error instanceof LeadConfigError)) throw error;
      console.error(`cleared-v2: ${error.message}`);
      process.exit(64);
    }
    return {};
  },
  // The lead and its plans are built at start, as a lead route builds them:
  // a restart's live generation is ended, and the stopped leads' containers
  // and networks are released, without waiting for the tower to poll.
  start: (registry) => {
    plansOf(registry);
    leadRuntime.lead(registry);
  },
};

export default lead;
