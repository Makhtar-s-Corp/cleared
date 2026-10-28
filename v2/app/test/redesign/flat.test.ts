// The owner's rules for the look (issue #451, lane j6-ui-hallmark,
// docs/v2/ui-pro/DESIGN.md, lane j6-ui-pro, issue #461), read from the web app's sources; CI runs
// this file alone, before the install, in the step "Flat colours guard":
//   - flat colours: the word "gradient" in no file of app/web, whatever its
//     case or its place (a sheet, a component, a comment);
//   - one theme, light: no dark theme, nothing chosen by the system;
//   - no blurred shadow, no blur filter;
//   - no translucent white on anything;
//   - nothing clickable moves or scales on a hover or a press;
//   - nothing loaded from another site: the fonts are the app's own files.
// Node's own modules only, so it runs without npm ci.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP = new URL('../../', import.meta.url).pathname;
const WEB = join(APP, 'web');
const PUBLIC = join(APP, 'public');
const BINARY = /\.(?:woff2?|png|jpe?g|gif|webp|ico)$/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : walk(path);
    return BINARY.test(name) ? [] : [path];
  });
}

const sources = [...walk(WEB), ...walk(PUBLIC)];
const sheets = sources.filter((path) => path.endsWith('.css'));
const uncommented = (text: string) => text.replace(/\/\*[^]*?\*\//g, '');
// Each rule of a sheet as its selector and its declarations; an at-rule's own braces are skipped.
const rules = (text: string) => [...uncommented(text).matchAll(/([^{}@;]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim(), body: m[2]! }));
// A selector list split at its own commas, not those inside :is() or :not().
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === '(') depth += 1;
    else if (list[i] === ')') depth -= 1;
    else if (list[i] === ',' && depth === 0) { out.push(list.slice(from, i)); from = i + 1; }
  }
  return [...out, list.slice(from)].map((part) => part.trim());
}

test('no gradient anywhere in the web app: the word is in no file of app/web or app/public', () => {
  assert.ok(sources.length > 50, 'the app\'s sources are read');
  for (const path of sources) assert.doesNotMatch(readFileSync(path, 'utf8'), /gradient/i, relative(APP, path));
});

test('one theme, light: no dark theme and no colour scheme taken from the system', () => {
  for (const path of sources) {
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, /prefers-color-scheme/i, relative(APP, path));
    assert.doesNotMatch(text, /data-theme=["']?dark|dataset\.theme\s*===?\s*['"]dark|@custom-variant dark|\bdark:[a-z]/, relative(APP, path));
  }
});

test('no blurred shadow and no blur: depth is a frame or a rule', () => {
  for (const path of sheets) {
    for (const { selector, body } of rules(readFileSync(path, 'utf8'))) {
      assert.doesNotMatch(body, /(?:^|[;\s])(?:-webkit-)?(?:backdrop-filter|filter)\s*:\s*[^;]*blur/, `${relative(APP, path)}: ${selector}`);
      for (const [, value] of body.matchAll(/(?:box-shadow|text-shadow)\s*:\s*([^;]+)/g)) {
        for (const shadow of value!.split(/,(?![^(]*\))/)) {
          // offset-x offset-y [blur [spread]]: the third length, when there is one, is the blur.
          const lengths = shadow.replace(/var\([^)]*\)|rgba?\([^)]*\)|color-mix\([^)]*\)|#[0-9a-fA-F]+|\binset\b/g, ' ').trim().split(/\s+/).filter((part) => /^-?[\d.]+(?:px|rem|em)?$/.test(part));
          if (lengths.length >= 3) assert.equal(parseFloat(lengths[2]!), 0, `${relative(APP, path)}: ${selector} has a blurred shadow (${shadow.trim()})`);
        }
      }
      // A shadow token is held to the same rule where it is declared.
      for (const [, name, value] of body.matchAll(/(--e-[a-z-]+)\s*:\s*([^;]+)/g)) {
        for (const shadow of value!.split(/,(?![^(]*\))/)) {
          const lengths = shadow.replace(/var\([^)]*\)|rgba?\([^)]*\)|#[0-9a-fA-F]+|\binset\b/g, ' ').trim().split(/\s+/).filter((part) => /^-?[\d.]+(?:px|rem|em)?$/.test(part));
          if (lengths.length >= 3) assert.equal(parseFloat(lengths[2]!), 0, `${relative(APP, path)}: ${name} is a blurred shadow`);
        }
      }
    }
  }
});

test('no translucent white: a chip, a pill or a count is an opaque fill or frame', () => {
  for (const path of sheets) {
    const text = uncommented(readFileSync(path, 'utf8'));
    assert.doesNotMatch(text, /rgba\(\s*255\s*,\s*255\s*,\s*255\s*,\s*(?:0?\.\d+|0)\s*\)/, relative(APP, path));
    assert.doesNotMatch(text, /rgb\(\s*255\s+255\s+255\s*\/\s*(?:0?\.\d+|\d{1,2}%)\s*\)/, relative(APP, path));
    assert.doesNotMatch(text, /#(?:FFF|fff)(?:[0-9a-fA-F]|F{3}[0-9a-eA-E][0-9a-fA-F]|f{3}[0-9a-e][0-9a-f])\b/, relative(APP, path));
    assert.doesNotMatch(text, /color-mix\([^)]*white[^)]*transparent/i, relative(APP, path));
  }
});

test('nothing clickable moves or scales on a hover or a press', () => {
  for (const path of sheets) {
    for (const { selector, body } of rules(readFileSync(path, 'utf8'))) {
      if (!/:(?:hover|active)\b/.test(selector)) continue;
      // A tooltip (::after) may slide in beside its button: the button itself stays where it is.
      const own = selectors(selector).filter((part) => /:(?:hover|active)\b/.test(part) && !/::(?:after|before)/.test(part));
      if (own.length === 0) continue;
      assert.doesNotMatch(body, /(?:^|[;\s])(?:transform|translate|scale|rotate)\s*:/, `${relative(APP, path)}: ${selector} moves what is pressed`);
      assert.doesNotMatch(body, /(?:^|[;\s])(?:top|left|margin(?:-[a-z]+)?)\s*:/, `${relative(APP, path)}: ${selector} shifts what is pressed`);
    }
  }
});

test('nothing from another site: every font and every url() is the app\'s own', () => {
  for (const path of sheets) {
    const text = uncommented(readFileSync(path, 'utf8'));
    for (const [, url] of text.matchAll(/url\(\s*["']?([^"')]+)/g)) assert.match(url!, /^\/(?:fonts|icons)\//, `${relative(APP, path)}: url(${url})`);
    assert.doesNotMatch(text, /@import\s+(?:url\()?["']?https?:/, relative(APP, path));
  }
  for (const path of sources.filter((p) => /\.(?:tsx?|html)$/.test(p))) {
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, /(?:src|href)=["']https?:\/\/[^"']*\.(?:png|jpe?g|webp|gif|svg|woff2?|css)/i, `${relative(APP, path)}: an image, a font or a sheet from another site`);
    assert.doesNotMatch(text, /fonts\.googleapis|unsplash|wikimedia|cdn\.jsdelivr|cdnjs|unpkg/i, relative(APP, path));
  }
});
