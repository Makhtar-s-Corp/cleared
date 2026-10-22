// The lead module (docs/v2/milestone-2-plan.md, decision 14): the project
// lead's tables (lead_*, plans and plan_items), its routes (section 7.1)
// and its engine (lead/engine.ts), built over the flow's engine on the
// first request to a lead or plan route, as the flow's is: a module's
// provide has no registry. The plans (lead/plans/, lane 7) are built with
// the lead, register their two tools, their lines of the compact state and
// their section of the handover through the lead's extensions, and tick
// every 30 seconds from then on.
import { homedir } from 'node:os';
import { runtime as flowRuntime } from '../flow/runtime.ts';
import { LeadConfigError } from '../lead/config.ts';
import { createLeadRuntime } from '../lead/engine.ts';
import { createPlanRoutes } from '../lead/plans/routes.ts';
import { PlanRunner, loadPlanConfig, type PlanConfig } from '../lead/plans/runner.ts';
import { PLAN_TABLES } from '../lead/plans/store.ts';
import { planExtensions } from '../lead/plans/tools.ts';
import { createLeadRoutes } from '../lead/routes.ts';
import { LEAD_TABLES } from '../lead/store.ts';
import { cleanText, secretValues } from '../session/clean.ts';
import type { Store } from '../store/db.ts';
import type { Module, Registry } from './registry.ts';

let store: Store | undefined;
let planConfig: PlanConfig | undefined;
let plans: PlanRunner | undefined;

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
  plans = new PlanRunner({
    store, inbox: flow.inbox, tickets: registry.ticketStore, flow, lead, project: fc.project, config: planConfig,
    clean: (text) => cleanText(text, { secrets: secretValues(env), servicePaths }),
  });
  plans.listen();
  plans.startTimer();
  return plans;
}

const lead: Module = {
  tables: [...LEAD_TABLES, ...PLAN_TABLES],
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
};

export default lead;
