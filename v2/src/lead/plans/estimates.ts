// Estimates from history (docs/v2/milestone-2-plan.md, section 5.2),
// computed by the service when a plan is proposed, never by the model.
//
//   A sample is a done ticket of the project with the same `size:<s>` label
//   and the same lane (the Quick label or not): its wall-clock from its
//   author's first RUN_STARTED to its release request (STEP_FINISHED
//   release), less the time it waited for the owner (waiting_human and
//   approval), and the sum of total_cost_usd of its sessions. With three
//   samples or more an item's estimate is their median; with fewer, the
//   defaults below. The plan's time is its critical path: the runner's own
//   rule (ready items in position order, at most maxParallel at once) played
//   on the estimates, not their sum.
import type { Estimate, PlanItem } from '../../api/types.ts';
import { QUICK_LABEL } from '../../flow/engine.ts';
import type { SessionEvent } from '../../session/events.ts';
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

export type Sample = { readonly size: Size; readonly lane: Lane; readonly minutes: number; readonly costUsd: number };

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

// The project's done tickets that carry a size, as samples.
export async function historyOf(deps: { readonly tickets: TicketStore; readonly store: Pick<Store, 'events' | 'sessions'> }, project: string): Promise<Sample[]> {
  const out: Sample[] = [];
  for (const ticket of await deps.tickets.list({ status: deps.tickets.states.done, project })) {
    const size = ticket.labels.find((label) => label.startsWith('size:'))?.slice(5);
    if (!size || !SIZES.has(size)) continue;
    const events = deps.store.sessions.list({ ticket: ticket.id }).filter((row) => row.project === project)
      .flatMap((row) => deps.store.events.after(row.id).map((e) => ({ ...e, role: row.role })));
    const sample = ticketSample(events);
    if (sample) out.push({ size: size as Size, lane: ticket.labels.includes(QUICK_LABEL) ? 'fast' : 'full', ...sample });
  }
  return out;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] as number : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export function estimateFor(samples: readonly Sample[], size: Size, lane: Lane): Estimate {
  const same = samples.filter((s) => s.size === size && s.lane === lane);
  if (same.length < MIN_SAMPLES) return { ...DEFAULT_ESTIMATES[size], weekPercent: null, samples: same.length };
  return { minutes: Math.max(1, Math.round(median(same.map((s) => s.minutes)))), costUsd: cents(median(same.map((s) => s.costUsd))), weekPercent: null, samples: same.length };
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
