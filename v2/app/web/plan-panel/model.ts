// The plan panel of lead-and-plan.png, shared by the lead screen and the
// inbox's plan item (lane 10): what the panel says of a plan, as pure
// functions, so the tests run them under Node; PlanPanel.tsx draws it. A
// page loads only the shell's catalog and its own, so the panel names its
// keys in PLAN_PANEL_KEYS, and each screen's catalog holds them
// (messages/lead.* here, messages/inbox.* for lane 10). Every key is written
// out whole, so a test can read the list from this file.
import type { Plan, PlanItem, PlanState, PlanStep, ServiceSensitivity } from '../../../src/api/types.ts';
import type { Translate } from '../lib/i18n.ts';

export const PLAN_PANEL_KEYS = [
  'plan_state_proposed', 'plan_state_approved', 'plan_state_paused', 'plan_state_done', 'plan_state_superseded', 'plan_state_rejected',
  'plan_progress', 'plan_items_label', 'plan_after', 'plan_and',
  'plan_lane_full', 'plan_lane_fast',
  'plan_item_waiting', 'plan_item_ready', 'plan_item_running', 'plan_item_needs_approval', 'plan_item_landed', 'plan_item_put_back', 'plan_item_held', 'plan_item_cancelled',
  'plan_minutes', 'plan_hours', 'plan_hours_minutes', 'plan_estimate', 'plan_week_share', 'plan_cost',
  'plan_work', 'plan_week_total', 'plan_cost_total', 'plan_parallel', 'plan_parallel_one', 'plan_samples', 'plan_defaults',
  'plan_change', 'plan_approve', 'plan_pause', 'plan_resume',
  'plan_steps_label', 'plan_step_contract', 'plan_step_service', 'plan_step_integration', 'plan_step_after',
] as const;

// The services an item names, with their sensitivity (decisions 18 and 24,
// lane 22). Their keys are not in PLAN_PANEL_KEYS, which the inbox's catalog
// must hold (lane 21's file in this wave): the lead's catalog holds them, and
// a screen asks for the chips with `services` once its catalog holds them too.
export const PLAN_SERVICE_KEYS = ['services_label', 'sensitivity_full', 'sensitivity_reviewer', 'sensitivity_human', 'sensitivity_other'] as const;

export type PlanAction = 'change' | 'approve' | 'pause' | 'resume';

export type PlanPanelOptions = {
  readonly language?: 'en' | 'fr';      // for the numbers: 0.30 or 0,30
  readonly busy?: boolean;              // a gesture is on its way: the buttons wait
  readonly note?: string | null;        // what the last gesture came to, said under the buttons
  readonly actions?: boolean;           // false: the panel without its buttons
  readonly services?: boolean;          // true: each item's services, as chips (PLAN_SERVICE_KEYS)
};

export const STATE_KEYS: Readonly<Record<PlanState, string>> = {
  proposed: 'plan_state_proposed', approved: 'plan_state_approved', paused: 'plan_state_paused',
  done: 'plan_state_done', superseded: 'plan_state_superseded', rejected: 'plan_state_rejected',
};
export const ITEM_KEYS: Readonly<Record<PlanItem['state'], string>> = {
  waiting: 'plan_item_waiting', ready: 'plan_item_ready', running: 'plan_item_running', needs_approval: 'plan_item_needs_approval',
  landed: 'plan_item_landed', put_back: 'plan_item_put_back', held: 'plan_item_held', cancelled: 'plan_item_cancelled',
};
export const LANE_KEYS: Readonly<Record<PlanItem['lane'], string>> = { full: 'plan_lane_full', fast: 'plan_lane_fast' };
export const ACTION_KEYS: Readonly<Record<PlanAction, string>> = { change: 'plan_change', approve: 'plan_approve', pause: 'plan_pause', resume: 'plan_resume' };

// The gestures each state offers: a plan to approve is approved or changed;
// a running one is paused; a paused one is resumed, or changed by asking
// the lead for a new plan of what remains (milestone 2 plan, section 5.4).
export const ACTIONS: Readonly<Record<PlanState, readonly PlanAction[]>> = {
  proposed: ['change', 'approve'], approved: ['pause'], paused: ['change', 'resume'], done: [], superseded: [], rejected: [],
};

// A state the maps do not know (a later lane's) reads as the service wrote
// it, rather than an unknown key that would blank the panel (issue 177).
export const stateText = (state: PlanState, t: Translate): string => (Object.hasOwn(STATE_KEYS, state) ? t(STATE_KEYS[state]) : state);
export const itemStateText = (state: PlanItem['state'], t: Translate): string => (Object.hasOwn(ITEM_KEYS, state) ? t(ITEM_KEYS[state]) : state);

export type ServiceChip = {
  readonly service: string;
  readonly kind: 'normal' | 'full' | 'reviewer' | 'human' | 'other';
  readonly who: string | null;           // the reviewer's model family, the approving user, or the setting as written
};

// 'claude-opus-5-5' reads 'Opus', as the tower names a reviewer.
function family(model: string): string {
  const match = /(opus|sonnet|haiku|fable)/i.exec(model)?.[1];
  return match ? match.charAt(0).toUpperCase() + match.slice(1).toLowerCase() : model;
}

