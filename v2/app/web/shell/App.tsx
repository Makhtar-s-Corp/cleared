// The shell in the browser: who is signed in, the sidebar (the screens, the
// inbox count, the lead's dot, the live sessions, the theme, notifications,
// signing out), the screen's bar, the command palette, the keyboard and its
// sheet (lane 35, docs/v2/ui-overhaul-plan.md, 2.2 and U8), the API access
// panel (shell/Access.tsx, C18), and the screen of the address, with its
// catalog over the shell's.
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
import { Fragment, lazy, memo, Suspense, useCallback, useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react';
import type { LeadState, NextInboxItem, SessionSummary } from '../../../src/api/types.ts';
import { json, serviceApi } from '@/lib/api.ts';
import { ScreenBoundary } from '@/lib/boundary.tsx';
import { Cache } from '@/lib/cache.ts';
import { screenCatalog, type Language } from '@/lib/catalogs.ts';
import { browserStore, rememberLanguage } from '@/lib/language.ts';
import { Screen } from '@/lib/context.tsx';
import { ChangeStream, type SourceLike } from '@/lib/events.ts';
import { translator } from '@/lib/i18n.ts';
import { CacheContext, sameFields, useReader } from '@/lib/query.tsx';
import { SCREEN_NAMES, createAppRouter, interceptLinks, loadScreen, loadedScreen } from '@/lib/router.tsx';
import { KeptView } from '@/lib/stack.tsx';
import { placeOf, pushStack, stackOrder, titleKey, type Place, type ScreenName } from '@/lib/routes.ts';
import { ApiError, type Me, type ScreenContext } from '@/lib/screen.ts';
import { showSheets } from '@/lib/sheets.ts';
import { REFRESH_MS, browserZone, readConsumption } from '@/screens/consumption/model.ts';
import { towerModel, type NeedCard } from '@/screens/tower/model.ts';
import type { Ticket } from '../../../src/tickets/contract.ts';
import { isMac } from './Kbd.tsx';
import type { Action } from './keys.ts';
import {
  SIDEBAR_KEY, applyTheme, currentTheme, hrefOf, leadDot, sessionGroups, sessionRows, sidebarMode, toggledSidebar, waitingCount,
  OPEN_FROM, RAIL_FROM, type SessionRow, type Theme,
} from './model.ts';
import { GESTURES, paletteItems, type PaletteItem } from './palette.ts';
import { AccessPanel } from './Access.tsx';
import { ShortcutSheet, pressTab, useShortcuts, walkRows } from './Shortcuts.tsx';
import { weeklyQuota, type WeeklyQuota } from './quota.ts';
import { Sidebar } from './Sidebar.tsx';

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
      refused: () => {
        json('/api/me').catch((error: unknown) => { if (error instanceof ApiError && error.status === 401) location.assign('/login'); });
      },
    });
    stream.start();
    const release = interceptLinks(router, cache);
    // Every screen's chunk, once the first screen has drawn: a switch then waits for none.
    const warm = setTimeout(() => {
      for (const name of SCREEN_NAMES) void loadScreen(name).catch(() => {});
      void loadPalette().catch(() => {});
    }, 0);
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

// One screen: its catalog, its reader of the cache, its boundary. Drawn
// again only when its own props change: the shell's clock redraws the
// header, not the screens (hidden sessions included).
const ScreenHost = memo(function ScreenHost({ screen, path, me, language, cache, raw, navigate, inboxChanged }: HostProps) {
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
});

// The window's scroll, kept for each place and given back on its return.
// The screen shown again may not be as tall at its first frame (its data
// arrives a frame or two later), so the scroll is set again at each frame
// until it holds, or for RESTORE_FRAMES at most; the scroll events of the
// swap itself (the browser clamping to the new height) are not taken for
// the person's, and the person's own wheel, touch or key ends it at once
// (review of pull request 248, F-b).
const RESTORE_FRAMES = 30;

function useScrollKept(key: string): void {
  const kept = useRef(new Map<string, number>());
  const current = useRef(key);
  const restoring = useRef(false);
  useEffect(() => {
    const onScroll = () => { if (!restoring.current) kept.current.set(current.current, window.scrollY); };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    if (current.current === key) return;
    current.current = key;
    const target = kept.current.get(key) ?? 0;
    restoring.current = true;
    let frames = 0;
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      restoring.current = false;
      for (const name of INTERRUPTS) window.removeEventListener(name, stop);
    };
    for (const name of INTERRUPTS) window.addEventListener(name, stop, { passive: true });
    const settle = () => {
      window.scrollTo(0, target);
      frames += 1;
      if (Math.abs(window.scrollY - target) < 1 || frames >= RESTORE_FRAMES) {
        // The last clamp's event comes after this frame: let it pass first.
        frame = requestAnimationFrame(stop);
        return;
      }
      frame = requestAnimationFrame(settle);
    };
    settle();
    return stop;
  }, [key]);
}

