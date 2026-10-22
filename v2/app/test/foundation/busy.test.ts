// No full-screen spinner anywhere (docs/v2/ui-overhaul-plan.md, 2.1.7,
// lane 34): the built sheets and the page's markup hold no page-level busy
// state. A screen's own first load may mark its part busy (aria-busy on a
// screen's element, until its first data); nothing marks the page, the
// shell's main or the body, and no sheet draws a spinner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureSource } from '../../fixtures/source.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { DIST_DIR } from '../../src/server.ts';
import { signedIn, startApp } from '../support.ts';

test('the built sheets draw no spinner and mark no page busy; the page itself is never busy', async () => {
  const assets = join(DIST_DIR, 'assets');
  const css = readdirSync(assets).filter((name) => name.endsWith('.css')).map((name) => readFileSync(join(assets, name), 'utf8')).join('\n');
  const js = readdirSync(assets).filter((name) => name.endsWith('.js')).map((name) => readFileSync(join(assets, name), 'utf8')).join('\n');
  assert.ok(css.length > 0 && js.length > 0, 'the build is there');
  assert.doesNotMatch(css, /(?:^|[\s,}])(?:html|body|main|#screen|\.screen|#root)\[aria-busy/, 'no page-level busy rule');
  assert.doesNotMatch(css, /@keyframes\s+[\w-]*spin|\.spinner\b|\.loading-screen\b|\.page-loading\b/i, 'no spinner');
  assert.doesNotMatch(js, /id:\s*`screen`[^}]{0,200}aria-busy/, 'the shell\'s main is never marked busy');
  const app = await startApp({ source: await fixtureSource({ now: () => FIXTURE_NOW }) });
  try {
    const { cookie } = await signedIn(app);
    const html = await (await fetch(`${app.base}/inbox`, { headers: { cookie } })).text();
    assert.doesNotMatch(html, /aria-busy|spinner|loading/i);
  } finally {
    await app.close();
  }
});
