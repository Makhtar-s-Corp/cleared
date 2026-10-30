// The assistant's checks step's screen (docs/v2/milestone-5-plan.md, sections 1
// and 7, step 8; the owner's request of 2026-10-30): one sentence, "Everything
// is ready", or each thing to fix in one sentence with its button; every line
// of `cleared doctor`'s ready section is in the detail, level in words beside
// its mark. Run by the service in the page's language when the step opens and
// again on demand; the step is done once no line failed.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChecksView, DoctorLine } from '../../../../../src/doctor/types.ts';
import type { StepId } from '../../../../../src/setup/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { hasMark, type Translate } from '@/lib/i18n.ts';
import { lasted } from '@/lib/time.ts';
import { setupPath } from '@/lib/routes.ts';
import { refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';
import './checks.css';

// Where a person fixes what a check found, when a step of the assistant can.
const FIXED_AT: Readonly<Record<string, StepId>> = { model: 'model', forge: 'forge', repository: 'workspace', checkout: 'workspace' };

export function checksSummary(t: Translate, view: ChecksView): string {
  if (view.failed === 0) return t('checks_ready');
  return view.failed === 1 ? t('checks_fail_one') : t('checks_fail_many', { failed: view.failed });
}

// A failure in one sentence; the check's own words when it has none.
const failLine = (t: Translate, line: DoctorLine): string => {
  const said = t(`checks_fail_${line.id}`);
  return hasMark(said) ? line.text : said;
};

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

export function ChecksStep({ t, api, onDone, initial, onOwnAction }: StepProps<ChecksView>) {
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

  const failures = view?.lines.filter((line) => line.level === 'fail') ?? [];
  useEffect(() => { onOwnAction?.(failures.length > 0); }, [onOwnAction, failures.length]);
  const detail = view ? (
    <>
      <p className="setup-note">{t('checks_summary_ok', { count: view.lines.length, took: lasted(view.tookMs, t) })}</p>
      <ul className="setup-checks" aria-busy={busy}>
        {view.lines.map((line, index) => <CheckLine key={`${line.id}-${index}`} t={t} line={line} />)}
      </ul>
      {view.lines.some((line) => line.level === 'notice') ? <p className="setup-note">{t('checks_notices')}</p> : null}
      <p className="setup-note">{t('checks_command')}</p>
      {failures.length === 0 ? <Button className="btn" data-act="setup_checks_again" onClick={run} disabled={busy}>{t('checks_again')}</Button> : null}
    </>
  ) : undefined;

  return (
    <StepFrame t={t} prefix="checks" detail={detail}>
      {busy ? <p className="setup-checks-summary" role="status" aria-live="polite" data-checks-summary=""><span className="setup-spinner" aria-hidden="true" />{t('checks_running')}</p> : null}
      {!busy && view ? <p className={view.failed === 0 ? 'setup-ok setup-checks-summary' : 'setup-checks-summary'} role="status" aria-live="polite" data-checks-summary={view.failed}>{checksSummary(t, view)}</p> : null}
      {error ? <p className="setup-error" role="alert">{error}</p> : null}
      {!busy && failures.length > 0 ? (
        <ul className="setup-fixes">
          {failures.map((line, index) => {
            const at = FIXED_AT[line.id];
            return (
              <li key={`${line.id}-${index}`} data-fix={line.id}>
                <span>{failLine(t, line)}</span>
                {at ? <a className="btn" href={setupPath(at)}>{t('checks_fix')}</a> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {!busy && failures.length > 0 ? <Button variant="ink" className="primary" data-act="setup_checks_again" onClick={run}>{t('checks_again')}</Button> : null}
    </StepFrame>
  );
}
