// The shell in the browser: who is signed in, the clock, the inbox count,
// the "Lead · always on" pill, the theme and notifications buttons, signing
// out, and the screen of the address, with its catalog over the shell's.
//
// One document for the whole app (docs/v2/ui-overhaul-plan.md, section
// 2.1, lane 34): the router (lib/router.tsx) names the screen from the
// address and a click on a link of the app moves without a load; every
// screen and the shell read the one cache (lib/cache.ts), which the
// service's change stream keeps fresh (lib/events.ts); the inbox count and
// the lead's pill read it too and poll nothing of their own. A session
// opened once stays mounted while the person visits other screens, up to
// STACK_MAX (lib/routes.ts), so its terminal, its editor and its thread
// are never made again; the other screens draw again from the cache. Each
// screen keeps its scroll, has its title, turns on its own sheets
// (lib/sheets.ts) and fails alone (lib/boundary.tsx).
import { RouterProvider, useRouterState, type AnyRouter } from '@tanstack/react-router';
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { LeadState } from '../../../src/api/types.ts';
import { json, serviceApi } from '@/lib/api.ts';
import { ScreenBoundary } from '@/lib/boundary.tsx';
import { Cache } from '@/lib/cache.ts';
import { screenCatalog, type Language } from '@/lib/catalogs.ts';
import { Screen } from '@/lib/context.tsx';
import { ChangeStream, type SourceLike } from '@/lib/events.ts';
import { translator } from '@/lib/i18n.ts';
import { CacheContext, useReader } from '@/lib/query.tsx';
import { SCREEN_NAMES, createAppRouter, interceptLinks, loadScreen, loadedScreen } from '@/lib/router.tsx';
import { placeOf, pushStack, titleKey, type Place, type ScreenName } from '@/lib/routes.ts';
import { ApiError, type Me, type ScreenContext } from '@/lib/screen.ts';
import { showSheets } from '@/lib/sheets.ts';
import { Header } from './Header.tsx';
import { leadPillShown, waitingCount } from './model.ts';

export type ShellStart = {
  readonly language: Language;
  readonly project: string;
  readonly userName: string;
  readonly source: Me['source'];
};

type Shared = {
  readonly start: ShellStart;
  readonly cache: Cache;
  readonly router: AnyRouter;
};

export function App({ start }: { readonly start: ShellStart }) {
  const shared = useMemo<Shared>(() => {
    // A read needs no anti-forgery token: the cache reads before /api/me answers.
    const cache = new Cache((path) => serviceApi({ csrf: '' })(path));
    let shared: Shared;
    const router = createAppRouter(function Root() { return <Shell shared={shared} />; });
    shared = { start, cache, router };
    return shared;
  }, [start]);

  useEffect(() => {
    const { cache, router } = shared;
    cache.start();
    const stream = new ChangeStream(cache, {
      open: (url) => new EventSource(url) as unknown as SourceLike,
      later: (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); },
    });
    stream.start();
    const release = interceptLinks(router, cache);
    // Every screen's chunk, once the first screen has drawn: a switch then waits for none.
    const warm = setTimeout(() => { for (const name of SCREEN_NAMES) void loadScreen(name).catch(() => {}); }, 0);
    return () => {
      clearTimeout(warm);
      release();
      stream.stop();
      cache.stop();
    };
  }, [shared]);

  return <CacheContext.Provider value={shared.cache}><RouterProvider router={shared.router} /></CacheContext.Provider>;
}

function useScreenComponent(name: ScreenName): ComponentType | undefined {
  const [, loaded] = useState(0);
  const component = loadedScreen(name);
  useEffect(() => {
    if (component) return;
    let live = true;
    void loadScreen(name).then(() => { if (live) loaded((n) => n + 1); }, () => {});
    return () => { live = false; };
  }, [name, component]);
  return component;
}

type HostProps = {
  readonly screen: ScreenName;
  readonly path: string;
  readonly me: Me;
  readonly language: Language;
  readonly cache: Cache;
  readonly raw: ScreenContext['api'];
  readonly navigate: NonNullable<ScreenContext['navigate']>;
  readonly inboxChanged: () => void;
};

