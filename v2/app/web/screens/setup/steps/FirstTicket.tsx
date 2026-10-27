// The assistant's first-ticket step's screen (docs/v2/milestone-5-plan.md,
// section 14): the proposed ticket as it will be written, the repository it
// targets, and one button that moves it to Todo; then the ticket followed
// stage by stage, each stage in words beside its mark, the current one
// marked for assistive technology and said in a polite live region; the
// session plan's Go and the approval sent to the inbox, as for every ticket. Live, the setup's
// summary: each step's time, the person's and the machine's, and the total.
import { useCallback, useEffect, useRef, useState } from 'react';
import { summaryOf } from '../../../../../src/setup/summary.ts';
import { FIRST_TICKET_STAGES, type FirstTicketView, type SetupView } from '../../../../../src/setup/types.ts';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { lasted } from '@/lib/time.ts';
import { refusal, stepKey } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';
import './first-ticket.css';

const FOLLOW_MS = 5_000;

// Each step's time and the total, as the last page shows them too.
export function SetupSummary({ t, view }: { readonly t: Translate; readonly view: SetupView }) {
  const summary = summaryOf(view.steps);
  return (
    <div className="setup-summary" data-setup-summary>
      <p>{t('first_ticket_summary_all', { all: lasted(summary.total.allMs, t), person: lasted(summary.total.personMs, t), machine: lasted(summary.total.machineMs, t) })}</p>
      <table className="setup-summary-table">
        <caption>{t('first_ticket_summary_caption')}</caption>
        <thead>
          <tr><th scope="col">{t('first_ticket_summary_step')}</th><th scope="col">{t('first_ticket_summary_person')}</th><th scope="col">{t('first_ticket_summary_machine')}</th></tr>
        </thead>
        <tbody>
          {summary.lines.map((line) => (
            <tr key={line.id} data-step={line.id} data-state={line.state}>
              <th scope="row">{t(`setup_step_${stepKey(line.id)}`)}{line.state === 'done' ? null : <span className="setup-summary-state">{t(`setup_state_${line.state}`)}</span>}</th>
              <td>{lasted(line.personMs, t)}</td>
              <td>{lasted(line.machineMs, t)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr><th scope="row">{t('first_ticket_summary_total')}</th><td>{lasted(summary.total.personMs, t)}</td><td>{lasted(summary.total.machineMs, t)}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}

function Proposal({ t, view, onMove, busy, error }: { readonly t: Translate; readonly view: FirstTicketView; readonly onMove: (service: string) => void; readonly busy: boolean; readonly error: string }) {
  const [service, setService] = useState(view.services[0] ?? '');
  return (
    <div className="setup-result" data-first-ticket="proposal">
      <h3>{t('first_ticket_proposal')}</h3>
      <div className="first-ticket-card">
        <p className="first-ticket-card-title">{view.proposal.title}</p>
        {view.proposal.body.split('\n\n').map((part) => <p key={part}>{part}</p>)}
      </div>
      {view.services.length > 1 ? (
        <div className="first-ticket-field">
          <label htmlFor="first-ticket-service">{t('first_ticket_service_label')}</label>
          <select id="first-ticket-service" value={service} onChange={(event) => setService(event.target.value)}>
            {view.services.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </div>
      ) : <p>{t('first_ticket_service_one', { service })}</p>}
      <p className="setup-note">{t('first_ticket_flow_note')}</p>
      {error ? <p className="setup-error" role="alert">{error}</p> : null}
      <Button variant="ink" className="primary" data-act="first_ticket_move" disabled={busy || !service} onClick={() => onMove(service)}>{busy ? t('first_ticket_moving') : t('first_ticket_move')}</Button>
    </div>
  );
}

function Followed({ t, view, summary }: { readonly t: Translate; readonly view: FirstTicketView; readonly summary: SetupView | undefined }) {
  const ticket = view.ticket;
  if (!ticket) return null;
  // A plan waiting for its Go is the author's stage: the list never moves back.
  const reached = FIRST_TICKET_STAGES.indexOf((ticket.stage === 'plan' ? 'working' : ticket.stage) as (typeof FIRST_TICKET_STAGES)[number]);
  return (
    <div className="setup-result" data-first-ticket={ticket.stage}>
      <p className="first-ticket-id"><span className="first-ticket-ref">{ticket.id}</span> {ticket.title}</p>
      <ol className="first-ticket-stages" aria-label={t('first_ticket_progress_label')}>
        {FIRST_TICKET_STAGES.map((stage, index) => {
          // Live is reached, not pending: every stage done, live the current one.
          const state = ticket.stage === 'stopped' ? 'todo' : index < reached || ticket.stage === 'live' ? 'done' : index === reached ? 'current' : 'todo';
          return (
            <li key={stage} data-stage={stage} data-state={state} aria-current={index === reached ? 'step' : undefined}>
              <span className="first-ticket-mark" aria-hidden="true">{index + 1}</span>
              <span>{t(`first_ticket_stage_${stage}`)}</span>
            </li>
          );
        })}
      </ol>
      <p className="setup-note" role="status" aria-live="polite">{t(`first_ticket_now_${ticket.stage}`)}</p>
      {ticket.rolledBack && ticket.stage !== 'live' ? <p className="setup-note" data-rolled-back>{t('first_ticket_rolled_back')}</p> : null}
      {ticket.stage === 'plan' && ticket.plan ? <a className="btn" href={`/inbox#${encodeURIComponent(ticket.plan)}`}>{t('first_ticket_open_plan')}</a> : null}
      {ticket.stage === 'approval' ? <a className="btn" href="/inbox">{t('first_ticket_open_inbox')}</a> : null}
      {ticket.stage === 'live' && summary ? <SetupSummary t={t} view={summary} /> : null}
    </div>
  );
}

export function FirstTicketStep({ t, api, onDone, initial, summary: shown }: StepProps<FirstTicketView> & { readonly summary?: SetupView }) {
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

  const move = (service: string) => {
    setBusy(true);
    setError('');
    void api.post<FirstTicketView>('/first-ticket', { service, language }).then((answer) => {
      if (answer.status !== 200) return setError(refusal(t, 'first_ticket', answer.body));
      setView(answer.body);
    }, () => setError(t('first_ticket_error_other'))).finally(() => setBusy(false));
  };

  return (
    <StepFrame t={t} prefix="first_ticket">
      {!view ? <p className="setup-note" aria-busy="true">{error || t('setup_loading')}</p>
        : !view.ready ? (
          <div className="setup-result" data-first-ticket="waiting">
            <p>{t('first_ticket_no_workspace')}</p>
            <a className="btn" href="/setup/workspace">{t('first_ticket_no_workspace_link')}</a>
          </div>
        )
        : view.ticket ? <Followed t={t} view={view} summary={summary} />
        : <Proposal t={t} view={view} onMove={move} busy={busy} error={error} />}
    </StepFrame>
  );
}
