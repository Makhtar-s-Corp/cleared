// What a person reads first on the session screen (the owner's request of
// 2026-10-31, issue #499): the ticket, what the agent does now, the one action
// expected of them, where the ticket is, its cost and duration, its result. The
// rules are glance.ts's; everything else is in the fold under "Show details".
import { ArrowUpRight, CaretRight, Check, Circle, CircleDashed, X } from '@phosphor-icons/react';
import { useId, type ReactNode } from 'react';
import { OwnChoices } from '@/components/choices/Choices.tsx';
import type { Answers } from '@/components/choices/model.ts';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { commandParts } from '@/lib/intent.ts';
import { requestAsk, requestFold, requestFoldOpen, requestReason } from '@/lib/request.ts';
import { doingNow, planSteps, type Capture, type PendingAction, type PullRequest, type Result, type StageView } from './glance.ts';
import { phaseOf, questionStatus, statusTone, target, type RequestState, type SessionView, type ToolRow } from './model.ts';
import { partsOf } from './ticket.ts';

// A command as it ran, one command a line, the operator before each.
export function CommandLines({ command }: { readonly command: string }) {
  return (
    <pre className="command"><code>{commandParts(command).map((part, index) => (
      <span key={index} className="command-line">{part.op ? <span className="op">{part.op} </span> : null}{part.text}{'\n'}</span>
    ))}</code></pre>
  );
}

// The fold of a card: "Show details", open by itself when it must be read.
function Detail({ t, open = false, children }: { readonly t: Translate; readonly open?: boolean; readonly children: ReactNode }) {
  return (
    <details className="s-action-fold" open={open}>
      <summary><CaretRight className="caret" size={12} aria-hidden="true" />{t('details_title')}</summary>
      {children}
    </details>
  );
}

// The ticket, and what the agent does now in one sentence.
export function SessionHead({ view, t, onTicket }: { readonly view: SessionView; readonly t: Translate; readonly onTicket?: () => void }) {
  const service = view.summary.service;
  return (
    <header className="s-head">
      <h1 className="s-title">{view.ticket?.title ?? view.summary.ticket}</h1>
      <p className="s-ticket">
        <button type="button" className="link-button id" data-act="open_ticket" aria-label={t('glance_ticket_open', { ticket: view.summary.ticket })} onClick={onTicket}>{view.summary.ticket}</button>
        {service ? <span className="s-ticket-service">{service}</span> : null}
      </p>
      <p className="s-now" id="status" data-tone={statusTone(view)}><span className="dot" aria-hidden="true" /><span>{doingNow(view, t)}</span></p>
      {phaseOf(view) === 'failed' && view.ticket?.status === 'Todo' ? <p className="s-now-next">{t('glance_back_todo')}</p> : null}
    </header>
  );
}

// A permission, asked in the person's words; the command and the service's own sentence behind "Show details".
function RequestAction({ row, request, role, view, t, onAnswer }: {
  readonly row: ToolRow; readonly request: RequestState; readonly role: SessionView['summary']['role']; readonly view: SessionView; readonly t: Translate;
  readonly onAnswer?: (kind: string) => void;
}) {
  const input = row.input;
  const asked = input ? { input, tool: row.name } : undefined;
  const title = asked ? requestAsk(asked, role, t) : t('wants_other', { tool: row.name });
  const why = asked ? requestReason(asked, request.suggestion, t) : {};
  const description = input?.kind === 'execute' && input.description ? input.description : '';
  const fold = input ? requestFold(input) : [];
  const off = view.busy?.has(request.requestId) ?? false;
  return (
    <div data-row="request" data-request-id={request.requestId} data-command={input ? target(input) : undefined} role="group" aria-label={t('request_group')}>
      <p className="s-action-title">{title}</p>
      <p className="s-action-why">{why.said ? <span>{why.said} </span> : null}{t('glance_only_this')}</p>
      <div className="s-action-buttons">
        <Button variant="ink" className="btn primary" data-answer="allow_once" disabled={off} onClick={() => onAnswer?.('allow_once')}>{t('allow_once')}</Button>
        <Button className="btn" data-answer="allow_always" disabled={off} onClick={() => onAnswer?.('allow_always')}>{t('allow_always')}</Button>
        <Button className="btn" data-answer="reject_once" disabled={off} onClick={() => onAnswer?.('reject_once')}>{t('deny')}</Button>
      </div>
      {fold.length > 0 ? (
        <Detail t={t} open={asked ? requestFoldOpen(asked) : false}>
          {input?.kind === 'execute' ? <CommandLines command={input.command} /> : <pre className="command"><code>{fold[0]?.text ?? ''}</code></pre>}
          {description || why.raw ? <p className="s-action-note">{description ? <span>{description}</span> : null}{why.raw ? <span>{why.raw}</span> : null}</p> : null}
        </Detail>
      ) : null}
    </div>
  );
}

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

