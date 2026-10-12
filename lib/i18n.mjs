import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'i18n');
const english = JSON.parse(readFileSync(join(root, 'en.json'), 'utf8'));
const catalog = new Map([['en', english]]);

export function message(key, language = 'en', values = {}) {
  const lang = /^[a-z]{2}(?:-[A-Z]{2})?$/.test(language) ? language.slice(0, 2) : 'en';
  if (!catalog.has(lang)) {
    try { catalog.set(lang, JSON.parse(readFileSync(join(root, `${lang}.json`), 'utf8'))); }
    catch { catalog.set(lang, {}); }
  }
  const template = catalog.get(lang)[key] ?? english[key];
  if (template === undefined) throw new Error(`Unknown message key: ${key}`);
  return template.replace(/\{([a-z_]+)\}/g, (_, name) => String(values[name] ?? ''));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [language, key, ...pairs] = process.argv.slice(2);
  const values = Object.fromEntries(pairs.map((pair) => {
    const index = pair.indexOf('=');
    return index < 0 ? [pair, ''] : [pair.slice(0, index), pair.slice(index + 1)];
  }));
  process.stdout.write(message(key, language, values));
}
