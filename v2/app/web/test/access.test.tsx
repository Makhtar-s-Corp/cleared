// The API access panel (docs/v2/milestone-5-plan.md, section 8, C18): from
// the person's menu, a dialog that lists the person's tokens by name, when
// each was made and last used, revokes one, and makes one whose value is
// shown once with the command that uses it. French and English.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ApiToken } from '../../../src/run/types.ts';
import { loadCatalog } from '../../src/catalog.ts';
import { translator, type Translate } from '../lib/i18n.ts';
import { AccessBody } from '../shell/Access.tsx';
import { ACCESS_COMMAND, accessNameProblem, accessRows, initialAccess, type AccessView } from '../shell/access.ts';
import { html, renderSidebar, visibleText } from './render.tsx';

const en = translator(loadCatalog('shell', 'en'));
const fr = translator(loadCatalog('shell', 'fr'));
const NOW = new Date('2026-10-25T10:00:00.000Z');

const tokens: ApiToken[] = [
  { id: 'a1b2c3d4e5f6', name: 'Nightly script', createdAt: '2026-10-25T09:57:00.000Z', lastUsedAt: '2026-10-25T09:58:00.000Z' },
  { id: 'f6e5d4c3b2a1', name: 'CI', createdAt: '2026-10-20T08:00:00.000Z', lastUsedAt: null },
];
const listed: AccessView = { ...initialAccess, rows: tokens };
const body = (view: AccessView, t: Translate) => html(<AccessBody t={t} view={view} now={NOW} onName={() => {}} onMake={() => {}} onRevoke={() => {}} onCopy={() => {}} />);

test('a name is one to sixty characters on one line', () => {
  assert.equal(accessNameProblem(''), 'empty');
  assert.equal(accessNameProblem('   '), 'empty');
  assert.equal(accessNameProblem('x'.repeat(61)), 'long');
  assert.equal(accessNameProblem(' x '.repeat(20)), null);
  assert.equal(accessNameProblem('two\nlines'), 'empty');
  assert.equal(accessNameProblem('Nightly'), null);
});

test('each token says its name, the day it was made and when it was last used, in either language', () => {
  const english = accessRows(tokens, NOW, en);
  assert.deepEqual(english.map((row) => [row.id, row.name, row.made]), [['a1b2c3d4e5f6', 'Nightly script', 'Made on 25 October'], ['f6e5d4c3b2a1', 'CI', 'Made on 20 October']]);
  assert.match(english[0]!.used, /^Used 2\smin ago$/);
  assert.equal(english[1]!.used, 'Never used');
  const french = accessRows(tokens, NOW, fr);
  assert.equal(french[0]!.made, 'Créé le 25 octobre');
  assert.match(french[0]!.used, /^Utilisé il y a 2\smin$/);
  assert.equal(french[1]!.used, 'Jamais utilisé');
});

test('the panel: what a token can and cannot do, the list with a Revoke per token, and the form to make one', () => {
  const markup = body(listed, en);
  const text = visibleText(markup).join(' | ');
  assert.match(text, /make and start tickets as you/);
  assert.match(text, /never approves a release/);
  assert.match(markup, /<h3 id="access-list-title">Your tokens<\/h3>/);
  assert.match(markup, /<ul aria-labelledby="access-list-title">/);
  assert.match(markup, /<button[^>]*data-revoke="a1b2c3d4e5f6"[^>]*aria-label="Revoke Nightly script"[^>]*>Revoke<\/button>/);
  assert.match(markup, /<label for="access-name">Name<\/label>/);
  assert.match(markup, /<input[^>]*id="access-name"[^>]*maxlength="60"/);
  assert.match(markup, /<button type="submit"[^>]*id="access-make"[^>]*>Make a token<\/button>/);
  assert.doesNotMatch(markup, /clr_/, 'no value outside the one just made');
  const none = visibleText(body({ ...initialAccess, rows: [] }, en)).join(' | ');
  assert.match(none, /No token yet\./);
  assert.match(visibleText(body(initialAccess, en)).join(' | '), /Reading your tokens/);
  assert.match(body(initialAccess, en), /aria-busy="true"/);
});