function PullRequestLink({ pr, t }: { readonly pr: PullRequest; readonly t: Translate }) {
  return <a className="s-link" href={pr.url} {...external} data-pull-request={pr.number}>{t('glance_pr', { n: pr.number })}<ArrowUpRight size={13} aria-hidden="true" /></a>;
}

// The one thing expected of the person, at the top, never another session's.
export function ActionCard({ action, view, t, plan, giveback, onAnswer, onQuestion }: {
  readonly action: PendingAction; readonly view: SessionView; readonly t: Translate;
  readonly plan?: ReactNode;          // the plan's gate (Tabs.tsx PlanGate), with its own state
  readonly giveback?: ReactNode;      // Give back, with its own gesture
  readonly onAnswer?: (requestId: string, kind: string, session: string) => void;
  readonly onQuestion?: (requestId: string, answers: Answers, chosen: readonly string[], session: string) => void;
}) {
  const heading = useId();
  const parts = partsOf(view);
  const own = 'session' in action ? parts.find((part) => part.summary.id === action.session) : undefined;
  const body = (() => {
    switch (action.kind) {
      case 'permission':
        return <RequestAction row={action.row} request={action.request} role={own?.summary.role ?? view.summary.role} view={view} t={t} onAnswer={(kind) => onAnswer?.(action.requestId, kind, action.session)} />;
      case 'question': {
        const shown = own?.thread ? { ...view, summary: own.summary, thread: own.thread } : view;
        const status = questionStatus(action.row, shown, t);
        const questions = shown.thread.interrupts.find((one) => one.id === action.requestId)?.metadata.questions ?? action.row.questions;
        return (
          <div className="request question waits" data-row="question" data-request-id={action.requestId}>
            <OwnChoices questions={questions} t={t} requestId={action.requestId} busy={status.kind === 'waiting' ? status.busy ?? false : false} onAnswer={(answers, chosen) => onQuestion?.(action.requestId, answers, chosen, action.session)} />
            <p className="s-action-why">{t('glance_only_this')}</p>
          </div>
        );
      }
      case 'plan':
        return plan;
      case 'review':
        return (
          <div>
            <p className="s-action-title">{t(action.what === 'release' ? 'glance_review_title' : 'glance_decision_title')}</p>
            <p className="s-action-why">{t(action.what === 'release' ? 'glance_review_why' : 'glance_decision_why')}</p>
            <div className="s-action-buttons">
              <Button asChild variant="ink" className="btn primary"><a href={action.href} data-act="open_review">{t(action.what === 'release' ? 'glance_review_open' : 'glance_decision_open')}</a></Button>
              {action.pr ? <PullRequestLink pr={action.pr} t={t} /> : null}
            </div>
          </div>
        );
      case 'giveback':
        return (
          <div>
            <p className="s-action-title">{t('glance_giveback_title')}</p>
            <p className="s-action-why">{t('takeover_after')}</p>
            <div className="s-action-buttons">{giveback}</div>
          </div>
        );
    }
  })();
  return (
    <section className="s-action" id="session-action" data-action={action.kind} aria-labelledby={heading}>
      <h2 className="s-action-label" id={heading}>{t('glance_action_label')}{action.total > 1 ? <span className="s-action-count">{t('glance_action_count', { n: action.total })}</span> : null}</h2>
      {body}
    </section>
  );
}

