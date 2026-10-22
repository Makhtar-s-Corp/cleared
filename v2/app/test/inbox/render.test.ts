// The inbox as HTML: the fixture inbox against the capture, each kind's
// detail and its buttons, the states a gesture leaves behind, the catalog in
// both languages, the escaping, and the rule that the page has no inline style.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { InboxItem, ReleaseItem } from '../../../src/api/types.ts';
import { QUESTION_TEXT, RELEASE_TICKET, RELEASE_TITLE, inboxFixture } from '../../fixtures/inbox.ts';
import { AUTHOR_ID } from '../../fixtures/session.ts';
import { FIXTURE_NOW } from '../../fixtures/tower.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../../public/i18n.ts';
import { renderInbox, type InboxView, type Local } from '../../public/screens/inbox.ts';
import { strings, visibleText } from '../session/support.ts';

const sentinel: Translate = (key) => `«${key}»`;
const en = translator(loadCatalog('inbox', 'en'));
const fr = translator(loadCatalog('inbox', 'fr'));

function viewOf(overrides: Partial<InboxView> = {}): InboxView {
  const fixture = inboxFixture(FIXTURE_NOW);
  return {
    items: fixture.items, tickets: fixture.tickets, sessions: fixture.sessions, selected: undefined, open: false,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', ...overrides,
  };
}

const idOf = (kind: InboxItem['kind'], state: InboxItem['state'] = 'waiting') => (inboxFixture(FIXTURE_NOW).items.find((i) => i.kind === kind && i.state === state) as InboxItem).id;
const count = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].length;
const text = (view: InboxView, t: Translate = en) => visibleText(renderInbox(view, t));

