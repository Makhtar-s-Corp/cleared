// The message catalog on both sides: the server renders the sign-in page
// and the shell with it, and the page translates each screen with it.
// Messages are plain text with {name} placeholders; the renderer escapes
// what it puts into HTML, the translator does not.
export type Catalog = Readonly<Record<string, string>>;
export type Values = Readonly<Record<string, string | number>>;
export type Translate = (key: string, values?: Values) => string;

export function format(template: string, values: Values = {}): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, name: string) => String(values[name] ?? ''));
}

export function translator(catalog: Catalog): Translate {
  return (key, values) => {
    const template = catalog[key];
    if (template === undefined) throw new Error(`unknown message key: ${key}`);
    return format(template, values);
  };
}
