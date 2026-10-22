// The plan panel of lead-and-plan.png, shared by the lead screen and the
// inbox's plan item: the plan's state, its items with their lanes and
// estimates, its totals and the gestures its state offers. Ink for the
// gesture the plan waits for (approve, resume); Change and Pause are
// outlined, since a running plan needs nothing of the person.
import { ShieldCheck } from '@phosphor-icons/react';
import type { Plan, PlanItem } from '../../../src/api/types.ts';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { ACTION_KEYS, ACTIONS, chipText, facts, formatDuration, itemStateText, LANE_KEYS, planStateLine, positions, serviceChips, share, type PlanAction, type PlanPanelOptions } from './model.ts';

function Item({ item, plan, t, language, services }: { readonly item: PlanItem; readonly plan: Plan; readonly t: Translate; readonly language: 'en' | 'fr'; readonly services: boolean }) {
  const chips = services ? serviceChips(item, plan) : [];
  const started = plan.state !== 'proposed' && plan.state !== 'superseded' && plan.state !== 'rejected';
  return (
    <li className="plan-item" data-position={item.position}>
      <span className="plan-n" aria-hidden="true">{item.position}</span>
      <div className="plan-what">
        <p className="plan-item-title">{item.title}</p>
        {chips.length > 0 ? (
          <ul className="plan-services" aria-label={t('services_label')}>
            {chips.map((c) => c.kind === 'normal' ? <li key={c.service} className="svc-chip">{chipText(c, t)}</li>
              : <li key={c.service} className="svc-chip sensitive" data-sensitivity={c.kind}><ShieldCheck size={12} aria-hidden="true" />{chipText(c, t)}</li>)}
          </ul>
        ) : null}
        {item.after.length > 0 ? <p className="plan-after">{t('plan_after', { list: positions(item.after, t) })}</p> : null}
        {started ? (
          <p className="plan-progress">
            <span className={`item-state ${item.state}`}>{itemStateText(item.state, t)}</span>
            {item.ticket ? <>{' '}<span className="id">{item.ticket}</span></> : null}
          </p>
        ) : null}
      </div>
      <span className={`lane ${item.lane}`}>{t(LANE_KEYS[item.lane])}</span>
      <span className="plan-estimate">{t('plan_estimate', { time: formatDuration(item.estimate.minutes, t), share: share(item.estimate, t, language) })}</span>
    </li>
  );
}

export function PlanPanel({ plan, t, options = {}, onAction }: {
  readonly plan: Plan; readonly t: Translate; readonly options?: PlanPanelOptions; readonly onAction?: (action: PlanAction) => void;
}) {
  const language = options.language ?? 'en';
  const id = `plan-title-${plan.id}`;
  const actions = options.actions === false ? [] : ACTIONS[plan.state];
  const busy = options.busy ?? false;
  return (
    <section className={`plan-panel${plan.state === 'proposed' ? ' awaiting' : ''}`} data-plan={plan.id} data-state={plan.state} aria-labelledby={id} aria-busy={busy ? 'true' : undefined}>
      <div className="plan-head">
        <p className="plan-eyebrow">{planStateLine(plan, t)}</p>
        <h2 id={id}>{plan.title}</h2>
        <p className="plan-summary">{plan.summary}</p>
      </div>
      <ol className="plan-items" aria-label={t('plan_items_label')}>
        {plan.items.map((item) => <Item key={item.position} item={item} plan={plan} t={t} language={language} services={options.services === true} />)}
      </ol>
      <ul className="plan-facts">{facts(plan, t, language).map((fact) => <li className="plan-fact" key={fact}>{fact}</li>)}</ul>
      {actions.length > 0 || options.note ? (
        <div className="plan-actions">
          {actions.map((action) => action === 'change' || action === 'pause'
            ? <Button key={action} variant="outline" className={`plain plan-${action === 'change' ? 'change' : 'quiet'}`} data-plan-action={action} disabled={busy} onClick={() => onAction?.(action)}>{t(ACTION_KEYS[action])}</Button>
            : <Button key={action} variant="ink" className="primary plan-go" data-plan-action={action} disabled={busy} onClick={() => onAction?.(action)}>{t(ACTION_KEYS[action])}</Button>)}
          {options.note ? <p className="plan-note" role="status">{options.note}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
