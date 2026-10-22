// The catalogs of messages/<screen>.<language>.json, bundled into the page so
// the shell and the screens draw at once. The language is the app's setting
// (CLEARED_V2_APP_LANGUAGE), written by the server on <html lang>. As on the
// server (src/catalog.ts), a key missing from French falls back to English.
import inboxEn from '../../messages/inbox.en.json';
import inboxFr from '../../messages/inbox.fr.json';
import leadEn from '../../messages/lead.en.json';
import leadFr from '../../messages/lead.fr.json';
import sessionEn from '../../messages/session.en.json';
import sessionFr from '../../messages/session.fr.json';
import shellEn from '../../messages/shell.en.json';
import shellFr from '../../messages/shell.fr.json';
import towerEn from '../../messages/tower.en.json';
import towerFr from '../../messages/tower.fr.json';
import type { Catalog } from './i18n.ts';

export type Language = 'en' | 'fr';
export type CatalogScreen = 'shell' | 'tower' | 'session' | 'inbox' | 'lead';

const FILES: Readonly<Record<CatalogScreen, Readonly<Record<Language, Catalog>>>> = {
  shell: { en: shellEn, fr: shellFr },
  tower: { en: towerEn, fr: towerFr },
  session: { en: sessionEn, fr: sessionFr },
  inbox: { en: inboxEn, fr: inboxFr },
  lead: { en: leadEn, fr: leadFr },
};

export function catalogOf(screen: CatalogScreen, language: Language): Catalog {
  const files = FILES[screen];
  return language === 'en' ? files.en : { ...files.en, ...files[language] };
}

// A screen's catalog over the shell's, as the shell gives it to the screen.
export function screenCatalog(screen: CatalogScreen, language: Language): Catalog {
  return { ...catalogOf('shell', language), ...catalogOf(screen, language) };
}

export const isLanguage = (value: string | undefined): value is Language => value === 'en' || value === 'fr';