// One screen: its catalog, its reader of the cache, its boundary.
function ScreenHost({ screen, path, me, language, cache, raw, navigate, inboxChanged }: HostProps) {
  const Component = useScreenComponent(screen);
  const reader = useReader(cache, raw);
  const t = useMemo(() => translator(screenCatalog(screen, language)), [screen, language]);
  const context = useMemo<ScreenContext>(() => ({
    t, me, api: reader.api, now: () => new Date(), path, inboxChanged, live: reader.live, navigate,
  }), [t, me, reader, path, inboxChanged, navigate]);
  return (
    <Screen.Provider value={context}>
      <ScreenBoundary t={t} screen={screen}>{Component ? <Component /> : null}</ScreenBoundary>
    </Screen.Provider>
  );
}

// The window's scroll, kept for each place and given back on its return.
function useScrollKept(key: string): void {
  const kept = useRef(new Map<string, number>());
  const current = useRef(key);
  useEffect(() => {
    const onScroll = () => { kept.current.set(current.current, window.scrollY); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    if (current.current === key) return;
    current.current = key;
    window.scrollTo(0, kept.current.get(key) ?? 0);
  }, [key]);
}

function Shell({ shared }: { readonly shared: Shared }) {
  const { start, cache, router } = shared;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const place: Place = placeOf(pathname) ?? { screen: 'tower', path: '/' };
  const t = useMemo(() => translator(screenCatalog(place.screen, start.language)), [place.screen, start.language]);
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

  const raw = useMemo(() => (me ? serviceApi(me) : null), [me]);
  const readOnly = useMemo(() => serviceApi({ csrf: '' }), []);
  const shellReader = useReader(cache, raw ?? readOnly);

  // The count and the pill, from the cache, each time it holds a new inbox
  // or lead. This read is also what starts the lead after a service restart
  // (the lead starts on its first route), so the lead does not wait for its
  // own screen to be opened.
  const recount = useCallback(async () => {
    const [items, lead] = await Promise.all([
      shellReader.api<{ state: string }[]>('/inbox').catch(() => null),
      shellReader.api<LeadState>('/lead').catch(() => null),
    ]);
    setWaiting(items ? waitingCount(items) : null);
    setLeadOn(leadPillShown(lead));
  }, [shellReader]);
  useEffect(() => {
    void recount();
    return shellReader.live(() => void recount());
  }, [shellReader, recount]);

  const signOut = useCallback(async () => {
    try { if (me) await json('/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrf } }); }
    finally {
      cache.dispose();
      location.assign('/login');
    }
  }, [me, cache]);

  const navigate = useCallback<NonNullable<ScreenContext['navigate']>>((href, options) => {
    void router.navigate({ href, ...(options?.replace ? { replace: true } : {}) });
  }, [router]);
  const inboxChanged = useCallback(() => { void cache.refetch(['inbox']).catch(() => {}); }, [cache]);

  // The sessions kept mounted: the one shown first.
  const stack = useRef<string[]>([]);
  if (place.session && stack.current[0] !== place.session) stack.current = pushStack(stack.current, place.session);

  useScrollKept(place.path);
  useLayoutEffect(() => {
    showSheets(place.screen);
    document.body.dataset.screen = place.screen;
    document.title = `${t('app_name')} · ${t(titleKey(place.screen))}`;
  }, [place.screen, t]);

  const host = (screen: ScreenName, path: string) => (me && raw
    ? <ScreenHost screen={screen} path={path} me={me} language={start.language} cache={cache} raw={raw} navigate={navigate} inboxChanged={inboxChanged} />
    : null);
  return (
    <>
      <Header t={t} screen={place.screen} project={start.project} userName={start.userName} source={start.source} me={me}
        waiting={waiting} leadOn={leadOn} now={now} language={start.language} onSignOut={() => void signOut()} />
      <main id="screen" className="screen">
        {place.session ? null : <Fragment key={place.screen === 'ask' ? place.path : place.screen}>{host(place.screen, place.path)}</Fragment>}
        {stack.current.map((id) => (
          <div key={id} data-session-view={id} style={{ display: id === place.session ? 'contents' : 'none' }}>
            {host('session', `/sessions/${id}`)}
          </div>
        ))}
      </main>
    </>
  );
}
