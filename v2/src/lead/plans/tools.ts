// The lead's two plan tools (docs/v2/milestone-2-plan.md, section 3.2),
// registered with the lead through the engine's extensions (section 10:
// lane 5's tools.ts is not edited), with the plans' lines of the compact
// state and their section of the handover record. propose_plan's input is
// checked here: the SDK checked its schema, the host checks what a plan is.
import type { LeadExtensions } from '../engine.ts';
import type { LeadToolInput, PlanItemInput } from '../contract.ts';
import { HostToolRefused } from '../../session/contract.ts';
import type { PlanRunner } from './runner.ts';
import { itemServices, type PlanService } from './store.ts';

export { itemServices } from './store.ts';

export const MAX_ITEMS = 12;
export const MAX_TITLE = 120;
const MAX_SUMMARY = 2000;
const MAX_BODY = 20_000;
const CRITERION = /^\s*[-*] \[ \] \S/m;

export type ValidPlan = LeadToolInput['propose_plan'] & { readonly items: readonly (PlanItemInput & { readonly after: readonly number[] })[] };

const refuse = (message: string): never => { throw new HostToolRefused(message); };

function text(value: unknown, what: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') return refuse(`Give ${what}.`);
  if (value.length > max) return refuse(`${what[0]?.toUpperCase()}${what.slice(1)} is at most ${max} characters.`);
  return value.trim();
}

// A plan the runner can run: 1 to 12 items, each with a title of at most
// 120 characters, a body with at least one "- [ ]" criterion, a lane, a
// size, and the positions it waits for, which exist, are not its own, and
// make no cycle. A position given twice is kept once.
export function validatePlan(input: unknown): ValidPlan {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const goal = text(value.goal, 'the goal id this plan answers', MAX_TITLE);
  const title = text(value.title, 'the plan title', MAX_TITLE);
  const summary = text(value.summary, 'the summary', MAX_SUMMARY);
  const raw = value.items;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ITEMS) return refuse(`A plan has 1 to ${MAX_ITEMS} items; split a larger goal into several plans.`);
  const items = raw.map((entry: unknown, index) => {
    const n = index + 1;
    const item = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const itemTitle = text(item.title, `the title of item ${n}`, MAX_TITLE);
    const body = text(item.body, `the body of item ${n}`, MAX_BODY);
    if (!CRITERION.test(body)) refuse(`Item ${n}'s body needs at least one "- [ ]" acceptance criterion.`);
    if (item.lane !== 'fast' && item.lane !== 'full') refuse(`Item ${n}'s lane is fast or full.`);
    if (!['xs', 's', 'm', 'l'].includes(item.size as string)) refuse(`Item ${n}'s size is xs, s, m or l.`);
    const after = item.after ?? [];
    if (!Array.isArray(after)) return refuse(`Item ${n}'s after is a list of positions.`);
    for (const p of after) {
      if (!Number.isInteger(p)) refuse(`Item ${n}'s after lists positions, whole numbers from 1 to ${raw.length}.`);
      if (p === n) refuse(`Item ${n} cannot wait for itself.`);
      if (p < 1 || p > raw.length) refuse(`Item ${n} waits for position ${p}, which the plan does not have.`);
    }
    return { title: itemTitle, body, lane: item.lane as PlanItemInput['lane'], size: item.size as PlanItemInput['size'], after: [...new Set(after as number[])].sort((a, b) => a - b) };
  });
  // Depth-first: a position met again on the path is a cycle.
  const state = new Map<number, 'open' | 'done'>();
  const visit = (position: number, path: number[]): void => {
    if (state.get(position) === 'done') return;
    if (state.get(position) === 'open') refuse(`The items wait for one another in a cycle (${[...path.slice(path.indexOf(position)), position].join(' after ')}): order them.`);
    state.set(position, 'open');
    for (const p of items[position - 1]?.after ?? []) visit(p, [...path, position]);
    state.set(position, 'done');
  };
  for (let position = 1; position <= items.length; position++) visit(position, []);
  return { goal, title, summary, items };
}

// Decision 24: a service whose sensitivity is `full` refuses the fast lane
// for any ticket touching it. The note ends the item's body, so the lead,
// the plan panel and the ticket's author read why its lane changed.
export function fullLaneNote(services: readonly string[]): string {
  const names = services.length < 2 ? services.join('') : `${services.slice(0, -1).join(', ')} and ${services.at(-1)}`;
  return `Cleared: this item runs in the full lane, not the fast one it was proposed in, since ${names} ${services.length === 1 ? 'has' : 'have'} the full sensitivity.`;
}

// The lead's input with every fast item that touches a full service made
// full, with its note, before the runner validates and estimates it, so
// its estimate is the full lane's and its ticket has no Quick label. An
// input that is not a plan is left as it is, for the validation to refuse.
export function applySensitivity(input: unknown, services: readonly PlanService[]): unknown {
  const value = input as { items?: unknown } | null;
  if (services.length === 0 || typeof value !== 'object' || value === null || !Array.isArray(value.items)) return input;
  return {
    ...value,
    items: value.items.map((entry: unknown) => {
      const item = entry as { lane?: unknown; body?: unknown } | null;
      if (typeof item !== 'object' || item === null || item.lane !== 'fast' || typeof item.body !== 'string') return entry;
      const full = itemServices(item.body, services).filter((service) => service.sensitivity === 'full').map((service) => service.name);
      return full.length === 0 ? entry : { ...item, lane: 'full', body: `${item.body.trimEnd()}\n\n${fullLaneNote(full)}` };
    }),
  };
}

// The extensions the lead module gives the lead's engine. The runner is
// built with the lead, so its tools ask for it when called.
export function planExtensions(plans: () => PlanRunner | undefined): LeadExtensions {
  const runner = (): PlanRunner => plans() ?? refuse('The plans are not running yet: try again in a moment.');
  return {
    tools: {
      propose_plan: async (input) => {
        const plans = runner();
        return plans.propose(applySensitivity(input, plans.store.services()));
      },
      start_ticket: async (input) => {
        const value = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
        return runner().startTicket(text(value.id, 'the ticket id', MAX_TITLE), text(value.reason, 'the reason', MAX_SUMMARY));
      },
    },
    state: [() => plans()?.stateLines() ?? ''],
    handover: [() => plans()?.handoverSection() ?? ''],
  };
}
