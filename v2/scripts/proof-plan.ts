// What the proofs decide about the plans already on the workspace (issue
// 285): whether a run may send a new goal, take over a plan already
// approved, or must stop before it starts; and, once a plan runs, whether it
// is blocked, so the 48-hour proof says so instead of waiting out its hours
// with "nothing to do now" (the 24-hour run of 2026-10-24 sat at step 07 from
// 08:47 to 15:45 on three held items and a question nobody answered).
import type { Plan, PlanItemState, PlanState } from '../src/api/types.ts';

// What a decision reads of a plan: GET /api/plans gives it whole.
export type PlanView = Pick<Plan, 'id' | 'title' | 'state'> & { readonly items: readonly Pick<Plan['items'][number], 'position' | 'state' | 'ticket' | 'after'>[] };

export type StartDecision =
  | { readonly kind: 'new' }
  | { readonly kind: 'resume'; readonly plan: PlanView }
  | { readonly kind: 'refuse'; readonly reason: string };

// The states a plan is taken over from: the runner starts an approved plan's
// tickets, and the owner's Resume gives a paused one back to it.
const RESUMABLE: readonly PlanState[] = ['approved', 'paused'];

const itemsLine = (plan: PlanView) => plan.items.map((i) => `${i.position}:${i.state}`).join(' ');

// Before the first gesture of a run. `resume` is the plan the run takes over
// (PROOF_RESUME_PLAN), absent for a run that sends a new goal; `resumable`
// is false for a driver that has no plan to take over (the multi-service
// proof). A paused plan does not refuse a new goal: the runner starts
// nothing of it (the orchestrator's workaround of 2026-10-23, 19:50).
export function startCheck(plans: readonly PlanView[], resume: string | undefined, options: { readonly resumable: boolean } = { resumable: true }): StartDecision {
  const approved = plans.filter((p) => p.state === 'approved');
  if (resume !== undefined) {
    const plan = plans.find((p) => p.id === resume);
    if (!plan) return { kind: 'refuse', reason: `there is no plan ${resume} on this workspace (${plans.map((p) => `${p.id} ${p.state}`).join(', ') || 'none'})` };
    if (!RESUMABLE.includes(plan.state)) return { kind: 'refuse', reason: `plan ${plan.id} is ${plan.state}: only an approved or paused plan is taken over` };
    const other = approved.find((p) => p.id !== plan.id);
    if (other) return { kind: 'refuse', reason: `plan ${other.id} is approved too: taking over ${plan.id} would run two plans at once; pause ${other.id} first (POST /api/plans/${other.id}/pause)` };
    return { kind: 'resume', plan };
  }
  const running = approved[0];
  if (!running) return { kind: 'new' };
  const ways = options.resumable
    ? `take it over with PROOF_RESUME_PLAN=${running.id}, or pause it first (POST /api/plans/${running.id}/pause)`
    : `pause it first (POST /api/plans/${running.id}/pause)`;
  return {
    kind: 'refuse',
    reason: `plan ${running.id} ("${running.title}") is approved and not paused (items ${itemsLine(running)}): a new run beside it would run two plans at once, with tickets on the same run branch, the morning rule on both and the measures mixed (issue 285); ${ways}`,
  };
}

// ---- a blocked plan ------------------------------------------------------------

export type BlockedItem = { readonly position: number; readonly ticket: string | null; readonly state: PlanItemState; readonly why: string };
export type Blockage = {
  // The same signature from one reading to the next is the same blockage: its time runs on.
  readonly signature: string;
  readonly reason: string;
  readonly items: readonly BlockedItem[];
};

// An item that moves on its own: a session runs it, its card waits for an
// approval, or the runner starts it again at its next tick.
const MOVING: ReadonlySet<PlanItemState> = new Set(['running', 'needs_approval', 'put_back']);
const FINAL: ReadonlySet<PlanItemState> = new Set(['landed', 'cancelled']);

const WHY: Partial<Record<PlanItemState, string>> = {
  held: 'held: the lead starts it again with start_ticket, or asks the owner',
  parked: 'parked on a question nobody answered: the lead starts it again with the answer',
  ready: 'ready but not started: the week stop or the day budget may hold the plans',
};

// Whether the plan can go on without the proof: null while an item moves,
// or once the plan is done. Otherwise every item left is held, parked,
// ready but not started, or waits for one of those (or for a cancelled
// item, which never lands), and the blockage says which and why. A paused
// plan is blocked as a whole: the owner resumes it. The caller asks only
// when it has nothing to do itself (morningAction answered wait).
export function planBlockage(plan: PlanView): Blockage | null {
  if (plan.state === 'done' || plan.items.every((i) => FINAL.has(i.state))) return null;
  const left = plan.items.filter((i) => !FINAL.has(i.state));
  const signature = `${plan.id} ${plan.state} ${itemsLine(plan)}`;
  if (plan.state === 'paused') {
    return { signature, reason: `plan ${plan.id} is paused: the owner resumes it`, items: left.map((i) => ({ position: i.position, ticket: i.ticket, state: i.state, why: 'the plan is paused' })) };
  }
  if (plan.state !== 'approved' || left.some((i) => MOVING.has(i.state))) return null;
  const at = new Map(plan.items.map((i) => [i.position, i]));
  const items: BlockedItem[] = left.map((item) => {
    const why = WHY[item.state];
    if (why) return { position: item.position, ticket: item.ticket, state: item.state, why };
    // waiting: for which of its "after" that has not landed.
    const behind = item.after.filter((p) => at.get(p)?.state !== 'landed').map((p) => `${p} (${at.get(p)?.state ?? 'missing'})`);
    return { position: item.position, ticket: item.ticket, state: item.state, why: `waits for ${behind.join(', ') || 'nothing: the runner makes it ready at its next tick'}` };
  });
  const named = (state: PlanItemState) => items.filter((i) => i.state === state).map((i) => `${i.position}${i.ticket ? ` (${i.ticket})` : ''}`);
  const parts = [['held', named('held')], ['parked', named('parked')], ['ready but not started', named('ready')]] as const;
  const what = parts.filter(([, list]) => list.length > 0).map(([label, list]) => `${list.join(', ')} ${label}`).join('; ');
  return { signature, reason: `plan ${plan.id} has nothing running and nothing to approve: ${what || 'every item left waits for another'}`, items };
}

// One line for the log and the report.
export function blockageLine(blockage: Blockage): string {
  return `${blockage.reason} (${blockage.items.map((i) => `item ${i.position}${i.ticket ? ` ${i.ticket}` : ''} ${i.why}`).join('; ')})`;
}
