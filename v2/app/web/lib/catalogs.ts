// The catalogs of messages/<screen>.<language>.json, bundled into the page so
// the shell and the screens draw at once. The language is the app's setting
// (CLEARED_V2_APP_LANGUAGE), written by the server on <html lang>. As on the
// server (src/catalog.ts), a key missing from French falls back to English.
import askEn from '../../messages/ask.en.json';
import askFr from '../../messages/ask.fr.json';
import consumptionEn from '../../messages/consumption.en.json';
import consumptionFr from '../../messages/consumption.fr.json';
import inboxEn from '../../messages/inbox.en.json';
import inboxFr from '../../messages/inbox.fr.json';
import leadEn from '../../messages/lead.en.json';
import leadFr from '../../messages/lead.fr.json';
import servicesEn from '../../messages/services.en.json';
import servicesFr from '../../messages/services.fr.json';
import sessionEn from '../../messages/session.en.json';
import sessionFr from '../../messages/session.fr.json';
import shellEn from '../../messages/shell.en.json';
import shellFr from '../../messages/shell.fr.json';
import towerEn from '../../messages/tower.en.json';
import towerFr from '../../messages/tower.fr.json';
import type { Catalog } from './i18n.ts';

export type Language = 'en' | 'fr';
export type CatalogScreen = 'shell' | 'tower' | 'session' | 'inbox' | 'lead' | 'ask' | 'consumption' | 'services';

const FILES: Readonly<Record<CatalogScreen, Readonly<Record<Language, Catalog>>>> = {
  shell: { en: shellEn, fr: shellFr },
  tower: { en: towerEn, fr: towerFr },
  session: { en: sessionEn, fr: sessionFr },
  inbox: { en: inboxEn, fr: inboxFr },
  lead: { en: leadEn, fr: leadFr },
  ask: { en: askEn, fr: askFr },
  consumption: { en: consumptionEn, fr: consumptionFr },
  services: { en: servicesEn, fr: servicesFr },
};

// Each made once per language: a switch to a screen makes its translator
// again, and the catalogs hold hundreds of keys (lane j3-tab-perf).
const merged = new Map<string, Catalog>();
const once = (key: string, make: () => Catalog): Catalog => {
  let catalog = merged.get(key);
  if (!catalog) {
    catalog = make();
    merged.set(key, catalog);
  }
  return catalog;
};

export function catalogOf(screen: CatalogScreen, language: Language): Catalog {
  const files = FILES[screen];
  return language === 'en' ? files.en : once(`${screen} ${language}`, () => ({ ...files.en, ...files[language] }));
}

// A screen's catalog over the shell's, as the shell gives it to the screen.
export function screenCatalog(screen: CatalogScreen, language: Language): Catalog {
  return once(`shell+${screen} ${language}`, () => ({ ...catalogOf('shell', language), ...catalogOf(screen, language) }));
}

export const isLanguage = (value: string | undefined): value is Language => value === 'en' || value === 'fr';
