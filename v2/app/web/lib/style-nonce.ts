// The page's style nonce for packages that create <style> elements at run
// time and offer no nonce option (the web terminal, @xterm/xterm). The app's
// Content-Security-Policy allows no inline style, so such an element is
// blocked unless it carries the nonce of its page's response. As bundlers'
// nonce hooks do, the insertion of a <style> element is wrapped: a style
// element passed directly to appendChild, insertBefore, append or prepend,
// with no nonce of its own, is given the page's nonce before it is inserted.
// A style element inside a fragment or parsed markup is not, so injected
// HTML never gains the nonce. Never 'unsafe-inline'.
//
// The terminal's DOM renderer also writes colours as style attributes (a
// cell in 24-bit colour, a selected cell, a decoration), which no nonce can
// allow. installStyleAttributeCssom turns such a script-set attribute into
// the same declarations written through the CSSOM, which the policy does not
// govern, for `color` and `background-color` with a plain colour value only;
// any other value goes to the native setAttribute and stays blocked, and a
// style attribute in parsed markup is never touched.

type Method = (this: unknown, ...args: unknown[]) => unknown;
type Prototype = Record<string, unknown>;

// What the shims patch: the page's own constructors in the browser, fakes in the tests.
export interface StyleNonceScope {
  Node: { prototype: object };
  Element: { prototype: object };
  HTMLStyleElement: abstract new (...args: never[]) => { nonce?: string; setAttribute(name: string, value: string): void };
}

export interface StyleAttributeScope {
  Element: { prototype: object };
}

const INSERTS: readonly ['Node' | 'Element', string][] = [
  ['Node', 'appendChild'],
  ['Node', 'insertBefore'],
  ['Element', 'append'],
  ['Element', 'prepend'],
];

// The properties the terminal writes as attributes (measured by lane
// v2-j2-deps-xterm's probe), each with a hex, rgb() or rgba() colour.
const CSSOM_PROPERTIES = new Set(['color', 'background-color']);
const COLOUR = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*){2,3}\))$/i;

let nonceInstalled: (() => void) | null = null;
let cssomInstalled: (() => void) | null = null;

function wrap(proto: Prototype, name: string, make: (original: Method) => Method): () => void {
  const original = proto[name] as Method;
  proto[name] = make(original);
  return () => { proto[name] = original; };
}

// Gives `nonce` to every <style> element inserted from now on; returns the
// function that restores the original methods. Installing again replaces
// the previous nonce rather than wrapping twice.
export function installStyleNonce(nonce: string, scope: StyleNonceScope = globalThis as unknown as StyleNonceScope): () => void {
  if (!nonce) throw new Error('installStyleNonce needs the page\'s style nonce');
  nonceInstalled?.();
  const Style = scope.HTMLStyleElement;
  const stamp = (node: unknown): void => {
    if (node instanceof Style && !node.nonce) node.setAttribute('nonce', nonce);
  };
  const restore = INSERTS.map(([owner, name]) => wrap(scope[owner].prototype as Prototype, name, (original) =>
    function (this: unknown, ...nodes: unknown[]) {
      // insertBefore's second argument is the reference node, never inserted.
      if (name === 'insertBefore') stamp(nodes[0]);
      else nodes.forEach(stamp);
      return original.apply(this, nodes);
    }));
  const uninstall = (): void => {
    if (nonceInstalled !== uninstall) return;
    restore.forEach((undo) => undo());
    nonceInstalled = null;
  };
  nonceInstalled = uninstall;
  return uninstall;
}

// Whether a style attribute's value holds only the terminal's colours.
export function cssomColours(value: string): boolean {
  const declarations = value.split(';').map((part) => part.trim()).filter(Boolean);
  return declarations.length > 0 && declarations.every((declaration) => {
    const colon = declaration.indexOf(':');
    if (colon < 0) return false;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    return CSSOM_PROPERTIES.has(property) && COLOUR.test(declaration.slice(colon + 1).trim());
  });
}

// Writes a script-set style attribute of colours only through the CSSOM;
// returns the function that restores setAttribute. Installing again does
// not wrap twice.
export function installStyleAttributeCssom(scope: StyleAttributeScope = globalThis as unknown as StyleAttributeScope): () => void {
  cssomInstalled?.();
  const restore = wrap(scope.Element.prototype as Prototype, 'setAttribute', (original) =>
    function (this: unknown, ...args: unknown[]) {
      const [name, value] = args;
      const style = (this as { style?: { cssText: string } }).style;
      if (style && String(name).toLowerCase() === 'style' && cssomColours(String(value))) {
        style.cssText = String(value);
        return undefined;
      }
      return original.apply(this, args);
    });
  const uninstall = (): void => {
    if (cssomInstalled !== uninstall) return;
    restore();
    cssomInstalled = null;
  };
  cssomInstalled = uninstall;
  return uninstall;
}
