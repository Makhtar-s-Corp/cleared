// The flow on a versioned agent profile and environment (issue #452): the
// default versions start each session exactly as the service did before
// profiles (the inputs recorded from origin/v2 at 584d3ebe); an edited
// profile and environment reach the author and the reviewer; a session
// keeps the versions it started on and says them; `harness: auto` goes
// through the harness pick (P213) and the session records the harness it
// ran on; the receipt names the versions. Fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ReceiptData } from '../../src/flow/receipt.ts';
import { renderReceipt } from '../../src/flow/receipt.ts';
import { profileVersions } from '../../src/profiles/store.ts';
import type { Harness } from '../../src/session/contract.ts';
import { VARIANTS_TABLE } from '../../src/flow/variants.ts';
import { REPORT_PASS, authorScript, quickAuthor, reviewerScript, scriptedAdapter, setup, until, type Setup } from './support.ts';

const FIXTURE = new URL('../profiles/fixtures/default-inputs.json', import.meta.url);
// A start input as JSON: a host tool's handler is a function, written as its place.
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'function' ? '[fn]' : v)));

async function reviewed(t: Setup): Promise<void> {
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => t.startedSessions.some((s) => s.input.role === 'reviewer'), 'the reviewer', 5000);
  await t.engine.settled();
}

test('the default profile and environment start the author and the reviewer exactly as before profiles', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });
  await reviewed(t);
  assert.deepEqual(t.startedSessions.map((s) => plain(s.input)), JSON.parse(readFileSync(FIXTURE, 'utf8')));
  for (const s of t.startedSessions) {
    assert.ok(!('image' in s.input) && !('limits' in s.input), 'no image and no limits: the runtime\'s own');
    assert.deepEqual(t.engine.sessionDetail(s.id)?.versions, { profile: 1, environment: 1, auto: false });
  }
});

test('an edited profile and environment reach the author and the reviewer, and each session says their versions', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });
  const versions = profileVersions(t.store.db);
  versions.profile.save({
    authorModel: 'claude-opus-5-1', reviewerModel: 'claude-haiku-5-5',
    rolePrompts: { author: 'Write the changelog line too.', reviewer: 'Check the changelog line.' }, allowedTools: ['make check', 'make check *'],
  }, 'u1');
  versions.environment.save({ image: 'cleared-v2-session:custom', allowedHosts: ['api.example.com'], cpus: '1', memory: '2g' }, 'u1');
  await reviewed(t);
  const author = t.startedSessions.find((s) => s.input.role === 'author');
  const reviewer = t.startedSessions.find((s) => s.input.role === 'reviewer');
  assert.ok(author && reviewer);
  assert.equal(author.input.model, 'claude-opus-5-1');
  assert.equal(reviewer.input.model, 'claude-haiku-5-5');
  assert.ok(author.input.prompt.endsWith('\n\nWrite the changelog line too.'), author.input.prompt);
  assert.ok(reviewer.input.prompt.endsWith('\n\nCheck the changelog line.'), reviewer.input.prompt);
  for (const s of [author, reviewer]) {
    assert.deepEqual(s.input.policy.safeCommands.slice(-3), ['npm ci', 'make check', 'make check *']);
    assert.deepEqual(s.input.policy.allowedHosts, ['registry.npmjs.org', 'api.example.com']);
    assert.equal(s.input.image, 'cleared-v2-session:custom');
    assert.deepEqual(s.input.limits, { cpus: '1', memory: '2g' });
    assert.deepEqual(t.engine.sessionDetail(s.id)?.versions, { profile: 2, environment: 2, auto: false });
  }
});

test('a session keeps the versions it started on when the profile changes under it; a rollback is the next session\'s', async () => {
  const t = await setup({ scripts: { author: authorScript } });
  await t.engine.start(t.ticket.id, 'u1');
  const [first] = t.startedSessions;
  assert.ok(first);
  const versions = profileVersions(t.store.db);
  versions.profile.save({ authorModel: 'claude-opus-5-1' }, 'u1');
  versions.environment.save({ network: 'model-only' }, 'u1');
  assert.deepEqual(t.engine.sessionDetail(first.id)?.versions, { profile: 1, environment: 1, auto: false });
  assert.equal(first.input.model, 'claude-opus-5-5');
  versions.profile.restore(1, 'u1');
  assert.equal(versions.profile.current().version, 3);
});

test('a model-only network gives the session the model API and the registry alone, whatever the project declares', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });
  profileVersions(t.store.db).environment.save({ network: 'model-only' }, 'u1');
  await reviewed(t);
  for (const s of t.startedSessions) assert.deepEqual(s.input.policy.allowedHosts, []);
});

test('harness auto with the default gate: one Claude Code session, no variants, and the session says auto', async () => {
  const t = await setup({ scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] } });
  profileVersions(t.store.db).profile.save({ harness: 'auto' }, 'u1');
  await reviewed(t);
  const authors = t.startedSessions.filter((s) => s.input.role === 'author');
  assert.deepEqual(authors.map((s) => s.input.harness), ['claude-code']);
  assert.equal(t.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'ticket_variants'").get() === undefined
    || (t.store.db.prepare('SELECT COUNT(*) AS n FROM ticket_variants').get() as { n: number }).n === 0, true);
  assert.deepEqual(t.engine.sessionDetail((authors[0] as { id: string }).id)?.versions, { profile: 2, environment: 1, auto: true });
});

