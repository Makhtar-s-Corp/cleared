// Estimates from history (docs/v2/milestone-2-plan.md, section 5.2),
// computed by the service when a plan is proposed, never by the model.
//
//   A sample is a done ticket of the project with the same `size:<s>` label
//   and the same lane (the Quick label or not): its wall-clock from its
//   author's first RUN_STARTED to its release request (STEP_FINISHED
//   release), less the time it waited for the owner (waiting_human and
//   approval), and the sum of total_cost_usd of its sessions. With three
//   samples or more an item's estimate is their median; with fewer, the
//   defaults below. The v1 tickets the import brought (src/import/samples.ts,
//   milestone 4 plan, section 3) are samples too, without a cost: the cost
//   is the median of the samples that have one, three or more, else the
//   default, and the sample count then says so. The plan's time is its critical path: the runner's own
//   rule (ready items in position order, at most maxParallel at once) played
//   on the estimates, not their sum.
import type { DatabaseSync } from 'node:sqlite';
import type { Estimate, PlanItem, PlanStep } from '../../api/types.ts';
import { QUICK_LABEL } from '../../flow/engine.ts';
import type { SessionEvent } from '../../session/events.ts';
import { importedSamples } from '../../import/samples.ts';
import type { Store } from '../../store/db.ts';
import type { TicketStore } from '../../tickets/contract.ts';

type Size = PlanItem['size'];
type Lane = PlanItem['lane'];

// From the milestone 1 proof (a one-file ticket: author 40 s, review 29 s,
// $0.24), scaled up for real projects.
export const DEFAULT_ESTIMATES: Readonly<Record<Size, { readonly minutes: number; readonly costUsd: number }>> = {
  xs: { minutes: 5, costUsd: 0.15 },
  s: { minutes: 12, costUsd: 0.3 },
  m: { minutes: 30, costUsd: 0.8 },
  l: { minutes: 60, costUsd: 2 },
};

export const MIN_SAMPLES = 3;

export type Sample = { readonly size: Size; readonly lane: Lane; readonly minutes: number; readonly costUsd: number | null };

const SIZES: ReadonlySet<string> = new Set(['xs', 's', 'm', 'l']);
const WAITS: ReadonlySet<string> = new Set(['waiting_human', 'approval']);
const cents = (value: number) => Math.round(value * 100) / 100;

// The time and cost of one ticket from its sessions' events, or undefined
// when it never reached a release request.
export function ticketSample(events: readonly (SessionEvent & { readonly role: string })[]): { readonly minutes: number; readonly costUsd: number } | undefined {
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq - b.seq);
  const first = sorted.find((e) => e.role === 'author' && e.event.type === 'RUN_STARTED');
  const release = sorted.filter((e) => e.event.type === 'STEP_FINISHED' && e.event.stepName === 'release').at(-1);
  if (!first || !release) return undefined;
  const from = Date.parse(first.at);
  const to = Date.parse(release.at);
  if (!(to > from)) return undefined;
  // Each session's waits, clipped to the span: an open wait ends with the span.
  let waited = 0;
  const open = new Map<string, number>();
  for (const e of sorted) {
    if ((e.event.type !== 'STEP_STARTED' && e.event.type !== 'STEP_FINISHED') || !WAITS.has(e.event.stepName)) continue;
    const key = `${e.sessionId}:${e.event.stepName}`;
    const at = Date.parse(e.at);
    if (e.event.type === 'STEP_STARTED') open.set(key, at);
    else if (open.has(key)) {
      const began = open.get(key) as number;
      open.delete(key);
      waited += Math.max(0, Math.min(at, to) - Math.max(began, from));
    }
  }
  for (const began of open.values()) waited += Math.max(0, to - Math.max(began, from));
  let cost = 0;
  for (const e of sorted) if (e.event.type === 'RUN_FINISHED') cost += e.event.result.total_cost_usd ?? 0;
  return { minutes: Math.max(0, (to - from - waited) / 60_000), costUsd: cents(cost) };
}

// The project's done tickets that carry a size, as samples, then the v1
// tickets imported for it.
export async function historyOf(deps: { readonly tickets: TicketStore; readonly store: Pick<Store, 'events' | 'sessions'> & Partial<Pick<Store, 'db'>> }, project: string): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const ticket of await deps.tickets.list({ status: deps.tickets.states.done, project })) {
    const size = ticket.labels.find((label) => label.startsWith('size:'))?.slice(5);
    if (!size || !SIZES.has(size)) continue;
    const events = deps.store.sessions.list({ ticket: ticket.id }).filter((row) => row.project === project)
      .flatMap((row) => deps.store.events.after(row.id).map((e) => ({ ...e, role: row.role })));
    const sample = ticketSample(events);
    if (sample) out.push({ size: size as Size, lane: ticket.labels.includes(QUICK_LABEL) ? 'fast' : 'full', ...sample });
  }
  if (deps.store.db) out.push(...importedSamples(deps.store.db, project));
  return out;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] as number : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

// ---- the steps of an item (decision 26, lane 23) ------------------------

type StepKind = PlanStep['kind'];
export type StepSample = Sample & { readonly kind: StepKind };

// What a step costs by default, from its item's size: a contract step is a
// small change to one file; the integration step is a run of the tests that
// cross the services, with a fix, at most a small change; a service step
// is the item's own size.
export function stepSize(size: Size, kind: StepKind): Size {
  if (kind === 'contract') return 'xs';
  if (kind === 'integration') return size === 'xs' ? 'xs' : 's';
  return size;
}

// The medians of the done steps of the same kind, item size and lane, with
// three samples or more; else the default of the step's size.
export function stepEstimate(samples: readonly StepSample[], size: Size, lane: Lane, kind: StepKind): Estimate {
  return fromSamples(samples.filter((s) => s.kind === kind && s.size === size && s.lane === lane), DEFAULT_ESTIMATES[stepSize(size, kind)]);
}

