import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_NOW, towerFixture } from '../fixtures/tower.ts';
import { loadCatalog } from '../src/catalog.ts';
import { translator, type Translate } from '../public/i18n.ts';
import { formatModel, newTicket, renderBar, renderTower, towerModel, type TowerData } from '../public/screens/tower.ts';

const sentinel: Translate = (key) => `«${key}»`;

// The visible text of an HTML string: the text between tags, and the
// attributes a person reads or hears.
function visibleText(html: string): string[] {
  const out: string[] = [];
  for (const match of html.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]*)"/g)) out.push(match[1] ?? '');
  for (const run of html.replace(/<[^>]*>/g, '\n').split('\n')) out.push(run);
  return out.map((text) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()).filter(Boolean);
}

function strings(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, into);
  return into;
}

test('the fixture is the capture\'s data that milestone 1 has: two waiting items, four live sessions, two landed today', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const model = towerModel(data, FIXTURE_NOW);
  assert.deepEqual(model.needs.map((n) => [n.kind, n.ticket, n.minutes, n.title]), [
    ['release', 'LOCAL-158', 12, '“Comings and goings” replaces “Departures and arrivals”'],
    ['permission', 'LOCAL-161', 3, 'Install date-fns to group dates by week'],
  ]);
  assert.deepEqual(model.live.map((s) => [s.role, s.ticket, s.title, s.status, formatModel(s.harness, s.model), s.minutes]), [
    ['author', 'LOCAL-161', 'Upcoming: group entries by week', 'Waiting for your permission to install date-fns', 'claude · opus-5.5', 18],
    ['reviewer', 'LOCAL-152', 'Envelope sheet shows its previous months', 'Reading the diff of src/screens/Envelope.jsx', 'claude · sonnet-5.5', 4],
    ['author', 'LOCAL-160', 'Glossary: add the “Fast lane” entry', 'Running the docs tests · 12 passed so far', 'claude · haiku-5.5', 2],
    ['author', 'LOCAL-163', 'Bank sync: retry once before failing', 'Writing a test for a timeout on the bank API', 'codex · gpt-6-sol', 31],
  ]);
  assert.deepEqual(model.landed.map((l) => [l.title, l.minutes]), [
    ['Stale figures no longer survive two crossing reads', 52],
    ['The envelope list reads one section at a time', 38],
  ]);
});

test('every word on the tower comes from the catalog or from the data', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const model = towerModel(data, FIXTURE_NOW);
  const allowed = strings(data);
  for (const session of model.live) allowed.add(formatModel(session.harness, session.model));
  for (const row of model.landed) allowed.add(row.time);
  const html = renderTower(model, sentinel);
  for (const text of visibleText(html)) {
    const rest = text.replace(/«[a-z0-9_]+»/g, '').trim();
    if (!/\p{L}/u.test(rest)) continue;
    assert.ok(allowed.has(rest), `not from the catalog nor the data: ${JSON.stringify(rest)}`);
  }
});

test('the English tower reads as the capture, in milestone 1\'s words', async () => {
  const t = translator(loadCatalog('tower', 'en'));
  const html = renderTower(towerModel(await towerFixture(FIXTURE_NOW), FIXTURE_NOW), t);
  const text = visibleText(html).join('\n');
  for (const expected of [
    'Two things need you.', '4 sessions running · 2 landed today', 'Needs you', 'Open inbox', 'Release · 12 min', 'Permission · 3 min',
    'Reviewed by Sonnet, all checks green. Your approval ships it.', 'Network access and a new dependency. The author is paused until you answer.',
    'Live sessions', 'Author', 'Reviewer', 'Open session', '18 min', 'Lead', 'Plans', 'Landed today', 'New ticket', 'New goal', 'Ask the lead',
  ]) assert.ok(text.includes(expected), `missing: ${expected}`);
  assert.doesNotMatch(html, /\sstyle=/, 'no inline style: the page runs under default-src \'self\'');
});

test('the French tower has no English sentence left', async () => {
  const en = loadCatalog('tower', 'en');
  const fr = loadCatalog('tower', 'fr');
  const html = renderTower(towerModel(await towerFixture(FIXTURE_NOW), FIXTURE_NOW), translator(fr));
  for (const [key, value] of Object.entries(en)) {
    if (fr[key] === value || value.length < 12 || !/\s/.test(value)) continue;   // a word French shares, such as Permission
    const plain = value.replace(/\{[a-z_]+\}/g, '').trim();
    assert.ok(!html.includes(plain), `English left in French: ${plain}`);
  }
});

test('what the data says is escaped, never markup', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const evil = '<img src=x onerror=alert(1)>"&';
  const changed: TowerData = { ...data, tickets: data.tickets.map((ticket) => ({ ...ticket, title: evil })), sessions: data.sessions.map((s) => ({ ...s, status: evil })) };
  const html = renderTower(towerModel(changed, FIXTURE_NOW), translator(loadCatalog('tower', 'en')));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;'));
});

test('nothing waiting says so, and a waiting question is a card of its own', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const t = translator(loadCatalog('tower', 'en'));
  const calm = renderTower(towerModel({ ...data, inbox: [] }, FIXTURE_NOW), t);
  assert.ok(visibleText(calm).includes('Nothing needs you.'));
  const question = towerModel({
    ...data,
    inbox: [{ kind: 'question', id: 'q1', ticket: 'LOCAL-160', project: 'guestbook', since: new Date(FIXTURE_NOW.getTime() - 5 * 60_000).toISOString(), state: 'waiting', sessionId: 's', requestId: 'r', questions: [{ question: 'Which date format should the list use?' }] }],
  }, FIXTURE_NOW);
  assert.deepEqual(question.needs.map((n) => [n.kind, n.title, n.minutes]), [['question', 'Which date format should the list use?', 5]]);
  assert.ok(visibleText(renderTower(question, t)).includes('Question · 5 min'));
});

test('a model name reads as the capture writes it', () => {
  assert.equal(formatModel('claude-code', 'claude-opus-5-5'), 'claude · opus-5.5');
  assert.equal(formatModel('claude-code', 'claude-sonnet-5-5'), 'claude · sonnet-5.5');
  assert.equal(formatModel('codex', 'gpt-6-sol'), 'codex · gpt-6-sol');
});

test('the bar takes an optional description, sent as the ticket\'s body only when written', () => {
  const html = renderBar(sentinel);
  assert.match(html, /<textarea id="ask-body" name="body" maxlength="20000"[^>]*aria-label="«bar_body_label»"/);
  assert.ok(html.indexOf('id="ask-body"') > html.indexOf('<form') && html.indexOf('id="ask-body"') < html.indexOf('</form>'), 'inside the form');
  assert.deepEqual(newTicket('  Newest first ', '  Show the newest at the top.\n', 'guestbook'), { title: 'Newest first', project: 'guestbook', body: 'Show the newest at the top.' });
  assert.deepEqual(newTicket('Newest first', '  \n ', 'guestbook'), { title: 'Newest first', project: 'guestbook' });
});
