// The shell in the browser: who is signed in, the clock, the inbox count,
// the "Lead · always on" pill, the theme and notifications buttons, signing
// out, and the screen of this page (the body's data-screen, written by the
// server for the address), with its catalog over the shell's.
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import type { LeadState } from '../../../src/api/types.ts';
import { json, serviceApi } from '@/lib/api.ts';
import { screenCatalog, type Language } from '@/lib/catalogs.ts';
import { Screen } from '@/lib/context.tsx';
import { translator } from '@/lib/i18n.ts';
import { ApiError, type Me, type ScreenContext } from '@/lib/screen.ts';
import { Header, type ShellScreen } from './Header.tsx';
import { INBOX_MS, leadPillShown, waitingCount } from './model.ts';

// Each screen and its sheet load with its own chunk, as each screen loaded
// its own sheet before: the sheets name classes alike (.btn, .card).
const SCREENS: Readonly<Record<ShellScreen, ComponentType>> = {
  tower: lazy(() => import('@/screens/tower/Tower.tsx')),
  session: lazy(() => import('@/screens/session/Session.tsx')),
  lead: lazy(() => import('@/screens/lead/Lead.tsx')),
  inbox: lazy(() => import('@/screens/inbox/Inbox.tsx')),
  ask: lazy(() => import('@/screens/ask/Ask.tsx')),
};

export type ShellStart = {
  readonly screen: ShellScreen;
  readonly language: Language;
  readonly project: string;
  readonly userName: string;
  readonly source: Me['source'];
};

export function App({ start }: { readonly start: ShellStart }) {
  const t = useMemo(() => translator(screenCatalog(start.screen, start.language)), [start.screen, start.language]);
  const [me, setMe] = useState<Me | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [leadOn, setLeadOn] = useState(false);

  useEffect(() => {
    json<Me>('/api/me').then(setMe, (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) location.assign('/login');
    });
    setNow(new Date());
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(clock);
  }, []);

  const api = useMemo(() => (me ? serviceApi(me) : null), [me]);
  const recount = useCallback(async () => {
    if (!api) return;
    try { setWaiting(waitingCount(await api<{ state: string }[]>('/inbox'))); }
    catch { setWaiting(null); }
  }, [api]);

  // On the inbox count's poll, on every page. This read is also what
  // starts the lead after a service restart (the lead starts on its first
  // route), so the lead does not wait for its own screen to be opened.
  useEffect(() => {
    if (!api) return;
    const lead = async () => {
      try { setLeadOn(leadPillShown(await api<LeadState>('/lead'))); }
      catch { setLeadOn(false); }
    };
    void recount();
    void lead();
    const timer = setInterval(() => { void recount(); void lead(); }, INBOX_MS);
    return () => clearInterval(timer);
  }, [api, recount]);

  const signOut = useCallback(async () => {
    try { if (me) await json('/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrf } }); }
    finally { location.assign('/login'); }
  }, [me]);

  const context = useMemo<ScreenContext | null>(() => (me && api
    ? { t, me, api, now: () => new Date(), path: location.pathname, inboxChanged: () => void recount() }
    : null), [t, me, api, recount]);

  const Current = SCREENS[start.screen];
  return (
    <>
      <Header t={t} screen={start.screen} project={start.project} userName={start.userName} source={start.source} me={me}
        waiting={waiting} leadOn={leadOn} now={now} language={start.language} onSignOut={() => void signOut()} />
      <main id="screen" className="screen">
        {context ? (
          <Screen.Provider value={context}>
            <Suspense fallback={null}><Current /></Suspense>
          </Screen.Provider>
        ) : null}
      </main>
    </>
  );
}
