// The sidebar (docs/v2/ui-overhaul-plan.md, 2.2.1 and U8, lane 35): the
// workspace at the head with the button that folds it ([), the search that
// opens the palette, the four screens with the inbox's count, the lead's
// dot and their chords, the live sessions grouped by state, and at the foot
// the quota gauge, the sample-data line, the person (whose menu opens the API
// access panel too) and the notifications. One theme, light. Open
// on a computer, a rail of icons on a tablet or when folded, a top bar and
// a bottom bar on a phone (styles/app.css).
import { Broadcast, Gauge, ListChecks, MagnifyingGlass, SidebarSimple, TerminalWindow, Tray, type Icon } from '@phosphor-icons/react';
import { memo, useState } from 'react';
import { Button } from '@/components/ui/button.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Toggle } from '@/components/ui/toggle.tsx';
import type { Language } from '@/lib/catalogs.ts';
import type { Translate } from '@/lib/i18n.ts';
import type { ScreenName } from '@/lib/routes.ts';
import type { Me } from '@/lib/screen.ts';
import { isMac, Keys } from './Kbd.tsx';
import { keyLabel } from './keys.ts';
import { Logo } from './Logo.tsx';
import { inboxBadge, NAV, type LeadDot, type SessionGroup, type SidebarMode } from './model.ts';
import { NotifyButton } from './NotifyButton.tsx';
import { quotaLevel, type WeeklyQuota } from './quota.ts';
import { weekdayClock } from '@/lib/time.ts';

const LANGUAGES: readonly Language[] = ['fr', 'en'];

const ICONS: Readonly<Record<string, Icon>> = { tower: Broadcast, inbox: Tray, session: TerminalWindow, lead: ListChecks, consumption: Gauge };

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
  readonly quota?: WeeklyQuota | null;                    // the week's quota, null until the shell has read it
  readonly zone?: string;                                 // the person's time zone, for the reset
  readonly language?: Language;
  readonly onLanguage?: (language: Language) => void;
  readonly onSearch?: () => void;
  readonly onToggle?: () => void;
  readonly onSignOut?: () => void;
  readonly onAccess?: () => void;                          // the API access panel (shell/Access.tsx)
  readonly onPick?: (href: string) => void;               // a screen or a session picked here: the focus stays on it
};

// The week's quota at the sidebar's foot (the product owner's decision of 2026-10-25, 11:14, P227): its percent in
// the Consumption screen's verdict colour, its reset as a weekday and a clock, the whole a link to Consumption, read
// out with its percent and its reset. Folded, the bar alone, its words in its tooltip. On a phone (the owner's answer
// of 12:20), in the top bar: the percent alone over the bar, a 44 px target; the gauge's icon when nothing is measured.
export function QuotaGauge({ t, quota, zone, current, onPick }: { readonly t: Translate; readonly quota: WeeklyQuota; readonly zone: string; readonly current: boolean; readonly onPick?: (href: string) => void }) {
  const when = quota.kind === 'measured' ? weekdayClock(quota.resetsAt, zone, t) : '';
  const name = quota.kind === 'measured' ? t('quota_name', { percent: quota.percent, when }) : t(quota.kind === 'unavailable' ? 'quota_name_unavailable' : 'quota_name_none');
  return (
    <a className="quota-gauge" id="quota-gauge" href="/consumption" data-verdict={quota.kind === 'measured' ? quota.verdict : 'none'} data-level={quota.kind === 'measured' ? quotaLevel(quota.percent) : undefined} aria-label={name} data-tip={name}
      aria-current={current ? 'page' : undefined} onClick={() => onPick?.('/consumption')}>
      {/* Its words are its name's own, in the same order (WCAG 2.5.3, label in name). */}
      <span className="quota-gauge-head" aria-hidden="true">
        <span className="quota-gauge-label">{t('quota_label')}</span>{' '}
        <span className="quota-gauge-percent">{quota.kind === 'measured' ? t('quota_percent', { percent: quota.percent }) : t(quota.kind === 'unavailable' ? 'quota_unavailable' : 'quota_none')}</span>
      </span>
      {quota.kind === 'measured'
        ? <span className="quota-gauge-short" aria-hidden="true">{t('quota_short', { percent: quota.percent })}</span>
        : <Gauge className="quota-gauge-icon" size={16} aria-hidden="true" />}
      {quota.kind === 'measured' ? (
        <>
          <progress className="quota-gauge-bar" max={100} value={Math.min(100, quota.percent)} aria-hidden="true" />{' '}
          <span className="quota-gauge-reset" aria-hidden="true">{t('quota_resets', { when })}</span>
        </>
      ) : null}
    </a>
  );
}

