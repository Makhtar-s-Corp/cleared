// The inbox's contract and knowledge items as HTML (decisions 26 and 27,
// lane 27): the contract's diff with Send back and Approve, the field a Send
// back opens, the knowledge's text and level with Reject and Approve, what a
// handled one says, and the plan item's service chips (issue 210, item 5).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ContractItem, KnowledgeItem, NextInboxItem, PlanItemInbox } from '../../../../src/api/types.ts';
import { contractItem, dreamedItem, inboxFixture, knowledgeItem } from '../../../fixtures/inbox.ts';
import { DREAM_TICKET as SERVICE_DREAM_TICKET } from '../../../../src/knowledge/dreaming.ts';
import { servicePlan } from '../../../fixtures/lead.ts';
import { FIXTURE_NOW } from '../../../fixtures/tower.ts';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator, type Translate } from '../../lib/i18n.ts';
import { DREAM_TICKET, itemLine, type InboxView, type Local } from '../../screens/inbox/model.ts';
import { renderDetail, visibleText } from '../render.tsx';

// The screen's translator: the shell's catalog under the inbox's, as the shell gives it.
const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('inbox', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('inbox', 'fr') });
const sentinel: Translate = (key) => `«${key}»`;
const ME = 'user-demo';

function viewOf(items: readonly NextInboxItem[], overrides: Partial<InboxView> = {}): InboxView {
  const fixture = inboxFixture(FIXTURE_NOW);
  return {
    items, tickets: fixture.tickets, sessions: fixture.sessions, selected: items[0]?.id, open: true,
    me: { id: ME, name: 'demo' }, now: FIXTURE_NOW, local: new Map(), frame: 'desktop', language: 'en', ...overrides,
  };
}
const acts = (html: string) => [...html.matchAll(/data-act="([a-z_]+)"/g)].map((m) => m[1]);
const detailOf = (item: NextInboxItem, t: Translate = en, overrides: Partial<InboxView> = {}) => renderDetail(viewOf([item], overrides), t);
const shown = (html: string) => visibleText(html).join('\n');
const at = new Date(2026, 9, 21, 9, 12).toISOString();

test('a contract waiting: its service, its file, the diff, then Send back and Approve, Approve in ink', () => {
  const html = detailOf(contractItem(FIXTURE_NOW));
  assert.match(html, /<h2 class="d-title">Contract of filter-api<\/h2>/);
  assert.match(html, /<pre class="diff">/);
  assert.match(html, /<span class="add">\+            severity:/);
  assert.deepEqual(acts(html), ['contract_send_back', 'contract_approve']);
  assert.match(html, /<button[^>]*class="btn primary"[^>]*data-act="contract_approve"[^>]*>Validate the contract<\/button>/);
  assert.match(shown(html), /The steps after it start once you validate it\./);
  assert.doesNotMatch(html, /Shown for reading/);
  assert.doesNotMatch(html, /\sstyle=/);
});

test('Send back opens a field for what to change, kept by the screen, with Keep and Send back', () => {
  const item = contractItem(FIXTURE_NOW);
  const html = renderDetail(viewOf([item], { local: new Map<string, Local>([[item.id, { kind: 'change' }]]) }), en);
  assert.match(html, /<textarea[^>]*id="contract-message"[^>]*maxlength="2000"/);
  assert.deepEqual(acts(html), ['contract_keep', 'contract_send_back_send']);
});

