// The shell's classes and the screens' sheets (art director of lane 35, item 1):
// every screen's sheet is on while its screen shows (lib/sheets.ts), and the palette
// and the sheet open over any screen, so a class the shell draws must not be styled
// unscoped by a screen's sheet. The inbox's bare .detail made every palette row
// 804 px tall over the inbox. .sr-only means the same everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WEB = new URL('../../web/', import.meta.url).pathname;
const SAME_EVERYWHERE = new Set(['sr-only']);

function shellClasses(): Set<string> {
  const out = new Set<string>();
  const files = [...readdirSync(join(WEB, 'shell')).filter((f) => f.endsWith('.tsx')).map((f) => join(WEB, 'shell', f)), join(WEB, 'components/ui/command.tsx')];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(/className="([^"]+)"|\bcn\('([^']+)'/g)) for (const name of (match[1] ?? match[2] ?? '').split(/\s+/)) out.add(name);
  }
  return out;
}

function screenSheets(): string[] {
  const dirs = ['screens/inbox', 'screens/session', 'screens/lead', 'screens/ask', 'components/choices', 'components/terminal', 'components/editor', 'plan-panel'];
  return dirs.flatMap((dir) => {
    try { return readdirSync(join(WEB, dir)).filter((f) => f.endsWith('.css')).map((f) => join(WEB, dir, f)); }
    catch { return []; }
  });
}

test('no class the shell draws is styled unscoped by a screen\'s sheet', () => {
  const classes = shellClasses();
  assert.ok(classes.has('palette-item') && classes.has('nav-item'), 'the shell\'s classes are read');
  for (const sheet of screenSheets()) {
    const css = readFileSync(sheet, 'utf8').replace(/\/\*[^]*?\*\//g, '');
    for (const [, selectors] of css.matchAll(/(?:^|[{}])\s*([^{}@]+)\{/g)) {
      for (const selector of selectors!.split(',').map((s) => s.trim())) {
        const first = /^\.([\w-]+)/.exec(selector)?.[1];
        if (first && classes.has(first) && !SAME_EVERYWHERE.has(first)) assert.fail(`${sheet}: "${selector}" styles the shell's .${first}`);
      }
    }
  }
});