const INTERRUPTS = ['wheel', 'touchstart', 'keydown'] as const;

// The width's band, from two media queries: a phone, a tablet, a computer.
const BANDS = [`(min-width: ${RAIL_FROM}px)`, `(min-width: ${OPEN_FROM}px)`];

function useBand(): number {
  const read = () => (typeof window === 'undefined' ? OPEN_FROM : BANDS.filter((query) => window.matchMedia(query).matches).length);
  const band = useSyncExternalStore((change) => {
    const lists = BANDS.map((query) => window.matchMedia(query));
    for (const list of lists) list.addEventListener('change', change);
    return () => { for (const list of lists) list.removeEventListener('change', change); };
  }, read, () => 2);
  return [0, RAIL_FROM, OPEN_FROM][band] ?? OPEN_FROM;
}

function storedSidebar(): string | null {
  try { return localStorage.getItem(SIDEBAR_KEY); }
  catch { return null; }
}

// What a shown element of a gesture is: drawn and not disabled.
function shownGesture(selector: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    const off = (element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true';
    if (!off && element.getClientRects().length > 0) return element;
  }
  return null;
}

type Overlay = 'palette' | 'sheet' | 'access' | null;

// The palette is a chunk of its own (cmdk and what it brings), loaded once
// the first screen has drawn, so the first draw does not wait for it.
const loadPalette = () => import('./Palette.tsx');
const Palette = lazy(loadPalette);

