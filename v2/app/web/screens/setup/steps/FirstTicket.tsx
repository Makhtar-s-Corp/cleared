// The assistant's first-ticket step's screen (docs/v2/milestone-5-plan.md,
// section 14; the owner's request of 2026-10-30): one sentence and one button
// that starts the ticket, what it will say in the detail. Then the ticket as it
// really goes: where it stands in one sentence, its session live with its link
// and its pull request, and the person's gesture when it is theirs. The time per
// step is folded on the last page.
import { useCallback, useEffect, useRef, useState } from 'react';
import { summaryOf } from '../../../../../src/setup/summary.ts';
import type { FirstTicketView, SetupView } from '../../../../../src/setup/types.ts';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { lasted } from '@/lib/time.ts';
import { LiveSession } from '../live.tsx';
import { credibleTime, refusal, stepKey } from '../model.ts';
import { Detail, StepFrame, type StepProps } from '../step.tsx';
import './first-ticket.css';

const FOLLOW_MS = 5_000;

// Each step's time and the total, as the last page's fold shows them.
export function SetupSummary({ t, view }: { readonly t: Translate; readonly view: SetupView }) {
  const summary = summaryOf(view.steps);
  return (
    <div className="setup-summary" data-setup-summary>
      <table className="setup-summary-table">
        <caption>{t('first_ticket_summary_caption')}</caption>
        <thead>
          <tr><th scope="col">{t('first_ticket_summary_step')}</th><th scope="col">{t('first_ticket_summary_person')}</th><th scope="col">{t('first_ticket_summary_machine')}</th></tr>
        </thead>
        <tbody>
          {summary.lines.map((line) => (
            <tr key={line.id} data-step={line.id} data-state={line.state}>
              <th scope="row">{t(`setup_step_${stepKey(line.id)}`)}{line.state === 'done' ? null : <span className="setup-summary-state">{t(`setup_state_${line.state}`)}</span>}</th>
              <td>{credibleTime(line.personMs, t)}</td>
              <td>{lasted(line.machineMs, t)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Proposal({ t, view, onMove, busy, error }: { readonly t: Translate; readonly view: FirstTicketView; readonly onMove: (service: string) => void; readonly busy: boolean; readonly error: string }) {
  const [service, setService] = useState(view.services[0] ?? '');
  return (
    <div className="setup-result" data-first-ticket="proposal">
      {view.services.length > 1 ? (
        <div className="first-ticket-field">
          <label htmlFor="first-ticket-service">{t('first_ticket_service_label')}</label>
          <select id="first-ticket-service" value={service} onChange={(event) => setService(event.target.value)}>
            {view.services.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
      ) : null}
      {error ? <p className="setup-error" role="alert">{error}</p> : null}
      <Button variant="ink" className="primary" data-act="first_ticket_move" disabled={busy || !service} onClick={() => onMove(service)}>{busy ? t('first_ticket_moving') : t('first_ticket_move')}</Button>
      <Detail t={t}>
        <h3>{t('first_ticket_proposal')}</h3>
        <div className="first-ticket-card">
          <p className="first-ticket-card-title">{view.proposal.title}</p>
          {view.proposal.body.split('\n\n').map((part) => <p key={part}>{part}</p>)}
        </div>
        <p className="setup-note">{t('first_ticket_flow_note')}</p>
      </Detail>
    </div>
  );
}

function Followed({ t, view, summary }: { readonly t: Translate; readonly view: FirstTicketView; readonly summary: SetupView | undefined }) {
  const ticket = view.ticket;
  if (!ticket) return null;
  return (
    <div className="setup-result" data-first-ticket={ticket.stage}>
      <p className="first-ticket-id"><span className="first-ticket-ref">{ticket.id}</span> {ticket.title}</p>
      {ticket.stage === 'live' ? null : <LiveSession t={t} ticket={ticket.id} pullRequest={ticket.pullRequest} />}
      {ticket.stage === 'live' && ticket.pullRequest ? <p><a className="setup-link" href={ticket.pullRequest.url} target="_blank" rel="noreferrer">{t('setup_live_pr', { number: ticket.pullRequest.number })}</a></p> : null}
      {ticket.rolledBack && ticket.stage !== 'live' ? <p className="setup-note" data-rolled-back>{t('first_ticket_rolled_back')}</p> : null}
      {ticket.stage === 'plan' && ticket.plan ? <a className="primary" href={`/inbox#${encodeURIComponent(ticket.plan)}`}>{t('first_ticket_open_plan')}</a> : null}
      {ticket.stage === 'approval' ? <a className="primary" href="/inbox">{t('first_ticket_open_inbox')}</a> : null}
      {ticket.stage === 'live' && summary ? <Detail t={t} label={t('first_ticket_summary_toggle')}><SetupSummary t={t} view={summary} /></Detail> : null}
    </div>
  );
}

export function FirstTicketStep({ t, api, onDone, initial, summary: shown, onOwnAction }: StepProps<FirstTicketView> & { readonly summary?: SetupView }) {
  const [view, setView] = useState<FirstTicketView | undefined>(initial);
  const [summary, setSummary] = useState<SetupView | undefined>(shown);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // The assistant's reload is a new function at each of its renders: kept here.
  const done = useRef(onDone);
  done.current = onDone;
  const language = t('locale');

  const read = useCallback(() => api.get<FirstTicketView>(`/first-ticket?language=${encodeURIComponent(language)}`).then((answer) => {
    if (answer.status !== 200) return setError(refusal(t, 'first_ticket', answer.body));
    setView(answer.body);
  }, () => setError(t('first_ticket_error_other'))), [api, language, t]);

  useEffect(() => { if (!initial) void read(); }, [initial, read]);

  // Followed until it is live or left the flow, at a calm pace.
  const stage = view?.ticket?.stage;
  useEffect(() => {
    if (initial || !stage || stage === 'live' || stage === 'stopped') return;
    const timer = setInterval(() => void read(), FOLLOW_MS);
    return () => clearInterval(timer);
  }, [initial, stage, read]);

  // Live: the step is done, and the setup's summary is read.
  useEffect(() => {
    if (initial || stage !== 'live') return;
    done.current();
    void api.get<SetupView>('').then((answer) => { if (answer.status === 200) setSummary(answer.body); });
  }, [initial, stage, api]);

  useEffect(() => { onOwnAction?.(stage === 'plan' || stage === 'approval'); }, [onOwnAction, stage]);

  const move = (service: string) => {
    setBusy(true);
    setError('');
    void api.post<FirstTicketView>('/first-ticket', { service, language }).then((answer) => {
      if (answer.status !== 200) return setError(refusal(t, 'first_ticket', answer.body));
      setView(answer.body);
    }, () => setError(t('first_ticket_error_other'))).finally(() => setBusy(false));
  };

  const one = view?.services.length === 1 ? view.services[0] : undefined;
  const sentence = stage ? t(`first_ticket_now_${stage}`) : !view ? undefined : !view.ready ? t('first_ticket_no_workspace') : one ? t('first_ticket_intro', { service: one }) : t('first_ticket_intro_many');
  return (
    <StepFrame t={t} prefix="first_ticket" {...(sentence ? { sentence } : {})} values={{ service: one ?? '' }}>
      {!view ? <p className="setup-note" aria-busy="true">{error || t('setup_loading')}</p>
        : !view.ready ? (
          <div className="setup-result" data-first-ticket="waiting">
            <a className="primary" href="/setup/workspace">{t('first_ticket_no_workspace_link')}</a>
          </div>
        )
        : view.ticket ? <Followed t={t} view={view} summary={summary} />
        : <Proposal t={t} view={view} onMove={move} busy={busy} error={error} />}
    </StepFrame>
  );
}
