// The Hand over button as HTML, in both languages (matrix B6.3, P153).
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { loadCatalog } from '../../../src/catalog.ts';
import { translator } from '../../lib/i18n.ts';
import { HandoverButton } from '../../screens/session/Tabs.tsx';
import { html, visibleText } from '../render.tsx';

const en = translator({ ...loadCatalog('shell', 'en'), ...loadCatalog('session', 'en') });
const fr = translator({ ...loadCatalog('shell', 'fr'), ...loadCatalog('session', 'fr') });

test('the button names the other harness, in English and in French, and carries its target', () => {
  const toCodex = html(<HandoverButton t={en} handover={{ kind: 'offer', to: 'codex' }} />);
  assert.match(toCodex, /<button[^>]*id="handover"/);
  assert.match(toCodex, /data-to="codex"/);
  assert.equal(visibleText(toCodex), 'Hand over to Codex');
  assert.equal(visibleText(html(<HandoverButton t={en} handover={{ kind: 'offer', to: 'claude-code' }} />)), 'Hand back to Claude Code');
  assert.equal(visibleText(html(<HandoverButton t={fr} handover={{ kind: 'offer', to: 'codex' }} />)), 'Confier à Codex');
  assert.equal(visibleText(html(<HandoverButton t={fr} handover={{ kind: 'offer', to: 'claude-code' }} />)), 'Confier à Claude Code');
});

test('nothing is drawn when there is no offer, and the button is disabled while the gesture runs', () => {
  assert.equal(html(<HandoverButton t={en} handover={{ kind: 'none' }} />), '');
  assert.match(html(<HandoverButton t={en} handover={{ kind: 'offer', to: 'codex' }} busy />), /<button[^>]*disabled/);
});
