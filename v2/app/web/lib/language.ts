// The page's language, and the person's choice of it (the owner's request
// of 2026-10-23, 08:40, lane i18n). The server writes <html lang> from the
// choice, else the browser's languages, else the app's setting
// (src/catalog.ts, languageOf). A choice made in the account menu is kept
// in this browser's storage and in the cleared_lang cookie the server
// reads, so the sign-in page and the first paint follow it; the app redraws
// in the new language with no reload. There is no per-account preference
// on the server to keep it in.
// The catalogs' languages (catalogs.ts, which bundles JSON the server's Node tests cannot import).
type Language = 'en' | 'fr';

export const LANGUAGE_KEY = 'cleared.language';
export const LANGUAGE_COOKIE = 'cleared_lang';
const YEAR_SECONDS = 365 * 24 * 60 * 60;

const isLanguage = (value: string | null | undefined): value is Language => value === 'en' || value === 'fr';

type Store = Pick<Storage, 'getItem' | 'setItem'>;
type Doc = { cookie: string; documentElement: { lang: string } };

// The stored choice, else the page's, else French.
export function startLanguage(page: string | undefined, stored: string | null): Language {
  return isLanguage(stored) ? stored : isLanguage(page) ? page : 'fr';
}

// This browser's storage, or none where reading it throws (blocked site data).
export function browserStore(): Store | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function storedLanguage(store: Store | undefined): string | null {
  try { return store?.getItem(LANGUAGE_KEY) ?? null; } catch { return null; }
}

// Kept for this browser and told to the server; the page's lang follows.
export function rememberLanguage(language: Language, store: Store | undefined, doc: Doc, secure: boolean): void {
  try { store?.setItem(LANGUAGE_KEY, language); } catch { /* storage refused: the cookie still holds it */ }
  doc.cookie = `${LANGUAGE_COOKIE}=${language}; Path=/; Max-Age=${YEAR_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`;
  doc.documentElement.lang = language;
}
