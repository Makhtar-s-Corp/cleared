// The assistant's forge step's screen (docs/v2/milestone-5-plan.md, section
// 5.2): the permissions a fine-grained GitHub token needs, a hidden field,
// and the service's check on the spot. Once saved, the step says since when
// and offers Replace; it never shows the value, and the service never sends
// it back.
import { useEffect, useState, type FormEvent } from 'react';
import { FORGE_RIGHTS, type CredentialView, type ForgeChecked, type ForgeView } from '../../../../../src/setup/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { dayOf, refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';

// GitHub's page that makes a fine-grained credential.
const GITHUB_NEW_FINE_GRAINED = 'https://github.com/settings/personal-access-tokens/new';

export function credentialLine(t: Translate, prefix: string, credential: CredentialView): string {
  if (!credential.set) return '';
  if (credential.source === 'environment') return t(`${prefix}_set_environment`);
  return credential.at ? t(`${prefix}_set`, { date: dayOf(credential.at, t) }) : t(`${prefix}_set_undated`);
}

function checkedLine(t: Translate, checked: ForgeChecked): string {
  const names = checked.sample.join(', ');
  if (checked.more) return t('forge_ok_more', { count: checked.repositories, names });
  return checked.repositories === 1 ? t('forge_ok_one', { names }) : t('forge_ok_many', { count: checked.repositories, names });
}

export function ForgeStep({ t, api, onDone, initial }: StepProps<Pick<ForgeView, 'credential'>>) {
  const [credential, setCredential] = useState<CredentialView | undefined>(initial?.credential);
  const [checked, setChecked] = useState<ForgeChecked | undefined>();
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (initial) return;
    void api.get<ForgeView>('/forge').then((answer) => { if (answer.status === 200) setCredential(answer.body.credential); });
  }, [api, initial]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get('value') ?? '');
    setBusy(true);
    setError('');
    void api.post<ForgeChecked>('/forge', { value }).then((answer) => {
      if (answer.status !== 200) return setError(refusal(t, 'forge', answer.body));
      setChecked(answer.body);
      setCredential(answer.body.credential);
      setReplacing(false);
      onDone();
    }, () => setError(t('forge_error_other'))).finally(() => setBusy(false));
  };

  const fromEnvironment = credential?.set === true && credential.source === 'environment';
  const showField = credential !== undefined && !fromEnvironment && (!credential.set || replacing);
  return (
    <StepFrame t={t} prefix="forge">
      <p><a className="setup-link" href={GITHUB_NEW_FINE_GRAINED} target="_blank" rel="noreferrer">{t('forge_create')}</a></p>
      <h3>{t('forge_rights_title')}</h3>
      <ul className="setup-rights">
        {FORGE_RIGHTS.map((right) => (
          <li key={right.permission}>
            <span className="setup-right-name">{t(`forge_permission_${right.permission}`)}</span>
            <span className="setup-right-access">{t(`forge_access_${right.access}`)}</span>
            <span className="setup-right-use">{t(`forge_use_${right.permission}`)}{right.optional ? <span className="setup-tag">{t('forge_optional')}</span> : null}</span>
          </li>
        ))}
      </ul>
      <p className="setup-note">{t('forge_classic')}</p>
      {credential === undefined ? <p className="setup-note" aria-busy="true">{t('setup_loading')}</p> : null}
      {checked ? <p className="setup-ok" data-forge-result="ok" role="status">{checkedLine(t, checked)}</p> : null}
      {credential?.set && !replacing ? (
        <div className="setup-saved">
          <p>{credentialLine(t, 'forge', credential)}</p>
          {fromEnvironment ? null : <Button className="btn" data-act="setup_forge_replace" onClick={() => { setReplacing(true); setChecked(undefined); }}>{t('forge_replace')}</Button>}
        </div>
      ) : null}
      {showField ? (
        <form className="setup-form" onSubmit={submit} aria-busy={busy}>
          <label htmlFor="setup-forge-value">{t('forge_field')}</label>
          <Input id="setup-forge-value" name="value" type="password" autoComplete="off" spellCheck={false} required maxLength={512} />
          {error ? <p className="setup-error" role="alert">{error}</p> : null}
          <Button variant="ink" className="primary" type="submit" data-act="setup_forge_check" disabled={busy}>{busy ? t('forge_checking') : t('forge_check')}</Button>
        </form>
      ) : null}
    </StepFrame>
  );
}
