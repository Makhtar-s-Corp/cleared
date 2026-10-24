// Numbers are said in the page's language (O23, lane j2-i18n-audit): a count
// above 999 is grouped as the language groups it ("12 345", "12,345"), in a
// sentence of the catalog and where a screen draws it on its own. The lines a
// session added and removed were drawn as they came ("+12345").
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { LANGUAGES, loadCatalog, type Language } from '../../src/catalog.ts';
import { translator } from '../lib/i18n.ts';
import { EditorTab } from '../screens/session/Tabs.tsx';
import { html, visibleText } from './render.tsx';

const GROUPED: Readonly<Record<Language, string>> = { en: '12,345', fr: '12 345' };
const catalog = (language: Language) => translator({ ...loadCatalog('shell', language), ...loadCatalog('session', language) });

test('a number in a sentence of the catalog is grouped as the page\'s language groups it, a string or a catalog without a locale is left alone', () => {
  for (const language of LANGUAGES) {
    const t = catalog(language);
    assert.ok(t('edits_count', { n: 12345 }).startsWith(GROUPED[language]), `${language}: ${t('edits_count', { n: 12345 })}`);
    assert.ok(t('edits_count', { n: 7 }).startsWith('7 '), 'a small number is as it is');
    assert.ok(t('edits_count', { n: '12345' }).startsWith('12345'), 'a string is the caller\'s own text');
  }
  assert.equal(translator({ edits: '{n} edits' })('edits', { n: 12345 }), '12345 edits', 'no locale in the catalog: as it comes');
  assert.equal(translator({ locale: 'fr', pct: '{n} %' })('pct', { n: 86.5 }), '86,5 %');
});

test('the lines a file added and removed, and the counts of the scope, are grouped in the Editor tab, in both languages', () => {
  const files = [{ path: 'src/big.ts', added: 12345, removed: 1200 }] as never;
  for (const language of LANGUAGES) {
    const markup = html(<EditorTab t={catalog(language)} files={files} mode="diff" scope={{ value: 'all', all: 12345, last: 1234 } as never} />);
    const text = visibleText(markup).join(' | ');
    const grouped = GROUPED[language];
    assert.ok(text.includes(`+${grouped}`), `${language}: the added lines are "+${grouped}": ${text}`);
    assert.ok(text.includes(language === 'fr' ? '−1 200' : '−1,200'), `${language}: the removed lines are grouped: ${text}`);
    assert.ok(text.includes(grouped) && text.includes(language === 'fr' ? '1 234' : '1,234'), `${language}: the scope's counts are grouped: ${text}`);
  }
});
