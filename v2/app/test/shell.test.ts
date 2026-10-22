// The shell's milestone 2 parts: the Plans tab and the lead's pages with
// the stub lane 8 fills, the tower bar's New goal and Ask the lead, and
// what makes the app installable on a Home Screen (manifest, service
// worker, icons).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../src/catalog.ts';
import { translator, type Translate } from '../public/i18n.ts';
import { draftFrom, planFrom, renderLeadStub } from '../public/screens/lead.ts';
import { leadHref, renderBar } from '../public/screens/tower.ts';
import { signedIn, startApp } from './support.ts';

const sentinel: Translate = (key) => `«${key}»`;
const PUBLIC = new URL('../public/', import.meta.url).pathname;

test('the Plans tab opens /lead, and /lead and /plans/<id> mount the lead screen', async () => {
  const app = await startApp();
  try {
    const { cookie } = await signedIn(app);
    for (const path of ['/lead', '/plans/plan-7', '/plans/0f3c']) {
      const page = await fetch(`${app.base}${path}`, { headers: { cookie } });
      assert.equal(page.status, 200, path);
      const html = await page.text();
      assert.match(html, /<body data-screen="lead"/, path);
      assert.match(html, /<a href="\/lead" aria-current="page">Plans<\/a>/, path);
      assert.match(html, /<title>Cleared · Lead<\/title>/);
    }
    const tower = await (await fetch(`${app.base}/`, { headers: { cookie } })).text();
    assert.match(tower, /<a href="\/lead">Plans<\/a>/);
    assert.ok(tower.indexOf('>Plans<') > tower.indexOf('>Tickets<'), 'after Tickets, as the capture orders the tabs');
    for (const path of ['/plans', '/plans/', '/plans/a/b', '/lead/x']) assert.equal((await fetch(`${app.base}${path}`, { headers: { cookie }, redirect: 'manual' })).status, 404, path);
    const signedOut = await fetch(`${app.base}/lead`, { redirect: 'manual' });
    assert.equal(signedOut.status, 303);
    assert.equal(signedOut.headers.get('location'), '/login');
    const catalog = await fetch(`${app.base}/messages/lead.json`);
    assert.equal(catalog.status, 200);
  } finally {
    await app.close();
  }
});

test('the header carries the notifications button, hidden until the page knows what it can offer', async () => {
  const app = await startApp();
  try {
    const { cookie } = await signedIn(app);
    const html = await (await fetch(`${app.base}/`, { headers: { cookie } })).text();
    assert.match(html, /<details class="notify" id="notify" hidden>/);
    assert.match(html, /<summary class="icon" id="notify-summary" aria-label="Notifications">/);
    assert.ok(html.indexOf('id="notify"') < html.indexOf('id="clock"'), 'before the clock');
  } finally {
    await app.close();
  }
});

