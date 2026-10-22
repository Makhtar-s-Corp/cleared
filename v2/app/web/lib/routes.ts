// The page's addresses (docs/v2/ui-overhaul-plan.md, U1 and U4, lane 34):
// which screen an address draws, as the app's server matches them
// (app/src/server.ts, PAGES), which of the page's links the router takes
// over, and the stack of the sessions kept mounted. No React here, so the
// node tests read it.

export type ScreenName = 'tower' | 'inbox' | 'session' | 'lead' | 'ask';

export type Place = {
  readonly screen: ScreenName;
  readonly path: string;                       // the pathname, as the screens read it (ScreenContext.path)
  readonly session?: string;                   // /sessions/<id>: the session kept in the stack
};

const ID = '[A-Za-z0-9_-]{1,64}';
const PLACES: readonly (readonly [RegExp, ScreenName])[] = [
  [/^\/$/, 'tower'],
  [/^\/inbox$/, 'inbox'],
  [new RegExp(`^/sessions(?:/${ID})?$`), 'session'],
  [new RegExp(`^/(?:lead|plans/${ID})$`), 'lead'],
  [new RegExp(`^/ask/${ID}$`), 'ask'],
];

export function placeOf(pathname: string): Place | undefined {
  for (const [pattern, screen] of PLACES) {
    if (!pattern.test(pathname)) continue;
    const session = screen === 'session' ? pathname.split('/')[2] : undefined;
    return { screen, path: pathname, ...(session ? { session } : {}) };
  }
  return undefined;
}

// The title of the tab, as the server wrote it on each page before.
export const titleKey = (screen: ScreenName): string => `title_${screen}`;

// A click the router answers in the page: the main button, no modifier, on
// a link of this origin to one of the app's addresses, without a target or
// a download. Everything else (a new tab, a file, the sign out, a preview)
// is the browser's.
export function takenOver(link: { readonly href: string; readonly target?: string; readonly hasDownload?: boolean }, click: { readonly button: number; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean; readonly altKey: boolean; readonly defaultPrevented: boolean }, origin: string): string | undefined {
  if (click.defaultPrevented || click.button !== 0 || click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return undefined;
  if ((link.target && link.target !== '_self') || link.hasDownload) return undefined;
  let url: URL;
  try { url = new URL(link.href, origin); }
  catch { return undefined; }
  if (url.origin !== origin || !placeOf(url.pathname)) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}

// The sessions kept mounted (U4): the one shown first, then the others by
// their last visit, at most `max`; the one that falls off is unmounted.
export const STACK_MAX = 5;

export function pushStack(stack: readonly string[], id: string, max = STACK_MAX): string[] {
  return [id, ...stack.filter((other) => other !== id)].slice(0, max);
}
