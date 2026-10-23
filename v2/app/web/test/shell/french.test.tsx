// The shell in French (the owner's decision of 2026-10-23, docs/v2/ui-overhaul-plan.md,
// 2.5.6): the sidebar, the palette, the shortcut sheet, the tower and the lead's
// empty states draw no English sentence when the language is fr. A text is English
// when it is an English catalog's value, or matches one of its templates, that the
// French catalog does not share (Sessions, Plans, Permission are French too).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { ReactNode } from 'react';
import { loadCatalog } from '../../../src/catalog.ts';
import { FIXTURE_NOW, towerFixture } from '../../../fixtures/tower.ts';
import { translator, type Catalog } from '../../lib/i18n.ts';
import { towerModel } from '../../screens/tower/model.ts';
import { TowerBody } from '../../screens/tower/Tower.tsx';
import { Side, Thread } from '../../screens/lead/Lead.tsx';
import { sessionGroups, sessionRows } from '../../shell/model.ts';
import Palette from '../../shell/Palette.tsx';
import { paletteItems } from '../../shell/palette.ts';
import { ShortcutSheet } from '../../shell/Shortcuts.tsx';
import { Keys } from '../../shell/Kbd.tsx';
import { html, renderSidebar, visibleText } from '../render.tsx';
import type { LeadView } from '../../screens/lead/model.ts';

const SCREENS = ['shell', 'tower', 'lead'] as const;
const catalogs = (language: 'en' | 'fr'): Catalog => Object.assign({}, ...SCREENS.map((s) => loadCatalog(s, language))) as Catalog;
const en = catalogs('en');
const fr = catalogs('fr');
const t = translator(fr);

// The English sentences French does not share, as exact texts and as templates.
const english = Object.entries(en).filter(([key, value]) => fr[key] !== value);
const patterns = english.map(([key, value]) => {
  const literal = value.split(/\{[a-z_]+\}/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?');
  return { key, pattern: new RegExp(`^${literal}$`) };
});

// Key names and words a shell would draw without its catalog.
const WORDS = ['Tower', 'Inbox', 'Search', 'Live sessions', 'Needs you', 'Working', 'In review', 'then', 'Enter', 'Esc', 'Close', 'Sample data', 'Sign out', 'Keyboard shortcuts', 'Go to', 'General', 'On this screen'];

function assertFrench(where: string, markup: string): void {
  for (const text of visibleText(markup)) {
    assert.ok(!WORDS.includes(text), `${where}: "${text}" is English`);
    const hit = patterns.find(({ pattern }) => pattern.test(text));
    assert.ok(!hit, `${where}: "${text}" is the English of ${hit?.key}`);
  }
}

test('the sidebar in French: the screens, the sessions\' groups, the search, the person, the sample data', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const groups = sessionGroups(sessionRows(data.sessions, data.tickets));
  const markup = renderSidebar('tower', t, { waiting: 5, lead: 'on', groups, source: 'fixtures' });
  assert.match(markup, />Tour</);
  assert.match(markup, />Réception</);
  assert.match(markup, />Sessions en cours</);
  assert.match(markup, />Pour vous</);
  assert.match(markup, />Rechercher</);
  assertFrench('sidebar', markup);
  assertFrench('rail', renderSidebar('tower', t, { mode: 'rail', waiting: 5, lead: 'down', groups }));
});

test('the palette and the shortcut sheet in French, their key names included', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  const model = towerModel(data, FIXTURE_NOW);
  for (const screen of ['tower', 'session'] as const) {
    const items = paletteItems({ screen, needs: model.needs, sessions: sessionRows(data.sessions, data.tickets), gestures: ['new_ticket', 'takeover', 'giveback'], theme: 'light', t });
    for (const item of items) for (const text of [item.label, item.detail ?? '']) assertFrench(`palette ${screen}`, `<p>${text}</p>`);
    assertFrench(`palette ${screen}`, html(<Palette t={t} items={items} dark={false} onRun={() => {}} onClose={() => {}} />));
    assertFrench(`sheet ${screen}`, html(<ShortcutSheet t={t} screen={screen} mac={false} onClose={() => {}} />));
  }
  const caps = (node: ReactNode) => visibleText(html(node));
  assert.deepEqual(caps(<Keys keys={['Enter']} t={t} mac={false} />), ['Entrée']);
  assert.deepEqual(caps(<Keys keys={['Esc']} t={t} mac={false} />), ['Échap']);
  assert.deepEqual(caps(<Keys keys={['G', 'T']} t={t} mac={false} />), ['G', 'puis', 'T']);
});

test('the tower and the lead in French, full and empty', async () => {
  const data = await towerFixture(FIXTURE_NOW);
  assertFrench('tower', html(<TowerBody model={towerModel(data, FIXTURE_NOW)} t={t} language="fr" />));
  assertFrench('empty tower', html(<TowerBody model={towerModel({ ...data, inbox: [], sessions: [], plans: [], tickets: [] }, FIXTURE_NOW)} t={t} language="fr" />));
  const view = { state: { phase: 'idle' }, messages: [], plans: [], planId: null, now: FIXTURE_NOW, language: 'fr', memory: null, trains: [] } as unknown as LeadView;
  assertFrench('empty lead thread', html(<ol><Thread view={view} t={t} /></ol>));
  assertFrench('empty lead side', html(<Side view={view} t={t} />));
});

test('the test reads English as English: the English shell fails it', async () => {
  const english = translator(catalogs('en'));
  assert.throws(() => assertFrench('sidebar', renderSidebar('tower', english)), /is (?:the )?English/);
  assert.throws(() => assertFrench('sheet', html(<ShortcutSheet t={english} screen="tower" mac={false} onClose={() => {}} />)), /is (?:the )?English/);
});
