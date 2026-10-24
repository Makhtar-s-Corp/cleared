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
// Origin (schedules/budget.ts). The quota reading (issue #270) is its too,
// beside the Consumption screen it feeds: each harness's windows read every
// CLEARED_V2_QUOTA_MINUTES (60; 0 turns it off) into quota_readings.
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
import { LEVERS_TABLE, LeverStore } from '../consumption/levers.ts';
import { QUOTA_TABLES, QuotaReader, READ_MINUTES, claudeCodeQuotaSource } from '../consumption/quota.ts';
import { claudeCodeRuntime } from '../session/adapters/claude-code.ts';
import { consumptionRoutes } from '../consumption/routes.ts';
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
let quota: QuotaReader | undefined;

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
  schedules = new Scheduler({ db: store.db, project: fc.project, recipes, plans, lead, weekStopPercent: planConfig.weekStopPercent, levers: new LeverStore(store.db, fc.project) });
  schedules.startTimer();
  return plans;
}

// The hourly quota reading of the flow's project, once the flow runs.
export function quotaOf(registry: Registry): QuotaReader | undefined {
  if (quota) return quota;
  const flow = flowRuntime.engine(registry);
  if (!flow || !store) return undefined;
  const env = process.env;
  const minutes = quotaMinutes(env.CLEARED_V2_QUOTA_MINUTES);
  if (minutes === 0) return undefined;
  quota = new QuotaReader({
    db: store.db, project: flow.config.project,
    sources: [claudeCodeQuotaSource({ loginFile: claudeCodeRuntime(env).loginFile })],
    clean: (text) => cleanText(text, { secrets: secretValues(env), servicePaths: [] }),
  });
  quota.startTimer(minutes * 60_000);
  return quota;
}

// CLEARED_V2_QUOTA_MINUTES: a whole number of minutes, 0 for none; anything else is the default, said.
export function quotaMinutes(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return READ_MINUTES;
  const minutes = Number(value);
  if (Number.isInteger(minutes) && minutes >= 0) return minutes;
  console.error(`cleared-v2: CLEARED_V2_QUOTA_MINUTES is a whole number of minutes, not "${value}": the quota is read every ${READ_MINUTES} minutes`);
  return READ_MINUTES;
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
  tables: [...LEAD_TABLES, ...PLAN_TABLES, ...SCHEDULE_TABLES, LEVERS_TABLE, ...QUOTA_TABLES],
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
    // The Consumption screen (O15): its read, and the three levers it turns.
    ...consumptionRoutes({
      target: (registry) => {
        const flow = flowRuntime.engine(registry);
        return flow && store ? { db: store.db, project: flow.config.project, config: flow.config } : undefined;
      },
      proof: () => flowRuntime.proof(),
    }),
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
  // The schedules come due while the service is down: their first tick is
  // the start's, after the flow's recovery, not the timer's a minute later (P33).
  start: (registry) => {
    plansOf(registry);
    leadRuntime.lead(registry);
    quotaOf(registry);
    const first = schedules;
    if (first) void flowRuntime.engine(registry)?.recovered.then(() => first.tick()).catch((error) => console.error(`cleared-v2: the schedules' first tick failed (${error instanceof Error ? error.name : typeof error})`));
  },
};

export default lead;