function chip(service: string, sensitivity: ServiceSensitivity): ServiceChip {
  if (sensitivity === 'normal') return { service, kind: 'normal', who: null };
  if (sensitivity === 'full') return { service, kind: 'full', who: null };
  if (sensitivity.startsWith('reviewer:')) return { service, kind: 'reviewer', who: family(sensitivity.slice('reviewer:'.length)) };
  if (sensitivity.startsWith('human:')) return { service, kind: 'human', who: sensitivity.slice('human:'.length) };
  return { service, kind: 'other', who: sensitivity };
}

// The chips of an item: every service its body names once the plan names
// two services, or one of them is not of normal sensitivity; none otherwise,
// so a plan of a one-service workspace reads as before.
export function serviceChips(item: PlanItem, plan: Plan): ServiceChip[] {
  const named = item.sensitivity ?? [];
  const services = new Set(plan.items.flatMap((i) => (i.sensitivity ?? []).map((s) => s.service)));
  if (services.size < 2 && named.every((s) => s.sensitivity === 'normal')) return [];
  return named.map((s) => chip(s.service, s.sensitivity));
}

export function chipText(c: ServiceChip, t: Translate): string {
  switch (c.kind) {
    case 'normal': return c.service;
    case 'full': return t('sensitivity_full', { service: c.service });
    case 'reviewer': return t('sensitivity_reviewer', { service: c.service, model: c.who ?? '' });
    case 'human': return t('sensitivity_human', { service: c.service, user: c.who ?? '' });
    case 'other': return t('sensitivity_other', { service: c.service, value: c.who ?? '' });
  }
}

// 40 min, 1 h, 2 h 15: the critical path or an estimate, never zero.
export function formatDuration(minutes: number, t: Translate): string {
  const whole = Math.max(1, Math.round(minutes));
  if (whole < 60) return t('plan_minutes', { n: whole });
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return m === 0 ? t('plan_hours', { h }) : t('plan_hours_minutes', { h, m: String(m).padStart(2, '0') });
}

export const decimals = (value: number, digits: number, language: 'en' | 'fr') =>
  new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(value);

// The share of the week when the harness reports it, else the cost
// (section 5.2: "$0.30" in place of "1.2 %" until the week is measured).
export function share(estimate: PlanItem['estimate'], t: Translate, language: 'en' | 'fr'): string {
  return estimate.weekPercent === null
    ? t('plan_cost', { amount: decimals(estimate.costUsd, 2, language) })
    : t('plan_week_share', { n: decimals(estimate.weekPercent, 1, language) });
}

// "1", "1 and 2", "1, 2, 3 and 4".
export function positions(after: readonly number[], t: Translate): string {
  if (after.length <= 1) return after.join('');
  return `${after.slice(0, -1).join(', ')} ${t('plan_and')} ${after.at(-1)}`;
}

// The eyebrow: "Plan to approve", or the state with what landed once it runs.
export function planStateLine(plan: Plan, t: Translate): string {
  const state = stateText(plan.state, t);
  if (plan.state !== 'approved' && plan.state !== 'paused' && plan.state !== 'done') return state;
  const counted = plan.items.filter((item) => item.state !== 'cancelled');
  return t('plan_progress', { state, landed: counted.filter((item) => item.state === 'landed').length, total: counted.length });
}

export function facts(plan: Plan, t: Translate, language: 'en' | 'fr'): string[] {
  const { totals } = plan;
  return [
    t('plan_work', { time: formatDuration(totals.minutes, t) }),
    totals.weekPercent === null
      ? t('plan_cost_total', { amount: t('plan_cost', { amount: decimals(totals.costUsd, 2, language) }) })
      : t('plan_week_total', { n: decimals(totals.weekPercent, 1, language) }),
    plan.maxParallel === 1 ? t('plan_parallel_one') : t('plan_parallel', { n: plan.maxParallel }),
    totals.samples >= 3 ? t('plan_samples', { n: totals.samples }) : t('plan_defaults'),
  ];
}

// An item's steps across services (decision 26, lane 23's PlanItem.steps),
// in their order: the contract, a step per service, the integration. An
// item of one step, or none, shows none: it reads as before (lane 27).
export function planSteps(item: PlanItem): PlanStep[] {
  const steps = item.steps ?? [];
  return steps.length < 2 ? [] : [...steps].sort((a, b) => a.position - b.position);
}

const STEP_KEYS: Readonly<Record<PlanStep['kind'], string>> = { contract: 'plan_step_contract', service: 'plan_step_service', integration: 'plan_step_integration' };

// "Integration · guestbook · after 2 and 3 · 10 min · $0.20".
export function stepText(step: PlanStep, t: Translate, language: 'en' | 'fr'): string {
  const kind = Object.hasOwn(STEP_KEYS, step.kind) ? t(STEP_KEYS[step.kind]) : step.kind;
  const after = step.after.length > 0 ? [t('plan_step_after', { list: positions(step.after, t) })] : [];
  return [kind, step.service, ...after, formatDuration(step.estimate.minutes, t), share(step.estimate, t, language)].join(' · ');
}
