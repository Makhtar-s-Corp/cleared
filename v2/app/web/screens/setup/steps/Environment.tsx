// The assistant's environment step's screen (docs/v2/milestone-5-plan.md,
// sections 1 and 10, step 6, matrix C15): each service of the workspace
// with what its base holds and its prepared image, the image's state in
// words beside its mark, a ready one with its build's time and age, a
// failed one with its reason and what to do, then its declared check's
// result in that image. Build starts the builds; the page reads the view
// again while one runs, and the step is done once every image is ready.
// A service with no .devcontainer, whose image did not build or whose check
// failed is proposed a setup session (section 13, C4): a ticket of the
// environment template, in the person's language, started from here.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvironmentService, EnvironmentView, SetupSessionAnswer, SetupSessionBody } from '../../../../../src/container/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { catalogOf, type Language } from '@/lib/catalogs.ts';
import type { Translate } from '@/lib/i18n.ts';
import { ago, lasted } from '@/lib/time.ts';
import { refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';
import './environment.css';

const POLL_MS = 2_000;

// The ready images whose declared check failed in them.
const checksFailed = (view: EnvironmentView): number => view.services.filter((service) => service.state === 'ready' && service.check?.passed === false).length;

export function environmentSummary(t: Translate, view: EnvironmentView): string {
  const count = view.services.length;
  const failed = view.services.filter((service) => service.state === 'failed').length;
  if (view.services.some((service) => service.state === 'building')) return t('environment_summary_building');
  if (failed > 0) return t(failed === 1 ? 'environment_summary_failed_one' : 'environment_summary_failed_many', { failed, count });
  const todo = view.services.filter((service) => service.state !== 'ready').length;
  const red = checksFailed(view);
  if (todo === 0 && red > 0) return t(red === 1 ? 'environment_summary_check_failed_one' : 'environment_summary_check_failed_many', { failed: red });
  if (todo === 0) return t('environment_summary_ready');
  return todo === 1 ? t('environment_summary_todo_one') : t('environment_summary_todo_many', { count: todo });
}

// The setup session's ticket, as the tower's Environment template words it in the person's language.
export function sessionBody(t: Translate, service: string): SetupSessionBody {
  const language: Language = t('locale') === 'fr' ? 'fr' : 'en';
  return { service, title: t('environment_session_title', { service }), body: catalogOf('tower', language).template_environment_body ?? '' };
}

// The declared check: its result in the ready image, or what runs it, or that there is none.
function CheckLine({ t, service }: { readonly t: Translate; readonly service: EnvironmentService }) {
  if (!service.readable || service.state === 'failed') return null;
  const { check, checkCommand } = service;
  if (check) {
    return (
      <>
        <p className="setup-env-text" data-env-check={check.passed ? 'passed' : 'failed'}>
          <code>{check.command}</code> {check.passed ? t('environment_check_green', { took: lasted(check.ms, t) }) : t('environment_check_failed')}
        </p>
        {!check.passed && check.tail ? <pre className="setup-env-output" tabIndex={0} aria-label={t('environment_check_output', { service: service.name })}>{check.tail}</pre> : null}
      </>
    );
  }
  return <p className="setup-env-text">{checkCommand ? <>{t('environment_check_declared')} <code>{checkCommand}</code></> : t('environment_no_check')}</p>;
}

// The setup session: running, proposed with its reason and its start, or waiting for a restart.
function SessionLine({ t, service, sessions, starting, onStart }: {
  readonly t: Translate; readonly service: EnvironmentService; readonly sessions: EnvironmentView['sessions'];
  readonly starting: boolean; readonly onStart: (service: string) => void;
}) {
  if (service.setupTicket) return <p className="setup-env-session" data-env-session="open">{t('environment_session_open', { ticket: service.setupTicket })}</p>;
  if (!service.proposal) return null;
  return (
    <div className="setup-env-session" data-env-session={service.proposal}>
      <p className="setup-env-text">{t(`environment_proposal_${service.proposal}`)}</p>
      {sessions === 'ready' ? (
        <Button className="btn" data-act="setup_environment_session" data-service={service.name} onClick={() => onStart(service.name)} disabled={starting}>
          {t('environment_session_start')}
        </Button>
      ) : <p className="setup-env-text">{t('environment_session_restart')}</p>}
    </div>
  );
}

function ServiceLine({ t, service, now, sessions, starting, onStart }: {
  readonly t: Translate; readonly service: EnvironmentService; readonly now: Date; readonly sessions: EnvironmentView['sessions'];
  readonly starting: boolean; readonly onStart: (service: string) => void;
}) {
  const what = !service.readable ? t('environment_unreadable') : service.devcontainer ? t(service.devcontainer === 'none' ? 'environment_no_devcontainer' : `environment_devcontainer_${service.devcontainer}`) : '';
  return (
    <li className="setup-env-item" data-state={service.state} data-service={service.name}>
      <span className="setup-env-state">{t(`environment_state_${service.state}`)}</span>
      <div className="setup-env-body">
        <p className="setup-env-name">{service.name}</p>
        {what ? <p className="setup-env-text">{what}</p> : null}
        {service.foreignImage ? <p className="setup-env-text">{t('environment_foreign_image', { image: service.foreignImage })}</p> : null}
        {service.readable ? (
          <p className="setup-env-text">{service.install ? <>{t('environment_install')} <code>{service.install}</code></> : t('environment_no_install')}</p>
        ) : null}
        {service.state === 'ready' && service.image ? (
          <p className="setup-env-text">{t('environment_ready_line', { tag: service.image, took: lasted(service.buildMs ?? 0, t), age: service.builtAt ? ago(service.builtAt, now, t) : '' })}</p>
        ) : null}
        {service.state === 'building' && service.startedAt ? <p className="setup-env-text">{t('environment_building_line', { age: ago(service.startedAt, now, t) })}</p> : null}
        {service.state === 'stale' ? <p className="setup-env-text">{t('environment_stale_line')}</p> : null}
        {service.state === 'failed' ? (
          <>
            {service.error ? <p className="setup-env-text setup-env-error">{service.error}</p> : null}
            <p className="setup-env-todo"><span className="setup-env-todo-label">{t('environment_todo')}</span> {t('environment_failed_todo')}</p>
          </>
        ) : null}
        <CheckLine t={t} service={service} />
        <SessionLine t={t} service={service} sessions={sessions} starting={starting} onStart={onStart} />
      </div>
    </li>
  );
}

export function EnvironmentStep({ t, api, onDone, initial }: StepProps<EnvironmentView>) {
  const [view, setView] = useState<EnvironmentView | undefined>(initial);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const [starting, setStarting] = useState(false);
  // The assistant's reload is a new function at each of its renders: kept here.
  const done = useRef(onDone);
  done.current = onDone;
  const building = view?.services.some((service) => service.state === 'building') ?? false;

  const read = useCallback(() => api.get<EnvironmentView>('/environment').then((answer) => {
    if (answer.status !== 200) return setError(refusal(t, 'environment', answer.body));
    setView(answer.body);
    if (answer.body.services.length > 0 && answer.body.services.every((service) => service.state === 'ready')) done.current();
  }, () => setError(t('environment_error_other'))), [api, t]);

  useEffect(() => {
    if (initial) return;
    void read();
  }, [initial, read]);

  // While a build runs, the view is read again until none does.
  useEffect(() => {
    if (!building || initial) return;
    const timer = setTimeout(() => { void read(); }, POLL_MS);
    return () => clearTimeout(timer);
  }, [building, initial, read, view]);

  const build = () => {
    setAsking(true);
    setError('');
    void api.post<EnvironmentView>('/environment/build', {}).then((answer) => {
      if (answer.status !== 202) return setError(refusal(t, 'environment', answer.body));
      setView(answer.body);
    }, () => setError(t('environment_error_other'))).finally(() => setAsking(false));
  };

  // A setup session for one service, then the view again, which shows its ticket.
  const start = (name: string) => {
    setStarting(true);
    setError('');
    void api.post<SetupSessionAnswer>('/environment/session', sessionBody(t, name)).then((answer) => {
      if (answer.status !== 200) return setError(refusal(t, 'environment', answer.body));
      return read();
    }, () => setError(t('environment_error_other'))).finally(() => setStarting(false));
  };

  if (!view) return <StepFrame t={t} prefix="environment"><p className="setup-note" aria-busy="true">{t('setup_loading')}</p></StepFrame>;
  if (!view.workspace) return <StepFrame t={t} prefix="environment"><p className="setup-note" data-environment-none>{t('environment_no_workspace')}</p></StepFrame>;

  const now = new Date();
  const allReady = view.services.every((service) => service.state === 'ready');
  return (
    <StepFrame t={t} prefix="environment">
      <div data-environment-step>
        <p className={allReady && checksFailed(view) === 0 ? 'setup-ok setup-env-summary' : 'setup-env-summary'} role="status" aria-live="polite">{environmentSummary(t, view)}</p>
        {error ? <p className="setup-error" role="alert">{error}</p> : null}
        <ul className="setup-env" aria-busy={building}>
          {view.services.map((service) => <ServiceLine key={service.name} t={t} service={service} now={now} sessions={view.sessions} starting={starting} onStart={start} />)}
        </ul>
        <p className="setup-note">{t('environment_note')}</p>
        <Button className={allReady ? 'btn' : 'btn primary'} data-act="setup_environment_build" onClick={build} disabled={building || asking}>
          {allReady ? t('environment_build_again') : t('environment_build')}
        </Button>
      </div>
    </StepFrame>
  );
}
