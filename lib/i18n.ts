import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'i18n');
type Catalog = Record<string, string>;
const english = JSON.parse(readFileSync(join(root, 'en.json'), 'utf8')) as Catalog;
const catalog = new Map<string, Catalog>([['en', english]]);

export function message(key: string, language = 'en', values: Record<string, unknown> = {}): string {
  const lang = /^[a-z]{2}(?:-[A-Z]{2})?$/.test(language) ? language.slice(0, 2) : 'en';
  if (!catalog.has(lang)) {
    try { catalog.set(lang, JSON.parse(readFileSync(join(root, `${lang}.json`), 'utf8'))); }
    catch { catalog.set(lang, {}); }
  }
  const template = catalog.get(lang)![key] ?? english[key];
  if (template === undefined) throw new Error(`Unknown message key: ${key}`);
  return template.replace(/\{([a-z_]+)\}/g, (_, name: string) => String(values[name] ?? ''));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [language, key, ...pairs] = process.argv.slice(2);
  const values = Object.fromEntries(pairs.map((pair) => {
    const index = pair.indexOf('=');
    return index < 0 ? [pair, ''] : [pair.slice(0, index), pair.slice(index + 1)];
  }));
  process.stdout.write(message(key as string, language, values));
}