test('the list reads as the capture: what waits, with its time, then what was handled today', () => {
  const shown = text(viewOf());
  for (const expected of [
    'Inbox', '4 waiting',
    'Release', '12 min', RELEASE_TITLE, `${RELEASE_TICKET} · Reviewed by Sonnet, checks green`,
    'Permission', '3 min', 'Install date-fns to group dates by week', 'LOCAL-161 · author paused',
    'Question', '1 h', QUESTION_TEXT, 'LOCAL-164 · the team recommends: Show “Anonymous”',
    'Handled today', 'Apply the new migration to the test database', 'LOCAL-160 · no longer waits for you',
  ]) assert.ok(shown.includes(expected), `missing: ${expected}`);
  const html = renderInbox(viewOf(), en);
  const order = [...html.matchAll(/data-item="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order.map((id) => id?.split(':')[0]), ['release', 'permission', 'plan', 'question', 'permission'], 'release first, then by kind; handled last');
});

test('two releases with the same title, from two tickets, are told apart in the list by their ticket', () => {
  const fixture = inboxFixture(FIXTURE_NOW);
  const release = fixture.items.find((i): i is ReleaseItem => i.kind === 'release' && i.state === 'waiting') as ReleaseItem;
  const again: ReleaseItem = { ...release, id: `${release.id}-again`, ticket: 'LOCAL-999' };
  const html = renderInbox(viewOf({ items: [release, again] }), en);
  const lines = [...html.matchAll(/<span class="item-line">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.equal(lines.length, 2);
  assert.ok(lines[0]?.startsWith(`${RELEASE_TICKET} · `), lines[0]);
  assert.ok(lines[1]?.startsWith('LOCAL-999 · '), lines[1]);
});

test('with nothing chosen, the computer shows the first item, and the phone shows the list alone', () => {
  const html = renderInbox(viewOf(), en);
  assert.match(html, /class="inbox" data-open="false"/);
  assert.match(html, /<a class="item current"[^>]*aria-current="true"[^>]*data-item="release:/);
  assert.ok(text(viewOf()).includes('Approve the release'), 'the first item is shown in the detail');
  const chosen = renderInbox(viewOf({ selected: idOf('permission'), open: true }), en);
  assert.match(chosen, /class="inbox" data-open="true"/);
  assert.match(chosen, /<a class="back" href="#"/);
});

test('a release shows its announcement, the before and after, the sessions line, the change line and the two buttons', () => {
  const view = viewOf({ selected: idOf('release'), open: true });
  const html = renderInbox(view, en);
  const shown = visibleText(html);
  for (const expected of [
    'Release to approve', RELEASE_TICKET, 'Open the sessions', RELEASE_TITLE,
    'Two testers out of two found it clearer. The heading changes on the list and on the archive, nothing else.',
    'What changes on screen', 'Desktop', 'Phone', 'Before', 'After',
    'Sessions', 'Opus wrote it in 2 min · Sonnet reviewed it in 6 min, one round', 'Change', 'PR #42', 'all checks green',
    'Signed in as demo', 'Send back', 'Approve the release', '3f9c2a1',
  ]) assert.ok(shown.includes(expected), `missing: ${expected}`);
  assert.match(html, /<a class="d-link" href="\/sessions\/fixture-158-author">/);
  assert.match(html, /<a href="https:\/\/example\.invalid\/guestbook\/pull\/42"[^>]*>PR #42<\/a>/);
  assert.match(html, /<img[^>]*src="\/api\/service\/captures\/before-desktop\.svg"/);
  assert.match(html, /<img[^>]*src="\/api\/service\/captures\/after-desktop\.svg"/);
  assert.match(html, /<button[^>]*data-frame="desktop"[^>]*aria-pressed="true"/);
  assert.deepEqual([...html.matchAll(/data-act="([a-z_]+)"/g)].map((m) => m[1]), ['send_back', 'approve']);
  assert.match(html, /aria-label="Approve the release: pull request 42 at 3f9c2a1d5e7b40c8a6f1d2e3b4c5a6978d0e1f2a"/, 'every version it approves is in its accessible name');
  const phone = renderInbox({ ...view, frame: 'phone' }, en);
  assert.match(phone, /<img[^>]*src="\/api\/service\/captures\/after-phone\.svg"/);
  assert.match(phone, /<button[^>]*data-frame="phone"[^>]*aria-pressed="true"/);
});

test('a release with no capture says so instead of an empty frame, and a capture from elsewhere is not shown', () => {
  const fixture = inboxFixture(FIXTURE_NOW);
  const release = fixture.items[0] as ReleaseItem;
  const none: ReleaseItem = { ...release, captures: { before: { desktop: null, phone: null }, after: { desktop: 'https://elsewhere.invalid/a.png', phone: '//elsewhere.invalid/b.png' } } };
  const html = renderInbox(viewOf({ items: [none], selected: none.id }), en);
  assert.doesNotMatch(html, /<img/);
  assert.ok(visibleText(html).includes('No picture of this screen yet.'));
  const unreviewed: ReleaseItem = { ...release, sessions: [{ role: 'author', model: 'claude-opus-5-5', minutes: 75 }], pr: { ...release.pr, checks: 'pending' } };
  const shown = text(viewOf({ items: [unreviewed], selected: unreviewed.id }));
  assert.ok(shown.includes('Opus wrote it in 1 h 15'));
  assert.ok(shown.includes('checks running'));
});

test('a permission shows the command, what for, why it asks, and its three answers with a reason field for a deny', () => {
  const html = renderInbox(viewOf({ selected: idOf('permission'), open: true }), en);
  const shown = visibleText(html);
  for (const expected of [
    'Permission', 'LOCAL-161', 'Open the session', 'Wants to run', 'npm install date-fns', 'Upcoming: group entries by week',
    'What for', 'Install date-fns to group dates by week', 'Why it asks', 'Network access and a new dependency.',
    'Session', 'Author · Opus, paused for 3 min', 'Allow once', 'Always in this project', 'Deny',
  ]) assert.ok(shown.includes(expected), `missing: ${expected}`);
  assert.match(html, /<a class="d-link" href="\/sessions\/fixture-author">/);
  assert.deepEqual([...html.matchAll(/data-act="([a-z_]+)"/g)].map((m) => m[1]), ['reject_once', 'allow_always', 'allow_once']);
  assert.match(html, /<input[^>]*id="deny-reason"/);
  assert.match(html, /<label[^>]*for="deny-reason"/);
});

test('a question shows each question, its choices and a free answer', () => {
  const html = renderInbox(viewOf({ selected: idOf('question'), open: true }), en);
  const shown = visibleText(html);
  for (const expected of [
    'Question', 'LOCAL-164', 'Open the session', 'Empty name', QUESTION_TEXT, 'Show “Anonymous”', 'Recommended by the team',
    'Every entry stays visible, and the form keeps the name optional.', 'Refuse the entry', 'Or answer in your own words', 'Send the answer',
  ]) assert.ok(shown.includes(expected), `missing: ${expected}`);
  assert.equal(count(html, /<button[^>]*data-option=/g), 2);
  assert.equal(count(html, /aria-pressed="false"[^>]*data-option=|data-option=[^>]*aria-pressed="false"/g), 2, 'no choice is made for the person');
  assert.match(html, /<input[^>]*data-free="0"/);
  assert.deepEqual([...html.matchAll(/data-act="([a-z_]+)"/g)].map((m) => m[1]), ['answer']);
});

test('an approval in its grace shows the bar, the seconds left and Undo, never the buttons again', () => {
  const id = idOf('release');
  const dueAt = new Date(FIXTURE_NOW.getTime() + 42_000).toISOString();
  const local = new Map<string, Local>([[id, { kind: 'grace', dueAt }]]);
  const html = renderInbox(viewOf({ selected: id, local }), en);
  assert.ok(visibleText(html).includes('Approving in 42 s'));
  assert.match(html, /class="grace-fill"/);
  assert.deepEqual([...html.matchAll(/data-act="([a-z_]+)"/g)].map((m) => m[1]), ['undo']);
  const approved = renderInbox(viewOf({ selected: id, local: new Map([[id, { kind: 'approved', at: FIXTURE_NOW.toISOString() }]]) }), en);
  assert.ok(visibleText(approved).includes('Approved by you at 09:41, landing.'));
  assert.equal(count(approved, /data-act=/g), 0);
  const back = renderInbox(viewOf({ selected: id, local: new Map([[id, { kind: 'sent_back', at: FIXTURE_NOW.toISOString() }]]) }), en);
  assert.ok(visibleText(back).includes('Sent back at 09:41. The ticket is in Todo and the author starts again.'));
  assert.equal(count(back, /data-act=/g), 0);
});

test('Send back asks once before it moves the ticket', () => {
  const id = idOf('release');
  const html = renderInbox(viewOf({ selected: id, local: new Map([[id, { kind: 'confirm' }]]) }), en);
  assert.ok(visibleText(html).includes('Send this release back? The ticket returns to Todo and the author starts again from it.'));
  assert.deepEqual([...html.matchAll(/data-act="([a-z_]+)"/g)].map((m) => m[1]), ['keep', 'send_back_confirm']);
});

test('a request settled without the person (issue 145, item 4) says so and offers no button', () => {
  const id = idOf('permission');
  const html = renderInbox(viewOf({ selected: id, local: new Map([[id, { kind: 'settled' }]]) }), en);
  assert.ok(visibleText(html).includes('This request was settled without you: the session was interrupted or ended, or someone answered it from the session.'));
  assert.equal(count(html, /data-act=/g), 0);
  assert.match(html, /<a class="d-link" href="\/sessions\/fixture-author">/, 'the session, where the rules\' refusals are, stays one click away');
  const answered = renderInbox(viewOf({ selected: id, local: new Map([[id, { kind: 'answered', decision: 'allow_once' }]]) }), en);
  assert.ok(visibleText(answered).includes('Allowed once. The session goes on.'));
  assert.equal(count(answered, /data-act=/g), 0);
});

test('an item handled earlier has no button', () => {
  const html = renderInbox(viewOf({ selected: idOf('permission', 'handled'), open: true }), en);
  assert.ok(visibleText(html).includes('This no longer waits for you.'));
  assert.equal(count(html, /data-act=/g), 0);
  assert.doesNotMatch(html, /id="deny-reason"/);
});

test('an empty inbox says so in one sentence, and an unknown choice falls back to the list', () => {
  const empty = text(viewOf({ items: [] }));
  assert.ok(empty.includes('Nothing waits for you.'));
  assert.ok(empty.includes('What a session or the lead asks you, every plan and every release to approve, comes here.'));
  const gone = renderInbox(viewOf({ selected: 'release:gone', open: true }), en);
  assert.ok(visibleText(gone).includes('This item is no longer in the inbox.'));
});

test('every word on the screen comes from the catalog or from the data', () => {
  const fixture = inboxFixture(FIXTURE_NOW);
  const allowed = strings([fixture.items, fixture.tickets, fixture.sessions]);
  allowed.add('3f9c2a1').add('demo').add('Show “Anonymous”');      // the short head, the user, a label without "(Recommended)"
  for (const item of fixture.items) {
    for (const local of [undefined, { kind: 'grace', dueAt: new Date(FIXTURE_NOW.getTime() + 30_000).toISOString() }, { kind: 'confirm' }, { kind: 'settled' }] as (Local | undefined)[]) {
      const html = renderInbox(viewOf({ selected: item.id, open: true, local: new Map(local ? [[item.id, local]] : []) }), sentinel);
      for (const shown of visibleText(html)) {
        const rest = shown.replace(/«[a-z0-9_]+»/g, '').replace(/[·\s]+/g, ' ').trim();
        if (!/\p{L}/u.test(rest)) continue;
        assert.ok(allowed.has(rest), `not from the catalog nor the data: ${JSON.stringify(rest)}`);
      }
      assert.doesNotMatch(html, /\sstyle=/, 'no inline style: the page runs under default-src \'self\'');
      assert.doesNotMatch(html, /<style|<script/);
    }
  }
});

test('the French screen has no English sentence left', () => {
  const enCatalog = loadCatalog('inbox', 'en');
  const frCatalog = loadCatalog('inbox', 'fr');
  for (const kind of ['release', 'permission', 'question'] as const) {
    const html = renderInbox(viewOf({ selected: idOf(kind), open: true }), fr);
    for (const [key, value] of Object.entries(enCatalog)) {
      if (frCatalog[key] === value || value.length < 12 || !/\s/.test(value)) continue;
      const plain = value.replace(/\{[a-z_]+\}/g, '').trim();
      assert.ok(!html.includes(plain), `English left in French: ${plain}`);
    }
  }
  assert.ok(text(viewOf(), fr).includes('Approuver la mise en production'));
});

test('what the data says is escaped, never markup', () => {
  const evil = '<img src=x onerror=alert(1)>"&';
  const fixture = inboxFixture(FIXTURE_NOW);
  const [release, permission, question] = fixture.items as [ReleaseItem, Extract<InboxItem, { kind: 'permission' }>, Extract<InboxItem, { kind: 'question' }>];
  const items: InboxItem[] = [
    { ...release, id: evil, ticket: evil, title: evil, announcement: evil, pr: { ...release.pr, url: `javascript:${evil}` }, sessions: [{ role: 'author', model: evil, minutes: 1 }] },
    { ...permission, id: `${evil}p`, sessionId: evil, input: { kind: 'execute', command: evil, description: evil }, suggestion: { decision: 'ask', rule: evil, reason: evil } },
    { ...question, id: `${evil}q`, questions: [{ question: evil, header: evil, options: [{ label: evil, description: evil }] }] },
  ];
  for (const item of items) {
    const html = renderInbox(viewOf({ items, selected: item.id, open: true }), en);
    assert.ok(!html.includes('<img src=x'), item.kind);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;'), item.kind);
    assert.doesNotMatch(html, /href="javascript:/i, 'a link the data names is followed only when it is http or https');
  }
});

test('the session line says how long it has been paused, and a handled request is not said to pause anything', () => {
  const fixture = inboxFixture(FIXTURE_NOW);
  const permission = fixture.items[1] as Extract<InboxItem, { kind: 'permission' }>;
  const fresh = { ...permission, since: new Date(FIXTURE_NOW.getTime() - 20_000).toISOString(), suggestion: { decision: 'ask' as const, rule: 'shell.compound', reason: 'more than one simple command' } };
  const shown = text(viewOf({ items: [fresh], selected: fresh.id }));
  assert.ok(shown.includes('Author · Opus, paused just now'));
  assert.ok(shown.includes('More than one simple command'), 'the policy\'s reason reads as a sentence');
  const handled = text(viewOf({ items: [{ ...permission, state: 'handled' }], selected: permission.id }));
  assert.ok(handled.includes('Author · Opus'));
  assert.ok(!handled.some((line) => line.includes('paused')));
});

test('a session the list does not know still shows its request', () => {
  const shown = text(viewOf({ sessions: [], selected: idOf('permission'), open: true }));
  assert.ok(shown.includes('npm install date-fns'));
  assert.ok(shown.includes('Allow once'));
  assert.ok(!shown.includes('Author · Opus, paused for 3 min'));
  assert.equal(AUTHOR_ID.length > 0, true);
});
