// The shell's header (tower.png): the brand, the project, the screens, the
// sample-data pill, then "Lead · always on", the notifications button, the
// clock, the theme button and the signed-in person with Sign out.
import { Moon, Sun } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import type { Translate } from '@/lib/i18n.ts';
import type { Me } from '@/lib/screen.ts';
import { applyTheme, currentTheme, type Theme } from './model.ts';
import { NotifyButton } from './NotifyButton.tsx';

// ask: a question to the code (decision 28), opened from the tower's bar; no tab of its own.
export type ShellScreen = 'tower' | 'inbox' | 'session' | 'lead' | 'ask';

export function Logo({ className = 'logo' }: { readonly className?: string }) {
  return <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 L22 20 H2 Z" /></svg>;
}

export type HeaderProps = {
  readonly t: Translate;
  readonly screen: ShellScreen;
  readonly project: string;
  readonly userName: string;
  readonly source: Me['source'];
  readonly me: Me | null;                                 // null until /api/me answers
  readonly waiting: number | null;                        // the inbox count; null: not known
  readonly leadOn: boolean;
  readonly now: Date | null;                              // null: the clock is not drawn yet
  readonly language: Me['language'];
  readonly onSignOut?: () => void;
};

function Clock({ now, language }: { readonly now: Date | null; readonly language: Me['language'] }) {
  return (
    <time className="clock" id="clock" dateTime={now ? now.toISOString() : undefined}>
      {now ? now.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}
    </time>
  );
}

function ThemeButton({ t }: { readonly t: Translate }) {
  const [theme, setTheme] = useState<Theme>(() => (typeof document === 'undefined' ? 'light' : currentTheme()));
  const flip = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
    setTheme(next);
  };
  return (
    <Button variant="ghost" className="icon theme" id="theme" aria-label={t(theme === 'dark' ? 'theme_light' : 'theme_dark')} aria-pressed={theme === 'dark'} onClick={flip}>
      {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
    </Button>
  );
}

export function Header(props: HeaderProps) {
  const { t, screen } = props;
  const tab = (target: ShellScreen, href: string, label: string, extra?: ReactNode) => (
    <a href={href} aria-current={screen === target ? 'page' : undefined}>{label}{extra}</a>
  );
  const count = props.waiting !== null && props.waiting > 0 ? props.waiting : null;
  const signedIn = t('signed_in_as', { name: props.userName });
  return (
    <>
      <a className="skip" href="#screen">{t('skip_to_content')}</a>
      <header className="top">
        <div className="bar">
          <a className="brand" href="/"><Logo /><span className="name">{t('app_name')}</span></a>
          {props.project ? <><span className="slash" aria-hidden="true">/</span><span className="project">{props.project}</span></> : null}
          <nav className="views" aria-label={t('nav_label')}>
            {tab('tower', '/', t('nav_tower'))}
            {tab('inbox', '/inbox', t('nav_inbox'), <span className="count" id="inbox-count" hidden={count === null} aria-label={props.waiting === null ? undefined : t('inbox_waiting', { n: props.waiting })}>{count ?? ''}</span>)}
            {tab('session', '/sessions', t('nav_sessions'))}
            <span aria-disabled="true" title={t('nav_tickets_later')}>{t('nav_tickets')}</span>
            {tab('lead', '/lead', t('nav_plans'))}
          </nav>
          {props.source === 'fixtures' ? <span className="source-pill">{t('source_fixtures')}</span> : null}
          <div className="right">
            <a className="lead-pill" id="lead-pill" href="/lead" hidden={!props.leadOn}>{t('lead_pill')}</a>
            <NotifyButton t={t} me={props.me} />
            <Clock now={props.now} language={props.language} />
            <ThemeButton t={t} />
            <div className="me">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" className="avatar" aria-label={signedIn}>{props.userName.slice(0, 1).toUpperCase()}</Button>
                </PopoverTrigger>
                <PopoverContent>
                  <p>{signedIn}</p>
                  <Button className="plain" id="sign-out" onClick={props.onSignOut}>{t('sign_out')}</Button>
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>
      </header>
    </>
  );
}