function Shell({ shared }: { readonly shared: Shared }) {
  const { start, cache, router } = shared;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const place: Place = placeOf(pathname) ?? { screen: 'tower', path: '/' };
  // The person's language, picked again in the account menu: every screen redraws in it, with no reload.
  const [language, setLanguage] = useState<Language>(start.language);
  const pickLanguage = useCallback((next: Language) => {
    rememberLanguage(next, browserStore(), document, location.protocol === 'https:');
    setLanguage(next);
  }, []);
  const t = useMemo(() => translator(screenCatalog(place.screen, language)), [place.screen, language]);
  // The palette names what waits as the tower does: the shell's words over the tower's.
  const towerT = useMemo(() => translator(screenCatalog('tower', language)), [language]);
  const [me, setMe] = useState<Me | null>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const [lead, setLead] = useState<LeadState | null | undefined>(undefined);
  const [rows, setRows] = useState<readonly SessionRow[]>([]);
  const [needs, setNeeds] = useState<readonly NeedCard[]>([]);
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [stored, setStored] = useState<string | null>(storedSidebar);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [gestures, setGestures] = useState<readonly string[]>([]);
  const mode = sidebarMode(stored, useBand());
  const mac = useMemo(() => isMac(), []);

  useEffect(() => {
    json<Me>('/api/me').then(setMe, (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) location.assign('/login');
    });
  }, []);

  const raw = useMemo(() => (me ? serviceApi(me) : null), [me]);
  const readOnly = useMemo(() => serviceApi({ csrf: '' }), []);
  const shellReader = useReader(cache, raw ?? readOnly);

  // The count, the lead's dot, the sessions and what waits, from the
  // cache, each time it holds a new value of one of them. The lead's read
  // is also what starts the lead after a service restart (the lead starts
  // on its first route), so the lead does not wait for its own screen.
  const recount = useCallback(async () => {
    const [items, leadState, sessions, tickets] = await Promise.all([
      shellReader.api<NextInboxItem[]>('/inbox').catch(() => null),
      shellReader.api<LeadState>('/lead').catch(() => null),
      shellReader.api<SessionSummary[]>('/sessions').catch(() => null),
      shellReader.api<Ticket[]>('/tickets').catch(() => null),
    ]);
    setWaiting(items ? waitingCount(items) : null);
    setLead(leadState);
    if (sessions && tickets) setRows(sessionRows(sessions, tickets));
    if (items && sessions && tickets) {
      setNeeds(towerModel({ sessions, inbox: items, tickets, lead: null, leadLine: null, plans: [], weekLeft: null }, new Date()).needs);
    }
  }, [shellReader]);
  useEffect(() => {
    void recount();
    return shellReader.live(() => void recount());
  }, [shellReader, recount]);

  // The week's quota for the sidebar's gauge (P227): read once the person is known, then each minute, as the
  // Consumption screen reads it; a read that fails keeps what the gauge shows, and says nothing measured before it.
  const zone = useMemo(() => browserZone(), []);
  const [quota, setQuota] = useState<WeeklyQuota | null>(null);
  useEffect(() => {
    if (!raw) return;
    let stopped = false;
    const read = () => {
      readConsumption(raw, zone).then((data) => {
        if (stopped) return;
        const next = weeklyQuota(data);
        setQuota((held) => (held && sameFields(held, next) ? held : next));
      }, () => { if (!stopped) setQuota((held) => held ?? { kind: 'none' }); });
    };
    read();
    const timer = setInterval(read, REFRESH_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [raw, zone]);

  const signOut = useCallback(async () => {
    try { if (me) await json('/logout', { method: 'POST', headers: { 'x-csrf-token': me.csrf } }); }
    finally {
      cache.dispose();
      location.assign('/login');
    }
  }, [me, cache]);

  const navigate = useCallback<NonNullable<ScreenContext['navigate']>>((href, options) => {
    void router.navigate({ href, resetScroll: false, ...(options?.replace ? { replace: true } : {}) });
  }, [router]);
  const inboxChanged = useCallback(() => { void cache.refetch(['inbox']).catch(() => {}); }, [cache]);

  // The sessions kept mounted: by their last visit for the five kept, and
  // drawn in the order they were first opened, so none moves in the page.
  const stack = useRef<string[]>([]);
  const drawn = useRef<string[]>([]);
  if (place.session && stack.current[0] !== place.session) {
    stack.current = pushStack(stack.current, place.session);
    drawn.current = stackOrder(drawn.current, stack.current);
  }

  // The screen's name in its bar and the tab: a session's ticket and title.
  const shownRow = place.session ? rows.find((row) => row.id === place.session) : undefined;
  const here = shownRow ? t('top_session', { ticket: shownRow.ticket, title: shownRow.title }) : t(titleKey(place.screen));

  // The screen's sheets on before any layout effect, the screen's own
  // included (a child's run before the shell's): what they measure, and the
  // layout the scroll below forces, is the next screen's as it will be
  // painted, not laid out again in the same frame (lane j3-tab-perf).
  useInsertionEffect(() => {
    showSheets(place.screen);
    document.body.dataset.screen = place.screen;
  }, [place.screen]);
  useLayoutEffect(() => {
    document.title = `${t('app_name')} · ${here}`;
  }, [t, here]);

  // A move in the page does what a page load did for a keyboard or a
  // screen reader: focus at the start of the new screen (the main region,
  // which draws no ring), and its name said. A move started in the
  // sidebar keeps the focus on the item pressed, as a native app's list
  // of places does (lane 34's art director). Not on the first draw. The
  // name is written into the live region, not drawn again by the shell.
  const said = useRef<HTMLParagraphElement | null>(null);
  const moved = useRef(false);
  const fromSidebar = useRef(false);
  useLayoutEffect(() => {
    if (!moved.current) { moved.current = true; return; }
    if (!fromSidebar.current) document.getElementById('screen')?.focus({ preventScroll: true });
    fromSidebar.current = false;
    if (said.current) said.current.textContent = document.title;
  }, [place.path]);
  // Last of the switch's changes to the page, since it forces a layout.
  useScrollKept(place.path);

  const flipTheme = useCallback(() => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
    setTheme(next);
  }, []);
  const toggleSidebar = useCallback(() => {
    const next = toggledSidebar(mode);
    setStored(next);
    try { localStorage.setItem(SIDEBAR_KEY, next); }
    catch { /* the choice lasts for this page only */ }
  }, [mode]);
  // The focus a dialog gives back when it closes: where it was when the
  // dialog opened (a field's typing goes on), read before the app behind the
  // dialog is made inert, which takes the focus away (art director, item 5).
  const back = useRef<HTMLElement | null>(null);
  const open = useCallback((next: Exclude<Overlay, null>) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && !active.closest('.overlay')) back.current = active;
    setOverlay(next);
  }, []);
  const shut = useRef<Overlay>(null);
  useEffect(() => {
    if (overlay === null && shut.current !== null && back.current?.isConnected) back.current.focus({ preventScroll: true });
    shut.current = overlay;
  }, [overlay]);
  const openPalette = useCallback(() => {
    setGestures(GESTURES.filter((g) => g.screen === place.screen && shownGesture(g.selector)).map((g) => g.id));
    open('palette');
  }, [place.screen, open]);

  const runItem = useCallback((item: PaletteItem) => {
    setOverlay(null);
    const run = item.run;
    // After the dialog has closed and given the focus back.
    requestAnimationFrame(() => {
      switch (run.kind) {
        case 'navigate': navigate(run.href); break;
        case 'theme': flipTheme(); break;
        case 'sheet': open('sheet'); break;
        case 'sidebar': toggleSidebar(); break;
        case 'gesture': {
          const gesture = GESTURES.find((g) => g.id === run.id);
          const element = gesture ? shownGesture(gesture.selector) : null;
          if (gesture?.focus) element?.focus();
          else element?.click();
          break;
        }
      }
    });
  }, [navigate, flipTheme, toggleSidebar, open]);

  // The sidebar draws again only when what it shows changes (Sidebar is memo).
  const groups = useMemo(() => sessionGroups(rows), [rows]);
  const onSignOut = useCallback(() => void signOut(), [signOut]);
  // The menu that opens the API access panel closes first: the focus goes back to the person's button.
  const openAccess = useCallback(() => {
    back.current = document.getElementById('person');
    setOverlay('access');
  }, []);
  const onPick = useCallback((href: string) => { fromSidebar.current = href !== location.pathname; }, []);

  const lastRow = useRef<HTMLElement | null>(null);
  // The pointer used: Enter no longer opens the row the keys last walked to (review of 252, item 2).
  useEffect(() => {
    const forget = () => { lastRow.current = null; };
    addEventListener('pointerdown', forget, true);
    return () => removeEventListener('pointerdown', forget, true);
  }, []);
  const runKey = useCallback((action: Action) => {
    switch (action.kind) {
      case 'palette': openPalette(); break;
      case 'sheet': open('sheet'); break;
      case 'sidebar': if (mode !== 'bar') toggleSidebar(); break;
      case 'go': navigate(hrefOf(action.to)); break;
      case 'next': case 'previous': case 'open': case 'back': walkRows(action.kind, lastRow); break;
      case 'tab': pressTab(action.n); break;
      case 'send': (document.activeElement?.closest('form') as HTMLFormElement | null)?.requestSubmit(); break;
    }
  }, [openPalette, toggleSidebar, navigate, mode, open]);
  useShortcuts({ screen: place.screen, overlay: overlay !== null, mac, run: runKey });

  const items = useMemo(() => (overlay === 'palette' ? paletteItems({ screen: place.screen, needs, sessions: rows, gestures, theme, t: towerT }) : []),
    [overlay, place.screen, needs, rows, gestures, theme, towerT]);

  const host = (screen: ScreenName, path: string) => (me && raw
    ? <ScreenHost screen={screen} path={path} me={me} language={language} cache={cache} raw={raw} navigate={navigate} inboxChanged={inboxChanged} />
    : null);
  return (
    <>
      <div className="app" data-sidebar={mode} inert={overlay !== null}>
        <a className="skip" href="#screen">{t('skip_to_content')}</a>
        <Sidebar t={t} mode={mode} screen={place.screen} session={place.session} project={start.project} userName={start.userName} source={start.source} me={me}
          waiting={waiting} lead={leadDot(lead)} groups={groups} quota={quota} zone={zone} theme={theme} onTheme={flipTheme} language={language} onLanguage={pickLanguage}
          onSearch={openPalette} onToggle={toggleSidebar} onSignOut={onSignOut} onAccess={openAccess} onPick={onPick} />
        <div className="main">
          {/* The bar names the screen: the page's banner, so nothing on it lies outside a landmark. */}
          <header className="top-bar" id="top-bar">
            <p className="top-title">{shownRow ? <><a className="crumb" href="/sessions">{t('title_session')}</a><span className="crumb" aria-hidden="true">/</span></> : null}<span className="here">{here}</span></p>
            {/* The sample data says so on every screen of a computer; a phone's top bar says it (Sidebar.tsx). */}
            {start.source === 'fixtures' ? <div className="top-actions"><p className="source-pill" id="source-pill">{t('source_fixtures')}</p></div> : null}
          </header>
          <p className="sr-only" role="status" aria-live="polite" id="screen-said" ref={said} />
          <main id="screen" className="screen" tabIndex={-1}>
            {place.session ? null : <Fragment key={place.screen === 'ask' ? place.path : place.screen}>{host(place.screen, place.path)}</Fragment>}
            {drawn.current.map((id) => (
              <KeptView key={id} id={id} shown={id === place.session}>{host('session', `/sessions/${id}`)}</KeptView>
            ))}
          </main>
        </div>
      </div>
      {overlay === 'palette' ? <Suspense fallback={null}><Palette t={towerT} items={items} dark={theme === 'dark'} onRun={runItem} onClose={() => setOverlay(null)} /></Suspense> : null}
      {overlay === 'sheet' ? <ShortcutSheet t={t} screen={place.screen} mac={mac} onClose={() => setOverlay(null)} /> : null}
      {overlay === 'access' && raw ? <AccessPanel t={t} api={raw} onClose={() => setOverlay(null)} /> : null}
    </>
  );
}
