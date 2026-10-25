// The assistant's environment step's screen (docs/v2/milestone-5-plan.md,
// sections 1 and 10, step 6, matrix C15): each service of the workspace
// with what its base holds and its prepared image, the image's state in
// words beside its mark, a ready one with its build's time and age, a
// failed one with its reason and what to do. Build starts the builds; the
// page reads the view again while one runs, and the step is done once every
// image is ready.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnvironmentService, EnvironmentView } from '../../../../../src/container/types.ts';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { ago, lasted } from '@/lib/time.ts';
import { refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';
import './environment.css';

const POLL_MS = 2_000;

export function environmentSummary(t: Translate, view: EnvironmentView): string {
  const count = view.services.length;
  const failed = view.services.filter((service) => service.state === 'failed').length;
  if (view.services.some((service) => service.state === 'building')) return t('environment_summary_building');
  if (failed > 0) return t(failed === 1 ? 'environment_summary_failed_one' : 'environment_summary_failed_many', { failed, count });
  const todo = view.services.filter((service) => service.state !== 'ready').length;
  if (todo === 0) return t('environment_summary_ready');
  return todo === 1 ? t('environment_summary_todo_one') : t('environment_summary_todo_many', { count: todo });
}

function ServiceLine({ t, service, now }: { readonly t: Translate; readonly service: EnvironmentService; readonly now: Date }) {
  const what = !service.readable ? t('environment_unreadable') : service.devcontainer ? t(`environment_devcontainer_${service.devcontainer}`) : '';
  return (
    <li className="setup-env-item" data-state={service.state} data-service={service.name}>
      <span className="setup-env-state">{t(`environment_state_${service.state}`)}</span>
      <div className="setup-env-body">
        <p className="setup-env-name">{service.name}</p>
        {what ? <p className="setup-env-text">{what}</p> : null}
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
      </div>
    </li>
  );
}

export function EnvironmentStep({ t, api, onDone, initial }: StepProps<EnvironmentView>) {
  const [view, setView] = useState<EnvironmentView | undefined>(initial);
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
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

  if (!view) return <StepFrame t={t} prefix="environment"><p className="setup-note" aria-busy="true">{t('setup_loading')}</p></StepFrame>;
  if (!view.workspace) return <StepFrame t={t} prefix="environment"><p className="setup-note" data-environment-none>{t('environment_no_workspace')}</p></StepFrame>;

  const now = new Date();
  const allReady = view.services.every((service) => service.state === 'ready');
  return (
    <StepFrame t={t} prefix="environment">
      <div data-environment-step>
        <p className={allReady ? 'setup-ok setup-env-summary' : 'setup-env-summary'} role="status" aria-live="polite">{environmentSummary(t, view)}</p>
        {error ? <p className="setup-error" role="alert">{error}</p> : null}
        <ul className="setup-env" aria-busy={building}>
          {view.services.map((service) => <ServiceLine key={service.name} t={t} service={service} now={now} />)}
        </ul>
        <p className="setup-note">{t('environment_note')}</p>
        <Button className={allReady ? 'btn' : 'btn primary'} data-act="setup_environment_build" onClick={build} disabled={building || asking}>
          {allReady ? t('environment_build_again') : t('environment_build')}
        </Button>
      </div>
    </StepFrame>
  );
}
