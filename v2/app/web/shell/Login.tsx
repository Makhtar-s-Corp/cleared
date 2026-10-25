// The sign-in page: a plain form that posts to /login, as before, so the
// server checks the origin, throttles and sets the cookie; nothing of the
// password passes through the page's code. A refusal comes back as this
// page with the server's sentence on the body (data-error), since the page
// runs no inline script.
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import type { Translate } from '@/lib/i18n.ts';
import { Logo } from './Logo.tsx';

export function Login({ t, error }: { readonly t: Translate; readonly error?: string | undefined }) {
  return (
    <main className="login">
      <div className="login-brand"><Logo /><span className="name">{t('app_name')}</span></div>
      <form className="login-card" method="post" action="/login">
        <h1>{t('login_title')}</h1>
        {error ? <p className="login-error" role="alert">{error}</p> : null}
        <label htmlFor="name">{t('login_name')}</label>
        <Input id="name" name="name" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={32} autoFocus />
        <label htmlFor="password">{t('login_phrase')}</label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required maxLength={1024} />
        <Button variant="ink" className="primary" type="submit">{t('login_submit')}</Button>
      </form>
    </main>
  );
}