// A scripted adapter under another harness's name, as the pick's own tests register one.
function otherHarness(t: Setup, harness: Harness): void {
  const adapter = scriptedAdapter(t.store, { authors: [quickAuthor as never] }, t.startedSessions);
  (t.registry.sessionAdapters as Record<string, unknown>)[harness] = { ...adapter, harness };
}

test('harness auto with two harnesses enabled: the ticket runs as a harness pick on them, each session on its harness', async () => {
  const t = await setup({ config: { pickHarnesses: [{ harness: 'claude-code' }, { harness: 'codex' }] }, scripts: { author: quickAuthor } });
  t.store.db.exec(VARIANTS_TABLE);
  otherHarness(t, 'codex');
  profileVersions(t.store.db).profile.save({ harness: 'auto' }, 'u1');
  await t.engine.start(t.ticket.id, 'u1');
  const authors = t.startedSessions.filter((s) => s.input.role === 'author');
  assert.deepEqual(authors.map((s) => s.input.harness), ['claude-code', 'codex']);
  const rows = t.store.db.prepare('SELECT harness, pick FROM ticket_variants ORDER BY position').all() as { harness: string; pick: number }[];
  assert.deepEqual(rows.map((r) => [r.harness, r.pick]), [['claude-code', 1], ['codex', 1]]);
  for (const s of authors) assert.deepEqual(t.engine.sessionDetail(s.id)?.versions, { profile: 2, environment: 1, auto: true });
  const comments = (await t.tickets.comments(t.ticket.id)).map((c) => c.body);
  assert.ok(comments.includes('Started by u1 in 2 variants, one per harness: claude-code, codex.'), comments.join('\n'));
});

test('harness auto leaves a Quick ticket in its fast lane and a setup session on its one author', async () => {
  const t = await setup({ config: { pickHarnesses: [{ harness: 'claude-code' }, { harness: 'codex' }] }, scripts: { author: quickAuthor } });
  t.store.db.exec(VARIANTS_TABLE);
  otherHarness(t, 'codex');
  profileVersions(t.store.db).profile.save({ harness: 'auto' }, 'u1');
  for (const labels of [['Quick'], ['type:environment']]) {
    const ticket = await t.tickets.create({ title: `A ${labels[0]} ticket`, project: 'guestbook', labels }, { kind: 'human', id: 'u1' });
    await t.engine.start(ticket.id, 'u1');
    const authors = t.startedSessions.filter((s) => s.input.ticket === ticket.id && s.input.role === 'author');
    assert.deepEqual(authors.map((s) => s.input.harness), ['claude-code'], labels[0]);
  }
  assert.equal((t.store.db.prepare('SELECT COUNT(*) AS n FROM ticket_variants').get() as { n: number }).n, 0);
});

test('harness auto does not override what the ticket asks: a number of variants stays plain variants on Claude Code', async () => {
  const t = await setup({ config: { pickHarnesses: [{ harness: 'claude-code' }, { harness: 'codex' }] }, scripts: { author: quickAuthor } });
  t.store.db.exec(VARIANTS_TABLE);
  otherHarness(t, 'codex');
  profileVersions(t.store.db).profile.save({ harness: 'auto' }, 'u1');
  await t.engine.start(t.ticket.id, 'u1', undefined, 2);
  const rows = t.store.db.prepare('SELECT harness, pick FROM ticket_variants ORDER BY position').all() as { harness: string; pick: number }[];
  assert.deepEqual(rows.map((r) => [r.harness, r.pick]), [['claude-code', 0], ['claude-code', 0]]);
});

test('the receipt names the profile and environment versions the ticket\'s sessions ran on', async () => {
  const receipts: (ReceiptData | undefined)[] = [];
  const t = await setup({
    scripts: { author: quickAuthor, reviewers: [reviewerScript(REPORT_PASS)] },
    effects: { async publish(input) { receipts.push(input.receipt); return { url: 'https://example.invalid/pull/7', number: 7, head: 'abc123', created: true }; } },
  });
  profileVersions(t.store.db).environment.save({ cpus: '1' }, 'u1');
  await t.engine.start(t.ticket.id, 'u1');
  await until(() => receipts.length > 0, 'the publish', 5000);
  await t.engine.settled();
  const [receipt] = receipts;
  assert.deepEqual(receipt?.versions, { profile: [1], environment: [2] });
  const en = renderReceipt(receipt as ReceiptData, 'en');
  const fr = renderReceipt(receipt as ReceiptData, 'fr');
  assert.ok(en.includes('- Agent profile version: 1. Environment version: 2.'), en);
  assert.ok(fr.includes('- Version du profil d\'agent\u00a0: 1. Version de l\'environnement\u00a0: 2.'), fr);
  const changed = renderReceipt({ ...(receipt as ReceiptData), versions: { profile: [1, 2], environment: [2] } }, 'en');
  assert.ok(changed.includes('- Agent profile version: 1, then 2. Environment version: 2.'), changed);
  const without = renderReceipt({ ...(receipt as ReceiptData), versions: undefined }, 'en');
  assert.ok(!without.includes('Agent profile'), 'a receipt with no versions reads as before');
});
