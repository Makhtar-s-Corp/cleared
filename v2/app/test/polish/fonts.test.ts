// The fonts (docs/v2/ui-overhaul-plan.md, lane 38; lane 35's log left it):
// both pages ask for Geist and Geist Mono before the sheet does, so the
// first paint waits less for them, and while Geist is not there yet the
// text is set in a local face sized to Geist's metrics, so nothing moves
// when it arrives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { signedIn, startApp } from '../support.ts';

const SHEET = readFileSync(new URL('../../web/styles/app.css', import.meta.url), 'utf8');
const FONTS = ['/fonts/Geist-Variable.woff2', '/fonts/GeistMono-Variable.woff2'];

test('the shell page and the sign-in page preload both fonts, before any sheet', async () => {
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie } = await signedIn(app);
    const shell = await (await fetch(`${app.base}/`, { headers: { cookie } })).text();
    const login = await (await fetch(`${app.base}/login`)).text();
    for (const [name, html] of [['shell', shell], ['login', login]] as const) {
      for (const font of FONTS) {
        const link = new RegExp(`<link rel="preload" href="${font}" as="font" type="font/woff2" crossorigin>`).exec(html);
        assert.ok(link, `${name}: preloads ${font}`);
        assert.ok(link.index < html.indexOf('<link rel="stylesheet"'), `${name}: ${font} before the sheets`);
      }
    }
  } finally {
    await app.close();
  }
});

test('a local face sized to Geist stands in for it, and every sans stack names it right after Geist', () => {
  const face = /@font-face \{ font-family: "Geist Fallback"; ([^}]+)\}/.exec(SHEET)?.[1] ?? '';
  assert.match(face, /src: local\("Arial"\), local\("Helvetica"\), local\("Liberation Sans"\);/);
  for (const [property, value] of [['size-adjust', '102.34%'], ['ascent-override', '89.9%'], ['descent-override', '21.5%'], ['line-gap-override', '0%']] as const) {
    assert.match(face, new RegExp(`${property}: ${value.replace('.', '\\.')};`), property);
  }
  assert.match(SHEET, /--sans: Geist, "Geist Fallback", /);
  // Geist itself swaps in when it arrives, as before.
  assert.match(SHEET, /@font-face \{ font-family: Geist; src: url\("\/fonts\/Geist-Variable\.woff2"\) format\("woff2"\); font-weight: 100 900; font-display: swap; \}/);
});
