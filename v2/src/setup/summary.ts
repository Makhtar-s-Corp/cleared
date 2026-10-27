// The setup's summary (docs/v2/milestone-5-plan.md, sections 1 and 14):
// each step's time from the assistant's records (records.ts), the person's
// and the machine's, and the totals the last page and the first-ticket step
// show. The proof's hour is the total of both; a skipped step counts the
// time the person spent before skipping it.
import type { StepId, StepState, StepView } from './types.ts';

export const HOUR_MS = 60 * 60 * 1000;

export type SetupTotal = { readonly personMs: number; readonly machineMs: number };

export type SummaryLine = { readonly id: StepId; readonly state: StepState; readonly personMs: number; readonly machineMs: number };

export type SetupSummary = {
  readonly lines: readonly SummaryLine[];
  readonly total: SetupTotal & { readonly allMs: number };
  readonly finished: boolean;                     // no step left to do
  readonly withinHour: boolean;
  readonly skipped: readonly StepId[];
};

export function totalOf(steps: readonly Pick<StepView, 'personMs' | 'machineMs'>[]): SetupTotal {
  return steps.reduce((sum, step) => ({ personMs: sum.personMs + step.personMs, machineMs: sum.machineMs + step.machineMs }), { personMs: 0, machineMs: 0 });
}

export function summaryOf(steps: readonly StepView[]): SetupSummary {
  const total = totalOf(steps);
  const allMs = total.personMs + total.machineMs;
  return {
    lines: steps.map(({ id, state, personMs, machineMs }) => ({ id, state, personMs, machineMs })),
    total: { ...total, allMs },
    finished: steps.every((step) => step.state !== 'todo'),
    withinHour: allMs < HOUR_MS,
    skipped: steps.filter((step) => step.state === 'skipped').map((step) => step.id),
  };
}
