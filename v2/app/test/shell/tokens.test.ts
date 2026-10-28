// The design tokens (docs/v2/ui-overhaul-plan.md, 2.2.5, 2.2.8 and 2.4,
// lane 35; docs/v2/ui-hallmark/DESIGN.md, lane j6-ui-hallmark): the one
// theme, light, comes from a base, a contrast and an accent, the neutrals
// mixed from the first two; every text colour reads at AA (4.5:1) on every
// ground it is drawn on; six spacing steps, five text sizes, three weights;
// and no slop: no gradient at all, no emoji and no exclamation mark in any
// catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEB = new URL('../../web/', import.meta.url).pathname;
const MESSAGES = new URL('../../messages/', import.meta.url).pathname;
const SHEET = readFileSync(join(WEB, 'styles/app.css'), 'utf8');
// Sheets left off the scale: none since lane 38 brought the inbox's on, after lane 37's merge.
const PENDING: ReadonlySet<string> = new Set();

// The declarations of every rule whose selector is exactly `selector`, at the start of a line, in order.
function blocks(selector: string): Map<string, string>[] {
  const out: Map<string, string>[] = [];
  for (const match of SHEET.matchAll(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{`, 'gm'))) {
    const start = match.index!;
    const body = SHEET.slice(SHEET.indexOf('{', start) + 1, SHEET.indexOf('}', start)).replace(/\/\*[^]*?\*\//g, '');
    const vars = new Map<string, string>();
    for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) vars.set(name!, value!.trim());
    out.push(vars);
  }
  return out;
}

// The theme's colours and scale, then the roles mixed from them: two :root rules.
const [LIGHT = new Map<string, string>(), SHARED = new Map<string, string>()] = blocks(':root');
const theme = () => new Map([...LIGHT, ...SHARED]);

type Rgb = readonly [number, number, number];

function hex(value: string): Rgb {
  const h = value.slice(1);
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as unknown as Rgb;
}

// var(), colour-mix in sRGB and hex: what the tokens are written with.
function resolve(value: string, vars: Map<string, string>, depth = 0): string {
  assert.ok(depth < 20, `a cycle at ${value}`);
  const v = value.trim();
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
  if (ref) {
    const next = vars.get(ref[1]!);
    assert.ok(next !== undefined, `${ref[1]} is not declared`);
    return resolve(next, vars, depth + 1);
  }
  return v.replace(/var\((--[a-z0-9-]+)\)/g, (_, name: string) => resolve(vars.get(name) ?? '', vars, depth + 1));
}

function colour(name: string, vars: Map<string, string>): Rgb {
  const value = resolve(`var(${name})`, vars);
  if (value.startsWith('#')) return hex(value);
  const mix = /^color-mix\(in srgb,\s*(#[0-9A-Fa-f]{3,6})\s+([\d.]+)%,\s*(#[0-9A-Fa-f]{3,6})\)$/.exec(value);
  assert.ok(mix, `${name} is a hex colour or a colour-mix in sRGB, not ${value}`);
  const a = hex(mix[1]!);
  const b = hex(mix[3]!);
  const p = Number(mix[2]) / 100;
  return [0, 1, 2].map((i) => Math.round(a[i]! * p + b[i]! * (1 - p))) as unknown as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const GROUNDS = ['--canvas', '--surface', '--sidebar', '--sunken', '--surface-muted', '--tab-fill', '--selected', '--popover'];
const PAIRS: readonly (readonly [string, readonly string[]])[] = [
  ['--text', GROUNDS], ['--text-secondary', GROUNDS], ['--text-muted', GROUNDS], ['--text-faint', GROUNDS],
  ['--placeholder', ['--canvas', '--surface', '--sunken', '--popover']],
  ['--link', ['--canvas', '--surface', '--sidebar', '--sunken', '--awaiting-surface', '--popover']],
  ['--awaiting-text', ['--canvas', '--surface', '--sidebar', '--awaiting-pill', '--awaiting-surface', '--selected']],   // --selected: the inbox's shown row (lane 37)
  ['--danger-text', ['--canvas', '--surface', '--sunken', '--sidebar', '--tab-fill']],   // --sidebar, --tab-fill: the quota gauge's percent (P227)
  ['--on-ink', ['--ink']], ['--count-ink', ['--awaiting']],
];

test('every text colour reads at AA on every ground it is drawn on', () => {
  const vars = theme();
  for (const [ink, grounds] of PAIRS) {
    for (const ground of grounds) {
      const r = ratio(colour(ink, vars), colour(ground, vars));
      assert.ok(r >= 4.5, `${ink} on ${ground} is ${r.toFixed(2)}:1`);
    }
  }
});

test('one theme, light: no dark theme, nothing chosen by the system (issue #451)', () => {
  assert.equal(blocks(':root').length, 2, 'the theme and its roles, nothing else on :root');
  assert.doesNotMatch(SHEET, /data-theme="dark"|prefers-color-scheme|@custom-variant dark/);
  assert.match(SHEET, /color-scheme: light;/);
});

test('the theme is a base, a contrast and an accent; the neutrals are mixed from them, not written', () => {
  for (const name of ['--theme-base', '--theme-contrast', '--theme-accent']) assert.match(LIGHT.get(name) ?? '', /^#[0-9A-Fa-f]{6}$/, name);
  for (const name of ['--canvas', '--surface', '--sidebar', '--sunken', '--surface-muted', '--tab-fill', '--selected', '--hairline', '--text-secondary', '--text-muted', '--text-faint', '--placeholder']) {
    assert.match(SHARED.get(name) ?? '', /^color-mix\(in srgb, var\(--theme-contrast\) var\(--mix-[a-z-]+\), var\(--theme-base\)\)$/, name);
  }
  assert.equal(SHARED.get('--text'), 'var(--theme-contrast)');
  assert.equal(SHARED.get('--link'), 'var(--theme-accent)');
});

test('six spacing steps, five text sizes and three weights, and every sheet of the app uses only them', () => {
  assert.deepEqual(['--space-1', '--space-2', '--space-3', '--space-4', '--space-5', '--space-6'].map((n) => LIGHT.get(n)), ['4px', '8px', '16px', '24px', '32px', '48px']);
  // In rem, so the person's own font size scales the text (lane 38): 13, 14, 20, 28 and 40 px at the browser's default
  // (the Hallmark redesign, lane j6-ui-hallmark: a heading and a figure set large and heavy, DESIGN.md, Type).
  assert.deepEqual(['--text-sm', '--text-md', '--text-lg', '--text-xl', '--text-display', '--text-input'].map((n) => LIGHT.get(n)), ['0.8125rem', '0.875rem', '1.25rem', '1.75rem', '2.5rem', '1rem']);
  assert.deepEqual(['--weight-regular', '--weight-strong', '--weight-heavy'].map((n) => LIGHT.get(n)), ['400', '600', '800']);
  // Every rule of every sheet (the sign-in page's included): no size or weight but a token; --text-input is a
  // phone's fields' size, where iOS zooms on less (art director of lane 35, item 9). Lane 35 held the app's and
  // the tower's sheets to it, lane 38 the others.
  for (const file of files(WEB, /\.css$/)) {
    const name = file.slice(WEB.length);
    if (PENDING.has(name)) continue;
    const sheet = name === 'styles/app.css' ? SHEET.slice(SHEET.indexOf('* {')) : readFileSync(file, 'utf8');
    const rules = sheet.replace(/\/\*[^]*?\*\//g, '');
    for (const [, value] of rules.matchAll(/font-size:\s*([^;}]+)/g)) assert.match(value!, /^(var\(--text-(sm|md|lg|xl|display|input)\)|inherit)$/, `${name}: font-size: ${value}`);
    for (const [, value] of rules.matchAll(/font-weight:\s*([^;}]+)/g)) assert.match(value!, /^(var\(--weight-(regular|strong|heavy)\)|inherit)$/, `${name}: font-weight: ${value}`);
    for (const [, value] of rules.matchAll(/\bfont:\s*([^;}]+)/g)) if (value !== 'inherit') assert.match(value!, /var\(--weight-[a-z]+\) var\(--text-[a-z]+\)/, `${name}: font: ${value}`);
  }
});

test('transitions are short and move only opacity and transform, and stop for reduced motion', () => {
  // Every sheet of the app (lane 38).
  const sheets = files(WEB, /\.css$/).filter((file) => !PENDING.has(file.slice(WEB.length))).map((file) => readFileSync(file, 'utf8'));
  // The grace bar's fill is the one exception, as for the gradient: a 60-second timer that moves each second.
  const durations = sheets.map((sheet) => sheet.replace(/\.grace-fill \{[^}]*\}/g, ''))
    .flatMap((sheet) => [...sheet.matchAll(/transition:\s*([^;}]+)/g)].map((m) => m[1]!)).filter((value) => value !== 'none');
  for (const value of durations) {
    for (const part of value.split(',')) {
      assert.match(part.trim(), /^(opacity|transform) var\(--motion\)/, `transition: ${value}`);
    }
  }
  assert.match(LIGHT.get('--motion') ?? '', /^(1[2-5]\d|160)ms$/);
  assert.match(SHEET, /@media \(prefers-reduced-motion: reduce\) \{[^]*--motion: 0ms/);
});

test('no sheet takes the focus ring away: a field\'s own ring keeps a transparent outline, which forced colours draw', () => {
  // The main region and the dialogs take the focus without a ring (they are not controls); the palette's field sits in its dialog.
  const RINGLESS = new Set(['.screen:focus', '.dialog:focus', '.palette-input input']);
  for (const file of files(WEB, /\.css$/)) {
    if (PENDING.has(file.slice(WEB.length))) continue;
    const sheet = readFileSync(file, 'utf8').replace(/\/\*[^]*?\*\//g, '');
    for (const match of sheet.matchAll(/([^{}]+)\{[^}]*(?<![-\w])outline:\s*(?:none|0)\b/g)) assert.ok(RINGLESS.has(match[1]!.trim()), `${file}: ${match[1]!.trim()} has no outline`);
  }
});

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path, ext) : ext.test(name) ? [path] : [];
  });
}

test('no gradient in any sheet of the app, the grace bar\'s fill included (issue #451: flat colours only)', () => {
  for (const file of files(WEB, /\.css$/)) {
    const sheet = readFileSync(file, 'utf8').replace(/\/\*[^]*?\*\//g, '');
    for (const match of sheet.matchAll(/([^{}]+)\{[^}]*\b(?:linear|radial|conic)-gradient\(/g)) assert.fail(`${file}: a gradient in ${match[1]!.trim()}`);
  }
  for (const file of files(WEB, /\.tsx?$/)) assert.doesNotMatch(readFileSync(file, 'utf8'), /(?:linear|radial|conic)-gradient\(/, file);
});

test('no emoji, no exclamation mark and no em dash in any catalog, in either language', () => {
  for (const name of readdirSync(MESSAGES).filter((n) => n.endsWith('.json'))) {
    const catalog = JSON.parse(readFileSync(join(MESSAGES, name), 'utf8')) as Record<string, string>;
    for (const [key, text] of Object.entries(catalog)) {
      assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, `${name} ${key}: an emoji`);
      assert.doesNotMatch(text, /!/, `${name} ${key}: an exclamation mark`);
      assert.doesNotMatch(text, /\u2014/, `${name} ${key}: an em dash`);
    }
  }
});
