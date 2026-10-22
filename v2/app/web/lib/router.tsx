// The page's router (docs/v2/ui-overhaul-plan.md, 2.1.1, 2.1.4 and U1,
// lane 34): TanStack Router in code, one route per address the server
// answers with the shell page, over the browser's history. The shell draws
// the screen of the address (shell/App.tsx); the routes only name them.
//
// The screens keep their plain links: a click on a link to one of the
// app's addresses (lib/routes.ts, takenOver) is answered in the page, so
// no screen's markup changes. Hovering or focusing such a link prefetches
// the screen's chunk and the resources it reads first (prefetch), so a
// row of the tower or the inbox is warm when it is clicked.
import { createBrowserHistory, createRootRoute, createRoute, createRouter, type AnyRouter } from '@tanstack/react-router';
import type { ComponentType, ReactNode } from 'react';
import type { Cache } from './cache.ts';
import { placeOf, takenOver, type Place, type ScreenName } from './routes.ts';

// Each screen and its sheet load with its own chunk; the page names them
// all (app/src/server.ts), and the shell loads them once it has drawn.
const LOADERS: Readonly<Record<ScreenName, () => Promise<{ default: ComponentType }>>> = {
  tower: () => import('@/screens/tower/Tower.tsx'),
  session: () => import('@/screens/session/Session.tsx'),
  lead: () => import('@/screens/lead/Lead.tsx'),
  inbox: () => import('@/screens/inbox/Inbox.tsx'),
  ask: () => import('@/screens/ask/Ask.tsx'),
};
export const SCREEN_NAMES = Object.keys(LOADERS) as ScreenName[];

const loaded = new Map<ScreenName, ComponentType>();
const loading = new Map<ScreenName, Promise<ComponentType>>();

export const loadedScreen = (name: ScreenName): ComponentType | undefined => loaded.get(name);

export function loadScreen(name: ScreenName): Promise<ComponentType> {
  const done = loaded.get(name);
  if (done) return Promise.resolve(done);
  let pending = loading.get(name);
  if (!pending) {
    pending = LOADERS[name]().then((module) => {
      loaded.set(name, module.default);
      return module.default;
    });
    pending.catch(() => loading.delete(name));
    loading.set(name, pending);
  }
  return pending;
}

// What a screen reads first, read into the cache ahead of a click.
export function firstReads(place: Place): string[] {
  switch (place.screen) {
    case 'tower': return ['/sessions', '/inbox', '/tickets', '/lead', '/plans', '/workspace', '/recipes', '/schedules'];
    case 'inbox': return ['/inbox', '/tickets', '/sessions', '/plans'];
    case 'session': return place.session ? [`/sessions/${encodeURIComponent(place.session)}`, '/sessions', '/tickets'] : ['/sessions', '/tickets'];
    case 'lead': return ['/lead', '/lead/messages', '/plans', '/inbox'];
    case 'ask': return [];
  }
}

export function prefetch(cache: Cache, href: string): void {
  const place = placeOf(new URL(href, location.origin).pathname);
  if (!place) return;
  void loadScreen(place.screen).catch(() => {});
  for (const path of firstReads(place)) void cache.read(path).catch(() => {});
}

export function createAppRouter(Shell: () => ReactNode): AnyRouter {
  const root = createRootRoute({ component: Shell });
  const routes = ['/', '/inbox', '/sessions', '/sessions/$id', '/lead', '/plans/$id', '/ask/$id'].map((path) => createRoute({ getParentRoute: () => root, path }));
  return createRouter({
    routeTree: root.addChildren(routes),
    history: createBrowserHistory(),
    // The screens restore nothing of the browser's: the shell keeps each screen's scroll.
    scrollRestoration: false,
    defaultHashScrollIntoView: false,
    defaultPreload: false,
    defaultPendingMs: Infinity,
  });
}

// The page's links, answered in the page; and their prefetch on intent.
export function interceptLinks(router: AnyRouter, cache: Cache, root: Document = document): () => void {
  const linkOf = (target: EventTarget | null): HTMLAnchorElement | null => (target instanceof Element ? target.closest('a[href]') : null);
  const onClick = (event: MouseEvent) => {
    const link = linkOf(event.target);
    if (!link) return;
    const href = takenOver({ href: link.href, target: link.target, hasDownload: link.hasAttribute('download') }, event, location.origin);
    if (href === undefined) return;
    // A link to a place on this page (an inbox item) is the browser's, whose hashchange the screen reads.
    const url = new URL(href, location.origin);
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
    event.preventDefault();
    if (href === `${location.pathname}${location.search}${location.hash}`) return;
    // The shell gives each place its scroll back (shell/App.tsx): the router resets none.
    void router.navigate({ href, resetScroll: false });
  };
  const onIntent = (event: Event) => {
    const link = linkOf(event.target);
    if (link && link.origin === location.origin) prefetch(cache, link.href);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('pointerover', onIntent, { passive: true });
  root.addEventListener('focusin', onIntent);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('pointerover', onIntent);
    root.removeEventListener('focusin', onIntent);
  };
}