test('the manifest, the service worker and the icons are served without a session, and every page links them', async () => {
  const app = await startApp();
  try {
    const manifest = await fetch(`${app.base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
    const body = await manifest.json() as { name: string; display: string; start_url: string; scope: string; icons: { src: string; sizes: string }[] };
    assert.equal(body.name, 'Cleared');
    assert.equal(body.display, 'standalone');
    assert.equal(body.start_url, '/');
    assert.equal(body.scope, '/');
    assert.deepEqual(body.icons.map((icon) => [icon.src, icon.sizes]), [['/icons/icon-192.png', '192x192'], ['/icons/icon-512.png', '512x512']]);
    for (const [path, size] of [['/icons/icon-192.png', 192], ['/icons/icon-512.png', 512], ['/icons/apple-touch-icon.png', 180]] as const) {
      const icon = await fetch(`${app.base}${path}`);
      assert.equal(icon.status, 200, path);
      assert.equal(icon.headers.get('content-type'), 'image/png');
      const bytes = Buffer.from(await icon.arrayBuffer());
      assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG');
      assert.equal(bytes.readUInt32BE(16), size, `${path} is ${size} px wide`);
    }
    const worker = await fetch(`${app.base}/sw.js`);
    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(worker.headers.get('cache-control'), 'no-cache');
    for (const path of ['/login', '/']) {
      const response = await fetch(`${app.base}${path}`, { headers: path === '/' ? { cookie: (await signedIn(app)).cookie } : {} });
      const html = await response.text();
      assert.match(html, /<link rel="manifest" href="\/manifest.webmanifest">/, path);
      assert.match(html, /<link rel="apple-touch-icon" href="\/icons\/apple-touch-icon.png">/, path);
    }
    for (const path of ['/icons/other.png', '/sw.ts', '/fonts/x.png']) assert.equal((await fetch(`${app.base}${path}`)).status, 404, path);
  } finally {
    await app.close();
  }
});

test('the service worker shows what the service pushes and opens only an address of this app', () => {
  const code = readFileSync(`${PUBLIC}sw.js`, 'utf8');
  assert.match(code, /addEventListener\('push'/);
  assert.match(code, /addEventListener\('notificationclick'/);
  assert.match(code, /url\.origin === self\.location\.origin/);
  assert.doesNotMatch(code, /addEventListener\('fetch'/, 'it answers no request and caches nothing');
});

test('the tower bar\'s New goal and Ask the lead open /lead with the typed text as a draft', () => {
  assert.equal(leadHref('goal', '  Make the guestbook ready for a small team '), '/lead?goal=1&draft=Make+the+guestbook+ready+for+a+small+team');
  assert.equal(leadHref('lead', 'What landed last night?'), '/lead?draft=What+landed+last+night%3F');
  assert.equal(leadHref('goal', '   '), '/lead?goal=1');
  assert.equal(leadHref('lead', ''), '/lead');
  assert.equal(leadHref('lead', 'a&b=c#d'), '/lead?draft=a%26b%3Dc%23d');
  assert.equal(leadHref('goal', 'A team-ready guestbook', '  A JSON route, trimmed names.\n'), '/lead?goal=1&draft=A+team-ready+guestbook%0A%0AA+JSON+route%2C+trimmed+names.', 'the description follows the title');
  assert.equal(leadHref('lead', '', 'Only a description'), '/lead?draft=Only+a+description');
  const long = new URLSearchParams(leadHref('goal', 'Goal', 'é'.repeat(20_000)).split('?')[1]).get('draft') ?? '';
  assert.equal(long.length, 2000, 'cut at the draft limit, whatever the description holds');
  const bar = renderBar(sentinel);
  assert.match(bar, /<button class="chip-button" type="button" data-lead="goal">«bar_new_goal»<\/button>/);
  assert.match(bar, /<button class="chip-button" type="button" data-lead="lead">«bar_ask_lead»<\/button>/);
  assert.doesNotMatch(bar, /aria-disabled|data-later/, 'the two buttons work now');
});

test('the lead screen reads the draft and the plan from its address', () => {
  assert.deepEqual(draftFrom('?goal=1&draft=Make+it+ready'), { text: 'Make it ready', goal: true });
  assert.deepEqual(draftFrom('?draft=What%20landed%3F'), { text: 'What landed?', goal: false });
  assert.deepEqual(draftFrom(''), { text: '', goal: false });
  assert.deepEqual(draftFrom('?goal=yes'), { text: '', goal: false });
  assert.equal(draftFrom(`?draft=${'a'.repeat(5000)}`).text.length, 2000, 'a draft is cut at 2000 characters');
  assert.equal(planFrom('/plans/plan-7'), 'plan-7');
  assert.equal(planFrom('/lead'), null);
});

test('the lead stub keeps the draft and says the lead is not running yet, with no button that pretends to send', () => {
  const t = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('lead', 'en') });
  const goal = renderLeadStub({ text: 'Make the <b>guestbook</b> ready', goal: true }, null, t);
  assert.match(goal, /<h1[^>]*>Lead<\/h1>/);
  assert.match(goal, /Make the &lt;b&gt;guestbook&lt;\/b&gt; ready<\/textarea>/);
  assert.match(goal, /<label for="lead-draft">Your goal<\/label>/);
  assert.doesNotMatch(goal, /<button/);
  const ask = renderLeadStub({ text: 'What landed?', goal: false }, null, t);
  assert.match(ask, /<label for="lead-draft">Your message<\/label>/);
  const empty = renderLeadStub({ text: '', goal: false }, null, t);
  assert.doesNotMatch(empty, /<textarea/);
  const plan = renderLeadStub({ text: '', goal: false }, 'plan-<7>', t);
  assert.match(plan, /plan-&lt;7&gt;/);
  const keys = new Set<string>();
  const record: Translate = (key) => { keys.add(key); return key; };
  for (const [draft, id] of [[{ text: 'x', goal: true }, 'p'], [{ text: 'x', goal: false }, null], [{ text: '', goal: false }, null]] as const) renderLeadStub(draft, id, record);
  const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('lead', 'fr') });
  for (const key of keys) assert.doesNotThrow(() => fr(key, { id: 'p' }), key);
});