test('a proposal of the nightly pass: the pass instead of a ticket, each source a link to its reviewer session, then Reject and Approve, in English and French', () => {
  assert.equal(DREAM_TICKET, SERVICE_DREAM_TICKET);
  const item = dreamedItem(FIXTURE_NOW);
  const html = detailOf(item);
  assert.ok(shown(html).includes(item.text));
  assert.match(shown(html), /Past sessions/);
  assert.doesNotMatch(shown(html), /\bdreaming\b/);
  assert.match(shown(html), /From 2 reviews/);
  assert.match(html, /<a class="d-link" href="\/sessions\/fixture-162-reviewer">LOCAL-162<\/a>/);
  assert.match(html, /<a class="d-link" href="\/sessions\/fixture-151-reviewer">LOCAL-151<\/a>/);
  assert.match(shown(html), /Reject writes nothing, and it is never proposed again\./);
  assert.deepEqual(acts(html), ['knowledge_reject', 'knowledge_approve']);
  assert.equal(itemLine(item, viewOf([item]), en), 'Seen in 2 reviews · for guestbook');
  const french = detailOf(item, fr, { language: 'fr' });
  assert.match(shown(french), /Sessions passées/);
  assert.match(shown(french), /Tiré de 2 relectures/);
  assert.equal(itemLine(item, viewOf([item]), fr), 'Vu dans 2 relectures · pour guestbook');
  for (const text of [html, french]) assert.doesNotMatch(text, /«dream_|\u2014/);
  // A handover's item keeps its ticket and its rule.
  assert.doesNotMatch(shown(detailOf(knowledgeItem(FIXTURE_NOW))), /Past sessions|reviews/);
});

test('a knowledge item waiting: its text, its level, then Reject and Approve', () => {
  const html = detailOf(knowledgeItem(FIXTURE_NOW));
  assert.ok(shown(html).includes(knowledgeItem(FIXTURE_NOW).text));
  assert.match(shown(html), /The service guestbook/);
  assert.deepEqual(acts(html), ['knowledge_reject', 'knowledge_approve']);
  assert.match(shown(html), /Approve writes it into the memory and queues it for the service's skill\./);
});

test('what the owner did shows on the item, from the page at once, then from the service', () => {
  const contract = contractItem(FIXTURE_NOW);
  const decided = (item: NextInboxItem, local: Local) => shown(detailOf(item, en, { local: new Map([[item.id, local]]) }));
  assert.match(decided(contract, { kind: 'decided', decision: 'approve', at }), /Validated at 09:12\. The next steps start\./);
  assert.match(decided(knowledgeItem(FIXTURE_NOW), { kind: 'decided', decision: 'reject', at }), /Rejected at 09:12\./);
  const handled: ContractItem = { ...contract, state: 'handled', outcome: { decision: 'send_back', message: 'Name it level.', by: ME, at } };
  const html = detailOf(handled);
  assert.deepEqual(acts(html), []);
  assert.match(shown(html), /Sent back by you at 09:12: “Name it level\.”/);
  const approved: KnowledgeItem = { ...knowledgeItem(FIXTURE_NOW), state: 'handled', outcome: { decision: 'approve', by: ME, at } };
  assert.match(shown(detailOf(approved)), /Approved by you at 09:12: it is in the memory, and queued for the skill\./);
});

test('every word of the new parts is from the catalog, in both languages', () => {
  for (const item of [contractItem(FIXTURE_NOW), knowledgeItem(FIXTURE_NOW)]) {
    const text = shown(detailOf(item, sentinel));
    for (const word of ['Validate', 'Send back', 'Approve', 'Reject', 'The steps after']) assert.ok(!text.includes(word), `${item.kind}: "${word}"`);
    assert.ok(shown(detailOf(item, fr)).length > 0);
  }
  assert.match(shown(detailOf(contractItem(FIXTURE_NOW), fr)), /Valider le contrat/);
});

test('the inbox\'s plan item shows each item\'s services, as the lead screen does (issue 210, item 5)', () => {
  const plan = servicePlan(FIXTURE_NOW);
  const item: PlanItemInbox = {
    kind: 'plan', id: `plan-item-${plan.id}`, ticket: 'lead', project: 'guestbook', since: plan.proposedAt, state: 'waiting',
    planId: plan.id, title: plan.title, summary: plan.summary, itemCount: plan.items.length, totals: plan.totals,
  };
  const html = renderDetail(viewOf([item], { plans: new Map([[plan.id, plan]]) }), en);
  assert.match(html, /<ul class="plan-services" aria-label="Services">/);
  assert.match(html, /<li class="svc-chip sensitive" data-sensitivity="full">/);
  assert.match(renderDetail(viewOf([item], { plans: new Map([[plan.id, plan]]) }), fr), /plan-services/);
});
