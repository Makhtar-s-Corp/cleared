// The catalogs: one pair of files per screen, messages/<screen>.en.json and
// messages/<screen>.fr.json, as v1's lib/i18n keeps one file per language.
// A screen lane edits only its own pair (plan, section 10), and a test
// checks that the French file has every English key. The language is the
// app's setting (CLEARED_V2_APP_LANGUAGE); a key missing from French falls
// back to English.
import { readFileSync } from 'node:fs';
import type { Catalog } from '../web/lib/i18n.ts';

export const LANGUAGES = ['en', 'fr'] as const;
export type Language = (typeof LANGUAGES)[number];
export const SCREENS = ['shell', 'tower', 'session', 'inbox', 'lead'] as const;
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
