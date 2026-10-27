// The assistant's owner step's screen (docs/v2/milestone-5-plan.md, section
// 5.2). Before anyone is signed in, OwnerFirst: the setup code the command
// printed, a name and a password, posted to the app's /setup/owner, which
// makes the account and signs it in. Then, and when the owner comes back to
// the step, the public half of the approval signature, with the line it
// goes in.
import { useEffect, useState, type FormEvent } from 'react';
import type { OwnerMade, OwnerView } from '../../../../../src/setup/types.ts';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { refusal } from '../model.ts';
import { StepFrame, type StepProps } from '../step.tsx';

type Shown = { readonly name: string | null; readonly publicKey: string | null; readonly existed?: boolean };

export function OwnerMadePanel({ t, made }: { readonly t: Translate; readonly made: Shown }) {
  const [copied, setCopied] = useState(false);
  const line = made.publicKey ? `human_public_key = ${made.publicKey}` : '';
  const copy = () => void navigator.clipboard?.writeText(line).then(() => setCopied(true), () => undefined);
  return (
    <div className="setup-result" data-owner-made>
      <h3>{t('owner_done_title')}</h3>
      <p>{t('owner_done_body', { name: made.name ?? '' })}</p>
      <h3>{t('owner_signing_title')}</h3>
      {made.publicKey ? (
        <>
          <p>{t('owner_signing_body')}</p>
          {made.existed ? <p className="setup-note">{t('owner_signing_existed')}</p> : null}
          {/* Issue #432: nothing to commit. The line stays at hand for a release lock set up by hand. */}
          <details className="setup-more">
            <summary>{t('owner_signing_more')}</summary>
            <p>{t('owner_signing_by_hand')}</p>
            <pre className="setup-code" data-public-key><code>{line}</code></pre>
            <Button className="btn" data-act="setup_copy" onClick={copy}>{copied ? t('owner_copied') : t('owner_copy')}</Button>
          </details>
        </>
      ) : <p className="setup-error" role="alert">{t('owner_signing_missing')}</p>}
    </div>
  );
}

export function OwnerFirst({ t, onMade }: { readonly t: Translate; readonly onMade: (made: OwnerMade) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    void fetch('/setup/owner', {
      method: 'POST', credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ code: form.get('code'), name: form.get('name'), password: form.get('password') }),
    }).then(async (response) => {
      const body = await response.json().catch(() => ({})) as OwnerMade & { error?: string };
      if (response.status === 201) return onMade(body);
      const wait = Number(response.headers.get('retry-after') ?? 0);
      setError(body.error === 'throttled' ? t('owner_error_throttled', { minutes: Math.max(1, Math.ceil(wait / 60)) }) : refusal(t, 'owner', body));
    }, () => setError(t('owner_error_other'))).finally(() => setBusy(false));
  };
  return (
    <StepFrame t={t} prefix="owner">
      <form className="setup-form" onSubmit={submit} aria-busy={busy}>
        <label htmlFor="setup-code">{t('owner_code')}</label>
        <Input id="setup-code" name="code" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} required maxLength={16} aria-describedby="setup-code-hint" autoFocus />
        <p className="setup-hint" id="setup-code-hint">{t('owner_code_hint')}</p>
        <label htmlFor="setup-name">{t('owner_name')}</label>
        <Input id="setup-name" name="name" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={32} aria-describedby="setup-name-hint" />
        <p className="setup-hint" id="setup-name-hint">{t('owner_name_hint')}</p>
        <label htmlFor="setup-password">{t('owner_phrase')}</label>
        <Input id="setup-password" name="password" type="password" autoComplete="new-password" required minLength={15} maxLength={1024} aria-describedby="setup-password-hint" />
        <p className="setup-hint" id="setup-password-hint">{t('owner_phrase_hint')}</p>
        {error ? <p className="setup-error" role="alert">{error}</p> : null}
        <Button variant="ink" className="primary" type="submit" data-act="setup_owner" disabled={busy}>{busy ? t('owner_sending') : t('owner_submit')}</Button>
      </form>
    </StepFrame>
  );
}

export function OwnerStep({ t, api, initial }: StepProps<OwnerView>) {
  const [view, setView] = useState<OwnerView | undefined>(initial);
  useEffect(() => {
    if (initial) return;
    void api.get<OwnerView>('/owner').then((answer) => { if (answer.status === 200) setView(answer.body); });
  }, [api, initial]);
  return (
    <StepFrame t={t} prefix="owner">
      {view ? <OwnerMadePanel t={t} made={view} /> : <p className="setup-note" aria-busy="true">{t('setup_loading')}</p>}
    </StepFrame>
  );
}
