// The sidebar (docs/v2/ui-overhaul-plan.md, 2.2.1 and U8, lane 35): the
// workspace at the head with the button that folds it ([), the search that
// opens the palette, the four screens with the inbox's count, the lead's
// dot and their chords, the live sessions grouped by state, and at the foot
// the sample-data line, the person, the notifications and the theme. Open
// on a computer, a rail of icons on a tablet or when folded, a top bar and
// a bottom bar on a phone (styles/app.css).
import { Broadcast, ListChecks, MagnifyingGlass, Moon, SidebarSimple, Sun, TerminalWindow, Tray, type Icon } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import type { Translate } from '@/lib/i18n.ts';
import type { ScreenName } from '@/lib/routes.ts';
import type { Me } from '@/lib/screen.ts';
import { Keys } from './Kbd.tsx';
import { Logo } from './Logo.tsx';
import { inboxBadge, NAV, type LeadDot, type SessionGroup, type SidebarMode, type Theme } from './model.ts';
import { NotifyButton } from './NotifyButton.tsx';

const ICONS: Readonly<Record<string, Icon>> = { tower: Broadcast, inbox: Tray, session: TerminalWindow, lead: ListChecks };

// A group shows this many sessions; the rest are on the sessions screen.
export const GROUP_MAX = 8;

export type SidebarProps = {
  readonly t: Translate;
  readonly mode: SidebarMode;
  readonly screen: ScreenName;
  readonly session?: string | undefined;                  // the session shown, marked in its group
  readonly project: string;
  readonly userName: string;
  readonly source: Me['source'];
  readonly me: Me | null;
  readonly waiting: number | null;
  readonly lead: LeadDot;
  readonly groups: readonly SessionGroup[];
  readonly theme: Theme;
  readonly onTheme?: () => void;
  readonly onSearch?: () => void;
  readonly onToggle?: () => void;
  readonly onSignOut?: () => void;
  readonly onPick?: (href: string) => void;               // a screen or a session picked here: the focus stays on it
};

export function ThemeButton({ t, theme, onFlip }: { readonly t: Translate; readonly theme: Theme; readonly onFlip?: () => void }) {
  return (
    <Button variant="ghost" className="icon theme" id="theme" aria-label={t(theme === 'dark' ? 'theme_light' : 'theme_dark')} aria-pressed={theme === 'dark'} title={t(theme === 'dark' ? 'theme_light' : 'theme_dark')} onClick={onFlip}>
      {theme === 'dark' ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
    </Button>
  );
}

export function Sidebar(props: SidebarProps) {
  const { t, mode, screen } = props;
  const badge = inboxBadge(props.waiting);
  const signedIn = t('signed_in_as', { name: props.userName });
  const folded = mode === 'rail';
  return (
    <aside className="sidebar" id="sidebar" aria-label={t('side_label')}>
      <div className="side-head">
        <a className="side-brand" href="/"><Logo size={18} /><span className="project">{props.project || t('app_name')}</span></a>
        <Button variant="ghost" className="icon side-toggle" id="sidebar-toggle" aria-label={t(folded ? 'side_expand' : 'side_collapse')} aria-expanded={!folded} aria-controls="sidebar"
          aria-keyshortcuts="[" title={`${t(folded ? 'side_expand' : 'side_collapse')} ([)`} onClick={props.onToggle}>
          <SidebarSimple size={16} aria-hidden="true" />
        </Button>
      </div>
      <button type="button" className="search" id="palette-open" aria-label={t('palette_open')} aria-keyshortcuts="Meta+K Control+K" title={t('key_palette')} onClick={props.onSearch}>
        <MagnifyingGlass size={16} aria-hidden="true" /><span className="search-text">{t('palette_open')}</span><Keys keys={['Mod+K']} />
      </button>
      <nav className="side-nav" id="nav" aria-label={t('nav_label')}>
        <ul>
          {NAV.map((item) => {
            const Glyph = ICONS[item.screen] ?? Broadcast;
            const label = t(item.label);
            return (
              <li key={item.screen}>
                <a className="nav-item" href={item.href} data-nav={item.screen} onClick={() => props.onPick?.(item.href)} aria-current={screen === item.screen ? 'page' : undefined} title={`${label} (${item.chord.join(' ')})`}>
                  <Glyph size={16} weight={screen === item.screen ? 'fill' : 'regular'} aria-hidden="true" />
                  <span className="nav-label">{label}</span>
                  {item.screen === 'inbox' ? (
                    <>
                      <span className="count" id="inbox-count" hidden={badge === null} aria-hidden="true">{badge ?? ''}</span>
                      {props.waiting ? <span className="sr-only">{t('inbox_waiting', { n: props.waiting })}</span> : null}
                    </>
                  ) : null}
                  {item.screen === 'lead' && props.lead !== 'unknown' ? (
                    <><span className="lead-dot" id="lead-dot" data-lead={props.lead} aria-hidden="true" /><span className="sr-only">{t(`side_lead_${props.lead}`)}</span></>
                  ) : null}
                  <Keys keys={item.chord} />
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      {props.groups.length > 0 ? (
        <section className="side-sessions" aria-labelledby="side-sessions-title">
          <p className="side-title" id="side-sessions-title">{t('side_sessions')}</p>
          {props.groups.map((group) => (
            <div className="side-group" key={group.key} data-group={group.key}>
              <p className="side-group-title" id={`side-group-${group.key}`}><span className="state-dot" data-state={group.key} aria-hidden="true" />{t(`side_group_${group.key}`)}</p>
              <ul aria-labelledby={`side-group-${group.key}`}>
                {group.rows.slice(0, GROUP_MAX).map((row) => (
                  <li key={row.id}>
                    <a className="side-session" href={`/sessions/${encodeURIComponent(row.id)}`} onClick={() => props.onPick?.(`/sessions/${encodeURIComponent(row.id)}`)} aria-current={props.session === row.id ? 'page' : undefined} title={`${row.ticket} · ${row.title}`}>
                      <span className="sr-only">{row.ticket} </span><span className="title">{row.title}</span>
                    </a>
                  </li>
                ))}
                {group.rows.length > GROUP_MAX ? <li><a className="side-session more" href="/sessions">{t('side_more', { n: group.rows.length - GROUP_MAX })}</a></li> : null}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
      <div className="side-foot">
        {props.source === 'fixtures' ? <p className="source-pill"><span className="long">{t('source_fixtures')}</span><span className="short">{t('source_fixtures_short')}</span></p> : null}
        <div className="side-foot-row">
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="person" id="person" aria-label={signedIn}>
                <span className="avatar" aria-hidden="true">{props.userName.slice(0, 1).toUpperCase()}</span><span className="name">{props.userName}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="person-menu">
              <p className="menu-note">{signedIn}</p>
              {/* On a phone the theme's button is here, the top bar has no room for it. */}
              <Button className="plain menu-theme" onClick={props.onTheme}>{t(props.theme === 'dark' ? 'theme_light' : 'theme_dark')}</Button>
              <Button className="plain" id="sign-out" onClick={props.onSignOut}>{t('sign_out')}</Button>
            </PopoverContent>
          </Popover>
          <NotifyButton t={t} me={props.me} />
          <ThemeButton t={t} theme={props.theme} onFlip={props.onTheme} />
        </div>
      </div>
    </aside>
  );
}
