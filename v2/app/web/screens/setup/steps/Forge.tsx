// The assistant's forge step's screen (docs/v2/milestone-5-plan.md, sections
// 5.2 and 11; issue #497): GitHub or GitLab, two radio buttons of one group,
// GitHub first and chosen until a GitLab token is saved alone. A link that
// opens the forge's page with the token's name and permissions filled in, a
// hidden field, one button; the permissions and the rest are in the detail.
// The service checks the token on the spot. Once saved, the step says it is
// connected; since when and Replace are in the detail. It never shows the
// value, and the service never sends it back.
import { useEffect, useState, type FormEvent } from 'react';
import { FORGE_RIGHTS, type CredentialView, type ForgeChecked, type ForgeView, type GitLabView } from '../../../../../src/setup/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { dayOf, refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';
import './forge.css';

// GitHub's page that makes a fine-grained credential, its name and the
// permissions FORGE_RIGHTS requires filled in (GitHub's "Pre-filling
// fine-grained personal access token details using URL parameters"). `statuses`
// is the API's name of what the page calls Commit statuses.
const FORGE_PARAMETER: Readonly<Record<string, string>> = { commit_statuses: 'statuses' };
export const githubTokenPage = (): string => {
  const query = new URLSearchParams({ name: 'Cleared' });
  for (const right of FORGE_RIGHTS) if (!right.optional) query.set(FORGE_PARAMETER[right.permission] ?? right.permission, right.access);
  return `https://github.com/settings/personal-access-tokens/new?${query.toString()}`;
};
const GITLAB_COM = 'https://gitlab.com';
const UNSET: GitLabView = { credential: { set: false }, address: GITLAB_COM };

type Forge = ForgeChecked['forge'];

// The page of a GitLab that makes a personal access token, its name and its
// scope filled in.
export const gitlabTokenPage = (address: string): string => `${address.replace(/\/+$/, '')}/-/user_settings/personal_access_tokens?name=Cleared&scopes=api`;

const hostOf = (address: string): string => {
  try { return new URL(address).host; } catch { return address; }
};

// The one sentence of a saved credential, and what the detail says of it.
export function credentialLine(t: Translate, prefix: string, credential: CredentialView, values: Record<string, string> = {}): string {
  if (!credential.set) return '';
  if (credential.source === 'environment') return t(`${prefix}_set_environment`, values);
  return credential.at ? t(`${prefix}_set`, { ...values, date: dayOf(credential.at, t) }) : t(`${prefix}_set_undated`, values);
}

export function credentialDetail(t: Translate, prefix: string, credential: CredentialView): string {
  if (!credential.set) return '';
  if (credential.source === 'environment') return t(`${prefix}_set_environment_detail`);
  return credential.at ? t(`${prefix}_set_detail`, { date: dayOf(credential.at, t) }) : '';
}

export function checkedLine(t: Translate, checked: ForgeChecked): string {
  const prefix = checked.forge === 'gitlab' ? 'gitlab' : 'forge';
  const names = checked.sample.join(', ');
  if (checked.more) return t(`${prefix}_ok_more`, { count: checked.repositories, names });
  return checked.repositories === 1 ? t(`${prefix}_ok_one`, { names }) : t(`${prefix}_ok_many`, { count: checked.repositories, names });
}

