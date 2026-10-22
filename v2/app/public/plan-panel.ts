// The plan panel of lead-and-plan.png, shared by the lead screen and the
// inbox's plan item (lane 10): a pure function from a plan and a translator
// to escaped HTML, so both screens render the same panel and the tests run
// it under Node. A page loads only the shell's catalog and its own, so the
// panel names its keys in PLAN_PANEL_KEYS, and each screen's catalog holds
// them (messages/lead.* here, messages/inbox.* for lane 10). Every key is
// written out whole, so a test can read the list from this file.
//
// The buttons carry data-plan-action ("change", "approve", "pause",
// "resume"); the screen that mounts the panel binds them.
import type { Plan, PlanItem, PlanState } from '../../src/api/types.ts';
import { esc } from './html.ts';
import type { Translate } from './i18n.ts';

export const PLAN_PANEL_KEYS = [
  'plan_state_proposed', 'plan_state_approved', 'plan_state_paused', 'plan_state_done', 'plan_state_superseded', 'plan_state_rejected',
  'plan_progress', 'plan_items_label', 'plan_after', 'plan_and',
  'plan_lane_full', 'plan_lane_fast',
  'plan_item_waiting', 'plan_item_ready', 'plan_item_running', 'plan_item_needs_approval', 'plan_item_landed', 'plan_item_put_back', 'plan_item_held', 'plan_item_cancelled',
  'plan_minutes', 'plan_hours', 'plan_hours_minutes', 'plan_estimate', 'plan_week_share', 'plan_cost',
  'plan_work', 'plan_week_total', 'plan_cost_total', 'plan_parallel', 'plan_parallel_one', 'plan_samples', 'plan_defaults',
  'plan_change', 'plan_approve', 'plan_pause', 'plan_resume',
] as const;

export type PlanAction = 'change' | 'approve' | 'pause' | 'resume';

export type PlanPanelOptions = {
  readonly language?: 'en' | 'fr';      // for the numbers: 0.30 or 0,30
  readonly busy?: boolean;              // a gesture is on its way: the buttons wait
  readonly note?: string | null;        // what the last gesture came to, said under the buttons
  readonly actions?: boolean;           // false: the panel without its buttons
};

const STATE_KEYS: Readonly<Record<PlanState, string>> = {
  proposed: 'plan_state_proposed', approved: 'plan_state_approved', paused: 'plan_state_paused',
  done: 'plan_state_done', superseded: 'plan_state_superseded', rejected: 'plan_state_rejected',
};
const ITEM_KEYS: Readonly<Record<PlanItem['state'], string>> = {
  waiting: 'plan_item_waiting', ready: 'plan_item_ready', running: 'plan_item_running', needs_approval: 'plan_item_needs_approval',
  landed: 'plan_item_landed', put_back: 'plan_item_put_back', held: 'plan_item_held', cancelled: 'plan_item_cancelled',
};
const LANE_KEYS: Readonly<Record<PlanItem['lane'], string>> = { full: 'plan_lane_full', fast: 'plan_lane_fast' };
const ACTION_KEYS: Readonly<Record<PlanAction, string>> = { change: 'plan_change', approve: 'plan_approve', pause: 'plan_pause', resume: 'plan_resume' };

// The gestures each state offers: a plan to approve is approved or changed;
// a running one is paused; a paused one is resumed, or changed by asking
// the lead for a new plan of what remains (milestone 2 plan, section 5.4).
const ACTIONS: Readonly<Record<PlanState, readonly PlanAction[]>> = {
  proposed: ['change', 'approve'], approved: ['pause'], paused: ['change', 'resume'], done: [], superseded: [], rejected: [],
};

// 40 min, 1 h, 2 h 15: the critical path or an estimate, never zero.
export function formatDuration(minutes: number, t: Translate): string {
  const whole = Math.max(1, Math.round(minutes));
  if (whole < 60) return t('plan_minutes', { n: whole });
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return m === 0 ? t('plan_hours', { h }) : t('plan_hours_minutes', { h, m: String(m).padStart(2, '0') });
}

