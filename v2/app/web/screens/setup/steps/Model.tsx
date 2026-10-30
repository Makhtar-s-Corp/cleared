// The assistant's model step's screen (docs/v2/milestone-5-plan.md, decision
// 7; issue #490): one button opens a terminal in a throwaway container, already
// running the sign-in command, on the app's loopback address only, as a
// session's terminal; the service takes the token from the terminal's output,
// masks it and closes the terminal, so there is nothing to copy. Elsewhere, and
// behind the detail, a field takes what the command printed, wrapped or not.
// Once saved, the step says it is connected; it never shows the value.
import { useEffect, useState, type FormEvent } from 'react';
import type { CredentialView, ModelView } from '../../../../../src/setup/types.ts';
import { WebTerminal } from '@/components/terminal/Terminal.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';
import { credentialDetail, credentialLine } from './Forge.tsx';

export const SETUP_TERMINAL_ROOT = '/api/service/setup/model/terminal';
const COMMAND = 'claude setup-token';
const READ_MS = 2_000;

// A terminal wraps the token (issue #490): what looks like one loses its spaces and line breaks.
export const pastedToken = (value: string): string => (value.trim().startsWith('sk-ant-') ? value.replace(/\s+/g, '') : value.trim());

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
  // The service takes the token by itself: the step reads when it did.
  useEffect(() => {
    if (!showing) return;
    const timer = setInterval(() => {
      void api.get<ModelView>('/model').then((answer) => {
        if (answer.status !== 200 || !answer.body.credential.set) return;
        if (replacing && view?.credential.set && answer.body.credential.set && answer.body.credential.at === view.credential.at) return;
        setView(answer.body);
        setSaved(true);
        setReplacing(false);
        onDone();
      });
    }, READ_MS);
    return () => clearInterval(timer);
  }, [api, showing, replacing, view, onDone]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = pastedToken(String(new FormData(event.currentTarget).get('value') ?? ''));
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
  const needed = credential !== undefined && !fromEnvironment && (!credential.set || replacing);
  const canCapture = view?.terminal === true && terminalHere;
  const pasteForm = (
    <form className="setup-form" onSubmit={submit} aria-busy={busy}>
      <label htmlFor="setup-model-value">{t('model_field')}</label>
      <Input id="setup-model-value" name="value" type="password" autoComplete="off" spellCheck={false} required maxLength={8192} />
      {error ? <p className="setup-error" role="alert">{error}</p> : null}
      <Button variant={canCapture ? 'outline' : 'ink'} className={canCapture ? 'btn' : 'primary'} type="submit" data-act="setup_model_save" disabled={busy}>{busy ? t('model_saving') : t('model_save')}</Button>
    </form>
  );
  const line = credential?.set ? credentialDetail(t, 'model', credential) : '';
  const detail = (
    <>
      {credential?.set && !replacing ? (
        <div className="setup-saved">
          {line ? <p>{line}</p> : null}
          {fromEnvironment ? null : <Button className="btn" data-act="setup_model_replace" onClick={() => { setReplacing(true); setSaved(false); }}>{t('model_replace')}</Button>}
        </div>
      ) : null}
      {needed && canCapture ? (
        <>
          <h3>{t('model_paste_title')}</h3>
          <pre className="setup-code"><code>{COMMAND}</code></pre>
          {pasteForm}
        </>
      ) : null}
      {needed ? <p className="setup-note">{t('model_terminal_note')}</p> : null}
      <p className="setup-note">{t('model_api')}</p>
    </>
  );
  return (
    <StepFrame t={t} prefix="model" sentence={needed && !canCapture ? t('model_intro_elsewhere') : undefined} detail={detail}>
      {credential === undefined ? <p className="setup-note" aria-busy="true">{t('setup_loading')}</p> : null}
      {saved || (credential?.set && !replacing)
        ? <p className="setup-ok" data-model-result="ok" role="status">{saved ? t('model_ok') : credential?.set ? credentialLine(t, 'model', credential) : ''}</p>
        : null}
      {needed && canCapture && !terminal ? <Button variant="ink" className="primary" data-act="setup_terminal" onClick={() => setTerminal(true)}>{t('model_connect')}</Button> : null}
      {needed && canCapture && terminal ? (
        <div className="setup-terminal">
          <p className="setup-note">{t('model_terminal_step')}</p>
          <WebTerminal session="setup" root={SETUP_TERMINAL_ROOT} csrf={csrf} active t={t} harness="" fixedMode="shell" capture />
        </div>
      ) : null}
      {needed && !canCapture ? (
        <>
          <pre className="setup-code"><code>{COMMAND}</code></pre>
          {pasteForm}
        </>
      ) : null}
    </StepFrame>
  );
}
