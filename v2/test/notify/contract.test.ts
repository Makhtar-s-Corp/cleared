// What milestone 2 adds to lib/notify/contract.ts and to the catalogs of
// lib/i18n: the kinds permission and plan, their order of urgency, the
// lead's question, and two health codes. v1's own behaviour is the test of
// test/notify.test.ts, which stays as it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

type Rendered = { kind: string; ticket: string | null; group: string; urgent: boolean; title: string; body: string; url: string | null };
type Contract = {
  KINDS: string[];
  URGENT: string[];
  URGENCY: string[];
  HEALTH_CODES: string[];
  render(facts: Record<string, unknown>, options?: { language?: string; linkBase?: string }): Rendered;
  notifySettings(conf: unknown, env: NodeJS.ProcessEnv): { events: string[] };
};

const contract = await import(new URL('../../../lib/notify/contract.ts', import.meta.url).href) as Contract;
const catalog = (language: string) => JSON.parse(readFileSync(new URL(`../../../lib/i18n/${language}.json`, import.meta.url), 'utf8')) as Record<string, string>;

test('permission and plan are kinds, ordered by urgency after rollback, health, approval', () => {
  assert.deepEqual(contract.KINDS, ['approval', 'question', 'rollback', 'health', 'blocked', 'permission', 'plan']);
  assert.deepEqual(contract.URGENCY, ['rollback', 'health', 'approval', 'plan', 'question', 'permission', 'blocked']);
  assert.deepEqual([...contract.URGENCY].sort(), [...contract.KINDS].sort(), 'every kind has a rank');
  assert.deepEqual(contract.URGENT, ['rollback', 'health']);
  // A project that names no events gets them all; one that lists its own keeps its list.
  assert.deepEqual(contract.notifySettings({ sections: {} }, {}).events, contract.KINDS);
  assert.deepEqual(contract.notifySettings({ sections: { notify: { events: 'approval, rollback' } } }, {}).events, ['approval', 'rollback']);
});

test('the new kinds read in English and French, from the catalog, with the ticket and its filtered title', () => {
  const en = (facts: Record<string, unknown>) => contract.render(facts, { language: 'en' });
  const fr = (facts: Record<string, unknown>) => contract.render(facts, { language: 'fr' });
  assert.deepEqual([en({ kind: 'permission', ticket: 'LOCAL-3', title: 'Sort the entries' }).title, en({ kind: 'permission', ticket: 'LOCAL-3', title: 'Sort the entries' }).body],
    ['A team asks for your permission', 'LOCAL-3 · Sort the entries: open it to allow or deny.']);
  assert.equal(fr({ kind: 'permission', ticket: 'LOCAL-3' }).body, 'LOCAL-3 : ouvrez-le pour autoriser ou refuser.');
  assert.deepEqual([en({ kind: 'plan', title: 'Make the guestbook ready' }).title, en({ kind: 'plan', title: 'Make the guestbook ready' }).body],
    ['A plan waits for your approval', 'Make the guestbook ready: open the lead to approve or change it.']);
  assert.equal(fr({ kind: 'plan', title: 'Préparer le livre' }).title, 'Un plan attend votre accord');
  // The lead's question has no ticket and no title: its own sentence.
  assert.deepEqual([en({ kind: 'question', from: 'lead' }).title, en({ kind: 'question', from: 'lead' }).body], ['The lead asks you a question', 'Open the lead to answer.']);
  assert.deepEqual([fr({ kind: 'question', from: 'lead' }).title, fr({ kind: 'question', from: 'lead' }).body], ['Le lead vous pose une question', 'Ouvrez le lead pour répondre.']);
  // A team's question is v1's sentence, whatever `from` says.
  assert.equal(en({ kind: 'question', ticket: 'LOCAL-4', from: 'someone' }).title, 'A team asks you a question');
  for (const kind of ['permission', 'plan']) assert.equal(en({ kind, ticket: 'LOCAL-1' }).urgent, false);
});

test('a title made to leak a path and a token is filtered in the new kinds too', () => {
  const title = 'Rotate tok_live_AbCdEfGhIjKlMnOpQrStUv in /srv/cleared/state/claude.token now';
  for (const kind of ['permission', 'plan']) for (const language of ['en', 'fr']) {
    const message = JSON.stringify(contract.render({ kind, ticket: 'LOCAL-1', title }, { language }));
    assert.doesNotMatch(message, /tok_live|AbCdEfGh|\/srv\/|claude\.token/, `${kind} ${language}`);
  }
});

test('the health codes of the lead and of the week stop have their sentence; v1\'s groups are unchanged', () => {
  assert.ok(contract.HEALTH_CODES.includes('lead_start_failed') && contract.HEALTH_CODES.includes('week_stop'));
  assert.equal(contract.render({ kind: 'health', code: 'lead_start_failed' }).body, 'Cleared: the project lead could not start.');
  assert.equal(contract.render({ kind: 'health', code: 'week_stop' }, { language: 'fr' }).body, 'Cleared : la limite d’usage est atteinte, aucun nouveau ticket ne démarre.');
  assert.equal(contract.render({ kind: 'health', code: 'week_stop' }).group, 'health:week_stop');
  // Issue #270: the quota's alerts and its failed reading each say what they are.
  assert.equal(contract.render({ kind: 'health', code: 'quota_75' }).body, 'Cleared: a usage window of the subscription is at 75%.');
  assert.match(contract.render({ kind: 'health', code: 'quota_85' }, { language: 'fr' }).body, /^Cleared : une fenêtre d’usage de l’abonnement est à 85\s%\.$/);
  assert.equal(contract.render({ kind: 'health', code: 'quota_read_failed' }).body, 'Cleared: the hourly quota reading failed.');
  assert.equal(contract.render({ kind: 'rollback' }).group, 'rollback:none');
  assert.equal(contract.render({ kind: 'approval', ticket: 'EX-1' }).group, 'EX-1');
});

test('every notify_ key of the English catalog is in the French one', () => {
  const en = catalog('en'), fr = catalog('fr');
  const missing = Object.keys(en).filter((key) => key.startsWith('notify_') && !(key in fr));
  assert.deepEqual(missing, []);
  for (const kind of contract.KINDS) assert.ok(en[`notify_${kind}_title`] && fr[`notify_${kind}_title`], kind);
});