// The medians of `same`, from three samples; the cost from three that have
// one. A default cost is never counted as history: the plan's panel says
// "Estimates from {n} similar tickets" from three samples, so the count is
// then the samples that have a cost.
function fromSamples(same: readonly Sample[], fallback: { readonly minutes: number; readonly costUsd: number }): Estimate {
  if (same.length < MIN_SAMPLES) return { ...fallback, weekPercent: null, samples: same.length };
  const costs = same.flatMap((s) => (s.costUsd === null ? [] : [s.costUsd]));
  const costed = costs.length >= MIN_SAMPLES;
  return {
    minutes: Math.max(1, Math.round(median(same.map((s) => s.minutes)))),
    costUsd: costed ? cents(median(costs)) : fallback.costUsd,
    weekPercent: null,
    samples: costed ? same.length : costs.length,
  };
}

// The steps of the project's done tickets that carry a size, from the
// flow's ticket_steps (flow/steps.ts): each done step with its cost and
// minutes. None before the table exists.
export async function stepHistoryOf(deps: { readonly tickets: TicketStore; readonly db: DatabaseSync }, project: string): Promise<StepSample[]> {
  let read: ReturnType<DatabaseSync['prepare']>;
  try {
    read = deps.db.prepare("SELECT kind, cost, minutes FROM ticket_steps WHERE ticket = ? AND project = ? AND state = 'done' AND cost IS NOT NULL AND minutes IS NOT NULL");
  } catch (error) {
    if (/no such table/.test((error as Error).message)) return [];
    throw error;
  }
  const out: StepSample[] = [];
  for (const ticket of await deps.tickets.list({ status: deps.tickets.states.done, project })) {
    const size = ticket.labels.find((label) => label.startsWith('size:'))?.slice(5);
    if (!size || !SIZES.has(size)) continue;
    const lane: Lane = ticket.labels.includes(QUICK_LABEL) ? 'fast' : 'full';
    for (const row of read.all(ticket.id, project) as Record<string, unknown>[])
      out.push({ kind: String(row.kind) as StepKind, size: size as Size, lane, minutes: Number(row.minutes), costUsd: Number(row.cost) });
  }
  return out;
}

// An item with steps: each step's estimate by kind; the item's cost their
// sum, its minutes their critical path, the ticket's steps running at most
// `maxParallel` at once (the flow's own limit, two when the plan runs none).
export function itemOfSteps(steps: readonly { readonly kind: StepKind; readonly service: string; readonly after: readonly number[] }[], samples: readonly StepSample[], size: Size, lane: Lane, maxParallel: number): { readonly steps: PlanStep[]; readonly estimate: Estimate } {
  const out = steps.map((step, index) => ({ position: index + 1, kind: step.kind, service: step.service, after: [...step.after], estimate: stepEstimate(samples, size, lane, step.kind) }));
  return {
    steps: out,
    estimate: {
      minutes: criticalPath(out.map((step) => ({ after: step.after, minutes: step.estimate.minutes })), maxParallel > 0 ? maxParallel : 2),
      costUsd: cents(out.reduce((total, step) => total + step.estimate.costUsd, 0)),
      weekPercent: null,
      samples: Math.min(...out.map((step) => step.estimate.samples)),
    },
  };
}

export function estimateFor(samples: readonly Sample[], size: Size, lane: Lane): Estimate {
  return fromSamples(samples.filter((s) => s.size === size && s.lane === lane), DEFAULT_ESTIMATES[size]);
}

// The plan's minutes: items started in position order once every item they
// wait for is done, at most maxParallel at once (a plan that runs nothing,
// maxParallel 0, is counted one at a time). An item whose dependencies can
// never be met (validation refuses it) is left out.
export function criticalPath(items: readonly { readonly after: readonly number[]; readonly minutes: number }[], maxParallel: number): number {
  const slots = Math.max(1, maxParallel);
  const done = new Map<number, number>();                   // position -> when it ends
  const running: { position: number; end: number }[] = [];
  let now = 0;
  for (;;) {
    for (const [index, item] of items.entries()) {
      const position = index + 1;
      if (running.length >= slots) break;
      if (done.has(position) || running.some((r) => r.position === position)) continue;
      if (!item.after.every((p) => done.has(p) && (done.get(p) as number) <= now)) continue;
      running.push({ position, end: now + item.minutes });
    }
    if (running.length === 0) break;
    running.sort((a, b) => a.end - b.end || a.position - b.position);
    const next = running.shift() as { position: number; end: number };
    now = next.end;
    done.set(next.position, next.end);
    while (running[0] && running[0].end === now) {
      const also = running.shift() as { position: number; end: number };
      done.set(also.position, also.end);
    }
  }
  return Math.max(0, ...done.values());
}

export function planTotals(items: readonly { readonly after: readonly number[]; readonly estimate: Estimate }[], maxParallel: number): Estimate {
  return {
    minutes: criticalPath(items.map((item) => ({ after: item.after, minutes: item.estimate.minutes })), maxParallel),
    costUsd: cents(items.reduce((total, item) => total + item.estimate.costUsd, 0)),
    weekPercent: null,
    samples: items.length ? Math.min(...items.map((item) => item.estimate.samples)) : 0,
  };
}

// "1 h 42", "40 min": how the screen and the thread say a duration.
export function duration(minutes: number): string {
  const rounded = Math.round(minutes);
  if (rounded < 60) return `${rounded} min`;
  const rest = rounded % 60;
  return `${Math.floor(rounded / 60)} h${rest ? ` ${String(rest).padStart(2, '0')}` : ''}`;
}