// GitLab's fields: its address, where to make the token, and the hidden field.
export function GitLabFields({ t, address, busy, error, onSubmit }: { readonly t: Translate; readonly address: string; readonly busy: boolean; readonly error: string; readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const [typed, setTyped] = useState(address);
  let page = gitlabTokenPage(GITLAB_COM);
  try { if (/^https?:\/\//.test(typed)) page = gitlabTokenPage(new URL(typed).href); } catch { /* the address is said wrong when it is checked */ }
  return (
    <form className="setup-form" onSubmit={onSubmit} aria-busy={busy}>
      <label htmlFor="setup-gitlab-address">{t('gitlab_address_field')}</label>
      <Input id="setup-gitlab-address" name="address" type="url" inputMode="url" autoComplete="url" spellCheck={false} required maxLength={300}
        aria-describedby="setup-gitlab-address-hint" value={typed} onChange={(event) => setTyped(event.currentTarget.value)} />
      <p className="setup-hint" id="setup-gitlab-address-hint">{t('gitlab_address_hint')}</p>
      <p className="forge-make"><a className="setup-link" href={page} target="_blank" rel="noreferrer">{t('gitlab_create')}</a></p>
      <label htmlFor="setup-gitlab-value">{t('gitlab_field')}</label>
      <Input id="setup-gitlab-value" name="value" type="password" autoComplete="off" spellCheck={false} required maxLength={512} />
      {error ? <p className="setup-error" role="alert">{error}</p> : null}
      <Button variant="ink" className="primary" type="submit" data-act="setup_gitlab_check" disabled={busy}>{busy ? t('gitlab_checking') : t('gitlab_check')}</Button>
    </form>
  );
}

// What the step is first drawn with: GitLab's part may be left out.
type Initial = { readonly credential: CredentialView; readonly gitlab?: GitLabView };

export function ForgeStep({ t, api, onDone, initial }: StepProps<Initial>) {
  const [credential, setCredential] = useState<CredentialView | undefined>(initial?.credential);
  const [gitlab, setGitlab] = useState<GitLabView | undefined>(initial ? initial.gitlab ?? UNSET : undefined);
  // GitLab is chosen when its token is saved and GitHub's is not.
  const [choice, setChoice] = useState<Forge>(initial?.gitlab?.credential.set && !initial.credential.set ? 'gitlab' : 'github');
  const [checked, setChecked] = useState<ForgeChecked | undefined>();
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (initial) return;
    void api.get<ForgeView>('/forge').then((answer) => {
      if (answer.status !== 200) return;
      setCredential(answer.body.credential);
      setGitlab(answer.body.gitlab);
      if (answer.body.gitlab.credential.set && !answer.body.credential.set) setChoice('gitlab');
    });
  }, [api, initial]);

  const send = (forge: Forge, body: Record<string, string>) => {
    setBusy(true);
    setError('');
    void api.post<ForgeChecked>('/forge', { forge, ...body }).then((answer) => {
      if (answer.status !== 200) return setError(refusal(t, forge === 'gitlab' ? 'gitlab' : 'forge', answer.body));
      setChecked(answer.body);
      if (forge === 'gitlab') setGitlab({ credential: answer.body.credential, address: body.address ?? GITLAB_COM });
      else setCredential(answer.body.credential);
      setReplacing(false);
      onDone();
    }, () => setError(t(forge === 'gitlab' ? 'gitlab_error_other' : 'forge_error_other'))).finally(() => setBusy(false));
  };
  const submit = (forge: Forge) => (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    send(forge, { value: String(form.get('value') ?? ''), ...(forge === 'gitlab' ? { address: String(form.get('address') ?? '').trim() } : {}) });
  };
  const pick = (forge: Forge) => { setChoice(forge); setChecked(undefined); setReplacing(false); setError(''); };

  const saved = choice === 'gitlab' ? gitlab?.credential : credential;
  const fromEnvironment = saved?.set === true && saved.source === 'environment';
  const showField = saved !== undefined && !fromEnvironment && (!saved.set || replacing);
  const host = hostOf(gitlab?.address ?? GITLAB_COM);
  const prefix = choice === 'gitlab' ? 'gitlab' : 'forge';
  const savedLine = saved?.set ? credentialDetail(t, prefix, saved) : '';
  const detail = (
    <>
      {saved?.set && !replacing ? (
        <div className="setup-saved">
          {savedLine ? <p>{savedLine}</p> : null}
          {fromEnvironment ? null : (
            <Button className="btn" data-act={choice === 'gitlab' ? 'setup_gitlab_replace' : 'setup_forge_replace'} onClick={() => { setReplacing(true); setChecked(undefined); }}>
              {t(choice === 'gitlab' ? 'gitlab_replace' : 'forge_replace')}
            </Button>
          )}
        </div>
      ) : null}
      {choice === 'github' ? (
        <>
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
        </>
      ) : (
        <>
          <h3>{t('gitlab_rights_title')}</h3>
          <ul className="setup-rights">
            <li>
              <span className="setup-right-name">{t('gitlab_scope_name')}</span>
              <span className="setup-right-access"><code>{t('gitlab_scope_value')}</code></span>
              <span className="setup-right-use">{t('gitlab_scope_use')}</span>
            </li>
            <li>
              <span className="setup-right-name">{t('gitlab_role_name')}</span>
              <span className="setup-right-access">{t('gitlab_role_developer')}</span>
              <span className="setup-right-use">{t('gitlab_role_use')}</span>
            </li>
          </ul>
        </>
      )}
    </>
  );
  return (
    <StepFrame t={t} prefix="forge" detail={detail}>
      <fieldset className="forge-choice">
        <legend>{t('forge_choice')}</legend>
        <div className="forge-options">
          {(['github', 'gitlab'] as const).map((forge) => (
            <label key={forge} className="forge-option" htmlFor={`setup-forge-${forge}`}>
              <input type="radio" id={`setup-forge-${forge}`} name="forge" value={forge} checked={choice === forge} onChange={() => pick(forge)} disabled={busy} />
              {t(`forge_choice_${forge}`)}
            </label>
          ))}
        </div>
      </fieldset>
      {saved === undefined ? <p className="setup-note" aria-busy="true">{t('setup_loading')}</p> : null}
      {checked && checked.forge === choice ? <p className="setup-ok" data-forge-result="ok" role="status">{checkedLine(t, checked)}</p>
        : saved?.set && !replacing ? <p className="setup-ok" data-forge-saved role="status">{credentialLine(t, prefix, saved, { host })}</p> : null}
      {showField && choice === 'github' ? (
        <form className="setup-form" onSubmit={submit('github')} aria-busy={busy}>
          <p className="forge-make"><a className="setup-link" href={githubTokenPage()} target="_blank" rel="noreferrer" data-forge-create>{t('forge_create')}</a></p>
          <label htmlFor="setup-forge-value">{t('forge_field')}</label>
          <Input id="setup-forge-value" name="value" type="password" autoComplete="off" spellCheck={false} required maxLength={512} />
          {error ? <p className="setup-error" role="alert">{error}</p> : null}
          <Button variant="ink" className="primary" type="submit" data-act="setup_forge_check" disabled={busy}>{busy ? t('forge_checking') : t('forge_check')}</Button>
        </form>
      ) : null}
      {showField && choice === 'gitlab' ? <GitLabFields t={t} address={gitlab?.address ?? GITLAB_COM} busy={busy} error={error} onSubmit={submit('gitlab')} /> : null}
    </StepFrame>
  );
}
