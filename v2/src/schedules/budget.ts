// A schedule's budget on its tickets (docs/v2/milestone-2-plan.md, decision
// 29): the plan runner starts every ticket of a plan through the flow's
// start with the plan in its Origin (a first start, a start again after a
// put back, the lead's start_ticket alike). The lead module gives the
// runner this flow, which adds to that Origin the budget the schedule that
// started the plan gave, so the flow stops the ticket past it in place of
// CLEARED_V2_BUDGET_USD. A plan no schedule started goes through unchanged.
import type { Origin } from '../flow/events.ts';
import type { PlanFlow } from '../lead/plans/runner.ts';

export function budgetedFlow(flow: PlanFlow, budgetOf: (plan: string) => number | undefined): PlanFlow {
  const withBudget = (origin: Origin | undefined): Origin | undefined => {
    const budget = origin ? budgetOf(origin.plan) : undefined;
    return origin && budget !== undefined ? { ...origin, budgetUsd: budget } : origin;
  };
  return {
    start: (ticket, by, origin) => flow.start(ticket, by, withBudget(origin)),
    isActive: (ticket) => flow.isActive(ticket),
    subscribe: (listener) => flow.subscribe(listener),
  };
}