const decimals = (value: number, digits: number, language: 'en' | 'fr') =>
  new Intl.NumberFormat(language, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(value);

// The share of the week when the harness reports it, else the cost
// (section 5.2: "$0.30" in place of "1.2 %" until the week is measured).
function share(estimate: PlanItem['estimate'], t: Translate, language: 'en' | 'fr'): string {
  return estimate.weekPercent === null
    ? t('plan_cost', { amount: decimals(estimate.costUsd, 2, language) })
    : t('plan_week_share', { n: decimals(estimate.weekPercent, 1, language) });
}

// "1", "1 and 2", "1, 2, 3 and 4".
function positions(after: readonly number[], t: Translate): string {
  if (after.length <= 1) return after.join('');
  return `${after.slice(0, -1).join(', ')} ${t('plan_and')} ${after.at(-1)}`;
}

// The eyebrow: "Plan to approve", or the state with what landed once it runs.
export function planStateLine(plan: Plan, t: Translate): string {
  const state = t(STATE_KEYS[plan.state]);
  if (plan.state !== 'approved' && plan.state !== 'paused' && plan.state !== 'done') return state;
  const counted = plan.items.filter((item) => item.state !== 'cancelled');
  return t('plan_progress', { state, landed: counted.filter((item) => item.state === 'landed').length, total: counted.length });
}

function renderItem(item: PlanItem, plan: Plan, t: Translate, language: 'en' | 'fr'): string {
  const started = plan.state !== 'proposed' && plan.state !== 'superseded' && plan.state !== 'rejected';
  const after = item.after.length > 0 ? `<p class="plan-after">${esc(t('plan_after', { list: positions(item.after, t) }))}</p>` : '';
  const progress = started
    ? `<p class="plan-progress"><span class="item-state ${item.state}">${esc(t(ITEM_KEYS[item.state]))}</span>${item.ticket ? ` <span class="id">${esc(item.ticket)}</span>` : ''}</p>`
    : '';
  return `<li class="plan-item" data-position="${item.position}">
<span class="plan-n" aria-hidden="true">${item.position}</span>
<div class="plan-what"><p class="plan-item-title">${esc(item.title)}</p>${after}${progress}</div>
<span class="lane ${item.lane}">${esc(t(LANE_KEYS[item.lane]))}</span>
<span class="plan-estimate">${esc(t('plan_estimate', { time: formatDuration(item.estimate.minutes, t), share: share(item.estimate, t, language) }))}</span>
</li>`;
}

function facts(plan: Plan, t: Translate, language: 'en' | 'fr'): string[] {
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

export function renderPlanPanel(plan: Plan, t: Translate, options: PlanPanelOptions = {}): string {
  const language = options.language ?? 'en';
  const id = `plan-title-${plan.id}`;
  const actions = options.actions === false ? [] : ACTIONS[plan.state];
  const disabled = options.busy ? ' disabled' : '';
  const buttons = actions.map((action) => action === 'change'
    ? `<button type="button" class="plain plan-change" data-plan-action="change"${disabled}>${esc(t(ACTION_KEYS[action]))}</button>`
    : `<button type="button" class="primary plan-go" data-plan-action="${action}"${disabled}>${esc(t(ACTION_KEYS[action]))}</button>`);
  const note = options.note ? `<p class="plan-note" role="status">${esc(options.note)}</p>` : '';
  return `<section class="plan-panel${plan.state === 'proposed' ? ' awaiting' : ''}" data-plan="${esc(plan.id)}" data-state="${plan.state}" aria-labelledby="${esc(id)}"${options.busy ? ' aria-busy="true"' : ''}>
<div class="plan-head"><p class="plan-eyebrow">${esc(planStateLine(plan, t))}</p>
<h2 id="${esc(id)}">${esc(plan.title)}</h2>
<p class="plan-summary">${esc(plan.summary)}</p></div>
<ol class="plan-items" aria-label="${esc(t('plan_items_label'))}">${plan.items.map((item) => renderItem(item, plan, t, language)).join('')}</ol>
<ul class="plan-facts">${facts(plan, t, language).map((fact) => `<li class="plan-fact">${esc(fact)}</li>`).join('')}</ul>
${buttons.length > 0 || note ? `<div class="plan-actions">${buttons.join('')}${note}</div>` : ''}
</section>`;
}
