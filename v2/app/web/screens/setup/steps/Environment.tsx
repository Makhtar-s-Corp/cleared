// The assistant's environment step's screen (docs/v2/milestone-5-plan.md,
// sections 1 and 10, step 6, matrix C15; issue #493): each service with its
// state in a word beside its mark and one sentence when it needs something; the
// one action of the moment: Prepare while nothing is installed, nothing while
// it installs, a setup session when the tests fail (a ticket of the environment
// template, in the person's language), and then that session live, with its
// link. What is under it (the commands, the image, the tests' last lines) is in
// the detail. The page reads the view again while a build runs; the step is
// done once every image is ready.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { EnvironmentService, EnvironmentView, SetupSessionAnswer, SetupSessionBody } from '../../../../../src/container/types.ts';
import type { ReceiptTargets } from '../../../../../src/workspace/receipt-targets.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { catalogOf, type Language } from '@/lib/catalogs.ts';
import type { Translate } from '@/lib/i18n.ts';
import { ago, lasted } from '@/lib/time.ts';
import { LiveSession } from '../live.tsx';
import { refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';
import './environment.css';

const POLL_MS = 2_000;

const checkFailed = (service: EnvironmentService): boolean => service.state === 'ready' && service.check?.passed === false;
// What a person acts on: its install failed, or its tests fail in what was installed.
const needsSession = (service: EnvironmentService): boolean => service.setupTicket === null && (service.state === 'failed' || checkFailed(service));

// Why the tests fail, in one sentence, from what the check printed.
const MISSING = /not found|cannot find module|no module named|enoent|command not found/i;
export function checkReason(service: EnvironmentService): 'none_installed' | 'missing' | 'other' {
  const missing = MISSING.test(service.check?.tail ?? '');
  if (missing && service.install === null) return 'none_installed';
  return missing ? 'missing' : 'other';
}

export function environmentSummary(t: Translate, view: EnvironmentView): string {
  if (view.services.some((service) => service.state === 'building')) return t('environment_summary_building');
  if (view.services.every((service) => service.state === 'ready')) return t('environment_summary_ready');
  return view.services.every((service) => service.state === 'none') ? t('environment_summary_todo') : t('environment_intro');
}

// The setup session's ticket, as the tower's Environment template words it in the person's language.
export function sessionBody(t: Translate, service: string): SetupSessionBody {
  const language: Language = t('locale') === 'fr' ? 'fr' : 'en';
  return { service, title: t('environment_session_title', { service }), body: catalogOf('tower', language).template_environment_body ?? '' };
}

function needLine(t: Translate, service: EnvironmentService): string {
  if (service.state === 'failed') return t('environment_failed');
  if (service.state === 'stale') return t('environment_stale');
  return checkFailed(service) ? t(`environment_check_${checkReason(service)}`) : '';
}

const stateWord = (t: Translate, service: EnvironmentService): string => t(checkFailed(service) ? 'environment_state_check_failed' : `environment_state_${service.state}`);
const stateTone = (service: EnvironmentService): string => (service.state === 'failed' || checkFailed(service) ? 'danger' : service.state === 'ready' ? 'ok' : service.state === 'building' ? 'working' : 'idle');

// What the receipt will be able to show, from what is saved.
export function receiptLine(t: Translate, targets: ReceiptTargets): string {
  if (targets.healthUrl && targets.run) return t('environment_targets_both');
  if (targets.healthUrl) return t('environment_targets_before');
  return t(targets.run ? 'environment_targets_after' : 'environment_targets_none');
}

// The receipt's addresses (issue #505): what the repository proposes, prefilled for
// the owner to confirm or correct; once saved, a sentence, and the form on a gesture.
function ReceiptTargetsForm({ t, service, onSaved }: { readonly t: Translate; readonly service: EnvironmentService; readonly onSaved: (name: string, targets: ReceiptTargets) => Promise<string> }) {
  const proof = service.proof as NonNullable<EnvironmentService['proof']>;
  const saved = proof.healthUrl !== null || proof.run !== null;
  const found = proof.detected.healthUrl !== null || proof.detected.run !== null;
  const [changing, setChanging] = useState(false);
  const [url, setUrl] = useState(proof.healthUrl ?? proof.detected.healthUrl ?? '');
  const [run, setRun] = useState(proof.run ?? proof.detected.run ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (saved && !changing) {
    return (
      <div className="setup-targets" data-targets="saved">
        <p className="setup-env-need">{receiptLine(t, proof)}</p>
        <Button variant="ghost" className="btn quiet" data-act="setup_targets_change" onClick={() => setChanging(true)}>{t('environment_targets_change')}</Button>
      </div>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    void onSaved(service.name, { healthUrl: url, run }).then((said) => { setError(said); if (!said) setChanging(false); }).finally(() => setBusy(false));
  };
  return (
    <form className="setup-form setup-targets" onSubmit={submit} aria-busy={busy} data-targets={saved ? 'changing' : found ? 'proposed' : 'missing'}>
      <p className="setup-env-need">{t(found || saved ? 'environment_targets_proposed' : 'environment_targets_missing')}</p>
      <label htmlFor={`setup-targets-url-${service.name}`}>{t('environment_targets_url')}</label>
      <Input id={`setup-targets-url-${service.name}`} name="healthUrl" type="url" inputMode="url" autoComplete="off" spellCheck={false} maxLength={300} value={url} aria-describedby={`setup-targets-url-hint-${service.name}`} onChange={(event) => setUrl(event.currentTarget.value)} />
      <p className="setup-hint" id={`setup-targets-url-hint-${service.name}`}>{t('environment_targets_url_hint')}</p>
      <label htmlFor={`setup-targets-run-${service.name}`}>{t('environment_targets_run')}</label>
      <Input id={`setup-targets-run-${service.name}`} name="run" autoComplete="off" spellCheck={false} maxLength={200} value={run} aria-describedby={`setup-targets-run-hint-${service.name}`} onChange={(event) => setRun(event.currentTarget.value)} />
      <p className="setup-hint" id={`setup-targets-run-hint-${service.name}`}>{t('environment_targets_run_hint')}</p>
      {error ? <p className="setup-error" role="alert">{error}</p> : null}
      <Button className="btn" type="submit" data-act="setup_targets_save" disabled={busy}>{busy ? t('environment_targets_saving') : t(found && !saved ? 'environment_targets_confirm' : 'environment_targets_save')}</Button>
    </form>
  );
}

function ServiceLine({ t, service, sessions, starting, onStart, onTargets }: {
  readonly t: Translate; readonly service: EnvironmentService; readonly sessions: EnvironmentView['sessions'];
  readonly starting: boolean; readonly onStart: (service: string) => void;
  readonly onTargets: (name: string, targets: ReceiptTargets) => Promise<string>;
}) {
  const need = needLine(t, service);
  return (
    <li className="setup-env-item" data-state={service.state} data-service={service.name} data-tone={stateTone(service)}>
      <div className="setup-env-head">
        <span className="setup-env-name">{service.name}</span>
        <span className="setup-env-state">
          {service.state === 'building' ? <span className="setup-spinner" aria-hidden="true" /> : <span className="dot" aria-hidden="true" />}
          {stateWord(t, service)}
        </span>
      </div>
      {need && !service.setupTicket ? <p className="setup-env-need" data-env-need={checkFailed(service) ? checkReason(service) : service.state}>{need}</p> : null}
      {service.setupTicket ? (
        <div data-env-session="open">
          <p className="setup-env-need">{t('environment_session_doing', { service: service.name })}</p>
          <LiveSession t={t} ticket={service.setupTicket} />
        </div>
      ) : null}
      {needsSession(service) ? (
        sessions === 'ready' ? (
          <Button variant="ink" className="primary" data-act="setup_environment_session" data-service={service.name} onClick={() => onStart(service.name)} disabled={starting}>
            {starting ? t('environment_session_starting') : t('environment_session_start')}
          </Button>
        ) : <p className="setup-env-need">{t('environment_session_restart')}</p>
      ) : null}
      {service.proof ? <ReceiptTargetsForm t={t} service={service} onSaved={onTargets} /> : null}
    </li>
  );
}

// What is under a service's line.
function ServiceDetail({ t, service, now, several, sessions, starting, onStart }: {
  readonly t: Translate; readonly service: EnvironmentService; readonly now: Date; readonly several: boolean; readonly sessions: EnvironmentView['sessions'];
  readonly starting: boolean; readonly onStart: (service: string) => void;
}) {
  const { check } = service;
  return (
    <div className="setup-env-detail" data-env-detail={service.name}>
      {several ? <h3>{service.name}</h3> : null}
      <dl className="setup-facts">
        <dt>{t('environment_detail_install')}</dt><dd>{service.install ? <code>{service.install}</code> : t('environment_detail_install_none')}</dd>
        <dt>{t('environment_detail_check')}</dt><dd>{service.checkCommand ? <code>{service.checkCommand}</code> : t('environment_detail_check_none')}{check?.passed ? ` ${t('environment_detail_check_ok', { took: lasted(check.ms, t) })}` : ''}</dd>
        {service.image ? <><dt>{t('environment_detail_image')}</dt><dd><code>{service.image}</code>{service.buildMs !== null && service.builtAt ? ` ${t('environment_detail_built', { took: lasted(service.buildMs, t), age: ago(service.builtAt, now, t) })}` : ''}</dd></> : null}
        {service.state === 'building' && service.startedAt ? <><dt>{t('environment_detail_image')}</dt><dd>{t('environment_detail_started', { age: ago(service.startedAt, now, t) })}</dd></> : null}
        {service.devcontainer === 'none' ? <><dt>{t('environment_detail_base')}</dt><dd>{t('environment_no_devcontainer')}</dd></> : null}
        {service.foreignImage ? <><dt>{t('environment_detail_base')}</dt><dd>{t('environment_foreign_image', { image: service.foreignImage })}</dd></> : null}
      </dl>
      {service.error ? <><h3>{t('environment_detail_error')}</h3><pre className="setup-env-output" tabIndex={0}>{service.error}</pre></> : null}
      {check && !check.passed && check.tail ? <pre className="setup-env-output" tabIndex={0} aria-label={t('environment_check_output', { service: service.name })} data-env-check="failed">{check.tail}</pre> : null}
      {service.proposal === 'no_devcontainer' && sessions === 'ready' && !service.setupTicket ? (
        <p className="setup-env-offer">
          <span>{t('environment_detail_proposal')}</span>
          <Button className="btn" data-act="setup_environment_session" data-service={service.name} onClick={() => onStart(service.name)} disabled={starting}>{t('environment_session_start_quiet')}</Button>
        </p>
      ) : null}
    </div>
  );
}

export function EnvironmentStep({ t, api, onDone, initial, onOwnAction }: StepProps<EnvironmentView>) {
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

  // The receipt's addresses: an empty answer is saved; what the service refuses is said in the form.
  const saveTargets = (name: string, targets: ReceiptTargets): Promise<string> =>
    api.post<EnvironmentView>('/environment/targets', { service: name, healthUrl: targets.healthUrl ?? '', run: targets.run ?? '' }).then((answer) => {
      if (answer.status !== 200) return refusal(t, 'environment', answer.body);
      setView(answer.body);
      return '';
    }, () => t('environment_error_other'));

  // The one action of the moment: nothing else is indigo while a session is proposed.
  const proposed = view?.services.some(needsSession) ?? false;
  useEffect(() => { onOwnAction?.(proposed); }, [onOwnAction, proposed]);

  if (!view) return <StepFrame t={t} prefix="environment"><p className="setup-note" aria-busy="true">{t('setup_loading')}</p></StepFrame>;
  if (!view.workspace) return <StepFrame t={t} prefix="environment" sentence={t('environment_no_workspace')}><span data-environment-none /></StepFrame>;

  const now = new Date();
  const allReady = view.services.every((service) => service.state === 'ready');
  const toPrepare = !building && !allReady && !view.services.some((service) => service.state === 'failed');
  const several = view.services.length > 1;
  const detail = (
    <>
      {view.services.map((service) => <ServiceDetail key={service.name} t={t} service={service} now={now} several={several} sessions={view.sessions} starting={starting} onStart={start} />)}
      <p className="setup-note">{t('environment_note')}</p>
      {!toPrepare && !building ? <Button className="btn" data-act="setup_environment_build" onClick={build} disabled={asking}>{t('environment_build_again')}</Button> : null}
    </>
  );
  return (
    <StepFrame t={t} prefix="environment" detail={detail} sentence={building ? environmentSummary(t, view) : undefined}>
      <div data-environment-step>
        {error ? <p className="setup-error" role="alert">{error}</p> : null}
        <ul className="setup-env" aria-busy={building}>
          {view.services.map((service) => <ServiceLine key={service.name} t={t} service={service} sessions={view.sessions} starting={starting} onStart={start} onTargets={saveTargets} />)}
        </ul>
        {toPrepare ? <Button variant="ink" className="primary" data-act="setup_environment_build" onClick={build} disabled={asking}>{t('environment_build')}</Button> : null}
      </div>
    </StepFrame>
  );
}
