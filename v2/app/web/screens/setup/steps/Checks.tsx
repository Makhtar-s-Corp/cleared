// The assistant's checks step's screen (docs/v2/milestone-5-plan.md,
// sections 1 and 7, step 8): the ready section of `cleared doctor`, run by
// the service in the page's language when the step opens and again on
// demand. Each line says its level in words beside its mark, so colour is
// never the only sign, and a failure says what to do under it. The step is
// done once no line failed.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChecksView, DoctorLine } from '../../../../../src/doctor/types.ts';
import { Button } from '@/components/ui/button.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { lasted } from '@/lib/time.ts';
import { refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';
import './checks.css';

export function checksSummary(t: Translate, view: ChecksView): string {
  const values = { count: view.lines.length, failed: view.failed, took: lasted(view.tookMs, t) };
  if (view.failed === 0) return t('checks_summary_ok', values);
  return view.failed === 1 ? t('checks_summary_fail_one', values) : t('checks_summary_fail_many', values);
}

function CheckLine({ t, line }: { readonly t: Translate; readonly line: DoctorLine }) {
  return (
    <li className="setup-check" data-level={line.level} data-check={line.id}>
      <span className="setup-check-level">{t(`checks_level_${line.level}`)}</span>
      <div className="setup-check-body">
        <p className="setup-check-text">{line.text}</p>
        {line.todo && line.level !== 'ok' ? <p className="setup-check-todo"><span className="setup-check-todo-label">{t('checks_todo')}</span> {line.todo}</p> : null}
      </div>
    </li>
  );
}

export function ChecksStep({ t, api, onDone, initial }: StepProps<ChecksView>) {
  const [view, setView] = useState<ChecksView | undefined>(initial);
  const [busy, setBusy] = useState(initial === undefined);
  const [error, setError] = useState('');
  // The assistant's reload is a new function at each of its renders: kept
  // here, so that the run is not made again by the render it causes.
  const done = useRef(onDone);
  done.current = onDone;
  const run = useCallback(() => {
    setBusy(true);
    setError('');
    void api.post<ChecksView>('/checks', { language: t('locale') }).then((answer) => {
      if (answer.status !== 200) return setError(refusal(t, 'checks', answer.body));
      setView(answer.body);
      if (answer.body.failed === 0) done.current();
    }, () => setError(t('checks_error_other'))).finally(() => setBusy(false));
  }, [api, t]);
  const opened = useRef(false);
  useEffect(() => {
    if (initial || opened.current) return;
    opened.current = true;
    run();
  }, [initial, run]);

  return (
    <StepFrame t={t} prefix="checks">
      <p className={view && view.failed === 0 && !busy ? 'setup-ok setup-checks-summary' : 'setup-checks-summary'} role="status" aria-live="polite" data-checks-summary={view ? view.failed : ''}>
        {busy ? t('checks_running') : view ? checksSummary(t, view) : ''}
      </p>
      {error ? <p className="setup-error" role="alert">{error}</p> : null}
      {view ? (
        <ul className="setup-checks" aria-busy={busy}>
          {view.lines.map((line, index) => <CheckLine key={`${line.id}-${index}`} t={t} line={line} />)}
        </ul>
      ) : null}
      {view?.lines.some((line) => line.level === 'notice') ? <p className="setup-note">{t('checks_notices')}</p> : null}
      <p className="setup-note">{t('checks_command')}</p>
      <Button className="btn" data-act="setup_checks_again" onClick={run} disabled={busy}>{t('checks_again')}</Button>
    </StepFrame>
  );
}