test('a token just made: its value once, a field to copy from, the warning, and the command that uses it', () => {
  const value = `clr_${'Q'.repeat(43)}`;
  const markup = body({ ...listed, fresh: { token: tokens[1]!, value } }, en);
  assert.match(markup, /<input[^>]*id="access-value"[^>]*readonly=""[^>]*value="clr_Q+"/);
  assert.match(markup, /<label for="access-value">The token CI<\/label>/);
  assert.match(markup, /<button[^>]*id="access-copy"[^>]*>Copy<\/button>/);
  const text = visibleText(markup).join(' | ');
  assert.match(text, /shown this once/);
  assert.match(text, /chmod 600/);
  assert.match(text, /CLEARED_V2_API_TOKEN_FILE/);
  assert.ok(markup.includes(ACCESS_COMMAND.replace(/"/g, '&quot;')), 'the command');
  assert.match(markup, /role="status"/);
  assert.equal((markup.match(/clr_Q+/g) ?? []).length, 1, 'the value once');
});

test('a refused name, a full list and a failed call are said, as alerts', () => {
  for (const [view, said] of [
    [{ ...listed, problem: 'empty' }, /Give it a name\./],
    [{ ...listed, problem: 'long' }, /60 characters at most/],
    [{ ...listed, problem: 'many' }, /revoke one first/],
    [{ ...listed, failed: { kind: 'read' } }, /could not be read/],
    [{ ...listed, failed: { kind: 'make' } }, /could not be made/],
    [{ ...listed, failed: { kind: 'revoke', name: 'CI' } }, /CI could not be revoked/],
  ] as const) {
    const markup = body(view as AccessView, en);
    assert.match(markup, /role="alert"/);
    assert.match(visibleText(markup).join(' | '), said);
  }
  const problem = body({ ...listed, problem: 'empty' }, en);
  assert.match(problem, /<input[^>]*aria-invalid="true"[^>]*aria-describedby="access-problem"/);
});

test('the French panel', () => {
  const text = visibleText(body({ ...listed, fresh: { token: tokens[1]!, value: `clr_${'Q'.repeat(43)}` } }, fr)).join(' | ');
  assert.match(text, /Accès à l’API/);
  assert.match(text, /Vos jetons/);
  assert.match(text, /n’approuve jamais une mise en production/);
  assert.match(text, /Révoquer/);
  assert.match(text, /Copier/);
  assert.doesNotMatch(text, /⟦|«access_/);
});

test('the person\'s menu opens the panel', () => {
  const markup = renderSidebar('tower', en);
  assert.match(markup, /<button[^>]*id="access-open"[^>]*>API access<\/button>/);
});

test('the panel\'s words: in both catalogs, no key a guard reads as a credential', () => {
  const shellEn = loadCatalog('shell', 'en');
  const shellFr = loadCatalog('shell', 'fr');
  const keys = Object.keys(shellEn).filter((key) => key.startsWith('access_'));
  assert.ok(keys.length >= 20, String(keys.length));
  for (const key of keys) {
    assert.ok(Object.hasOwn(shellFr, key), `${key} in French`);
    assert.notEqual(shellFr[key], shellEn[key], `${key} is translated`);
    assert.doesNotMatch(key, /token|secret|key|pass/, key);
  }
  const source = ['Access.tsx', 'access.ts'].map((file) => readFileSync(new URL(`../shell/${file}`, import.meta.url), 'utf8')).join('\n');
  for (const [, key] of source.matchAll(/\bt\('(access_[a-z_]+)'/g)) assert.ok(Object.hasOwn(shellEn, key as string), `${key} is said and not in the catalog`);
});
