// The inbox's part of the replanned milestone 2 (lane 21) as HTML: the
// release card as a train in each of its states, its intent groups and its
// flags, the blocked card with no Approve, the session plan with Go and
// Change, and the contract and knowledge items shown for reading.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { NextInboxItem, ReleaseItem, TrainState } from '../../../../src/api/types.ts';
import {
  BLOCKED_TICKET, GUESTBOOK_HEAD, FILTER_HEAD, PLAN_REASON, PLAN_SESSION, TRAIN_TICKET, contractItem, inboxFixture, knowledgeItem, sessionPlanItem, trainRelease,
} from '../../../fixtures/inbox.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import type { InboxView, Local } from '../../screens/inbox/model.ts';
import { renderActions, renderDetail, renderInbox, visibleText } from '../render.tsx';

const sentinel: Translate = (key) => `«${key}»`;
const en = translator(loadCatalog('inbox', 'en'));
const fr = translator(loadCatalog('inbox', 'fr'));

function viewOf(items: readonly NextInboxItem[], overrides: Partial<InboxView> = {}): InboxView {
  const fixture = inboxFixture(FIXTURE_NOW, { train: 'waiting', sessionPlan: 'medium' });
  return {
    items, tickets: fixture.tickets, sessions: fixture.sessions, selected: items[0]?.id, open: true,
    me: { id: 'user-demo', name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', language: 'en', ...overrides,
  };
}

const acts = (html: string) => [...html.matchAll(/data-act="([a-z_]+)"/g)].map((m) => m[1]);
const stops = (html: string) => [...html.matchAll(/data-stop="([^"]+)" data-state="([a-z_]+)"/g)].map((m) => `${m[1]}:${m[2]}`);
const detailOf = (item: NextInboxItem, t: Translate = en, overrides: Partial<InboxView> = {}) => renderDetail(viewOf([item], overrides), t);
const shown = (html: string) => visibleText(html).join('\n');

test('a two-service train waiting for its approval: the landing order, each pull request, the compatibility line, and Approve bound to both heads', () => {
  const item = trainRelease(FIXTURE_NOW, 'waiting');
  const html = detailOf(item);
  assert.match(html, /data-train="waiting"/);
  assert.deepEqual(stops(html), ['filter-api:waiting', 'guestbook:waiting'], 'the provider first');
  const text = shown(html);
  for (const expected of ['Landing order', 'filter-api', 'PR #7', 'guestbook', 'PR #43', 'Waits for your approval', 'guestbook consumes filter-api and is changed in this ticket.'])
    assert.ok(text.includes(expected), `missing: ${expected}`);
  assert.match(html, /href="https:\/\/example.invalid\/filter-api\/pull\/7"/);
  assert.deepEqual(acts(html), ['send_back', 'approve']);
  const approve = /<button[^>]*data-act="approve"[^>]*>/.exec(html)?.[0] ?? '';
  assert.ok(approve.includes(FILTER_HEAD) && approve.includes(GUESTBOOK_HEAD), 'the button names both versions');
  assert.ok(text.includes('2 pull requests'), 'the button says it approves two pull requests');
});

test('a train landing: the first service landed and healthy, the second merged and checked, and nothing to approve', () => {
  const item = trainRelease(FIXTURE_NOW, 'landing');
  const html = detailOf(item);
  assert.match(html, /data-train="landing"/);
  assert.deepEqual(stops(html), ['filter-api:healthy', 'guestbook:merged']);
  const text = shown(html);
  assert.ok(text.includes('Landing, 1 of 2 landed'));
  assert.ok(text.includes('Merged, health being checked'));
  assert.deepEqual(acts(html), [], 'handled: no button');
  // Even if the item read waiting, a landing train offers no approval.
  assert.ok(!acts(renderActions({ ...item, state: 'waiting' }, viewOf([{ ...item, state: 'waiting' }]), en)).includes('approve'));
});

test('a train landed: both services healthy, and the bar says where the train is', () => {
  const html = detailOf(trainRelease(FIXTURE_NOW, 'landed'));
  assert.deepEqual(stops(html), ['filter-api:healthy', 'guestbook:healthy']);
  assert.ok(shown(html).includes('Landed, 2 of 2'));
  assert.match(html, /<p class="d-done">Landed, 2 of 2\. Nothing to approve now\.<\/p>/);
});

test('a train rolled back: the card says "Rolled back, 2 of 2", each service reverted with its note', () => {
  const html = detailOf(trainRelease(FIXTURE_NOW, 'rolled_back'));
  assert.match(html, /data-train="rolled_back"/);
  assert.deepEqual(stops(html), ['filter-api:reverted', 'guestbook:reverted']);
  const text = shown(html);
  assert.ok(text.includes('Rolled back, 2 of 2'));
  assert.ok(text.includes('GET /health failed twice after the deploy; the merge was reverted.'));
  assert.deepEqual(acts(html), []);
});

test('a train halted: what landed, the service that failed and why, and no approval', () => {
  const item = trainRelease(FIXTURE_NOW, 'halted');
  const html = detailOf(item);
  assert.deepEqual(stops(html), ['filter-api:healthy', 'guestbook:failed']);
  assert.ok(shown(html).includes('Halted, 1 of 2 landed'));
  assert.ok(shown(html).includes('The merge failed: the base branch moved. Nothing was reverted.'));
  assert.ok(!acts(renderActions({ ...item, state: 'waiting' }, viewOf([{ ...item, state: 'waiting' }]), en)).includes('approve'));
});

test('the blocked card has no Approve: it says why, proposes the way out, and points to the lead', () => {
  const item = trainRelease(FIXTURE_NOW, 'blocked');
  const html = detailOf(item);
  assert.match(html, /data-train="blocked"/);
  assert.match(html, /data-blocked=""/);
  const text = shown(html);
  for (const expected of [
    'Blocked before approval',
    'filter-api changes its contract (openapi.yaml), and guestbook, which consumes it, is not changed in this ticket.',
    'Extend the contract so that guestbook keeps working as it is',
    'guestbook consumes filter-api and is not changed in this ticket.',
  ]) assert.ok(text.includes(expected), `missing: ${expected}`);
  const buttons = acts(html);
  assert.ok(!buttons.includes('approve'), 'no Approve');
  assert.deepEqual(buttons, ['send_back'], 'it can still be sent back');
  assert.match(html, /<a[^>]*href="\/lead"[^>]*>Ask the lead to add the step<\/a>/);
  // The list says it too, without opening it.
  assert.ok(shown(renderInbox(viewOf([item], { selected: undefined, open: false }), en)).includes(`${BLOCKED_TICKET} · Blocked: a consumer is not changed`));
});

test('the groups by intent with their files, "Other changes" last, and the flags as chips on the card and on their files', () => {
  const html = detailOf(trainRelease(FIXTURE_NOW, 'waiting'));
  const groups = [...html.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ['The filter answers a severity', 'A flagged entry is held for a moderator', 'Other changes']);
  const flags = [...html.matchAll(/<li class="flag[^"]*" data-flag="([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(flags, ['schema', 'dependency', 'contract']);
  const text = shown(html);
  for (const expected of ['What changes', 'Schema', 'Dependency', 'Contract', 'migrations/004_held.sql', 'views/moderate.html', 'package-lock.json'])
    assert.ok(text.includes(expected), `missing: ${expected}`);
  assert.match(html, /data-file="migrations\/004_held.sql"[\s\S]*?data-file-flag="schema"/, 'the flagged file carries its chip');
  // In French, the service's "Other changes" and the flags are translated.
  const french = shown(detailOf(trainRelease(FIXTURE_NOW, 'waiting'), fr));
  assert.ok(french.includes('Autres changements'));
  assert.ok(french.includes('Schéma'));
});

test('a one-service release is drawn as before: no train, no groups, its pull request in the facts', () => {
  const fixture = inboxFixture(FIXTURE_NOW);
  const release = fixture.items[0] as ReleaseItem;
  const html = renderDetail(viewOf(fixture.items, { selected: release.id, tickets: fixture.tickets, sessions: fixture.sessions }), en);
  assert.doesNotMatch(html, /data-train=/);
  assert.doesNotMatch(html, /data-group=/);
  assert.ok(shown(html).includes('PR #42'));
  assert.deepEqual(acts(html), ['send_back', 'approve']);
});

test('the session plan waiting for its Go: the steps, the files, the confidence with its reason, Change and Go', () => {
  const item = sessionPlanItem(FIXTURE_NOW, 'medium');
  const html = detailOf(item);
  assert.match(html, /data-kind="session_plan"/);
  assert.match(html, /data-confidence="medium"/);
  const text = shown(html);
  for (const expected of [
    'Session plan to start', 'LOCAL-165', 'Moderation: a held entry waits for a moderator', 'Service: guestbook',
    'Medium confidence', PLAN_REASON, 'Steps', 'Keep a held entry out of the public list', 'Files', 'views/moderate.html',
    'Open the session',
  ]) assert.ok(text.includes(expected), `missing: ${expected}`);
  assert.match(html, new RegExp(`href="/sessions/${PLAN_SESSION}"`));
  assert.deepEqual(acts(html), ['plan_change', 'plan_go']);
  // A medium or low confidence says it waits for the owner; a high one that the delay will start it.
  assert.ok(text.includes('A medium or low confidence waits for your Go.'));
  assert.ok(shown(detailOf(sessionPlanItem(FIXTURE_NOW, 'high'))).includes('With a high confidence, it starts by itself when the delay passes.'));
});

test('Change opens a field for what to change, with Keep the plan and Send the change', () => {
  const item = sessionPlanItem(FIXTURE_NOW);
  const html = detailOf(item, en, { local: new Map<string, Local>([[item.id, { kind: 'change' }]]) });
  assert.match(html, /<textarea[^>]*id="plan-change"[^>]*maxlength="2000"/);
  assert.deepEqual(acts(html), ['plan_keep', 'plan_change_send']);
});

test('after Go, after Change, and once the plan started: what the bar says', () => {
  const item = sessionPlanItem(FIXTURE_NOW);
  const after = (local: Local) => shown(detailOf(item, en, { local: new Map([[item.id, local]]) }));
  assert.match(after({ kind: 'plan_go', at: FIXTURE_NOW.toISOString() }), /Go given at \d\d:\d\d\. The author starts writing\./);
  assert.match(after({ kind: 'plan_changed', at: FIXTURE_NOW.toISOString() }), /Change sent at \d\d:\d\d\. The author reworks its plan\./);
  const started = { ...item, state: 'handled' as const, plan: { ...item.plan, go: { by: 'delay' as const, at: FIXTURE_NOW.toISOString() } } };
  const html = detailOf(started);
  assert.deepEqual(acts(html), []);
  assert.match(shown(html), /Started by itself at \d\d:\d\d/);
});

test('the contract and knowledge items are shown for reading, with no button', () => {
  for (const item of [contractItem(FIXTURE_NOW), knowledgeItem(FIXTURE_NOW)]) {
    const html = detailOf(item);
    assert.match(html, new RegExp(`data-kind="${item.kind}"`));
    assert.deepEqual(acts(html), [], item.kind);
  }
  const contract = shown(detailOf(contractItem(FIXTURE_NOW)));
  assert.ok(contract.includes('openapi.yaml') && contract.includes('+            severity:'), 'the diff');
  assert.ok(shown(detailOf(knowledgeItem(FIXTURE_NOW))).includes('The archive page reuses the list\'s heading: a heading changes in both templates.'));
});

test('the list with every new kind: each has its chip, in the order of the kinds', () => {
  const fixture = inboxFixture(FIXTURE_NOW, { train: 'waiting', sessionPlan: 'high', reading: true });
  const html = renderInbox(viewOf(fixture.items, { selected: undefined, open: false }), en);
  const order = [...html.matchAll(/data-item="([^"]+)"/g)].map((m) => m[1]?.split(':')[0]);
  assert.deepEqual(order, ['release', 'release', 'permission', 'session_plan', 'plan', 'question', 'contract', 'knowledge', 'permission']);
  const text = shown(html);
  for (const chip of ['Release', 'Session plan', 'Contract', 'Knowledge']) assert.ok(text.includes(chip), chip);
  assert.ok(text.includes(`${TRAIN_TICKET} · 2 services · Reviewed by Sonnet, checks green`));
  assert.ok(text.includes('8 waiting'));
});

test('every text of the new parts comes from the catalog, in both languages', () => {
  const items: NextInboxItem[] = [
    ...(['waiting', 'blocked', 'landing', 'landed', 'rolled_back', 'halted'] as TrainState['state'][]).map((s) => trainRelease(FIXTURE_NOW, s)),
    sessionPlanItem(FIXTURE_NOW, 'low'), contractItem(FIXTURE_NOW), knowledgeItem(FIXTURE_NOW),
  ];
  for (const item of items) {
    const view = viewOf(items, { selected: item.id });
    // With the sentinel translator, no English word of the screen is left: only the data.
    const text = shown(renderInbox(view, sentinel));
    for (const word of ['Landing order', 'Waits for your approval', 'Blocked before approval', 'What changes', 'Session plan to start', 'Low confidence', 'Steps', 'Files'])
      assert.ok(!text.includes(word), `${item.kind} ${'train' in item ? item.train?.state : ''}: "${word}" is not from the catalog`);
    // The French catalog has every key it names (the translator throws on a missing one).
    assert.ok(shown(renderInbox(view, fr)).length > 0);
  }
});

test('the new parts carry no inline style', () => {
  const fixture = inboxFixture(FIXTURE_NOW, { train: 'landing', sessionPlan: 'medium', reading: true });
  for (const item of [...fixture.items, trainRelease(FIXTURE_NOW, 'blocked')]) {
    const html = renderInbox(viewOf([...fixture.items, trainRelease(FIXTURE_NOW, 'blocked')], { selected: item.id }), en);
    assert.doesNotMatch(html, /\sstyle=/, item.id);
  }
});

test('a line shaped like a secret is a chip with its words, as every flag', () => {
  const item = { ...trainRelease(FIXTURE_NOW, 'waiting'), flags: [{ kind: 'secret_shape' as const, files: ['src/check.ts'], detail: 'Adds a line one of the guard\'s patterns flags (token): read it before approving.' }] };
  const html = detailOf(item);
  assert.match(html, /data-flag="secret_shape"><span class="flag-chip secret_shape">Secret shape<\/span><span class="flag-note">A line looks like a secret\. Read it before approving\.<\/span>/);
  assert.match(html, /data-file="src\/check.ts"[\s\S]*?data-file-flag="secret_shape">Secret shape</);
  assert.ok(shown(detailOf(item, fr)).includes('Forme de secret'));
});

test('in the list, a train that is not waiting carries its state beside its kind; a waiting one does not', () => {
  const states = ['blocked', 'landing', 'landed', 'rolled_back', 'halted'] as const;
  const items = states.map((state) => ({ ...trainRelease(FIXTURE_NOW, state), id: `release:${state}` }));
  const html = renderInbox(viewOf([...items, trainRelease(FIXTURE_NOW, 'waiting')], { selected: undefined, open: false }), en);
  assert.deepEqual([...html.matchAll(/data-train-chip="([a-z_]+)">([^<]*)</g)].map((m) => `${m[1]}:${m[2]}`),
    ['blocked:Blocked', 'landing:Landing', 'landed:Landed', 'rolled_back:Rolled back', 'halted:Halted']);
});