export const Sidebar = memo(function Sidebar(props: SidebarProps) {
  const { t, mode, screen } = props;
  const [menu, setMenu] = useState(false);
  const badge = inboxBadge(props.waiting);
  const signedIn = t('signed_in_as', { name: props.userName });
  const folded = mode === 'rail';
  return (
    <aside className="sidebar" id="sidebar" aria-label={t('side_label')}>
      <div className="side-head">
        <a className="side-brand" href="/"><Logo size={18} /><span className="project">{props.project || t('app_name')}</span></a>
        <Button variant="ghost" className="icon side-toggle" id="sidebar-toggle" aria-label={t(folded ? 'side_expand' : 'side_collapse')} aria-expanded={!folded} aria-controls="sidebar"
          aria-keyshortcuts="[" data-tip={`${t(folded ? 'side_expand' : 'side_collapse')} · [`} onClick={props.onToggle}>
          <SidebarSimple size={16} aria-hidden="true" />
        </Button>
      </div>
      <button type="button" className="search" id="palette-open" aria-label={t('palette_open')} aria-keyshortcuts="Meta+K Control+K" data-tip={`${t('palette_open')} · ${keyLabel('Mod', isMac(), t)} K`} onClick={props.onSearch}>
        <MagnifyingGlass size={16} aria-hidden="true" /><span className="search-text">{t('palette_open')}</span><Keys keys={['Mod+K']} t={t} />
      </button>
      <nav className="side-nav" id="nav" aria-label={t('nav_label')}>
        <ul>
          {NAV.map((item) => {
            const Glyph = ICONS[item.screen] ?? Broadcast;
            const label = t(item.label);
            return (
              <li key={item.screen}>
                <a className="nav-item" href={item.href} data-nav={item.screen} onClick={() => props.onPick?.(item.href)} aria-current={screen === item.screen ? 'page' : undefined}
                  data-tip={`${label} · ${item.chord.join(' ')}${item.screen === 'lead' && props.lead !== 'unknown' ? ` · ${t(`side_lead_${props.lead}`)}` : ''}`}>
                  <Glyph size={16} weight={screen === item.screen ? 'fill' : 'regular'} aria-hidden="true" />
                  <span className="nav-label">{label}</span>
                  <Keys keys={item.chord} t={t} />
                  {item.screen === 'inbox' ? (
                    <>
                      <span className="count" id="inbox-count" hidden={badge === null} aria-hidden="true">{badge ?? ''}</span>
                      {props.waiting ? <span className="sr-only">{t('inbox_waiting', { n: props.waiting })}</span> : null}
                    </>
                  ) : null}
                  {item.screen === 'lead' && props.lead !== 'unknown' ? (
                    <><span className="lead-dot" id="lead-dot" data-lead={props.lead} aria-hidden="true" /><span className="sr-only">{t(`side_lead_${props.lead}`)}</span></>
                  ) : null}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      {/* A group of the sidebar, which is a landmark already, not a region: the tower's block of the same name is one. */}
      {props.groups.length > 0 ? (
        <div className="side-sessions" role="group" aria-labelledby="side-sessions-title">
          <p className="side-title" id="side-sessions-title">{t('side_sessions')}</p>
          {props.groups.map((group) => (
            <div className="side-group" key={group.key} data-group={group.key}>
              <p className="side-group-title" id={`side-group-${group.key}`}><span className="state-dot" data-state={group.key} aria-hidden="true" />{t(`side_group_${group.key}`)}<span className="side-group-count" aria-hidden="true">{group.rows.length}</span></p>
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
        </div>
      ) : null}
      <div className="side-foot">
        {props.quota ? <QuotaGauge t={t} quota={props.quota} zone={props.zone ?? 'UTC'} current={screen === 'consumption'} onPick={props.onPick} /> : null}
        {/* The lead's state in words: its dot beside Plans alone read as a plan running (art director, item 14). */}
        {props.lead === 'unknown' ? null : <p className="lead-status" id="lead-status"><span className="lead-dot" data-lead={props.lead} aria-hidden="true" />{t(`side_lead_${props.lead}`)}</p>}
        {props.source === 'fixtures' ? <p className="source-pill"><span className="long">{t('source_fixtures')}</span><span className="short">{t('source_fixtures_short')}</span></p> : null}
        <div className="side-foot-row">
          <Popover open={menu} onOpenChange={setMenu}>
            <PopoverTrigger asChild>
              <button type="button" className="person" id="person" aria-label={signedIn} data-tip={signedIn}>
                <span className="avatar" aria-hidden="true">{props.userName.slice(0, 1).toUpperCase()}</span><span className="name">{props.userName}</span>
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="person-menu" aria-labelledby="person-menu-title">
              <p className="menu-note" id="person-menu-title">{signedIn}</p>
              {/* Each language named in itself (lane i18n): the person finds theirs whatever the page's. */}
              <div className="menu-language" id="language" role="group" aria-label={t('language_label')}>
                {LANGUAGES.map((language) => (
                  <Toggle key={language} lang={language} data-language={language} pressed={props.language === language} onPressedChange={() => props.onLanguage?.(language)}>{t(`language_${language}`)}</Toggle>
                ))}
              </div>
              {/* Consumption, from the settings too: it left the sidebar's screens (P227). */}
              <a className="plain menu-link" href="/consumption" onClick={() => setMenu(false)}>{t('nav_consumption')}</a>
              {/* The person's API tokens, for cleared run and scripts (C18). */}
              <Button className="plain menu-access" id="access-open" onClick={() => { setMenu(false); props.onAccess?.(); }}>{t('access_open')}</Button>
              <Button className="plain" id="sign-out" onClick={props.onSignOut}>{t('sign_out')}</Button>
            </PopoverContent>
          </Popover>
          <NotifyButton t={t} me={props.me} />
        </div>
      </div>
    </aside>
  );
});
