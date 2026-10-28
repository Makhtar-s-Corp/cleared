// Ready-made tickets in the tower (P214, issue #330): "Template" in the bar
// opens Bug, Review, CI and Question, and Environment, the setup session
// (C4, lane v2-j5-env-setup); a pick fills an empty description with
// the template's sections, or one still as another template left it, and
// never a description the person wrote; the title's placeholder says what to
// write; the ticket carries the template's type label. French and English.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { TICKET_TEMPLATES } from '../../../src/tickets/templates.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { Bar } from '../screens/tower/Tower.tsx';
import { newTicket } from '../screens/tower/model.ts';
import { pickTemplate, templateBody, templateLabels } from '../screens/tower/templates.ts';
import { html, visibleText } from './render.tsx';

const sentinel: Translate = (key) => `«${key}»`;
const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('tower', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('tower', 'fr') });
const toggles = (markup: string) => [...markup.matchAll(/<button[^>]*data-template="([a-z]+)"[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/button>/g)].map((m) => [m[1], m[2]]);

test('the bar offers Template, pressed when the five templates are shown, in both languages', () => {
  assert.match(html(<Bar t={en} title="" body="" />), /<button[^>]*data-bar="template"[^>]*>Template<\/button>/);
  assert.match(html(<Bar t={en} title="" body="" />), /data-bar="template"[^>]*aria-expanded="false"[^>]*aria-controls="ask-templates"|aria-expanded="false"[^>]*aria-controls="ask-templates"[^>]*data-bar="template"/);
  assert.match(html(<Bar t={fr} title="" body="" />), /data-bar="template"[^>]*>Modèle<\/button>/);
  assert.doesNotMatch(html(<Bar t={en} title="" body="" />), /id="ask-templates"/, 'closed, no template picked: no row');

  const open = html(<Bar t={en} title="" body="" templatesOpen />);
  assert.match(open, /aria-expanded="true"[^>]*aria-controls="ask-templates"|aria-controls="ask-templates"[^>]*aria-expanded="true"/);
  assert.match(open, /<div[^>]*id="ask-templates"[^>]*role="group"[^>]*aria-label="Ready-made tickets"/);
  assert.deepEqual(toggles(open), [['bug', 'Bug'], ['review', 'Review'], ['ci', 'CI'], ['question', 'Question'], ['environment', 'Environment']]);
  assert.deepEqual(toggles(html(<Bar t={fr} title="" body="" templatesOpen />)), [['bug', 'Bug'], ['review', 'Revue'], ['ci', 'CI'], ['question', 'Question'], ['environment', 'Environnement']]);
  assert.match(html(<Bar t={fr} title="" body="" templatesOpen />), /aria-label="Tickets prêts à l&#39;emploi"/);
  for (const text of visibleText(html(<Bar t={sentinel} title="" body="" templatesOpen />))) assert.ok(!/Template|Bug|Review|Question/.test(text), `"${text}" is not from the catalog`);
});

test('a picked template is pressed, keeps its row shown, and gives the title its placeholder; in both bar shapes', () => {
  for (const services of [[], ['guestbook', 'filter-api']]) {
    const markup = html(<Bar t={en} title="" body="" services={services} template="bug" />);
    assert.match(markup, /id="ask-templates"/, 'shown while a template is picked');
    assert.match(markup, /aria-pressed="true"[^>]*data-template="bug"|data-template="bug"[^>]*aria-pressed="true"/);
    assert.doesNotMatch(markup, /aria-pressed="true"[^>]*data-template="(?:review|ci|question)"|data-template="(?:review|ci|question)"[^>]*aria-pressed="true"/);
    assert.match(markup, /<input[^>]*id="ask-input"[^>]*placeholder="What breaks"/);
  }
  assert.match(html(<Bar t={en} title="" body="" />), /placeholder="E.g. add a CSV export"/, 'no template: the bar\'s own placeholder');
  assert.match(html(<Bar t={fr} title="" body="" template="question" />), /placeholder="La question"/);
});

test('each template\'s sections, in both languages, from the catalogs', () => {
  for (const t of [en, fr]) {
    for (const template of TICKET_TEMPLATES) {
      const body = templateBody(template, t);
      assert.match(body, /^## /, `${template}: starts with its first section`);
      assert.ok(body.length < 1000, `${template}: short`);
      assert.ok(!body.includes(String.fromCharCode(0x2014)) && !body.includes(String.fromCharCode(0x27e6)), `${template}: no em dash, no missing key`);
    }
  }
  assert.match(templateBody('bug', en), /## Steps to reproduce/);
  assert.match(templateBody('bug', fr), /## Étapes pour reproduire/);
  assert.match(templateBody('ci', en), /No test skipped or removed/);
  // A branch with no commit is not published (workspace/publish.ts): Review fixes what it can, Question writes its answer down.
  assert.match(templateBody('review', en), /fixed on this branch, each with a test/);
  assert.match(templateBody('question', fr), /là où le prochain lecteur la cherchera/);
  // The setup session: what Cleared reads of a .devcontainer, and what it checks before the review.
  assert.match(templateBody('environment', en), /`image`, or `build\.dockerfile`/);
  assert.match(templateBody('environment', en), /Cleared runs both before the review/);
  assert.match(templateBody('environment', fr), /lifecycle|cycle de vie/);
  for (const template of TICKET_TEMPLATES) assert.doesNotMatch(templateBody(template, en), /No change to the code/i, template);
  assert.equal(templateBody('review', sentinel), '«template_review_body»');
});

test('a pick fills an empty or untouched description, never one the person wrote', () => {
  // Empty: filled.
  assert.deepEqual(pickTemplate({ template: null, body: '' }, 'bug', en), { template: 'bug', body: templateBody('bug', en), kept: false });
  assert.deepEqual(pickTemplate({ template: null, body: '  \n' }, 'ci', en), { template: 'ci', body: templateBody('ci', en), kept: false });
  // Still as Bug left it: replaced by Review's.
  assert.deepEqual(pickTemplate({ template: 'bug', body: templateBody('bug', en) }, 'review', en), { template: 'review', body: templateBody('review', en), kept: false });
  // Written by the person: kept, and said.
  const written = `${templateBody('bug', en)}\nThe name is cut at 40.`;
  assert.deepEqual(pickTemplate({ template: 'bug', body: written }, 'review', en), { template: 'review', body: written, kept: true });
  assert.deepEqual(pickTemplate({ template: null, body: 'My own words' }, 'question', en), { template: 'question', body: 'My own words', kept: true });
  // The same template again: none picked; its untouched sections leave with it, written words stay, unsaid.
  assert.deepEqual(pickTemplate({ template: 'bug', body: templateBody('bug', en) }, 'bug', en), { template: null, body: '', kept: false });
  assert.deepEqual(pickTemplate({ template: 'bug', body: written }, 'bug', en), { template: null, body: written, kept: false });
  assert.equal(en('template_kept'), 'Your description is kept: a template only fills an empty one.');
  assert.equal(fr('template_kept'), 'Votre description est gardée, un modèle ne remplit qu\'une description vide.');
});

test('the ticket carries the template\'s type label, and no label without one', () => {
  assert.deepEqual(templateLabels('bug'), ['type:bug']);
  assert.deepEqual(templateLabels(null), []);
  assert.deepEqual(newTicket('Long names', 'b', 'guestbook', [], 1, templateLabels('bug')), { title: 'Long names', project: 'guestbook', body: 'b', labels: ['type:bug'] });
  assert.deepEqual(newTicket('Long names', '', 'guestbook', [], 2, templateLabels('question')), { title: 'Long names', project: 'guestbook', labels: ['type:question'], variants: 2 });
  assert.deepEqual(newTicket('Long names', '', 'guestbook', [], 1, []), { title: 'Long names', project: 'guestbook' });
});
