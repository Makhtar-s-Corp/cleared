// The app's words, for the proof scripts that read its screens (lane 38):
// a sentence of the app's catalogs (v2/app/messages/<catalog>.<language>.json)
// as a pattern that matches it in English or in French, so a run reads the
// screens whatever the app's language (French by default since lane 35).
// A placeholder ({round}, {who}) matches the value given, or anything.
import { readFileSync } from 'node:fs';

const LANGUAGES = ['en', 'fr'] as const;
const MESSAGES = new URL('../app/messages/', import.meta.url);
const catalogs = new Map<string, Record<string, string>>();

function catalog(name: string, language: string): Record<string, string> {
  const file = `${name}.${language}.json`;
  let read = catalogs.get(file);
  if (!read) {
    read = JSON.parse(readFileSync(new URL(file, MESSAGES), 'utf8')) as Record<string, string>;
    catalogs.set(file, read);
  }
  return read;
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function said(name: string, keys: string | readonly string[], values: Readonly<Record<string, string | number>> = {}): RegExp {
  const sentences = (typeof keys === 'string' ? [keys] : keys).flatMap((key) => LANGUAGES.map((language) => {
    const text = catalog(name, language)[key];
    if (text === undefined) throw new Error(`${name}.${language}.json has no ${key}`);
    return text.split(/(\{[a-z_]+\})/).map((part) => {
      const slot = /^\{([a-z_]+)\}$/.exec(part)?.[1];
      if (!slot) return literal(part);
      return slot in values ? literal(String(values[slot])) : '.+?';
    }).join('');
  }));
  return new RegExp(`(?:${[...new Set(sentences)].join('|')})`);
}
