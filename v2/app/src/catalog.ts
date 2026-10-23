// The catalogs: one pair of files per screen, messages/<screen>.en.json and
// messages/<screen>.fr.json, as v1's lib/i18n keeps one file per language.
// A screen lane edits only its own pair (plan, section 10), and a test
// checks that the French file has every English key. The language is the
// request's (languageOf): the person's choice, else the browser's, else the
// app's setting (CLEARED_V2_APP_LANGUAGE).
import { readFileSync } from 'node:fs';
import type { Catalog } from '../web/lib/i18n.ts';

export const LANGUAGES = ['en', 'fr'] as const;
export type Language = (typeof LANGUAGES)[number];
export const SCREENS = ['shell', 'tower', 'session', 'inbox', 'lead', 'ask'] as const;
export type Screen = (typeof SCREENS)[number];
export const MESSAGES_DIR = new URL('../messages/', import.meta.url).pathname;

const cache = new Map<string, Catalog>();

function file(screen: Screen, language: Language, dir: string): Record<string, string> {
  return JSON.parse(readFileSync(`${dir}${screen}.${language}.json`, 'utf8')) as Record<string, string>;
}

export function isScreen(value: string): value is Screen {
  return (SCREENS as readonly string[]).includes(value);
}

export function loadCatalog(screen: Screen, language: Language, dir: string = MESSAGES_DIR): Catalog {
  const key = `${dir}\0${screen}\0${language}`;
  let catalog = cache.get(key);
  if (!catalog) {
    catalog = Object.freeze(language === 'en' ? file(screen, 'en', dir) : { ...file(screen, 'en', dir), ...file(screen, language, dir) });
    cache.set(key, catalog);
  }
  return catalog;
}

// The cookie the account menu writes when the person picks a language
// (web/lib/language.ts): not a secret, read by the server so the sign-in
// page and the first paint are in that language.
export const LANGUAGE_COOKIE = 'cleared_lang';

const isLanguage = (value: string | undefined): value is Language => (LANGUAGES as readonly string[]).includes(value ?? '');

// A page's language (the owner's request of 2026-10-23, 08:40): the
// person's choice, else the first of the browser's languages the app has,
// by their weights, else the app's setting.
export function languageOf(headers: { readonly cookie?: string | undefined; readonly 'accept-language'?: string | undefined }, fallback: Language): Language {
  const chosen = /(?:^|;\s*)cleared_lang=([^;]*)/.exec(headers.cookie ?? '')?.[1]?.trim();
  if (isLanguage(chosen)) return chosen;
  const asked = (headers['accept-language'] ?? '').split(',').map((part, index) => {
    const [tag = '', ...params] = part.trim().split(';');
    const q = Number(params.map((param) => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find(Boolean) ?? 1);
    return { language: tag.trim().toLowerCase().split('-')[0], q: Number.isNaN(q) ? 0 : q, index };
  }).filter((entry) => entry.q > 0 && isLanguage(entry.language)).sort((a, b) => b.q - a.q || a.index - b.index);
  return (asked[0]?.language as Language | undefined) ?? fallback;
}
