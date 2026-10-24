// The message catalog on both sides: the server renders the sign-in page
// and the shell with it, and the page translates each screen with it.
// Messages are plain text with {name} placeholders; the renderer escapes
// what it puts into HTML, the translator does not.
export type Catalog = Readonly<Record<string, string>>;
export type Values = Readonly<Record<string, string | number>>;
export type Translate = (key: string, values?: Values) => string;

// A number is said as the catalog's language says it ("12 345", "12,345",
// "86,5"); a string is the caller's own text, left as it is. The catalog
// names its language in its `locale` key (the shell's); one without it, the
// server's sign-in page and a test's, writes the number as it comes.
export function format(template: string, values: Values = {}, locale?: string): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, name: string) => {
    const value = values[name];
    return typeof value === 'number' && locale ? new Intl.NumberFormat(locale).format(value) : String(value ?? '');
  });
}

// A key missing from the catalog is drawn marked (⟦key⟧), never thrown:
// one missing word blanked a whole page before (the sessions index without
// role_lead, docs/v2/ui-overhaul-plan.md, 1.4 and U10). The catalogs' test
// (app/test/catalog.test.ts) keeps every key the components use in both
// languages, and the browser tests of app/test/foundation/ fail on any
// mark a screen draws.
export const MARK_OPEN = '\u27e6';
export const MARK_CLOSE = '\u27e7';
export const marked = (key: string): string => `${MARK_OPEN}${key}${MARK_CLOSE}`;
export const hasMark = (text: string): boolean => text.includes(MARK_OPEN);

export function translator(catalog: Catalog, onMissing?: (key: string) => void): Translate {
  return (key, values) => {
    const template = catalog[key];
    if (template === undefined) {
      onMissing?.(key);
      return marked(key);
    }
    return format(template, values, catalog['locale']);
  };
}