const MARK = { done: Check, current: CircleDashed, failed: X, todo: Circle } as const;

// Where the ticket is, out of its stages; the agent's own plan under the stage it is written for.
export function StageCard({ stage, view, t }: { readonly stage: StageView; readonly view: SessionView; readonly t: Translate }) {
  const planned = partsOf(view).filter((part) => part.summary.role === 'author').map((part) => part.thread?.plan).findLast(Boolean) ?? view.thread.plan;
  const steps = planned ? planSteps(planned) : [];
  const now = stage.stages[stage.current - 1];
  return (
    <section className="s-stage" aria-labelledby="s-stage-title">
      <h2 className="s-section-title" id="s-stage-title">{t('glance_stage_title')}<span className="s-stage-count">{t('glance_stage_count', { n: stage.current, total: stage.total })}</span></h2>
      <ol className="s-stages">
        {stage.stages.map((one) => {
          const Mark = MARK[one.state];
          const reads = one === now && (one.key === 'prepare' || one.key === 'write') && steps.length > 0;
          return (
            <li key={one.key} data-stage={one.key} data-state={one.state} aria-current={one === now ? 'step' : undefined}>
              <span className="s-stage-line">
                <Mark size={14} aria-hidden="true" />
                <span>{t(`glance_stage_${one.key}`)}</span>
                <span className="sr-only">{t(`glance_stage_is_${one.state}`)}</span>
              </span>
              {reads ? (
                <div className="s-plan">
                  <p className="s-plan-title">{t('glance_plan_steps', { n: steps.length })}</p>
                  <ol className="s-plan-steps">{steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

const captureKey = (capture: Capture) => `glance_capture_${capture.kind}`;

// The result once the ticket is through: its pull request and its receipt.
export function ResultCard({ result, t }: { readonly result: Result; readonly t: Translate }) {
  const several = new Set(result.captures.map((capture) => capture.service)).size > 1;
  return (
    <section className="s-result" id="session-result" aria-labelledby="s-result-title">
      <h2 className="s-section-title" id="s-result-title">{t('glance_result_title')}</h2>
      {result.pr ? <p className="s-result-line"><PullRequestLink pr={result.pr} t={t} /></p> : <p className="s-result-none">{t('glance_result_none')}</p>}
      {result.captures.length > 0 ? (
        <div className="s-receipt">
          <p className="s-plan-title">{t('glance_receipt')}</p>
          <ul>
            {result.captures.map((capture) => (
              <li key={capture.href}><a className="s-link" href={capture.href} {...external} data-capture={capture.kind}>{several ? t('glance_capture_service', { what: t(captureKey(capture)), service: capture.service }) : t(captureKey(capture))}</a></li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

// Cost and duration, small and calm.
export function SideFacts({ facts, pr, t }: { readonly facts: { readonly duration: string; readonly cost?: string }; readonly pr?: PullRequest | undefined; readonly t: Translate }) {
  return (
    <aside className="s-side" aria-label={t('glance_side_label')}>
      <dl className="s-facts">
        <div><dt>{t('glance_fact_duration')}</dt><dd>{facts.duration}</dd></div>
        {facts.cost ? <div><dt>{t('glance_fact_cost')}</dt><dd data-session-cost="">{facts.cost}</dd></div> : null}
        {pr ? <div><dt>{t('glance_fact_pr')}</dt><dd><a className="s-link" href={pr.url} {...external} aria-label={t('glance_pr', { n: pr.number })}>{t('glance_pr_short', { n: pr.number })}<ArrowUpRight size={13} aria-hidden="true" /></a></dd></div> : null}
      </dl>
    </aside>
  );
}
