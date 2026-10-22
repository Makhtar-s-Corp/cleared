// The lead module (docs/v2/milestone-2-plan.md, decision 14): the project
// lead's tables (lead_*; lane 7 adds plans and plan_items), its routes
// (section 7.1) and its engine (lead/engine.ts), built over the flow's
// engine on the first request to a lead route, as the flow's is: a module's
// provide has no registry. Lane 7 registers its tools, its lines of the
// compact state and its routes here (LeadExtensions).
import { runtime as flowRuntime } from '../flow/runtime.ts';
import { LeadConfigError } from '../lead/config.ts';
import { createLeadRuntime } from '../lead/engine.ts';
import { createLeadRoutes } from '../lead/routes.ts';
import { LEAD_TABLES } from '../lead/store.ts';
import type { Module } from './registry.ts';

export const leadRuntime = createLeadRuntime({ flow: flowRuntime });

const lead: Module = {
  tables: LEAD_TABLES,
  routes: createLeadRoutes({ lead: (registry) => leadRuntime.lead(registry), proof: () => flowRuntime.proof() }),
  provide: ({ store }) => {
    try {
      leadRuntime.attach({ store });
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
