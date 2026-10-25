// The assistant's model step's screen (docs/v2/milestone-5-plan.md, decision
// 7): the command to run, a terminal to run it in (a throwaway container,
// on the app's loopback address only, as a session's terminal), and the
// field to paste what it prints. Once saved, the step says since when and
// offers Replace; it never shows the value.
import { useEffect, useState, type FormEvent } from 'react';
import type { CredentialView, ModelView } from '../../../../../src/setup/types.ts';
import { WebTerminal } from '@/components/terminal/Terminal.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';
import { credentialLine } from './Forge.tsx';

export const SETUP_TERMINAL_ROOT = '/api/service/setup/model/terminal';

export function ModelStep({ t, api, onDone, initial, csrf = '', terminalHere = true }: StepProps<ModelView>) {
  const [view, setView] = useState<ModelView | undefined>(initial);
  const [terminal, setTerminal] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (initial) return;
    void api.get<ModelView>('/model').then((answer) => { if (answer.status === 200) setView(answer.body); });
  }, [api, initial]);
  // The terminal goes with the field: once a login is saved, or the step left, its container is removed.
  const showing = terminal && !saved;
  useEffect(() => {
    if (!showing) return;
    return () => { void api.post('/model/terminal/close').catch(() => undefined); };
  }, [api, showing]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('value') ?? '');
    setBusy(true);
    setError('');
    void api.post<ModelView>('/model', { value }).then((answer) => {
      if (answer.status !== 200) return setError(refusal(t, 'model', answer.body));
      setView(answer.body);
      setSaved(true);
      setReplacing(false);
      onDone();
    }, () => setError(t('model_error_other'))).finally(() => setBusy(false));
  };

  const credential: CredentialView | undefined = view?.credential;
  const fromEnvironment = credential?.set === true && credential.source === 'environment';
  const showField = credential !== undefined && !fromEnvironment && (!credential.set || replacing);
  return (
    <StepFrame t={t} prefix="model">
      <h3>{t('model_command')}</h3>
      <pre className="setup-code"><code>{t('model_command_text')}</code></pre>
      {view?.terminal && terminalHere && showField ? (
        terminal ? (
          <div className="setup-terminal">
            <WebTerminal session="setup" root={SETUP_TERMINAL_ROOT} csrf={csrf} active t={t} harness="" fixedMode="shell" />
            <p className="setup-note">{t('model_terminal_note')}</p>
          </div>
        ) : (
          <p>
            <Button className="btn" data-act="setup_terminal" onClick={() => setTerminal(true)}>{t('model_terminal_open')}</Button>
            <span className="setup-note"> {t('model_terminal_elsewhere')}</span>
          </p>
        )
      ) : null}
      {credential === undefined ? <p className="setup-note" aria-busy="true">{t('setup_loading')}</p> : null}
      {saved ? <p className="setup-ok" data-model-result="ok" role="status">{t('model_ok')}</p> : null}
      {credential?.set && !replacing ? (
        <div className="setup-saved">
          <p>{credentialLine(t, 'model', credential)}</p>
          {fromEnvironment ? null : <Button className="btn" data-act="setup_model_replace" onClick={() => { setReplacing(true); setSaved(false); }}>{t('model_replace')}</Button>}
        </div>
      ) : null}
      {showField ? (
        <form className="setup-form" onSubmit={submit} aria-busy={busy}>
          <label htmlFor="setup-model-value">{t('model_field')}</label>
          <Input id="setup-model-value" name="value" type="password" autoComplete="off" spellCheck={false} required maxLength={4096} />
          {error ? <p className="setup-error" role="alert">{error}</p> : null}
          <Button variant="ink" className="primary" type="submit" data-act="setup_model_save" disabled={busy}>{busy ? t('model_saving') : t('model_save')}</Button>
        </form>
      ) : null}
      <p className="setup-note">{t('model_api')}</p>
    </StepFrame>
  );
}
